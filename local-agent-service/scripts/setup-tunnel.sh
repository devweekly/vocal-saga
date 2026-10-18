#!/usr/bin/env bash
#
# 一次性创建 Cloudflare 命名隧道，把本机 Agent 服务暴露到指定域名。
#
# 为什么用命名隧道而不是 `cloudflared tunnel --url`：
#   quick tunnel 每次重启换域名，扩展侧要跟着改；命名隧道域名固定，且能配 Access。
#
# 前置：cloudflared tunnel login（需要浏览器授权，脚本无法代劳）
#
# 用法：
#   TUNNEL_HOSTNAME=local.sunxiunan.com ./scripts/setup-tunnel.sh
#
set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-vocal-saga-local}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-local.sunxiunan.com}"
SERVICE_PORT="${LOCAL_AGENT_PORT:-8789}"
CF_DIR="$HOME/.cloudflared"
CONFIG_PATH="$CF_DIR/config.yml"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "缺少 cloudflared，先安装：brew install cloudflared" >&2
  exit 1
fi

if [ ! -f "$CF_DIR/cert.pem" ]; then
  echo "尚未登录 Cloudflare。请先执行：" >&2
  echo "  cloudflared tunnel login" >&2
  echo "浏览器里选择 $TUNNEL_HOSTNAME 所属的 zone（证书会写到 $CF_DIR/cert.pem）。" >&2
  exit 1
fi

# 隧道创建是幂等的：已存在就复用，避免重复 create 报错打断流程。
TUNNEL_ID="$(cloudflared tunnel list --output json | node -e '
  let raw = "";
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    const name = process.argv[1];
    const tunnels = JSON.parse(raw || "[]");
    const hit = tunnels.find((t) => t.name === name);
    process.stdout.write(hit ? hit.id : "");
  });
' "$TUNNEL_NAME")"

if [ -z "$TUNNEL_ID" ]; then
  echo "创建隧道 $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME" >/dev/null
  TUNNEL_ID="$(cloudflared tunnel list --output json | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      const name = process.argv[1];
      const tunnels = JSON.parse(raw || "[]");
      const hit = tunnels.find((t) => t.name === name);
      process.stdout.write(hit ? hit.id : "");
    });
  ' "$TUNNEL_NAME")"
else
  echo "复用已存在的隧道 $TUNNEL_NAME ($TUNNEL_ID)"
fi

if [ -z "$TUNNEL_ID" ]; then
  echo "无法取得隧道 ID，请检查 cloudflared tunnel list 的输出" >&2
  exit 1
fi

# DNS 记录已存在时 cloudflared 会报错，这里显式容忍。
echo "绑定域名 $TUNNEL_HOSTNAME -> $TUNNEL_NAME"
cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_HOSTNAME" 2>&1 | sed 's/^/  /' || true

cat > "$CONFIG_PATH" <<YAML
# 由 scripts/setup-tunnel.sh 生成
tunnel: $TUNNEL_ID
credentials-file: $CF_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $TUNNEL_HOSTNAME
    service: http://127.0.0.1:$SERVICE_PORT
  # 其余主机名一律 404，避免隧道被当成通用出口
  - service: http_status:404
YAML

echo "已写入 $CONFIG_PATH"
echo
echo "下一步："
echo "  1) 确认 $PWD/.env 里 LOCAL_AGENT_TOKEN 非空，且"
echo "     LOCAL_AGENT_ALLOWED_HOSTS 包含 $TUNNEL_HOSTNAME"
echo "  2) 前台试跑：cloudflared tunnel run $TUNNEL_NAME"
echo "  3) 验证：curl -H 'Authorization: Bearer <token>' https://$TUNNEL_HOSTNAME/api/documents/projects"
echo "  4) 确认无误后常驻：sudo cloudflared service install"
