#!/bin/bash
set -e

VPS_HOST="178.156.252.99"
VPS_USER="root"
REMOTE_DIR="/opt/obzide-sales"

echo "Building..."
npm run build

echo "Syncing to VPS..."
rsync -avz --exclude node_modules --exclude .env dist/ package.json package-lock.json "$VPS_USER@$VPS_HOST:$REMOTE_DIR/"

echo "Installing dependencies on VPS..."
ssh "$VPS_USER@$VPS_HOST" "cd $REMOTE_DIR && npm ci --omit=dev"

echo "Restarting service..."
ssh "$VPS_USER@$VPS_HOST" "systemctl restart obzide-sales"

echo "Done. Checking status..."
ssh "$VPS_USER@$VPS_HOST" "systemctl status obzide-sales --no-pager"
