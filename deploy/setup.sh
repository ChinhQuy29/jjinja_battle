#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04 server.
#
#   sudo bash setup.sh <your-domain> [git-repo-url]
#   e.g. sudo bash setup.sh jjinja.duckdns.org
#
# Installs Node.js, Caddy (automatic HTTPS), and coturn (video relay), clones the game,
# and runs it as a service that restarts on crashes and reboots. Safe to re-run.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${2:-https://github.com/ChinhQuy29/jjinja_battle.git}"
APP_DIR=/opt/jjinja
APP_USER=jjinja
ENV_FILE=/etc/jjinja/env
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash setup.sh <your-domain> [git-repo-url]" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo (or as root)." >&2
  exit 1
fi

step() { echo; echo "==> $*"; }

step "Updating the system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

step "Turning on automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

# npm install can run out of memory on 1 GB servers without swap
if ! swapon --show | grep -q .; then
  step "Adding 1 GB of swap"
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

step "Installing Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

step "Installing Caddy (web server with automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

step "Installing coturn (video relay for strict networks)"
apt-get install -y coturn

step "Creating the app user and downloading the game"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
if [[ ! -d "$APP_DIR/.git" ]]; then
  if ! git clone "$REPO" "$APP_DIR"; then
    echo "Couldn't clone $REPO. If the repository is private, see 'Private repository' in DEPLOY.md." >&2
    exit 1
  fi
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci --no-audit --no-fund"

step "Writing configuration"
mkdir -p /etc/jjinja
if [[ ! -f "$ENV_FILE" ]] || ! grep -q TURN_SECRET "$ENV_FILE"; then
  TURN_SECRET="$(openssl rand -hex 32)"
else
  TURN_SECRET="$(grep TURN_SECRET "$ENV_FILE" | cut -d= -f2)"
fi
cat > "$ENV_FILE" <<EOF
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=1
TURN_HOST=$DOMAIN
TURN_SECRET=$TURN_SECRET
EOF
chmod 640 "$ENV_FILE"
chown root:"$APP_USER" "$ENV_FILE"

cat > /etc/systemd/system/jjinja.service <<EOF
[Unit]
Description=Jjinja Battle game server
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/node_modules/.bin/tsx server/index.ts
Restart=always
RestartSec=2
# basic hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Permissions-Policy "camera=(self), microphone=(self), geolocation=()"
		-Server
	}
	reverse_proxy 127.0.0.1:3000
}
EOF

cat > /etc/turnserver.conf <<EOF
listening-port=3478
realm=$DOMAIN
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
min-port=$TURN_MIN_PORT
max-port=$TURN_MAX_PORT
total-quota=200
stale-nonce=600
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
# never relay into private or local networks
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true

step "Keeping logs for 30 days (matches the privacy page)"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/jjinja.conf <<EOF
[Journal]
MaxRetentionSec=30day
EOF
systemctl restart systemd-journald

step "Configuring the firewall"
ufw allow 22/tcp # SSH; by port, since the "OpenSSH" profile only exists if openssh-server is installed
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow $TURN_MIN_PORT:$TURN_MAX_PORT/udp
ufw --force enable

step "Starting everything"
systemctl daemon-reload
systemctl enable --now jjinja
systemctl enable coturn && systemctl restart coturn
systemctl enable caddy && systemctl restart caddy

sleep 3
if curl -fsS http://127.0.0.1:3000/ >/dev/null; then
  echo
  echo "All set! In a minute (once Caddy has its HTTPS certificate) open: https://$DOMAIN"
else
  echo
  echo "The game didn't answer yet. Check the logs with: journalctl -u jjinja -n 50" >&2
  exit 1
fi
