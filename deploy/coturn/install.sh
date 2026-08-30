#!/usr/bin/env bash
# 在 192.168.1.100 上安装并启动 coturn（需 root）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "配置 ufw 规则..."
  ufw allow 3478/tcp comment 'coturn'
  ufw allow 3478/udp comment 'coturn'
  ufw allow 49152:65535/udp comment 'coturn-media'
fi

cd "$SCRIPT_DIR"
docker compose up -d
echo "coturn 已启动。请确认 DNS: turn.sc.bjedu.pro -> 192.168.1.100"
echo "验证: docker run --rm --network host coturn/coturn turnutils_uclient -y -v -u shanchuan -w '<password>' turn.sc.bjedu.pro"
