// LifeTokenHub API Gateway — 供应商配置、定价、汇率、敏感内容过滤
// 从 src/worker.js 拆分，不改逻辑

// === 双供应商配置 ===
// DeepSeek V4 系列（主力）+ 华为 Ascend 计算池（备用）
export const API_PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    providerGroup: 'primary',
    label: 'Primary Provider',
    // 上游成本（USD/1K tokens，用于公式计算基价，实际以覆盖值为准）
    pricing: { input: 0.000139, output: 0.000278 }
  },
  ascend: {
    baseUrl: 'https://ap-southeast-1.api.huaweicloud.com',
    models: ['huawei-pangu', 'huawei-pangu-lite'],
    providerGroup: 'ascend',
    label: 'Ascend Compute Provider',
    pricing: { input: 0.0004, output: 0.0015 }
  }
}

// === 零售定价（CNY/百万 tokens）===
// 输入价分正常和缓存两种，输出价不变
// 缓存价仅对 DeepSeek 供应商有效（其他上游无缓存机制）
export const USER_PRICING = {
  'deepseek-v4-flash': { input: 1.33, output: 2.67, input_cache: 0.13 },
  'deepseek-v4-pro': { input: 16, output: 32, input_cache: 1.33 },
  'huawei-pangu': { input: 5.33, output: 21.33 },
  'huawei-pangu-lite': { input: 5.33, output: 21.33 },
  // 缓存命中折扣模型（保留兼容，但推荐使用自动缓存计价）
  'deepseek-v4-flash-cache': { input: 0.13, output: 2.67 },
  'deepseek-v4-pro-cache': { input: 1.33, output: 32 }
}

// === 敏感内容过滤（防止上游 API Key 被封）===
export const sensitiveContentFilter = [
  // Level 1: CSAM / child exploitation (absolute must-block)
  /child.*sexual|未成年.*(?:色情|性)|儿童.*(?:色情|性)|csam|cocsa/i,
  // Level 2: Illegal activities that could get API key banned
  /制作.*(?:毒品|炸弹|炸药)|(?:毒品|炸弹|炸药).*制作|制毒|黑客.*攻击|攻击.*服务器|钓鱼.*网站/i,
  // Level 3: Self-harm
  /自杀.*(?:方法|教程|步骤|方式)|怎么.*自杀|如何.*自杀|自残.*方法/i,
]

export function checkSensitiveContent(messages) {
  if (!messages || !Array.isArray(messages)) return null
  for (const msg of messages) {
    if (!msg.content || typeof msg.content !== 'string') continue
    for (const pattern of sensitiveContentFilter) {
      if (pattern.test(msg.content)) {
        return { blocked: true, reason: 'Request blocked: content violates usage policy' }
      }
    }
  }
  return null
}

// === 实时汇率（er-api.com，内存缓存 1 小时）===
// 返回 { usdToCny, usdToEur, source, updatedAt }
let _exchangeRateCache = null
let _exchangeRateCacheTime = 0

export async function getExchangeRate() {
  const now = Date.now()
  if (_exchangeRateCache && (now - _exchangeRateCacheTime) < 3600000) return _exchangeRateCache
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD')
    const data = await res.json()
    _exchangeRateCache = {
      cny: data.rates?.CNY || 7.2,
      eur: data.rates?.EUR || 0.92,
      updatedAt: new Date(now).toISOString(),
      _raw: data
    }
    _exchangeRateCacheTime = now
    return _exchangeRateCache
  } catch (e) {
    return _exchangeRateCache || { cny: 7.2, eur: 0.92, updatedAt: new Date().toISOString() }
  }
}

// === 用户费用计算 ===
export function calculateUserCost(inputTokens, outputTokens, pricing, cacheHitTokens) {
  if (cacheHitTokens && pricing.input_cache) {
    const cacheMiss = Math.max(0, inputTokens - cacheHitTokens)
    const cost = (cacheMiss / 1000000) * pricing.input + (cacheHitTokens / 1000000) * pricing.input_cache + (outputTokens / 1000000) * pricing.output
    return parseFloat(cost.toFixed(4))
  }
  return parseFloat(((inputTokens / 1000000) * pricing.input + (outputTokens / 1000000) * pricing.output).toFixed(4))
}
