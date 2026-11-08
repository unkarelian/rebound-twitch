#!/usr/bin/env bash
# Publish the monitor's public status.json to the orphan `status` branch as a
# single force-pushed commit (no history growth). Display-only data, unsigned.
set -euo pipefail
status=$1
repo=$(cd "$(dirname "$0")/.." && pwd)
remote=$(git -C "$repo" remote get-url origin)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q -b status
cp "$status" "$tmp/status.json"
git -C "$tmp" add status.json
git -C "$tmp" -c user.name="rebound-monitor" -c user.email="rebound-monitor@users.noreply.github.com" commit -qm "status $(date -u +%FT%TZ)"
GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh} git -C "$tmp" push -q -f "$remote" HEAD:refs/heads/status
