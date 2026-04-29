/**
 * LifeTokenHub API Gateway v2.0
 * ==============================
 * 云原生 API 网关 — 双供应商路由 + KV Key 管理 + Paddle Webhook
 *
 * 功能:
 *   - OpenAI 兼容 API 代理（DeepSeek 主力 + 华为 Ascend 备用）
 *   - 自动故障转移（DeepSeek 失败 → Ascend 容灾）
 *   - KV 存储的 API Key 管理（生成/验证/用量扣减）
 *   - Paddle 支付 Webhook（支付确认 → 自动发 Key）
 *   - 生命基金利润记录
 *   - 流式 SSE 支持
 *
 * 路由:
 *   POST /v1/chat/completions   — API 代理（Bearer auth）
 *   GET  /v1/models             — 模型列表
 *   POST /webhook/paddle        — Paddle 支付回调
 *   POST /v1/auth/verify        — 验证 API Key
 *   GET  /v1/keys               — 当前 Key 信息（Bearer auth）
 *   POST /v1/keys               — 创建 Key（Admin-Key auth）
 *   GET  /v1/admin/stats        — 管理统计
 *   GET  /health                — 健康检查
 */

// ============================================================
// 双供应商配置
// ============================================================
const API_PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner', 'deepseek-v4-flash'],
    providerGroup: 'primary',
    label: 'DeepSeek Primary',
    // 上游成本（USD/1K tokens）
    pricing: { input: 0.000139, output: 0.000278 },
    authType: 'bearer',
  },
  ascend: {
    baseUrl: 'https://ap-southeast-1.api.huaweicloud.com/v1/infers/cognitive-brain-compatible',
    models: ['huawei-pangu', 'huawei-pangu-lite'],
    providerGroup: 'ascend',
    label: 'Ascend Compute',
    pricing: { input: 0.0004, output: 0.0015 },
    authType: 'header',
    authHeader: 'X-Auth-Token',
  },
};

// 零售加价系数
const USER_PRICE_MULTIPLIER = 1.3333;

// 自动计算定价
const USER_PRICING = {};
for (const [key, p] of Object.entries(API_PROVIDERS)) {
  for (const modelId of p.models) {
    USER_PRICING[modelId] = {
      input: parseFloat(((p.pricing.input * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
      output: parseFloat(((p.pricing.output * 1000000 / 1000) * USER_PRICE_MULTIPLIER).toFixed(6)),
    };
  }
}
// V4 系列手动定价（含 1.3333 加价，USD/1K tokens）
USER_PRICING['deepseek-v4-flash'] = { input: 0.000185, output: 0.000371 };
USER_PRICING['deepseek-v4-flash-cache'] = { input: 0.0000375, output: 0.000371 };
USER_PRICING['deepseek-chat'] = { input: 0.000185, output: 0.000371 };
USER_PRICING['deepseek-coder'] = { input: 0.000185, output: 0.000371 };
USER_PRICING['deepseek-reasoner'] = { input: 0.000741, output: 0.002967 };
USER_PRICING['huawei-pangu'] = { input: 0.000356, output: 0.001778 };
USER_PRICING['huawei-pangu-lite'] = { input: 0.000356, output: 0.001778 };

// Sensitive content filter — protects upstream API keys from being banned
const BLOCKED_PATTERNS = [
  // Level 1: CSAM / child exploitation (absolute must-block)
  /child.*sexual|未成年.*(?:色情|性)|儿童.*(?:色情|性)|csam|cocsa/i,
  // Level 2: Illegal activities that could get API key banned
  /制作.*(?:毒品|炸弹|炸药)|(?:毒品|炸弹|炸药).*制作|制毒|黑客.*攻击|攻击.*服务器|钓鱼.*网站/i,
  // Level 3: Self-harm
  /自杀.*(?:方法|教程|步骤|方式)|怎么.*自杀|如何.*自杀|自残.*方法/i,
];

function checkSensitiveContent(messages) {
  if (!messages || !Array.isArray(messages)) return null;
  for (const msg of messages) {
    if (!msg.content || typeof msg.content !== "string") continue;
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(msg.content)) {
        return { blocked: true, reason: "Request blocked: content violates usage policy" };
      }
    }
  }
  return null;
}

// ============================================================
// 路由表
// ============================================================
const ROUTES = [
  ['GET',  '/health',              handleHealth],
  ['GET',  '/v1/models',           handleModels],
  ['POST', '/v1/chat/completions', handleChatCompletion],
  ['POST', '/v1/auth/verify',      handleAuthVerify],
  ['GET',  '/v1/keys',             handleGetKeyInfo],
  ['POST', '/v1/keys',             handleAdminCreateKey],
  ['GET',  '/v1/admin/stats',      handleAdminStats],
  ['POST', '/webhook/paddle',      handlePaddleWebhook],
];

// ============================================================
// 入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request),
      });
    }

    // 路由匹配
    for (const [m, path, handler] of ROUTES) {
      if (method !== m) continue;
      if (!matchPath(path, url.pathname)) continue;

      try {
        const result = await handler(request, env, ctx);
        return ensureCors(result, request);
      } catch (err) {
        return jsonError(500, `Internal error: ${err.message}`, request);
      }
    }

    return jsonError(404, 'Not found', request);
  },
};

