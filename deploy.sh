#!/bin/bash
# LifeTokenHub API Gateway 一键部署指引
# ========================================
# 场景：你有 Cloudflare Dashboard 访问权限但没有 wrangler CLI 认证
# 3 分钟搞定，不需要命令行

set -e

echo "=== LifeTokenHub 部署助手 ==="
echo ""
echo "第1步：打开 Cloudflare Dashboard"
echo "  https://dash.cloudflare.com/"
echo "  用 GitHub 登录（管理 lifetokenhub.com 那个账号）"
echo ""
echo "第2步：进入 Worker"
echo "  左侧菜单 Workers & Pages → api.lifetokenhub.com"
echo ""
echo "第3步：粘贴代码"
echo "  在编辑器中全选替换为:"
echo "  /home/qilei/.openclaw/workspace/workers/lifetokenhub-api.js"
echo "  (或 GitHub: https://github.com/qil149/lifetokenhub-api)"
echo "  点 Save and Deploy"
echo ""
echo "第4步：设置环境变量"
echo "  Dashboard → Settings → Variables"
echo "  添加:"
echo "    DEEPSEEK_API_KEY  = <你刚充值的 DeepSeek API Key>"
echo "  点 Save"
echo ""
echo "第5步：验证"
echo "  curl https://api.lifetokenhub.com/health"
echo "  curl -X POST https://api.lifetokenhub.com/v1/chat/completions \\"
echo '    -H "Authorization: Bearer ltk_v1_test" \'
echo '    -H "Content-Type: application/json" \'
echo '    -d '"'"'{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'"'"''
echo ""
echo "=== 完成 ==="
