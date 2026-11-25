#!/usr/bin/env bash
# Keeps the monitor host's checkout on origin/master without anyone logging in.
# Runs before each monitor tick (rebound-monitor.service, ExecStartPre). Fast
# when there is nothing new. Only ever fast-forwards: a checkout that is on
# another branch, has local commits or has edited tracked files is left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
log() { echo "$(date -u +%FT%TZ) [self-update] $*" >&2; }

[ "$(git rev-parse --abbrev-ref HEAD)" = master ] || { log "not on master; skipping"; exit 0; }
git fetch -q origin master
old=$(git rev-parse HEAD) new=$(git rev-parse origin/master)
[ "$old" = "$new" ] && exit 0
git merge-base --is-ancestor "$old" "$new" || { log "local commits not on origin/master; skipping"; exit 0; }
git diff --quiet || { log "tracked files edited locally; skipping"; exit 0; }
# A full run or the agent may be reading this tree: wait for the next tick.
if systemctl --user is-active --quiet rebound-agent.service rebound-fixers.service rebound-fixers-breakage.service; then log "agent or fixers running; will update on a later tick"; exit 0; fi

git merge -q --ff-only "$new"
log "updated $(git rev-parse --short "$old") -> $(git rev-parse --short "$new")"
changed() { ! git diff --quiet "$old" "$new" -- "$@"; }
if changed package-lock.json package.json; then
  log "dependencies changed: npm ci"
  npm ci --no-audit --no-fund >/dev/null
  npx puppeteer browsers install firefox >/dev/null
fi
if changed agent/Dockerfile; then log "agent image changed: rebuilding"; docker build -q -t rebound-agent:latest agent/ >/dev/null; fi
if changed deploy/systemd; then
  log "units changed: reinstalling"
  cp deploy/systemd/*.service deploy/systemd/*.timer ~/.config/systemd/user/
  # Takes effect from the next activation; never restart the unit this runs in.
  systemctl --user daemon-reload
  systemctl --user enable --now rebound-monitor.timer rebound-fixers.timer rebound-agent.timer >/dev/null 2>&1 || true
fi
