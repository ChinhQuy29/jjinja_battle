#!/usr/bin/env bash
# Pulls the latest code from GitHub and restarts the game. Run on the server:
#   sudo bash /opt/jjinja/deploy/update.sh
# Matches in progress are dropped by the restart, so update when it's quiet.
set -euo pipefail

APP_DIR=/opt/jjinja
APP_USER=jjinja

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo (or as root)." >&2
  exit 1
fi

before="$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"
sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
after="$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"

if [[ "$before" == "$after" ]]; then
  echo "Already up to date ($after). Nothing to do."
  exit 0
fi

sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci --no-audit --no-fund"
systemctl restart jjinja
sleep 2
if systemctl is-active --quiet jjinja; then
  echo "Updated $before -> $after and restarted."
else
  echo "The game failed to start after updating. Logs: journalctl -u jjinja -n 50" >&2
  exit 1
fi
