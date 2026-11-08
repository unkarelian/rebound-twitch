#!/usr/bin/env bash
# Push a config candidate (config.json + evidence.json) as branch $2, based on
# origin/master. Run on the monitor host with the repo deploy key. The deploy
# key cannot push master (branch protection) and the host never holds the
# signing key: .github/workflows/publish-config.yml decides and signs.
set -euo pipefail
src=$1 branch=$2
repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"' EXIT
git -C "$repo" fetch -q origin master
git -C "$repo" worktree add -q --detach "$tmp" origin/master
mkdir -p "$tmp/candidate"
cp "$src/config.json" "$src/evidence.json" "$tmp/candidate/"
git -C "$tmp" add candidate
git -C "$tmp" -c user.name="rebound-fixer" -c user.email="rebound-fixer@users.noreply.github.com" commit -qm "config candidate: ${branch#config-candidates/}"
git -C "$tmp" push -q origin "HEAD:refs/heads/$branch"
