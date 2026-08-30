#!/usr/bin/env bash
# 在应用服务器上安装并启动 coturn（需 root）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "配置 ufw 规则..."
  ufw allow 3478/tcp comment 'coturn'
  ufw allow 3478/udp comment 'coturn'
  ufw allow 49152:65535/udp comment 'coturn-media'
fi

cd "$SCRIPT_DIR"
if [ ! -f turnserver.conf ]; then
  cp turnserver.conf.example turnserver.conf
  echo "已从 turnserver.conf.example 创建 turnserver.conf，请编辑后再启动。"
fi
docker compose up -d
echo "coturn 已启动。请确认 DNS: turn.example.com -> 应用服务器公网 IP"
echo "验证: curl -s https://croc.example.com/api/config | jq '.ice_servers[] | select(.urls|contains(\"turn\"))'"
echo "然后用 turnutils_uclient -u <username> -w <credential> turn.example.com 测试"
