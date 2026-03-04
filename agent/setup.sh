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
echo "[5/6] Configuring environment variables..."
if [ ! -f "$AGENT_DIR/agent/.env" ]; then
  cp "$AGENT_DIR/agent/.env.example" "$AGENT_DIR/agent/.env"
  echo ""
  echo "Please enter your environment variables:"
  echo ""

  read -rp "SUPABASE_URL: " SUPABASE_URL
  read -rp "SUPABASE_SERVICE_ROLE_KEY: " SUPABASE_SERVICE_ROLE_KEY
  read -rp "ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY
  read -rp "GITHUB_TOKEN: " GITHUB_TOKEN
  read -rp "GITHUB_ORG [obzide-tech]: " GITHUB_ORG
  GITHUB_ORG=${GITHUB_ORG:-obzide-tech}
  read -rp "VERCEL_TOKEN: " VERCEL_TOKEN
  read -rp "VERCEL_TEAM_ID (leave empty if personal account): " VERCEL_TEAM_ID
  read -rp "NAMECHEAP_API_USER (leave empty to skip): " NAMECHEAP_API_USER
  read -rp "NAMECHEAP_API_KEY (leave empty to skip): " NAMECHEAP_API_KEY
  read -rp "RESEND_API_KEY (leave empty to skip): " RESEND_API_KEY

  cat > "$AGENT_DIR/agent/.env" << EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
GITHUB_TOKEN=$GITHUB_TOKEN
GITHUB_ORG=$GITHUB_ORG
VERCEL_TOKEN=$VERCEL_TOKEN
VERCEL_TEAM_ID=$VERCEL_TEAM_ID
NAMECHEAP_API_USER=$NAMECHEAP_API_USER
NAMECHEAP_API_KEY=$NAMECHEAP_API_KEY
NAMECHEAP_CLIENT_IP=178.156.252.99
RESEND_API_KEY=$RESEND_API_KEY
NODE_ENV=production
EOF

  chmod 600 "$AGENT_DIR/agent/.env"
  echo ".env file created and secured"
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
echo "  Useful commands:"
echo "    systemctl status obzide-agent"
echo "    journalctl -u obzide-agent -f"
echo "    systemctl restart obzide-agent"
echo ""
echo "==========================================="