// ============================================================
// 工具函数
// ============================================================

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin') || 'https://lifetokenhub.com';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'Access-Control-Max-Age': '86400',
  };
}

function ensureCors(response, request) {
  if (!response.headers.has('Access-Control-Allow-Origin')) {
    const h = new Headers(response.headers);
    for (const [k, v] of Object.entries(buildCorsHeaders(request))) {
      h.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: h,
    });
  }
  return response;
}

function matchPath(pattern, actual) {
  return pattern === actual;
}

function jsonError(status, message, request) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code: status.toString() } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(request || { headers: new Map() }) },
  });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function generateApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'ltk_';
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

function extractBearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function requireAdminKey(request, env) {
  const key = request.headers.get('x-api-key') || '';
  return key && key === env.ADMIN_API_KEY;
}

function generateRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
}

// ============================================================
// 1. 健康检查
// ============================================================
async function handleHealth(request, env) {
  return new Response(JSON.stringify({
    status: 'healthy',
    service: 'LifeTokenHub API Gateway',
    version: '2.0',
    timestamp: new Date().toISOString(),
    providers: Object.keys(API_PROVIDERS),
    providerGroups: ['primary', 'ascend'],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// 2. 模型列表
// ============================================================
async function handleModels(request, env) {
  const data = [];
  for (const [key, p] of Object.entries(API_PROVIDERS)) {
    for (const id of p.models) {
      const uc = USER_PRICING[id];
      data.push({
        id, object: 'model',
        owned_by: key === 'deepseek' ? 'deepseek' : 'huawei-ascend',
        provider_group: p.providerGroup,
        user_pricing: uc ? { input_per_1k: uc.input, output_per_1k: uc.output } : null,
        status: 'available',
      });
    }
  }
  return new Response(JSON.stringify({
    object: 'list', data,
    provider_groups: [
      { id: 'primary', name: 'DeepSeek Primary' },
      { id: 'ascend', name: 'Ascend Compute' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// 3. API 认证
// ============================================================
async function handleAuthVerify(request, env) {
  const body = await readJson(request);
  const apiKey = body?.apiKey || extractBearerToken(request);
  if (!apiKey || !apiKey.startsWith('ltk_')) {
    return new Response(JSON.stringify({ valid: false, error: 'Invalid API key format' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // 查 KV 验证
  const keyData = await env.API_KEYS.get(apiKey, 'json');
  const valid = !!keyData && keyData.status === 'active';

  return new Response(JSON.stringify({
    valid,
    userId: keyData?.userId || null,
    balance: keyData?.balance || 0,
    quota: keyData?.quota || 0,
    quotaUsed: keyData?.quotaUsed || 0,
    permissions: valid ? ['chat', 'models'] : [],
    provider_groups: ['primary', 'ascend'],
    life_fund_enabled: true,
  }), { status: valid ? 200 : 401, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// 4. 获取 Key 信息
// ============================================================
async function handleGetKeyInfo(request, env, ctx) {
  const token = extractBearerToken(request);
  if (!token) return jsonError(401, 'Missing Authorization header', request);

  const keyData = await env.API_KEYS.get(token, 'json');
  if (!keyData) return jsonError(401, 'Invalid API key', request);

  ctx.waitUntil(
    env.API_KEYS.put(token, JSON.stringify({ ...keyData, lastUsed: Date.now() }))
  );

  return new Response(JSON.stringify({
    object: 'api_key',
    key: token.slice(0, 8) + '...',
    ...keyData,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// 5. 管理员创建 Key
// ============================================================
async function handleAdminCreateKey(request, env) {
  if (!requireAdminKey(request, env)) {
    return jsonError(403, 'Forbidden: invalid admin key', request);
  }

  const body = await readJson(request);
  if (!body?.userId) return jsonError(400, 'Missing userId', request);

  const apiKey = generateApiKey();
  const now = Date.now();
  const keyData = {
    userId: body.userId,
    name: body.name || 'Default',
    balance: body.balance || 0,
    quota: body.quota || 100000,
    quotaUsed: 0,
    status: 'active',
    created: now,
    lastUsed: null,
    plan: body.plan || 'pay-as-you-go',
    email: body.email || '',
  };

  await env.API_KEYS.put(apiKey, JSON.stringify(keyData));

  return new Response(JSON.stringify({
    object: 'api_key', id: apiKey, ...keyData,
  }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// 6. Paddle Webhook
// ============================================================
async function handlePaddleWebhook(request, env) {
  const contentType = request.headers.get('Content-Type') || '';
  let payload;

  if (contentType.includes('application/json')) {
    payload = await readJson(request);
  } else {
    const formData = await request.formData();
    payload = {};
    for (const [key, val] of formData.entries()) {
      try { payload[key] = JSON.parse(val); } catch { payload[key] = val; }
    }
  }

  if (!payload?.alert_name) return jsonError(400, 'Invalid webhook payload', request);

  const alertName = payload.alert_name;

  if (alertName !== 'payment_succeeded') {
    return new Response(JSON.stringify({ status: 'ignored', alert: alertName }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const {
    order_id: orderId,
    customer_email: email,
    total: totalUsd,
    currency,
    product_id: productId,
    passthrough: passthroughStr,
  } = payload;

  let passthrough = {};
  if (passthroughStr) { try { passthrough = JSON.parse(passthroughStr); } catch {} }

  const userId = passthrough.userId || `user_${Date.now()}`;
  const amount = parseFloat(totalUsd) || 0;
  const bonusRate = amount >= 50 ? 0.1 : 0;
  const bonus = amount * bonusRate;
  const apiKey = generateApiKey();
  const txId = `tx_paddle_${orderId}`;

  // 幂等处理
  const existingTx = await env.TRANSACTIONS.get(txId, 'json');
  if (existingTx) {
    return new Response(JSON.stringify({ status: 'duplicate', txId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const quota = Math.floor(amount * 10000);
  const now = Date.now();
  const keyData = {
    userId,
    name: passthrough.name || 'Default',
    balance: amount + bonus,
    quota,
    quotaUsed: 0,
    status: 'active',
    created: now,
    lastUsed: null,
    plan: passthrough.plan || 'pay-as-you-go',
    email: email || '',
    orderId,
    totalPaid: amount,
  };

  const txData = {
    type: 'payment',
    provider: 'paddle',
    orderId,
    email,
    amount,
    currency: currency || 'USD',
    bonus,
    quota,
    userId,
    apiKey,
    timestamp: now,
    productId,
  };

  // 并发写入 KV
  const writes = [
    env.API_KEYS.put(apiKey, JSON.stringify(keyData)),
    env.TRANSACTIONS.put(txId, JSON.stringify(txData)),
  ];

  // 生命基金（利润 5%）
  const profitMargin = 0.25;
  const lifeFundAmount = amount * profitMargin * 0.05;
  if (lifeFundAmount > 0) {
    const currentFund = parseFloat(await env.API_KEYS.get('_life_fund_balance') || '0');
    writes.push(env.API_KEYS.put('_life_fund_balance', String(currentFund + lifeFundAmount)));
    writes.push(env.TRANSACTIONS.put(`lf_paddle_${orderId}`, JSON.stringify({
      type: 'life_fund', source: 'payment', orderId,
      amount: lifeFundAmount, timestamp: now,
    })));
  }

  await Promise.all(writes);

  return new Response(JSON.stringify({
    status: 'success', txId, apiKey, balance: amount + bonus, quota,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// 7. 核心 — OpenAI 兼容 API 代理
// ============================================================
async function handleChatCompletion(request, env) {
  const startTime = Date.now();
  const requestData = await readJson(request);
  if (!requestData) return jsonError(400, 'Invalid JSON body', request);

  // 认证
  const token = extractBearerToken(request);
  if (!token) return jsonError(401, 'Missing Authorization header', request);

  const keyData = await env.API_KEYS.get(token, 'json');
  if (!keyData) return jsonError(401, 'Invalid API key', request);
  if (keyData.status !== 'active') return jsonError(403, `API key is ${keyData.status}`, request);
  if (keyData.balance <= 0 && keyData.quota <= 0) {
    return jsonError(402, 'Insufficient balance. Top up at https://lifetokenhub.com', request);
  }

  // Check sensitive content before forwarding to upstream
  const blockResult = checkSensitiveContent(requestData?.messages);
  if (blockResult) {
    return new Response(JSON.stringify({
      error: { message: blockResult.reason, type: "content_policy_violation", code: "400" }
    }), { status: 400, headers: { "Content-Type": "application/json", ...buildCorsHeaders(request) } });
  }

  // 确定模型和供应商
  const model = requestData.model || 'deepseek-v4-flash';
  const providerInfo = getProviderByModel(model);
  if (!providerInfo) return jsonError(400, `Model "${model}" not available`, request);
  const { provider, endpoint } = providerInfo;

  // 获取上游 API Key
  const upstreamApiKey = endpoint === 'ascend' ? env.ASCEND_API_KEY : env.UPSTREAM_API_KEY;
  if (!upstreamApiKey) return jsonError(500, `API key not configured for ${endpoint}`, request);

  // 构造上游请求
  const isStream = requestData.stream === true && endpoint === 'deepseek';
  const upstreamBody = {
    model,
    messages: requestData.messages || [],
    temperature: requestData.temperature ?? 0.7,
    max_tokens: requestData.max_tokens || 4096,
    stream: isStream,
  };

  // 向上游发请求
  const upstreamResponse = await fetch(provider.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: buildUpstreamHeaders(endpoint, upstreamApiKey),
    body: JSON.stringify(upstreamBody),
  });
  const responseTime = Date.now() - startTime;

  if (!upstreamResponse.ok) {
    // DeepSeek 失败 → 自动切 Ascend
    if (endpoint === 'deepseek') {
      const fallback = await tryAscendFallback(requestData, env);
      if (fallback) {
        return buildSuccessResponse(fallback, providerInfo, keyData, responseTime, request);
      }
    }
    const errText = await upstreamResponse.text();
    return jsonError(upstreamResponse.status, `Provider error (${upstreamResponse.status}): ${errText.slice(0, 200)}`, request);
  }

  if (isStream) {
    // 流式 → 转发 SSE
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    consumeStream(upstreamResponse.body, writer, encoder, async (fullBody) => {
      const usage = extractUsageFromSSE(fullBody);
      await updateUsage(env, token, keyData, requestData, usage);
    });

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-ID': generateRequestId(),
        'X-Provider': endpoint,
      },
    });
  }

  // 非流式
  const bodyText = await upstreamResponse.text();
  let responseData;
  try { responseData = JSON.parse(bodyText); } catch {
    return new Response(bodyText, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  await updateUsage(env, token, keyData, requestData, responseData.usage);
  return buildSuccessResponse(responseData, providerInfo, keyData, responseTime, request);
}

// ============================================================
// Ascend 容灾回退
// ============================================================
async function tryAscendFallback(requestData, env) {
  try {
    const key = env.ASCEND_API_KEY;
    if (!key) return null;
    const res = await fetch(API_PROVIDERS.ascend.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: buildUpstreamHeaders('ascend', key),
      body: JSON.stringify({
        model: 'huawei-pangu',
        messages: requestData.messages || [],
        temperature: requestData.temperature ?? 0.7,
        max_tokens: requestData.max_tokens || 4096,
        stream: false,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return { ...body, _fallback: { fromProvider: 'deepseek', toProvider: 'ascend', fromModel: requestData.model || 'deepseek-v4-flash', toModel: 'huawei-pangu' } };
  } catch { return null; }
}

// ============================================================
// 用量更新
// ============================================================
async function updateUsage(env, token, keyData, requestData, usage) {
  const inputTokens = usage?.prompt_tokens || estimateTokens(JSON.stringify(requestData?.messages || ''));
  const outputTokens = usage?.completion_tokens || 0;
  const totalTokens = usage?.total_tokens || (inputTokens + outputTokens);

  const modelId = requestData?.model || 'deepseek-v4-flash';
  const pricing = USER_PRICING[modelId] || USER_PRICING['deepseek-v4-flash'];
  const tokenCost = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;

  await env.API_KEYS.put(token, JSON.stringify({
    ...keyData,
    quotaUsed: (keyData.quotaUsed || 0) + totalTokens,
    balance: Math.max(0, (keyData.balance || 0) - tokenCost),
    lastUsed: Date.now(),
  }));
}

// ============================================================
// 流处理
// ============================================================
async function consumeStream(readable, writer, encoder, onComplete) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let fullBody = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullBody += chunk;
      await writer.write(encoder.encode(chunk));
    }
  } catch {} finally {
    try { await writer.close(); } catch {}
    onComplete(fullBody).catch(() => {});
  }
}

// ============================================================
// 管理统计
// ============================================================
async function handleAdminStats(request, env) {
  if (!requireAdminKey(request, env)) return jsonError(403, 'Forbidden', request);
  const lifeFundBalance = await env.API_KEYS.get('_life_fund_balance') || '0';
  return new Response(JSON.stringify({
    service: 'lifetokenhub-api', version: '2.0',
    lifeFundBalance: parseFloat(lifeFundBalance),
    note: 'Full stats require D1 database upgrade.',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// 辅助
// ============================================================

function getProviderByModel(model) {
  for (const [key, p] of Object.entries(API_PROVIDERS)) {
    if (p.models.includes(model)) return { provider: p, endpoint: key, model };
  }
  return null;
}

function buildUpstreamHeaders(endpoint, apiKey) {
  if (endpoint === 'ascend') {
    return { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Auth-Token': apiKey };
  }
  return { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${apiKey}` };
}

function buildSuccessResponse(data, providerInfo, keyData, responseTime, request) {
  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const totalTokens = data.usage?.total_tokens || (inputTokens + outputTokens);
  const modelId = data.model || providerInfo.model;
  const pricing = USER_PRICING[modelId] || USER_PRICING['deepseek-v4-flash'];
  const userCost = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;

  const enhanced = {
    ...data,
    _lifeTokenHub: {
      requestId: generateRequestId(),
      provider: providerInfo.endpoint,
      providerGroup: providerInfo.provider.providerGroup,
      responseTimeMs: responseTime,
      userCostUSD: parseFloat(userCost.toFixed(6)),
    },
  };
  if (data._fallback) enhanced._fallback = data._fallback;

  return new Response(JSON.stringify(enhanced), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': generateRequestId(),
      'X-Provider': providerInfo.endpoint,
      'Cache-Control': 'no-store',
    },
  });
}

function estimateTokens(text) {
  if (typeof text === 'string') return Math.ceil(text.length / 4);
  if (Array.isArray(text)) return text.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
  return 0;
}

function extractUsageFromSSE(sseBody) {
  const lines = sseBody.split('\n').filter(l => l.startsWith('data: '));
  if (lines.length === 0) return {};
  const lastLine = lines[lines.length - 1].slice(6);
  if (lastLine === '[DONE]') {
    if (lines.length >= 2) {
      try { return JSON.parse(lines[lines.length - 2].slice(6)).usage; } catch {}
    }
    return {};
  }
  try { return JSON.parse(lastLine).usage; } catch { return {}; }
}

function jsonError(status, message, request) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code: status.toString() } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(request) },
  });
}
