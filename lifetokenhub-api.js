// LifeTokenHub API Gateway - Cloudflare Worker v1.1
// 双流量池架构：DeepSeek Primary Provider + Huawei Ascend Compute Provider
// 支持：API转发 + 双供应商路由 + 生命基金记录 + 用户认证 + 用量计费

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// === 环境变量配置 (从 Cloudflare Workers 设置读取) ===
// 在 Workers 设置中添加环境变量：
// 1. DEEPSEEK_API_KEY = DeepSeek Primary API Key
// 2. ASCEND_API_KEY = Huawei Ascend API Key
// 3. JWT_SECRET = JWT 密钥
// 4. ALLOWED_ORIGIN = 前端域名 (可选，默认允许所有)

async function getEnv(key) {
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
    providerGroup: 'primary',
    label: 'Primary Provider',
    pricing: {
      input: 0.0005,
      output: 0.002
    }
  },
  ascend: {
    baseUrl: 'https://ap-southeast-1.api.huaweicloud.com/v1/infers/cognitive-brain-compatible',
    models: ['huawei-pangu', 'huawei-pangu-lite'],
    providerGroup: 'ascend',
    label: 'Ascend Compute Provider',
    pricing: {
      input: 0.0004,
      output: 0.0015
    }
  }
}

// 用户定价 = 官方成本 × 1.3333 (33% markup)
const USER_PRICE_MULTIPLIER = 1.3333

