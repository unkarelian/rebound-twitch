#!/usr/bin/env bash
# Installs Rebound's monitor/fixers/agent on the monitor host (user services).
# Idempotent. Run from the repo root: deploy/install-server.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --version
npm ci --no-audit --no-fund
npx puppeteer browsers install firefox
mkdir -p ~/.config/systemd/user ~/.config/rebound-twitch
# Make node visible to the units' login shells.
grep -q 'NVM_DIR' ~/.bash_profile 2>/dev/null || printf 'export NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n[ -f ~/.bashrc ] && . ~/.bashrc\n' >> ~/.bash_profile
cp deploy/systemd/*.service deploy/systemd/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
docker build -t rebound-agent:latest agent/
systemctl --user enable --now rebound-monitor.timer rebound-fixers.timer rebound-agent.timer
systemctl --user list-timers 'rebound-*'
