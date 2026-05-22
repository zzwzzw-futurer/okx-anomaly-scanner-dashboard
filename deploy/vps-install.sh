#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/okx_anomaly_scanner}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

install -d "$APP_DIR/data/logs" "$APP_DIR/reports"
install -m 0644 "$SCRIPT_DIR/systemd/okx-anomaly-scanner.service" /etc/systemd/system/okx-anomaly-scanner.service
install -m 0644 "$SCRIPT_DIR/systemd/okx-dashboard.service" /etc/systemd/system/okx-dashboard.service

systemctl daemon-reload
systemctl enable okx-anomaly-scanner.service okx-dashboard.service
systemctl restart okx-anomaly-scanner.service okx-dashboard.service

if command -v ufw >/dev/null 2>&1; then
  ufw allow 8787/tcp >/dev/null || true
fi

systemctl --no-pager --full status okx-anomaly-scanner.service okx-dashboard.service
