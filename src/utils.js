// LifeTokenHub API Gateway — 纯工具函数
// 从 src/worker.js 拆分，不改逻辑

export function errorResponse(status, message, corsHeaders) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code: status.toString() } }), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

export function estimateTokens(text) {
  if (typeof text === 'string') return Math.ceil(text.length / 4)
  if (Array.isArray(text)) return text.reduce((s, m) => s + estimateTokens(m.content || ''), 0)
  return 0
}

export function generateRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 11)
}

export function extractUserIdFromKey(apiKey) {
  const p = apiKey.split('_'); return p.length >= 3 ? p[2] : 'anonymous'
}
