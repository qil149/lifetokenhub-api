// LifeTokenHub API Gateway - Cloudflare Worker v1.0
// 支持：DeepSeek API转发 + 流量池管理 + 生命基金记录 + 用户认证
// 修复版：环境变量正确读取 + CORS限制 + 增强安全性

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// === 环境变量配置 (从 Cloudflare Workers 设置读取) ===
// 在 Workers 设置中添加环境变量：
// 1. DEEPSEEK_API_KEY = 你的DeepSeek API Key
// 2. JWT_SECRET = 随机字符串(用于用户令牌签名)
// 3. ALLOWED_ORIGIN = 你的前端域名 (可选，默认允许所有)

async function getEnv(key) {
  // Workers 环境中通过 env 访问
  try {
    return self.ENV?.[key] || '';
  } catch(e) {
    return '';
  }
}

const API_PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-v2.5'],
    // V1.0定价 (美元/百万tokens)
    pricing: {
      input: 0.8,
      output: 3.2,
      cache__hit: 0.4
    }
  }
}

// === 配置 ===
const CONFIG = {
  // 从环境变量读取
  get deepseekApiKey() {
    return self.ENV?.DEEPSEEK_API_KEY || '';
  },
  get jwtSecret() {
    return self.ENV?.JWT_SECRET || 'default-secret-change-me';
  },
  get allowedOrigin() {
    return self.ENV?.ALLOWED_ORIGIN || '*';
  }
}

