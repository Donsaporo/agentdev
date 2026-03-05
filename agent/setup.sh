#!/bin/bash
set -e

echo "==========================================="
echo "  Obzide Dev Agent - VPS Setup Script"
echo "==========================================="
echo ""

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup.sh"
  exit 1
fi

echo "[1/6] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git

if ! command -v node &> /dev/null; then
  echo "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "Node.js $(node -v) installed"
echo "npm $(npm -v) installed"

echo ""
echo "[2/6] Installing Chromium for screenshots..."
apt-get install -y -qq chromium-browser || apt-get install -y -qq chromium
echo "Chromium installed"

echo ""
echo "[3/6] Setting up project directory..."
AGENT_DIR="/opt/obzide-agent"
mkdir -p "$AGENT_DIR"

if [ -d "$AGENT_DIR/agent" ]; then
  echo "Agent directory already exists, pulling latest..."
  cd "$AGENT_DIR" && git pull
else
  echo "Enter the Git repo URL for the dashboard project:"
  read -r REPO_URL
  git clone "$REPO_URL" "$AGENT_DIR"
fi

cd "$AGENT_DIR/agent"

echo ""
echo "[4/6] Installing npm dependencies..."
npm install

echo ""
echo "[5/6] Configuring environment..."
echo ""
echo "  The agent only needs 2 environment variables."
echo "  All API keys (Anthropic, GitHub, Vercel, etc.) are"
echo "  stored securely in Supabase and managed via the dashboard."
echo ""

if [ ! -f "$AGENT_DIR/agent/.env" ]; then
  read -rp "SUPABASE_URL: " SUPABASE_URL
  read -rp "SUPABASE_SERVICE_ROLE_KEY: " SUPABASE_SERVICE_ROLE_KEY

  cat > "$AGENT_DIR/agent/.env" << EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
NAMECHEAP_CLIENT_IP=178.156.252.99
NODE_ENV=production
EOF

  chmod 600 "$AGENT_DIR/agent/.env"
  echo ".env file created (only Supabase credentials needed)"
else
  echo ".env already exists, skipping configuration"
fi

echo ""
echo "[6/6] Building TypeScript and creating systemd service..."
cd "$AGENT_DIR/agent"
npm run build

cat > /etc/systemd/system/obzide-agent.service << EOF
[Unit]
Description=Obzide Dev Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$AGENT_DIR/agent
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=obzide-agent

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable obzide-agent
systemctl start obzide-agent

echo ""
echo "==========================================="
echo "  Setup Complete!"
echo "==========================================="
echo ""
echo "  Agent is running as a systemd service."
echo ""
echo "  API keys are managed in the dashboard:"
echo "    Settings > API Keys"
echo ""
echo "  Useful commands:"
echo "    systemctl status obzide-agent"
echo "    journalctl -u obzide-agent -f"
echo "    systemctl restart obzide-agent"
echo ""
echo "==========================================="
