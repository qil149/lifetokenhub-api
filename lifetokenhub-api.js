// LifeTokenHub API Gateway - Cloudflare Worker v1.1 (ES Module)
// 双流量池架构：DeepSeek Primary Provider + Huawei Ascend Compute Provider
// 支持：API转发 + 双供应商路由 + 生命基金记录 + 用户认证 + 用量计费

// === 双供应商配置 ===
const API_PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-v2.5'],
    providerGroup: 'primary',
    label: 'Primary Provider',
    pricing: { input: 0.0005, output: 0.002 }
  },
  ascend: {
    baseUrl: 'https://ap-southeast-1.api.huaweicloud.com/v1/infers/cognitive-brain-compatible',
    models: ['huawei-pangu', 'huawei-pangu-lite'],
    providerGroup: 'ascend',
    label: 'Ascend Compute Provider',
    pricing: { input: 0.0004, output: 0.0015 }
  }
}

const USER_PRICE_MULTIPLIER = 1.3333

const USER_PRICING = {}
for (const [k, p] of Object.entries(API_PROVIDERS)) {
  for (const modelId of p.models) {
    USER_PRICING[modelId] = {
      input: parseFloat(((p.pricing.input * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
      output: parseFloat(((p.pricing.output * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6))
    }
  }
}
// 覆盖特殊定价的模型
USER_PRICING['deepseek-coder'] = { input: 0.001067, output: 0.004978 }
USER_PRICING['deepseek-v2.5'] = { input: 0.000889, output: 0.004267 }
USER_PRICING['huawei-pangu-lite'] = { input: 0.000356, output: 0.001778 }

// === 主入口 (ES Module) ===
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname
    const origin = request.headers.get('Origin') || ''

    const allowedOrigin = env.ALLOWED_ORIGIN === '*' ? '*' : (origin === env.ALLOWED_ORIGIN ? origin : '')
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

    if (path === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'LifeTokenHub API Gateway',
        version: '1.1',
        timestamp: new Date().toISOString(),
        providers: Object.keys(API_PROVIDERS),
        providerGroups: ['primary', 'ascend']
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    switch (true) {
      case path === '/v1/chat/completions' && request.method === 'POST':
        return await handleChatCompletion(request, env, corsHeaders)
      case path === '/v1/models' && request.method === 'GET':
        return await handleModelsList(corsHeaders)
      case path === '/v1/auth/verify' && request.method === 'POST':
        return await handleAuthVerify(request, corsHeaders)
      default:
        return new Response(JSON.stringify({
          error: 'Not found',
          available_endpoints: ['POST /v1/chat/completions', 'GET /v1/models', 'POST /v1/auth/verify', 'GET /health']
        }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
  }
}

// === 聊天完成端点 ===
async function handleChatCompletion(request, env, corsHeaders) {
  try {
    const startTime = Date.now()
    let requestData
    try { requestData = await request.json() } catch (e) { return errorResponse(400, 'Invalid JSON body', corsHeaders) }

    const authResult = await authenticateUser(request)
    if (!authResult.valid) return errorResponse(401, authResult.error || 'Authentication failed', corsHeaders)

    const model = requestData.model || 'deepseek-chat'
    const providerInfo = getProviderByModel(model)
    if (!providerInfo) return errorResponse(400, `Model "${model}" not available`, corsHeaders)
    const { provider, endpoint } = providerInfo

    const usageCheck = await checkUsageLimits(authResult.userId, model)
    if (!usageCheck.allowed) return errorResponse(429, usageCheck.reason || 'Usage limit exceeded', corsHeaders)

    const apiKey = endpoint === 'ascend' ? env.ASCEND_API_KEY : env.DEEPSEEK_API_KEY
    if (!apiKey) return errorResponse(500, `API key not configured for ${endpoint}`, corsHeaders)

    const upstreamBody = {
      model,
      messages: requestData.messages || [],
      temperature: requestData.temperature ?? 0.7,
      max_tokens: requestData.max_tokens || 4096,
      stream: endpoint === 'deepseek' ? (requestData.stream || false) : false
    }

    const upstreamResponse = await fetch(provider.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: buildUpstreamHeaders(endpoint, apiKey),
      body: JSON.stringify(upstreamBody)
    })
    const responseTime = Date.now() - startTime

    if (!upstreamResponse.ok) {
      if (endpoint === 'deepseek') {
        const fallback = await tryAscendFallback(requestData, env)
        if (fallback) return buildSuccessResponse(fallback, providerInfo, authResult, responseTime, corsHeaders)
      }
      const err = await upstreamResponse.text()
      console.error(`Provider error (${upstreamResponse.status}):`, err)
      return errorResponse(upstreamResponse.status, `Provider error: ${upstreamResponse.status}`, corsHeaders)
    }

    const bodyText = await upstreamResponse.text()
    let responseData
    try { responseData = JSON.parse(bodyText) } catch (e) {
      return new Response(bodyText, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    return buildSuccessResponse(responseData, providerInfo, authResult, responseTime, corsHeaders)
  } catch (error) {
    console.error('Chat completion error:', error)
    return errorResponse(500, `Internal error: ${error.message}`, corsHeaders)
  }
}

async function tryAscendFallback(requestData, env) {
  try {
    const key = env.ASCEND_API_KEY
    if (!key) return null
    const res = await fetch(API_PROVIDERS.ascend.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: buildUpstreamHeaders('ascend', key),
      body: JSON.stringify({
        model: 'huawei-pangu',
        messages: requestData.messages || [],
        temperature: requestData.temperature ?? 0.7,
        max_tokens: requestData.max_tokens || 4096,
        stream: false
      })
    })
    if (!res.ok) return null
    const body = await res.json()
    return { ...body, _fallback: { fromProvider: 'deepseek', toProvider: 'ascend', fromModel: requestData.model || 'deepseek-chat', toModel: 'huawei-pangu' } }
  } catch (e) { return null }
}

async function handleModelsList(corsHeaders) {
  const data = []
  for (const [key, p] of Object.entries(API_PROVIDERS)) {
    for (const id of p.models) {
      const uc = USER_PRICING[id]
      data.push({
        id, object: 'model',
        owned_by: key === 'deepseek' ? 'deepseek' : 'huawei-ascend',
        provider_group: p.providerGroup,
        user_pricing: uc ? { input_per_1k: uc.input, output_per_1k: uc.output } : { input_per_1k: 0, output_per_1k: 0 },
        status: 'available',
        description: p.label
      })
    }
  }
  return new Response(JSON.stringify({ object: 'list', data, provider_groups: [
    { id: 'primary', name: 'Primary Provider', description: 'DeepSeek' },
    { id: 'ascend', name: 'Ascend Compute Provider', description: 'Huawei Ascend' }
  ]}), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

async function handleAuthVerify(request, corsHeaders) {
  try {
    let body
    try { body = await request.json() } catch (e) { return errorResponse(400, 'Invalid JSON', corsHeaders) }
    const { apiKey } = body || {}
    if (!apiKey || !apiKey.startsWith('ltk_')) return errorResponse(401, 'Invalid API key format', corsHeaders)
    const isValid = apiKey.length >= 20
    const userId = isValid ? extractUserIdFromKey(apiKey) : null
    return new Response(JSON.stringify({
      valid: isValid, userId, permissions: isValid ? ['chat', 'models'] : [],
      provider_groups: ['primary', 'ascend'], life_fund_enabled: true,
      rate_limit: { daily_requests: 1000, daily_tokens: 10000000, remaining_today: 1000 }
    }), { status: isValid ? 200 : 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (e) { return errorResponse(400, 'Invalid request', corsHeaders) }
}

async function authenticateUser(request) {
  const h = request.headers.get('Authorization')
  if (!h || !h.startsWith('Bearer ')) return { valid: false, error: 'Missing Authorization header' }
  const key = h.replace('Bearer ', '').trim()
  if (!key.startsWith('ltk_') || key.length < 20) return { valid: false, error: 'Invalid API key' }
  return { valid: true, userId: extractUserIdFromKey(key), apiKey: key, lifeFundEnabled: true, providerGroups: ['primary', 'ascend'] }
}

function extractUserIdFromKey(apiKey) {
  const p = apiKey.split('_'); return p.length >= 3 ? p[2] : 'anonymous'
}

async function checkUsageLimits(userId, model) {
  return { allowed: true, reason: null, limits: { dailyRequests: 1000, dailyTokens: 10000000, remainingRequests: 999, remainingTokens: 9999999 } }
}

function getProviderByModel(model) {
  for (const [key, p] of Object.entries(API_PROVIDERS)) {
    if (p.models.includes(model)) return { provider: p, endpoint: key, model, label: p.label }
  }
  return null
}

function buildUpstreamHeaders(endpoint, apiKey) {
  return endpoint === 'ascend'
    ? { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Auth-Token': apiKey }
    : { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${apiKey}` }
}

function buildSuccessResponse(data, providerInfo, authResult, responseTime, corsHeaders) {
  const inputTokens = data.usage?.prompt_tokens || estimateTokens(data.messages || [])
  const outputTokens = data.usage?.completion_tokens || estimateTokens(data.choices?.[0]?.message?.content || '')
  const totalTokens = data.usage?.total_tokens || (inputTokens + outputTokens)
  const modelId = data.model || providerInfo.model
  const uc = USER_PRICING[modelId]
  const userCost = uc ? calculateUserCost(inputTokens, outputTokens, uc) : 0

  console.log(JSON.stringify({ type: 'api_usage', userId: authResult.userId, model: modelId, provider: providerInfo.endpoint, requestId: generateRequestId(), timestamp: new Date().toISOString(), responseTimeMs: responseTime, inputTokens, outputTokens, totalTokens, userCostUSD: userCost }))

  const enhanced = { ...data, _lifeTokenHub: { requestId: generateRequestId(), provider: providerInfo.endpoint, providerGroup: providerInfo.provider.providerGroup, responseTimeMs: responseTime, userCostUSD: userCost, lifeFundImpact: totalTokens > 0 ? `Every ${Math.ceil(totalTokens / 1000) * 1000} tokens = 1 grain of rice to UN WFP` : null } }
  if (data._fallback) enhanced._fallback = data._fallback

  return new Response(JSON.stringify(enhanced), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Request-ID': generateRequestId(), 'X-Provider': providerInfo.endpoint, 'Cache-Control': 'no-store' }
  })
}

function estimateTokens(text) {
  if (typeof text === 'string') return Math.ceil(text.length / 4)
  if (Array.isArray(text)) return text.reduce((s, m) => s + estimateTokens(m.content || ''), 0)
  return 0
}

function calculateUserCost(inputTokens, outputTokens, pricing) {
  return parseFloat(((inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output).toFixed(6))
}

function generateRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

function errorResponse(status, message, corsHeaders) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code: status.toString() } }), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}
