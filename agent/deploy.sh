#!/bin/bash
set -e

echo "==========================================="
echo "  Obzide Dev Agent - Deploy Update"
echo "==========================================="

AGENT_DIR="/opt/obzide-agent"
cd "$AGENT_DIR"

echo "[1/4] Pulling latest changes..."
git pull

echo "[2/4] Installing dependencies..."
cd "$AGENT_DIR/agent"
npm install

echo "[3/4] Building TypeScript..."
npm run build

echo "[4/4] Restarting service..."
systemctl restart obzide-agent

echo ""
echo "Deploy complete. Checking status..."
sleep 2
systemctl status obzide-agent --no-pager

echo ""
echo "View logs: journalctl -u obzide-agent -f"
