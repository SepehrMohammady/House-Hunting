#!/usr/bin/env bash
#
# Install the house finder on the web server, to run there and publish in place.
#
#   sudo ./scripts/vps-setup.sh
#
# What this sets up:
#   - a systemd timer on the schedule from config.json
#   - PUBLISH_DIR pointing at the directory nginx already serves, so reports are
#     written straight into place and nothing is uploaded anywhere
#   - Chromium for the two sources that need a real browser
#
# It is safe to re-run: it rewrites the unit files and reloads the timer.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="house-finder"
WEB_DIR="${WEB_DIR:-/var/www/house-hunter}"
RUN_USER="${RUN_USER:-housefinder}"

cd "$PROJECT_DIR"

echo "Project : $PROJECT_DIR"
echo "Publish : $WEB_DIR"
echo "User    : $RUN_USER"
echo

# ---------------------------------------------------------------- schedule ---
# config.json is the single source of truth: change the times there, re-run this.
read_schedule() {
  node -e '
    const c = JSON.parse(require("fs").readFileSync("config.json", "utf8"));
    const t = (c.schedule && c.schedule.times) || [];
    if (!t.length) { console.error("config.json has no schedule.times"); process.exit(1); }
    // systemd OnCalendar takes a comma list of hours when the minutes match.
    const mins = new Set(t.map((x) => x.split(":")[1]));
    if (mins.size === 1) {
      console.log(`*-*-* ${t.map((x) => x.split(":")[0]).join(",")}:${[...mins][0]}:00`);
    } else {
      // Mixed minutes need one OnCalendar line each.
      console.log(t.map((x) => `*-*-* ${x}:00`).join("\n"));
    }
  '
}
read_timezone() {
  node -e 'const c=JSON.parse(require("fs").readFileSync("config.json","utf8"));
           console.log((c.schedule && c.schedule.timezone) || "Europe/Rome");'
}

# ------------------------------------------------------------------- node ---
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

SCHEDULE="$(read_schedule)"
TIMEZONE="$(read_timezone)"
echo "Schedule: $(node -e 'const c=JSON.parse(require("fs").readFileSync("config.json","utf8"));console.log(c.schedule.times.join(", "))') ($TIMEZONE)"
echo

# ------------------------------------------------------------ dependencies ---
npm install --omit=dev

# Chromium is needed by Idealista and by the Immobiliare full-text lookup. Both
# degrade gracefully without it, but the report is thinner.
if [ ! -d "$HOME/.cache/ms-playwright" ] && [ ! -d "/home/$RUN_USER/.cache/ms-playwright" ]; then
  read -r -p "Install Chromium for Idealista? (~400 MB) [Y/n] " reply
  if [[ ! "$reply" =~ ^[Nn]$ ]]; then
    # Two steps, deliberately.
    #
    # `--with-deps` shells out to apt through sudo. Running it as the run user
    # cannot work: that account is created with `adduser --system`, so it has no
    # password and no sudo rights, and the install stalls forever on a password
    # prompt nobody can answer. So install the OS libraries here, where this
    # script is already root, and fetch the browser itself as the run user -
    # Playwright looks for it in that user's own cache.
    npx playwright install-deps chromium
    sudo -u "$RUN_USER" HOME="/home/$RUN_USER" npx playwright install chromium
  else
    echo "Skipping. Set sources.idealista.enabled=false in config.json to silence its warning."
  fi
fi

# ------------------------------------------------------------------- .env ---
# PUBLISH_DIR is what tells the scanner it IS the web server: it writes into the
# served directory and skips the upload step entirely.
if [ ! -f .env ]; then
  cp .env.example .env
fi
if ! grep -q '^PUBLISH_DIR=' .env; then
  printf '\n# Set by vps-setup.sh: publish straight into the served directory.\nPUBLISH_DIR=%s\n' "$WEB_DIR" >> .env
  echo "Added PUBLISH_DIR=$WEB_DIR to .env"
else
  sed -i "s|^PUBLISH_DIR=.*|PUBLISH_DIR=$WEB_DIR|" .env
  echo "Updated PUBLISH_DIR=$WEB_DIR in .env"
fi

# Everything inside data/ is git-ignored, and git does not track empty
# directories, so a fresh clone has no data/ at all. The unit below sends both
# streams to data/run.log with `append:`, and systemd will not create a missing
# parent for that - it fails the whole service with 209/STDOUT before node is
# ever reached, which reads like a crash rather than a missing directory.
sudo mkdir -p "$PROJECT_DIR/data"

# The scanner writes reports, its state file and its log, so it needs the
# project directory as well as the web directory.
sudo chown -R "$RUN_USER":"$RUN_USER" "$PROJECT_DIR"
sudo mkdir -p "$WEB_DIR/reports"
sudo chown -R "$RUN_USER":www-data "$WEB_DIR"
sudo chmod -R 750 "$WEB_DIR"
sudo find "$WEB_DIR" -type d -exec chmod g+s {} \;

# --------------------------------------------------------- systemd service ---
NODE_BIN="$(command -v node)"

sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Genoa house finder - scan rental portals and publish the report
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
Environment=HOME=/home/${RUN_USER}
ExecStart=${NODE_BIN} ${PROJECT_DIR}/src/index.js --quiet
# A stuck portal must not wedge the timer. Runs take about 40s; this is slack.
TimeoutStartSec=1800
StandardOutput=append:${PROJECT_DIR}/data/run.log
StandardError=append:${PROJECT_DIR}/data/run.log
EOF

# $SCHEDULE is one OnCalendar spec per line, and a single spec contains a space
# ("*-*-* 08,11,..."). It therefore has to be prefixed line by line: passing it
# unquoted to printf splits it on that space instead, which silently yields a
# bare "OnCalendar=*-*-*" - a valid spec meaning midnight - and systemd unions
# every OnCalendar line, so the timer gains a run nobody asked for.
sudo tee "/etc/systemd/system/${SERVICE_NAME}.timer" >/dev/null <<EOF
[Unit]
Description=Run the Genoa house finder on schedule

[Timer]
$(printf '%s\n' "$SCHEDULE" | sed 's/^/OnCalendar=/')
# Catch up a run the server missed while rebooting.
Persistent=true
# Portals see five identical requests at the same second every day otherwise.
RandomizedDelaySec=90
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

# Pin the clock to the schedule's timezone, or the times drift from Genoa.
CURRENT_TZ="$(timedatectl show -p Timezone --value)"
if [ "$CURRENT_TZ" != "$TIMEZONE" ]; then
  echo "Setting system timezone: $CURRENT_TZ -> $TIMEZONE"
  sudo timedatectl set-timezone "$TIMEZONE"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.timer"

echo
echo "Installed. Upcoming runs:"
systemctl list-timers "${SERVICE_NAME}.timer" --no-pager || true
echo
echo "Run now       : sudo systemctl start ${SERVICE_NAME}.service"
echo "Watch the log : tail -f ${PROJECT_DIR}/data/run.log"
echo "Timer status  : systemctl status ${SERVICE_NAME}.timer"
echo "Disable       : sudo systemctl disable --now ${SERVICE_NAME}.timer"