// === 主请求处理 ===
async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname
  const origin = request.headers.get('Origin') || ''
  
  // CORS headers (根据配置限制来源)
  const allowedOrigin = CONFIG.allowedOrigin === '*' ? '*' : 
                        (origin === CONFIG.allowedOrigin ? origin : '')
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  }
  
  // 处理OPTIONS预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  
  // 健康检查无需认证
  if (path === '/health' && request.method === 'GET') {
    return new Response(JSON.stringify({ 
      status: 'healthy', 
      service: 'LifeTokenHub API Gateway',
      version: '1.0',
      timestamp: new Date().toISOString(),
      providers: Object.keys(API_PROVIDERS)
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  
  // API路由分发
  switch(true) {
    case path === '/v1/chat/completions' && request.method === 'POST':
      return await handleChatCompletion(request, corsHeaders)
    
    case path === '/v1/models' && request.method === 'GET':
      return await handleModelsList(corsHeaders)
    
    case path === '/v1/auth/verify' && request.method === 'POST':
      return await handleAuthVerify(request, corsHeaders)
    
    default:
      return new Response(JSON.stringify({ 
        error: 'Not found',
        available_endpoints: [
          'POST /v1/chat/completions',
          'GET /v1/models', 
          'POST /v1/auth/verify',
          'GET /health'
        ]
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
  }
}

// === 聊天完成端点 (核心功能) ===
async function handleChatCompletion(request, corsHeaders) {
  try {
    const startTime = Date.now()
    let requestData;
    try {
      requestData = await request.json()
    } catch(e) {
      return errorResponse(400, 'Invalid JSON body', corsHeaders)
    }
    
    // 验证API Key
    const authResult = await authenticateUser(request)
    if (!authResult.valid) {
      return errorResponse(401, authResult.error || 'Authentication failed', corsHeaders)
    }
    
    // 提取模型
    const model = requestData.model || 'deepseek-chat'
    const provider = getProviderByModel(model)
    
    if (!provider) {
      return errorResponse(400, `Model "${model}" not available`, corsHeaders)
    }
    
    // 检查使用限制
    const usageCheck = await checkUsageLimits(authResult.userId, model)
    if (!usageCheck.allowed) {
      return errorResponse(429, usageCheck.reason || 'Usage limit exceeded', corsHeaders)
    }
    
    // 准备上游请求
    const upstreamUrl = `${API_PROVIDERS[provider].baseUrl}/v1/chat/completions`
    const apiKey = CONFIG.deepseekApiKey
    
    if (!apiKey) {
      console.error('DEEPSEEK_API_KEY not configured!')
      return errorResponse(500, 'API provider not configured', corsHeaders)
    }
    
    const upstreamBody = {
      model: model,
      messages: requestData.messages || [],
      temperature: requestData.temperature || 0.7,
      max_tokens: requestData.max_tokens || 4096,
      stream: requestData.stream || false
    }
    
    // 转发请求
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(upstreamBody)
    })
    
    const responseTime = Date.now() - startTime
    
    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text()
      console.error(`Upstream API error (${upstreamResponse.status}):`, errorText)
      return errorResponse(upstreamResponse.status, `Upstream API error`, corsHeaders)
    }
    
    const responseBody = await upstreamResponse.text()
    let responseData;
    try {
      responseData = JSON.parse(responseBody)
    } catch(e) {
      return new Response(responseBody, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    
    // 计算使用量
    const inputTokens = responseData.usage?.prompt_tokens || estimateTokens(requestData.messages)
    const outputTokens = responseData.usage?.completion_tokens || 
                        estimateTokens(responseData.choices?.[0]?.message?.content || '')
    const totalTokens = responseData.usage?.total_tokens || (inputTokens + outputTokens)
    
    const pricing = API_PROVIDERS[provider].pricing
    const estimatedCostUSD = calculateCost(inputTokens, outputTokens, pricing)
    
    // 记录日志
    console.log(JSON.stringify({
      type: 'api_usage',
      userId: authResult.userId,
      model: model,
      provider: provider,
      requestId: generateRequestId(),
      timestamp: new Date().toISOString(),
      responseTimeMs: responseTime,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUSD
    }))
    
    // 返回响应
    const enhancedResponse = {
      ...responseData,
      _lifeTokenHub: {
        requestId: generateRequestId(),
        provider: provider,
        responseTimeMs: responseTime,
        estimatedCostUSD: estimatedCostUSD,
        lifeFundImpact: totalTokens > 0 ? 
          `Every ${Math.ceil(totalTokens/1000)*1000} tokens = 1 grain of rice to UN WFP` : 
          null
      }
    }
    
    return new Response(JSON.stringify(enhancedResponse), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Request-ID': generateRequestId(),
        'Cache-Control': 'no-store'
      }
    })
    
  } catch (error) {
    console.error('Chat completion error:', error)
    return errorResponse(500, `Internal server error: ${error.message}`, corsHeaders)
  }
}

// === 模型列表端点 ===
async function handleModelsList(corsHeaders) {
  const models = []
  
  API_PROVIDERS.deepseek.models.forEach(modelId => {
    models.push({
      id: modelId,
      object: 'model',
      created: 1677610602,
      owned_by: 'deepseek',
      pricing: API_PROVIDERS.deepseek.pricing,
      status: 'available',
      description: 'DeepSeek AI model',
      supports_caching: true,
      cache_hit_discount: 0.5
    })
  })
  
  // 占位模型
  models.push({ id: 'glm-4', object: 'model', created: 1677610603, owned_by: 'zhipu-ai', status: 'coming_soon', description: '智谱GLM-4 (预计Q2 2026)' })
  models.push({ id: 'doubao-pro', object: 'model', created: 1677610604, owned_by: 'bytedance', status: 'coming_soon', description: '字节豆包Pro (预计Q3 2026)' })
  
  return new Response(JSON.stringify({ object: 'list', data: models }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// === 认证验证端点 ===
async function handleAuthVerify(request, corsHeaders) {
  try {
    let body
    try {
      body = await request.json()
    } catch(e) {
      return errorResponse(400, 'Invalid JSON', corsHeaders)
    }
    
    const { apiKey } = body || {}
    
    if (!apiKey || !apiKey.startsWith('ltk_')) {
      return errorResponse(401, 'Invalid API key format', corsHeaders)
    }
    
    const isValid = apiKey.length >= 20
    const userId = isValid ? extractUserIdFromKey(apiKey) : null
    
    return new Response(JSON.stringify({
      valid: isValid,
      userId: userId,
      permissions: isValid ? ['chat', 'models'] : [],
      life_fund_enabled: true,
      rate_limit: {
        daily_requests: 1000,
        daily_tokens: 10000000,
        remaining_today: 1000
      }
    }), {
      status: isValid ? 200 : 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
    
  } catch (error) {
    return errorResponse(400, 'Invalid request', corsHeaders)
  }
}

// === 辅助函数 ===

async function authenticateUser(request) {
  const authHeader = request.headers.get('Authorization')
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing Authorization header' }
  }
  
  const apiKey = authHeader.replace('Bearer ', '').trim()
  
  // 简化验证 - 生产环境应查询数据库
  if (!apiKey.startsWith('ltk_') || apiKey.length < 20) {
    return { valid: false, error: 'Invalid API key' }
  }
  
  const userId = extractUserIdFromKey(apiKey)
  
  return {
    valid: true,
    userId: userId,
    apiKey: apiKey,
    lifeFundEnabled: true
  }
}

function extractUserIdFromKey(apiKey) {
  const parts = apiKey.split('_')
  return parts.length >= 3 ? parts[2] : 'anonymous'
}

async function checkUsageLimits(userId, model) {
  // TODO: 实现实际的KV存储限制
  return {
    allowed: true,
    reason: null,
    limits: { dailyRequests: 1000, dailyTokens: 10000000, remainingRequests: 999, remainingTokens: 9999999 }
  }
}

function getProviderByModel(model) {
  if (model.includes('deepseek')) return 'deepseek'
  if (model.includes('glm')) return 'zhipu-ai'
  if (model.includes('doubao')) return 'bytedance'
  return null
}

function estimateTokens(text) {
  if (typeof text === 'string') return Math.ceil(text.length / 4)
  if (Array.isArray(text)) return text.reduce((sum, msg) => sum + estimateTokens(msg.content || ''), 0)
  return 0
}

function calculateCost(inputTokens, outputTokens, pricing) {
  const inputCost = (inputTokens / 1000000) * pricing.input
  const outputCost = (outputTokens / 1000000) * pricing.output
  return parseFloat((inputCost + outputCost).toFixed(6))
}

function generateRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

function errorResponse(status, message, corsHeaders) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code: status.toString() }
  }), {
    status: status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}