// 定价 (用户计费)
const USER_PRICING = {
  'deepseek-chat': {
    input: parseFloat(((API_PROVIDERS.deepseek.pricing.input * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
    output: parseFloat(((API_PROVIDERS.deepseek.pricing.output * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6))
  },
  'deepseek-coder': {
    input: parseFloat(((0.0006 * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
    output: parseFloat(((0.0028 * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6))
  },
  'deepseek-v2.5': {
    input: parseFloat(((0.0005 * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
    output: parseFloat(((0.0024 * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6))
  },
  'huawei-pangu': {
    input: parseFloat(((API_PROVIDERS.ascend.pricing.input * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
    output: parseFloat(((API_PROVIDERS.ascend.pricing.output * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6))
  },
  'huawei-pangu-lite': {
    input: parseFloat(((0.0002 * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
    output: parseFloat(((0.001 * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6))
  }
}

// === 配置 ===
const CONFIG = {
  get deepseekApiKey() {
    return self.ENV?.DEEPSEEK_API_KEY || '';
  },
  get ascendApiKey() {
    return self.ENV?.ASCEND_API_KEY || '';
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
      version: '1.1',
      timestamp: new Date().toISOString(),
      providers: Object.keys(API_PROVIDERS),
      providerGroups: ['primary', 'ascend'],
      computeRegions: ['DeepSeek (Primary)', 'Huawei Ascend (Compute Pool)']
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
    
    // 提取模型 + 获取供应商
    const model = requestData.model || 'deepseek-chat'
    const providerInfo = getProviderByModel(model)
    
    if (!providerInfo || !providerInfo.provider) {
      return errorResponse(400, `Model "${model}" not available`, corsHeaders)
    }
    
    const { provider, endpoint } = providerInfo
    
    // 检查使用限制
    const usageCheck = await checkUsageLimits(authResult.userId, model)
    if (!usageCheck.allowed) {
      return errorResponse(429, usageCheck.reason || 'Usage limit exceeded', corsHeaders)
    }
    
    // 准备上游请求
    const apiKey = endpoint === 'ascend' ? CONFIG.ascendApiKey : CONFIG.deepseekApiKey
    
    if (!apiKey) {
      console.error(`API key not configured for ${endpoint}!`)
      return errorResponse(500, `API provider not configured (${endpoint})`, corsHeaders)
    }
    
    // 构建上游请求体
    const upstreamBody = {
      model: model,
      messages: requestData.messages || [],
      temperature: requestData.temperature || 0.7,
      max_tokens: requestData.max_tokens || 4096,
      stream: endpoint === 'deepseek' ? (requestData.stream || false) : false
    }
    
    // 转发请求
    const upstreamResponse = await fetch(provider.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: buildUpstreamHeaders(endpoint, apiKey),
      body: JSON.stringify(upstreamBody)
    })
    
    const responseTime = Date.now() - startTime
    
    // 上游失败 - 自动降级到另一供应商 (如果请求的是primary模型)
    if (!upstreamResponse.ok && endpoint === 'deepseek') {
      console.error(`Primary API error (${upstreamResponse.status}), attempting Ascend fallback`)
      const fallbackResult = await tryAscendFallback(requestData, apiKey)
      if (fallbackResult) {
        return buildSuccessResponse(fallbackResult, providerInfo, authResult, responseTime, corsHeaders)
      }
      // fallback也失败，返回原始错误
      const errorText = await upstreamResponse.text()
      console.error(`Primary API error (${upstreamResponse.status}):`, errorText)
      return errorResponse(upstreamResponse.status, `Primary provider error`, corsHeaders)
    }
    
    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text()
      console.error(`Provider API error (${upstreamResponse.status}):`, errorText)
      return errorResponse(upstreamResponse.status, `Provider error: ${upstreamResponse.status}`, corsHeaders)
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
    
    return buildSuccessResponse(responseData, providerInfo, authResult, responseTime, corsHeaders)
    
  } catch (error) {
    console.error('Chat completion error:', error)
    return errorResponse(500, `Internal server error: ${error.message}`, corsHeaders)
  }
}

// === Ascend fallback 尝试 ===
async function tryAscendFallback(requestData, originalApiKey) {
  try {
    const ascendProvider = API_PROVIDERS.ascend
    const ascendKey = CONFIG.ascendApiKey
    
    if (!ascendKey) return null
    
    // 尝试使用 Ascend 的等价模型处理请求
    const fallbackModel = 'huawei-pangu'
    
    const fallbackBody = {
      model: fallbackModel,
      messages: requestData.messages || [],
      temperature: requestData.temperature || 0.7,
      max_tokens: requestData.max_tokens || 4096,
      stream: false
    }
    
    const fallbackResponse = await fetch(ascendProvider.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: buildUpstreamHeaders('ascend', ascendKey),
      body: JSON.stringify(fallbackBody)
    })
    
    if (!fallbackResponse.ok) return null
    
    const body = await fallbackResponse.json()
    return {
      ...body,
      _fallback: {
        fromProvider: 'deepseek',
        toProvider: 'ascend',
        fromModel: requestData.model || 'deepseek-chat',
        toModel: fallbackModel,
        originalProviderGroup: 'primary'
      }
    }
  } catch(e) {
    console.error('Ascend fallback failed:', e.message)
    return null
  }
}

// === 构建上游请求头 ===
function buildUpstreamHeaders(endpoint, apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
  
  if (endpoint === 'ascend') {
    headers['X-Auth-Token'] = apiKey
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  
  return headers
}

// === 构建成功响应 ===
function buildSuccessResponse(responseData, providerInfo, authResult, responseTime, corsHeaders) {
  const inputTokens = responseData.usage?.prompt_tokens || estimateTokens(responseData.messages || [])
  const outputTokens = responseData.usage?.completion_tokens || 
                      estimateTokens(responseData.choices?.[0]?.message?.content || '')
  const totalTokens = responseData.usage?.total_tokens || (inputTokens + outputTokens)
  
  // 计算用户计费 (按模型计费)
  const modelId = responseData.model || providerInfo.model
  const modelPricing = USER_PRICING[modelId]
  const userCost = modelPricing ? 
    calculateUserCost(inputTokens, outputTokens, modelPricing) : 0
  
  // 记录日志
  console.log(JSON.stringify({
    type: 'api_usage',
    userId: authResult.userId,
    model: modelId,
    provider: providerInfo.provider,
    providerGroup: providerInfo.endpoint,
    fallback: responseData._fallback ? true : false,
    requestId: generateRequestId(),
    timestamp: new Date().toISOString(),
    responseTimeMs: responseTime,
    inputTokens,
    outputTokens,
    totalTokens,
    userCostUSD: userCost
  }))
  
  // 返回响应
  const enhancedResponse = {
    ...responseData,
    _lifeTokenHub: {
      requestId: generateRequestId(),
      provider: providerInfo.provider,
      providerGroup: providerInfo.endpoint,
      responseTimeMs: responseTime,
      userCostUSD: userCost,
      lifeFundImpact: totalTokens > 0 ? 
        `Every ${Math.ceil(totalTokens/1000)*1000} tokens = 1 grain of rice to UN WFP` : 
        null
    }
  }
  
  // 如果有fallback信息，保留 (在_fallback字段)
  if (responseData._fallback) {
    enhancedResponse._fallback = responseData._fallback
  }
  
  return new Response(JSON.stringify(enhancedResponse), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'X-Request-ID': generateRequestId(),
      'X-Provider': providerInfo.endpoint,
      'Cache-Control': 'no-store'
    }
  })
}

// === 模型列表端点 (双供应商) ===
async function handleModelsList(corsHeaders) {
  const models = []
  
  // Primary Provider 模型 (DeepSeek)
  API_PROVIDERS.deepseek.models.forEach(modelId => {
    const userCost = USER_PRICING[modelId]
    models.push({
      id: modelId,
      object: 'model',
      created: 1677610602,
      owned_by: 'deepseek',
      provider_group: 'primary',
      user_pricing: {
        input_per_1k: userCost?.input || 0,
        output_per_1k: userCost?.output || 0
      },
      status: 'available',
      description: 'DeepSeek AI model - Primary Provider',
      supports_caching: true,
      cache_hit_discount: 0.5
    })
  })
  
  // Ascend Compute Provider 模型 (Huawei)
  API_PROVIDERS.ascend.models.forEach(modelId => {
    const userCost = USER_PRICING[modelId]
    models.push({
      id: modelId,
      object: 'model',
      created: 1700000000,
      owned_by: 'huawei-ascend',
      provider_group: 'ascend',
      user_pricing: {
        input_per_1k: userCost?.input || 0,
        output_per_1k: userCost?.output || 0
      },
      status: 'available',
      description: 'Huawei Ascend Compute model - Ascend Compute Provider',
      supports_caching: false
    })
  })
  
  return new Response(JSON.stringify({ 
    object: 'list', 
    data: models,
    provider_groups: [
      { id: 'primary', name: 'Primary Provider', description: 'DeepSeek models (Primary Compute)' },
      { id: 'ascend', name: 'Ascend Compute Provider', description: 'Huawei Ascend models (Compute Pool)' }
    ]
  }), {
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
      provider_groups: ['primary', 'ascend'],
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
  
  if (!apiKey.startsWith('ltk_') || apiKey.length < 20) {
    return { valid: false, error: 'Invalid API key' }
  }
  
  const userId = extractUserIdFromKey(apiKey)
  
  return {
    valid: true,
    userId: userId,
    apiKey: apiKey,
    lifeFundEnabled: true,
    providerGroups: ['primary', 'ascend']
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
  for (const [key, provider] of Object.entries(API_PROVIDERS)) {
    if (provider.models.includes(model)) {
      return {
        provider: provider,
        endpoint: key,
        model: model,
        label: provider.label
      }
    }
  }
  return null
}

function estimateTokens(text) {
  if (typeof text === 'string') return Math.ceil(text.length / 4)
  if (Array.isArray(text)) return text.reduce((sum, msg) => sum + estimateTokens(msg.content || ''), 0)
  return 0
}

function calculateUserCost(inputTokens, outputTokens, pricing) {
  const inputCost = (inputTokens / 1000) * pricing.input
  const outputCost = (outputTokens / 1000) * pricing.output
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
