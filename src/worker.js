// LifeTokenHub API Gateway - Cloudflare Worker v1.2 (ES Module)
// 双流量池架构：DeepSeek Primary Provider + Huawei Ascend Compute Provider
// 支持：API转发 + 双供应商路由 + 敏感内容过滤 + 用户注册/登录 + 用量计费
//
// 部署方式：粘贴到 Cloudflare Dashboard → Workers & Pages → api.lifetokenhub.com
// 需要设置的环境变量（Dashboard → Settings → Variables）：
//   DEEPSEEK_API_KEY  — 必填，DeepSeek API Key（有余额）
//   ASCEND_API_KEY    — 可选，华为 Ascend API Key
//   ADMIN_API_KEY     — 可选，后台管理 Key（用于手动充值等）
//   ALLOWED_ORIGIN    — 可选，CORS 允许的域名，默认 *
// 注意：无需 KV 也能工作，但不记账。想记作用量需创建 KV namespace 并绑定到 LIFETOKEN_KV

import { API_PROVIDERS, USER_PRICING, checkSensitiveContent, getExchangeRate, calculateUserCost } from './providers.js'
import { errorResponse, estimateTokens, generateRequestId, extractUserIdFromKey } from './utils.js'

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
        version: '1.2',
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
      case path === '/v1/balance' && request.method === 'GET':
        return await handleBalance(request, env, corsHeaders)
      case path === '/v1/admin/credits' && request.method === 'POST':
        return await handleAdminCredits(request, env, corsHeaders)
      case path === '/v1/auth/register' && request.method === 'POST':
        return await handleRegister(request, env, corsHeaders)
      case path === '/v1/auth/login' && request.method === 'POST':
        return await handleLogin(request, env, corsHeaders)
      case path === '/webhook/paddle' && request.method === 'POST':
        return await handlePaddleWebhook(request, env, corsHeaders)
      default:
        return new Response(JSON.stringify({
          error: 'Not found',
          available_endpoints: ['POST /v1/chat/completions', 'GET /v1/models', 'POST /v1/auth/verify', 'POST /v1/auth/register', 'POST /v1/auth/login', 'GET /v1/balance', 'POST /v1/admin/credits', 'GET /health']
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

    const authResult = await authenticateUser(request, env)
    if (!authResult.valid) return errorResponse(401, authResult.error || 'Authentication failed', corsHeaders)

    const model = requestData.model || 'deepseek-v4-flash'
    const providerInfo = getProviderByModel(model)
    if (!providerInfo) return errorResponse(400, `Model "${model}" not available`, corsHeaders)
    const { provider, endpoint } = providerInfo

    // 敏感内容过滤
    const blockResult = checkSensitiveContent(requestData?.messages)
    if (blockResult) {
      return new Response(JSON.stringify({
        error: { message: blockResult.reason, type: 'content_policy_violation', code: '400' }
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const usageCheck = await checkUsageLimits(authResult.userId, model, env)
    if (!usageCheck.allowed) return errorResponse(402, usageCheck.reason || 'Insufficient balance', corsHeaders)

    const dailyCheck = await checkDailyUsage(authResult.userId, env)
    if (!dailyCheck.allowed) return errorResponse(429, dailyCheck.reason || 'Daily limit exceeded', corsHeaders)

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
        if (fallback) {
          const fModel = fallback.model || 'huawei-pangu'
          const fInput = fallback.usage?.prompt_tokens || estimateTokens(fallback.messages || [])
          const fOutput = fallback.usage?.completion_tokens || estimateTokens(fallback.choices?.[0]?.message?.content || '')
          const fTotal = fallback.usage?.total_tokens || (fInput + fOutput)
          const fPricing = USER_PRICING[fModel]
          const fCost = fPricing ? calculateUserCost(fInput, fOutput, fPricing) : 0
          const [fBalance, fRate] = await Promise.all([
            deductBalance(authResult.userId, fCost, env),
            getExchangeRate()
          ])
          await recordUsage(authResult.userId, fTotal, env)
          return buildSuccessResponse(fallback, providerInfo, authResult, responseTime, corsHeaders, fCost, fBalance, fRate, fTotal, fInput, fOutput)
        }
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
    const inputTokens = responseData.usage?.prompt_tokens || estimateTokens(requestData.messages || [])
    const outputTokens = responseData.usage?.completion_tokens || estimateTokens(responseData.choices?.[0]?.message?.content || '')
    const totalTokens = responseData.usage?.total_tokens || (inputTokens + outputTokens)
    const cacheHitTokens = responseData.usage?.prompt_cache_hit_tokens || 0
    const uc = USER_PRICING[model]
    const costCNY = uc ? calculateUserCost(inputTokens, outputTokens, uc, cacheHitTokens) : 0
    const [newBalance, exchangeRate] = await Promise.all([
      deductBalance(authResult.userId, costCNY, env),
      getExchangeRate()
    ])
    await recordUsage(authResult.userId, totalTokens, env)
    return buildSuccessResponse(responseData, providerInfo, authResult, responseTime, corsHeaders, costCNY, newBalance, exchangeRate, totalTokens, inputTokens, outputTokens)
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
    return { ...body, _fallback: { fromProvider: 'deepseek', toProvider: 'ascend', fromModel: requestData.model || 'deepseek-v4-flash', toModel: 'huawei-pangu' } }
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
        user_pricing: uc ? { input_per_million: uc.input, output_per_million: uc.output, currency: 'CNY' } : { input_per_million: 0, output_per_million: 0, currency: 'CNY' },
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

async function handleBalance(request, env, corsHeaders) {
  const authResult = await authenticateUser(request, env)
  if (!authResult.valid) return errorResponse(401, authResult.error || 'Authentication failed', corsHeaders)
  const userId = authResult.userId
  const [balance, rate] = await Promise.all([getBalance(userId, env), getExchangeRate()])
  const rateCNY = rate.cny || 7.2
  const rateEUR = rate.eur || 0.92
  return new Response(JSON.stringify({
    userId,
    balance_cny: balance,
    balance_cny_display: '¥' + balance.toFixed(2),
    balance_usd: parseFloat((balance / rateCNY).toFixed(4)),
    balance_usd_display: '$' + (balance / rateCNY).toFixed(2),
    balance_eur: parseFloat((balance / rateCNY * rateEUR).toFixed(4)),
    balance_eur_display: '€' + (balance / rateCNY * rateEUR).toFixed(2),
    exchange_rate: { usdToCny: rateCNY, usdToEur: rateEUR, source: 'er-api.com', updatedAt: rate.updatedAt || new Date(0).toISOString() }
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

async function handleAdminCredits(request, env, corsHeaders) {
  const adminKey = request.headers.get('X-Admin-Key')
  if (!adminKey || adminKey !== env.ADMIN_API_KEY) return errorResponse(403, 'Forbidden', corsHeaders)
  let body
  try { body = await request.json() } catch (e) { return errorResponse(400, 'Invalid JSON', corsHeaders) }
  const { userId, amount } = body || {}
  if (!userId || typeof amount !== 'number' || amount <= 0) return errorResponse(400, 'userId and positive amount required', corsHeaders)
  const kv = env.LIFETOKEN_KV
  if (!kv) return errorResponse(500, 'KV storage not configured', corsHeaders)
  const key = `balance:${userId}`
  const raw = await kv.get(key)
  const previousBalance = raw ? parseFloat(raw) : 0
  const newBalance = parseFloat((previousBalance + amount).toFixed(6))
  await kv.put(key, newBalance.toFixed(6))
  return new Response(JSON.stringify({
    userId, previousBalance, addedAmount: amount, newBalance, currency: 'CNY'
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// === 注册 ===
async function handleRegister(request, env, corsHeaders) {
  let body
  try { body = await request.json() } catch (e) { return errorResponse(400, 'Invalid JSON', corsHeaders) }
  const { email, password } = body || {}
  if (!email || !password) return errorResponse(400, 'Email and password required', corsHeaders)
  if (password.length < 6) return errorResponse(400, 'Password must be at least 6 characters', corsHeaders)

  const kv = env.LIFETOKEN_KV
  if (!kv) return errorResponse(500, 'KV storage not configured', corsHeaders)

  const userKey = `user:${email.toLowerCase()}`
  const existing = await kv.get(userKey)
  if (existing) return errorResponse(409, 'Email already registered', corsHeaders)

  const userId = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')
  const passwordHash = await pbkdf2Hash(password, salt)
  const apiKey = 'ltk_v1_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  const userData = { userId, email: email.toLowerCase(), passwordHash, salt, apiKey, createdAt: new Date().toISOString() }
  await kv.put(userKey, JSON.stringify(userData))
  await kv.put(`api_key:${apiKey}`, JSON.stringify({ userId, email: email.toLowerCase() }))
  await kv.put(`balance:${userId}`, '0.000000')

  return new Response(JSON.stringify({ success: true, userId, apiKey, balance: 0 }), {
    status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// === 登录 ===
async function handleLogin(request, env, corsHeaders) {
  let body
  try { body = await request.json() } catch (e) { return errorResponse(400, 'Invalid JSON', corsHeaders) }
  const { email, password } = body || {}
  if (!email || !password) return errorResponse(400, 'Email and password required', corsHeaders)

  const kv = env.LIFETOKEN_KV
  if (!kv) return errorResponse(500, 'KV storage not configured', corsHeaders)

  const raw = await kv.get(`user:${email.toLowerCase()}`)
  if (!raw) return errorResponse(401, 'Invalid email or password', corsHeaders)

  const userData = JSON.parse(raw)
  const hash = await pbkdf2Hash(password, userData.salt)
  if (hash !== userData.passwordHash) return errorResponse(401, 'Invalid email or password', corsHeaders)

  return new Response(JSON.stringify({ success: true, userId: userData.userId, apiKey: userData.apiKey, balance: 0 }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// PBKDF2 密码哈希（Web Crypto API，Cloudflare Workers 原生支持）
async function pbkdf2Hash(password, salt) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  )
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
}

async function authenticateUser(request, env) {
  const h = request.headers.get('Authorization')
  if (!h || !h.startsWith('Bearer ')) return { valid: false, error: 'Missing Authorization header' }
  const key = h.replace('Bearer ', '').trim()
  if (!key.startsWith('ltk_') || key.length < 20) return { valid: false, error: 'Invalid API key' }

  const kv = env?.LIFETOKEN_KV
  if (!kv) return { valid: false, error: 'Service unavailable: KV storage not configured' }

  try {
    const raw = await kv.get(`api_key:${key}`)
    if (!raw) return { valid: false, error: 'Invalid API key' }
    const keyData = JSON.parse(raw)
    return { valid: true, userId: keyData.userId, apiKey: key, lifeFundEnabled: true, providerGroups: ['primary', 'ascend'] }
  } catch (e) {
    return { valid: false, error: 'Service unavailable: KV storage error' }
  }
}

async function checkUsageLimits(userId, model, env) {
  const kv = env?.LIFETOKEN_KV
  if (!kv) return { allowed: false, reason: 'KV storage not configured' }
  const balance = await getBalance(userId, env)
  const pricing = USER_PRICING[model]
  if (!pricing) return { allowed: false, reason: `Unknown model: ${model}` }
  const minCost = (100 / 1000000) * pricing.input + (100 / 1000000) * pricing.output
  if (balance < minCost) {
    return { allowed: false, reason: `余额不足，需要至少 ¥${minCost.toFixed(4)}，当前余额 ¥${balance.toFixed(2)}` }
  }
  return { allowed: true, balance }
}

async function checkDailyUsage(userId, env) {
  const kv = env.LIFETOKEN_KV
  if (!kv) return { allowed: true }
  const today = new Date().toISOString().split('T')[0]
  const key = `usage:${userId}:${today}`
  let usage = { requests: 0, tokens: 0 }
  try {
    const raw = await kv.get(key)
    if (raw) usage = JSON.parse(raw)
  } catch (e) { /* fallback to defaults */ }
  const limits = { dailyRequests: 1000, dailyTokens: 200000000 }
  if (usage.requests >= limits.dailyRequests) return { allowed: false, reason: 'Daily request limit exceeded' }
  if (usage.tokens >= limits.dailyTokens) return { allowed: false, reason: 'Daily token limit exceeded' }
  return { allowed: true, remainingRequests: limits.dailyRequests - usage.requests, remainingTokens: limits.dailyTokens - usage.tokens }
}

async function deductBalance(userId, costCNY, env) {
  const kv = env?.LIFETOKEN_KV
  if (!kv || costCNY <= 0) return 0
  const key = `balance:${userId}`
  try {
    const raw = await kv.get(key)
    const balance = raw ? parseFloat(raw) : 0
    if (costCNY > balance) {
      await kv.put(key, '0')
      return 0
    }
    const newBalance = parseFloat((balance - costCNY).toFixed(6))
    await kv.put(key, newBalance.toFixed(6))
    return newBalance
  } catch (e) { return 0 }
}

async function recordUsage(userId, tokens, env) {
  const kv = env.LIFETOKEN_KV
  if (!kv) return
  const today = new Date().toISOString().split('T')[0]
  const key = `usage:${userId}:${today}`
  try {
    const raw = await kv.get(key)
    const usage = raw ? JSON.parse(raw) : { requests: 0, tokens: 0 }
    usage.requests += 1
    usage.tokens += (tokens || 0)
    await kv.put(key, JSON.stringify(usage), { expirationTtl: 86400 })
  } catch (e) { /* best-effort */ }
}

async function getBalance(userId, env) {
  const kv = env.LIFETOKEN_KV
  if (!kv) return 0
  try {
    const raw = await kv.get(`balance:${userId}`)
    return raw ? parseFloat(raw) : 0
  } catch (e) { return 0 }
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

function buildSuccessResponse(data, providerInfo, authResult, responseTime, corsHeaders, costCNY, newBalance, exchangeRate, totalTokens, inputTokens, outputTokens) {
  const modelId = data.model || providerInfo.model
  const rateCNY = exchangeRate?.cny || 7.2
  const rateEUR = exchangeRate?.eur || 0.92
  const costUSD = parseFloat((costCNY / rateCNY).toFixed(6))
  const balanceUSD = parseFloat((newBalance / rateCNY).toFixed(4))
  const costEUR = parseFloat((costCNY / rateCNY * rateEUR).toFixed(6))
  const balanceEUR = parseFloat((newBalance / rateCNY * rateEUR).toFixed(4))

  console.log(JSON.stringify({ type: 'api_usage', userId: authResult.userId, model: modelId, provider: providerInfo.endpoint, requestId: generateRequestId(), timestamp: new Date().toISOString(), responseTimeMs: responseTime, inputTokens, outputTokens, totalTokens, costCNY, newBalanceCNY: newBalance, exchangeRate }))

  const enhanced = { ...data, _lifeTokenHub: {
    requestId: generateRequestId(),
    provider: providerInfo.endpoint,
    providerGroup: providerInfo.provider.providerGroup,
    responseTimeMs: responseTime,
    cost: { cny: costCNY, usd: costUSD, eur: costEUR, cny_display: costCNY < 0.01 ? '<¥0.01' : '¥' + costCNY.toFixed(2), usd_display: costUSD < 0.01 ? '<$0.01' : '$' + costUSD.toFixed(2) },
    balance: { cny: newBalance, usd: balanceUSD, eur: balanceEUR, cny_display: '¥' + newBalance.toFixed(2), usd_display: '$' + balanceUSD.toFixed(2), eur_display: '€' + balanceEUR.toFixed(2) },
    exchangeRate: exchangeRate || null,
    lifeFundImpact: totalTokens > 0 ? `每 ${Math.ceil(totalTokens / 1000) * 1000} tokens = 向 UN WFP 捐赠 1 粒米` : null
  }}
  if (data._fallback) enhanced._fallback = data._fallback

  return new Response(JSON.stringify(enhanced), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Request-ID': generateRequestId(), 'X-Provider': providerInfo.endpoint, 'Cache-Control': 'no-store' }
  })
}

// ================================================================
//  Paddle Webhook 处理
// ================================================================

async function handlePaddleWebhook(request, env, corsHeaders) {
  try {
    // 1. 获取原始 body（签名验证需要原始字符串）
    const rawBody = await request.text()

    // 2. 验证 Paddle-Signature
    const signatureHeader = request.headers.get('Paddle-Signature')
    if (!signatureHeader) {
      return errorResponse(401, 'Missing Paddle-Signature header', corsHeaders)
    }

    // 解析 ts=...;h1=...
    const parts = {}
    for (const p of signatureHeader.split(';')) {
      const eqIdx = p.indexOf('=')
      if (eqIdx > 0) parts[p.slice(0, eqIdx)] = p.slice(eqIdx + 1)
    }
    if (!parts.ts || !parts.h1) {
      return errorResponse(401, 'Invalid Paddle-Signature format', corsHeaders)
    }

    // 防重放攻击：5 分钟窗口
    const timestamp = parseInt(parts.ts, 10)
    if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) {
      return errorResponse(401, 'Paddle signature timestamp expired', corsHeaders)
    }

    // Ed25519 签名验证
    const secret = env.PADDLE_WEBHOOK_SECRET
    if (!secret) {
      return errorResponse(500, 'PADDLE_WEBHOOK_SECRET not configured', corsHeaders)
    }

    const signedContent = `${parts.ts}.${rawBody}`
    const signatureBytes = base64Decode(parts.h1)
    const publicKeyBytes = base64Decode(secret)

    const publicKey = await crypto.subtle.importKey(
      'raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']
    )

    const isValid = await crypto.subtle.verify(
      { name: 'Ed25519' }, publicKey, signatureBytes,
      new TextEncoder().encode(signedContent)
    )
    if (!isValid) {
      return errorResponse(401, 'Invalid Paddle webhook signature', corsHeaders)
    }

    // 3. 解析 payload
    const payload = JSON.parse(rawBody)
    const notification = payload.notification || payload
    const eventType = notification.event_type
    const data = notification.data || {}

    console.log(`Paddle webhook received: ${eventType} (txn: ${data.id || 'unknown'})`)

    // 4. 路由事件
    switch (eventType) {
      case 'transaction.completed':
      case 'transaction.paid':
        return await handleTransactionPaid(data, env, corsHeaders)
      case 'transaction.cancelled':
      case 'transaction.expired':
      case 'transaction.voided':
        console.log(`Paddle transaction ${eventType}: ${data.id}`)
        return new Response(JSON.stringify({ received: true, event: eventType }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      default:
        // 其他事件（如 subscription.*）记录日志但返回 200
        console.log(`Paddle unhandled event type: ${eventType}`)
        return new Response(JSON.stringify({ received: true, event: eventType }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
    }
  } catch (error) {
    console.error('Paddle webhook error:', error.message, error.stack)
    return errorResponse(500, `Paddle webhook internal error`, corsHeaders)
  }
}

// === 处理 transaction.completed/paid ===
async function handleTransactionPaid(data, env, corsHeaders) {
  const kv = env.LIFETOKEN_KV
  if (!kv) return errorResponse(500, 'KV storage not configured', corsHeaders)

  // 提取客户 email
  const email = data.customer?.email
  if (!email) {
    console.error('Paddle: missing customer email in transaction data')
    return new Response(JSON.stringify({ received: true, warning: 'Missing customer email' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // 通过 email 查找用户
  const userKey = `user:${email.toLowerCase()}`
  const userRaw = await kv.get(userKey)
  if (!userRaw) {
    console.error(`Paddle: user not found for email: ${email}`)
    return new Response(JSON.stringify({ received: true, warning: 'User not found' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  const userData = JSON.parse(userRaw)
  const userId = userData.userId

  // 提取金额（Paddle Billing API 金额单位为分）
  let amountInCents = 0
  const details = data.details
  if (details?.line_items) {
    for (const item of details.line_items) {
      amountInCents += parseInt(item.total || '0', 10) + parseInt(item.tax || '0', 10)
    }
  } else if (data.amount) {
    amountInCents = parseInt(String(data.amount), 10)
  }

  if (amountInCents <= 0) {
    console.error(`Paddle: invalid amount (${amountInCents} cents) for txn ${data.id}`)
    return new Response(JSON.stringify({ received: true, warning: 'Invalid amount' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // 货币单位转换
  const currencyCode = (data.currency_code || 'USD').toUpperCase()
  let amountInUnit = amountInCents / 100

  // 非 CNY 货币按汇率换算
  if (currencyCode !== 'CNY') {
    const rate = await getExchangeRate()
    const usdToCny = rate.cny || 7.2
    if (currencyCode === 'USD') {
      amountInUnit = parseFloat((amountInUnit * usdToCny).toFixed(4))
    } else {
      // 其他货币：先转 USD（近似），再转 CNY
      const usdRate = rate[currencyCode.toLowerCase()] || 1
      amountInUnit = parseFloat(((amountInUnit / usdRate) * usdToCny).toFixed(4))
    }
  }

  // 写入余额
  const balanceKey = `balance:${userId}`
  const prevRaw = await kv.get(balanceKey)
  const previousBalance = prevRaw ? parseFloat(prevRaw) : 0
  const newBalance = parseFloat((previousBalance + amountInUnit).toFixed(6))
  await kv.put(balanceKey, newBalance.toFixed(6))

  // 记录交易流水
  const txnKey = `paddle_txn:${data.id}`
  await kv.put(txnKey, JSON.stringify({
    transactionId: data.id,
    userId,
    email: email.toLowerCase(),
    amount: amountInUnit,
    currency: currencyCode,
    originalCents: amountInCents,
    previousBalance,
    newBalance,
    processedAt: new Date().toISOString(),
    eventType: 'transaction.completed'
  }))

  console.log(`Paddle: credited ¥${amountInUnit} to user ${userId} (${email}), balance: ${previousBalance} → ${newBalance}`)

  return new Response(JSON.stringify({
    received: true,
    event: 'transaction.completed',
    userId,
    credited: amountInUnit,
    currency: 'CNY',
    newBalance
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// === Base64 解码（返回 Uint8Array）===
function base64Decode(str) {
  const binStr = atob(str)
  const bytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i)
  return bytes
}
