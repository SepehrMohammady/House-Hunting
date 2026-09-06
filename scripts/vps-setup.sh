#!/usr/bin/env bash
#
# Linux VPS deployment - for when you move this off the Windows PC.
#
# Installs dependencies, registers a systemd timer for 06:00 / 12:00 / 18:00
# Rome time, and runs once to verify.
#
#   chmod +x scripts/vps-setup.sh
#   ./scripts/vps-setup.sh
#
# Idealista note: it needs a real browser. On a headless VPS either set
# sources.idealista.enabled=false in config.json, or install Chromium's system
# libraries (this script offers to) and accept that DataDome will challenge more
# often from a datacentre IP than from your home connection.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="house-finder"
RUN_USER="${SUDO_USER:-$USER}"

echo "Project : $PROJECT_DIR"
echo "User    : $RUN_USER"
echo

# --- Node ------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 18+ first, e.g.:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node 18+ required, found $(node -v)."
  exit 1
fi
echo "Node $(node -v) at $(command -v node)"

# --- Dependencies ----------------------------------------------------------
cd "$PROJECT_DIR"
npm install --omit=dev

# The timezone matters: the schedule is meant to be Rome time, and a VPS
# defaults to UTC. Pinning it on the unit avoids a two-hour drift in summer.
TIMEZONE="Europe/Rome"

read -r -p "Install Chromium libraries for Idealista scraping? [y/N] " reply
if [[ "$reply" =~ ^[Yy]$ ]]; then
  npx playwright install --with-deps chromium
else
  echo "Skipping. Set sources.idealista.enabled=false in config.json to silence its warning."
fi

# --- systemd service + timer ----------------------------------------------
NODE_BIN="$(command -v node)"

sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Genoa house finder - scan rental portals and build a report
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} ${PROJECT_DIR}/src/index.js --quiet
# A stuck portal must not wedge the timer.
TimeoutStartSec=1800
StandardOutput=append:${PROJECT_DIR}/data/run.log
StandardError=append:${PROJECT_DIR}/data/run.log
EOF

sudo tee "/etc/systemd/system/${SERVICE_NAME}.timer" >/dev/null <<EOF
[Unit]
Description=Run the Genoa house finder at 06:00, 12:00 and 18:00

[Timer]
OnCalendar=*-*-* 06,12,18:00:00
Persistent=true
# Catch up a run the VPS missed while rebooting.
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

# Pin the schedule to Rome time rather than the VPS default of UTC.
if [ "$(timedatectl show -p Timezone --value)" != "$TIMEZONE" ]; then
  echo "Setting system timezone to ${TIMEZONE} so the schedule matches Genoa."
  sudo timedatectl set-timezone "$TIMEZONE"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.timer"

echo
echo "Installed. Next runs:"
systemctl list-timers "${SERVICE_NAME}.timer" --no-pager || true
echo
echo "Run now      : sudo systemctl start ${SERVICE_NAME}.service"
echo "Watch log    : tail -f ${PROJECT_DIR}/data/run.log"
echo "Latest report: ${PROJECT_DIR}/reports/latest.html"
echo "Disable      : sudo systemctl disable --now ${SERVICE_NAME}.timer"
