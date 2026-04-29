# LifeTokenHub API Gateway

**Cloudflare Worker** — 双供应商路由 + API Key 管理 + Paddle 支付 Webhook

## 架构

用户 → `api.lifetokenhub.com/v1/chat/completions`
         ↓
   Cloudflare Worker ← KV (Key 存储 + 交易记录)
         ↓
   DeepSeek 主力 / 华为 Ascend 备用

## 部署步骤

### 1. 安装依赖
```bash
npm install
```

### 2. 创建 KV 命名空间
```bash
npx wrangler kv:namespace create "API_KEYS"
# → 把返回的 ID 填入 wrangler.toml 的 API_KEYS

npx wrangler kv:namespace create "TRANSACTIONS"
# → 把返回的 ID 填入 wrangler.toml 的 TRANSACTIONS
```

### 3. 设置密钥
```bash
npx wrangler secret put UPSTREAM_API_KEY      # DeepSeek API Key
npx wrangler secret put ASCEND_API_KEY         # 华为 Ascend API Key（可选）
npx wrangler secret put ADMIN_API_KEY          # 管理后台用的 Key
npx wrangler secret put PADDLE_WEBHOOK_SECRET  # Paddle Webhook 密钥
```

### 4. 部署
```bash
npx wrangler deploy
```

## API 文档

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/health` | GET | 无 | 健康检查 |
| `/v1/models` | GET | 无 | 模型列表及定价 |
| `/v1/chat/completions` | POST | Bearer Token | OpenAI 兼容代理（支持流式） |
| `/v1/auth/verify` | POST | API Key | 验证 Key 有效性 |
| `/v1/keys` | GET | Bearer Token | 查询当前 Key 余额/用量 |
| `/v1/keys` | POST | x-api-key | 管理员创建 Key |
| `/v1/admin/stats` | GET | x-api-key | 管理统计 |
| `/webhook/paddle` | POST | — | Paddle 支付回调 |

## 前端集成

在 LifeTokenHub 网站设置环境变量:
- `VITE_API_BASE_URL=https://api.lifetokenhub.com`
- `VITE_PADDLE_VENDOR_ID=`（在 Paddle 后台获取）
