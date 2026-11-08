#!/usr/bin/env bash
# Runs ONLY inside .github/workflows/publish-config.yml / rollback-config.yml, the
# only places REBOUND_SIGNING_KEY exists (environment secret).
#
#   tools/publish-live.sh publish <candidate.json>
#   tools/publish-live.sh rollback <version>
#
# 1. Checks out the `live` branch (what extensions fetch) into ./live-branch.
# 2. Copies its history/ into config/published/ so version numbers never repeat.
# 3. Signs the next version with config-tool.js and commits config.json(.sig) +
#    history/vN.json(.sig) to `live`.
# 4. Opens an informational PR syncing config/published/ and config/defaults.json
#    into master (the next extension release bundles it).
set -euo pipefail
mode=$1 arg=$2
: "${REBOUND_SIGNING_KEY:?signing key missing - is this job in a config-* environment?}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

rm -rf live-branch
if git ls-remote --exit-code --heads origin live >/dev/null 2>&1; then
  git worktree add -q live-branch origin/live
  git -C live-branch checkout -q -B live
else
  git worktree add -q --detach live-branch
  git -C live-branch checkout -q --orphan live
  git -C live-branch rm -rfq . >/dev/null 2>&1 || true
fi
mkdir -p live-branch/history config/published
cp live-branch/history/* config/published/ 2>/dev/null || true

case "$mode" in
  publish)  node tools/config-tool.js publish "$arg" --out live-branch --key-id "${REBOUND_SIGNING_KEY_ID:-k1}" ;;
  rollback) node tools/config-tool.js rollback "$arg" --out live-branch --key-id "${REBOUND_SIGNING_KEY_ID:-k1}" ;;
  *) echo "unknown mode $mode"; exit 2 ;;
esac
node tools/config-tool.js verify live-branch/config.json
ver=$(node -pe 'require("./live-branch/config.json").version')
cp "config/published/v$ver.json" "config/published/v$ver.json.sig" live-branch/history/
cat > live-branch/README.md <<MD
# live config
Served to Rebound for Twitch extensions from raw.githubusercontent.com. Written only by
the publish-config / rollback-config workflows. \`config.json.sig\` is an Ed25519 signature
over the exact bytes of \`config.json\`; extensions reject anything that does not verify.
MD
git -C live-branch add -A
git -C live-branch commit -qm "config v$ver ($mode)"
git -C live-branch push -q origin live
echo "version=$ver" >> "${GITHUB_OUTPUT:-/dev/null}"

# Informational sync PR into master.
sync="config-sync/v$ver"
git checkout -q -b "$sync" origin/master
cp "live-branch/history/v$ver.json" "live-branch/history/v$ver.json.sig" config/published/
cp "live-branch/config.json" config/defaults.json
git add config/published config/defaults.json
git commit -qm "config: sync published v$ver ($mode)"
git push -q origin "$sync"
gh pr create --base master --head "$sync" --title "config: sync published v$ver" \
  --body "Config v$ver is **already live** ($mode). This PR only records it in \`config/published/\` and makes it the bundled default for the next extension release. Merge at leisure." || true
