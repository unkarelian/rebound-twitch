# Runbook

## Where things are

| Piece | Location |
|---|---|
| Repo | `github.com/unkarelian/rebound-twitch` (fork of `ryanbr/TwitchAdSolutions`, default branch `master`, protected) |
| Live signed config | branch `live`: `config.json`, `config.json.sig`, `history/vN.json(.sig)` |
| Public status | branch `status`: `status.json` (force-pushed by the monitor) |
| Userscript (updates itself) | `https://github.com/unkarelian/rebound-twitch/releases/latest/download/rebound-vaft.user.js` |
| Firefox update manifest | branch `updates`: `updates.json` (force-pushed by the release workflow) |
| Monitor, fixers, agent | `kurvaz@home-server:~/Projects/rebound-twitch`, user systemd timers `rebound-*` |
| Monitor state | `~/Projects/rebound-twitch/monitor/state/` (`state.json`, `history.jsonl`, `observed.json`, `last-run.json`) |
| Failure artifacts | `~/Projects/rebound-twitch/monitor/artifacts/<runId>/<channel>/` (14-day retention, redacted) |
| Agent runs | `~/Projects/rebound-twitch/agent/work/<id>/` (`OUTCOME.json`, `FINAL_PR.md`, `agent-transcript.jsonl`) |
| Signing keys | `k1`: GitHub environment secret `REBOUND_SIGNING_KEY` in `config-auto`. Offline copies of `k1` and `k2` at `~/.config/rebound-twitch/keys/` on the desktop. Never on the server. |
| Deploy key | server `~/.ssh/rebound_deploy` (write access; cannot push `master`) |

Quick health check (server):

```sh
systemctl --user list-timers 'rebound-*'
journalctl --user -u rebound-monitor -n 30 --no-pager
cat ~/Projects/rebound-twitch/monitor/state/state.json
tail -5 ~/Projects/rebound-twitch/monitor/state/history.jsonl
```

## Cadence

When stable, the browser checks (monitor and fixers) run **twice a day**. Between them, a cheap probe runs every ~8 minutes. Any failure, open breakage or fix in the last 24h switches to full checks about every 13 minutes, until things have been clean for 24h. `journalctl --user -u rebound-monitor -n 5` shows which mode it's in ("skip full run (stable; next full monitor run due ...)" or "full run: unstable: ..."). To force a full run now: `systemctl --user start rebound-monitor.service` won't do it while stable, so run `node monitor/run.js --channels 3` directly. To change the interval, put `REBOUND_STABLE_INTERVAL_H=6` in `~/.config/rebound-twitch/monitor.env`.

## Nothing needs approving

Every path from "Twitch changed something" to "users have the fix" runs unattended.

| What happens | Who acts | How it reaches users |
|---|---|---|
| Hash, client ID, signifier or player-type order goes stale | fixers (`fixers/run.js`) | Candidate is live-tested, `tools/publish-gate.js` answers `auto` or `reject`, the workflow signs and publishes. Extensions fetch within 15 minutes. |
| A published config makes things worse | fixers, 4d | A breakage that begins within 24h of a publish gets the previous version's content re-published, if that content passes 5 channels now. |
| Anything config can't fix | agent (`agent/orchestrate.js`) | The fix is re-checked in a clean container with a live run. If it passes and only touches what `tools/automerge-guard.js` allows, the branch is pushed as `verified/agent-<id>`; `auto-pr.yml` merges it and starts **Release extension**. Otherwise it is a draft PR that changes nothing, and the agent tries again 6h later. |
| Upstream releases a new vaft | weekly workflow + host | `upstream-sync/<date>` is verified by the host like an agent fix, then merged and released as `verified/upstream-sync-<date>`. If it fails or conflicts, the agent repairs it. |
| A release | `rebound-release.yml` | Firefox: signed unlisted on AMO, offered through `updates.json` on the `updates` branch (the manifest's `update_url`); Firefox checks about daily. Userscript: `@updateURL` is the latest GitHub Release. |
| The host's own code or units change | `deploy/self-update.sh` | Runs before each monitor tick: fast-forwards to `origin/master`, reinstalls dependencies and units if they changed. |
| The monitor's Firefox stops starting | `monitor/run.js` (`ensureBrowser`) | Re-downloads it. If that fails the run stops without recording a failure, so a broken monitor never sends the agent after a healthy extension. |

What automation **cannot** change by itself, on purpose: workflows, the signing and publishing tools, the keys and URLs the extension trusts, the monitor and fixers, `agent/`, `deploy/` and dependencies. A change to any of those is yours to make and push.

What still needs you, once:

- **AMO credentials** (`AMO_JWT_ISSUER`, `AMO_JWT_SECRET` as secrets of the `release` environment; create them at addons.mozilla.org → Tools → Manage API Keys). Without them a release still happens, but there is no signed Firefox build, so only the userscript updates itself.
- **The agent's Claude login.** `claude setup-token` on the host (see below) lasts a year. Without it the orchestrator refreshes and borrows the host login, which works for as long as that login does.
- **Signing-key rotation**, if you ever want it (below).

To watch it work: `gh run list -R unkarelian/rebound-twitch`, and PRs labelled `verified` (merged by themselves) or `unverified` (drafts).

## Roll back a config

Every published version is in `live:history/`. To make the content of `vN` live again:

The fixers do this by themselves when a breakage follows a publish (4d). By hand:

- **Actions → Rollback config → Run workflow → `to_version` = N**. This re-signs vN's content as a new, higher version, because extensions refuse lower versions.
- CLI, from the desktop: `gh workflow run rollback-config.yml -f to_version=N -R unkarelian/rebound-twitch`

Extensions pick it up within 15 minutes (their alarm), and new page loads get it immediately after that.

## Pause automation

Everything (server):

```sh
systemctl --user stop rebound-monitor.timer rebound-fixers.timer rebound-agent.timer
```

Only config publishing: in **Settings → Environments → config-auto**, add yourself as a required reviewer. Every candidate then waits for you. Only releases: the same on the `release` environment. Only merges: disable the **Open and merge PR for automation branch** workflow (branches then pile up unmerged).

Only the agent: `systemctl --user stop rebound-agent.timer`. A running agent: `docker kill $(docker ps -q --filter name=rebound-agent)`.

Resume with `systemctl --user start ...`, or by removing the reviewer.

## Rotate the signing key

The extension ships `k1` (current) and `k2` (next) in `extension/src/shared/keys.js`.

1. Put `k2`'s private key (`~/.config/rebound-twitch/keys/k2.private.pem` on the desktop) into the `config-auto` environment's `REBOUND_SIGNING_KEY` secret, and set the repo variable `REBOUND_SIGNING_KEY_ID=k2`:
   ```sh
   gh secret set REBOUND_SIGNING_KEY --env config-auto -R unkarelian/rebound-twitch < ~/.config/rebound-twitch/keys/k2.private.pem
   gh variable set REBOUND_SIGNING_KEY_ID -b k2 -R unkarelian/rebound-twitch
   ```
2. Publish once (roll back to the current version) so a `k2`-signed config is live.
3. Generate `k3` (`node tools/config-tool.js keygen ~/.config/rebound-twitch/keys k3`). Replace `k1` with `k3` in `keys.js`, then release the extension.
4. After most users have updated, destroy `k1`.

If `k1` is **compromised**, do steps 1 and 2 immediately. Configs signed by an attacker with `k1` keep verifying until an extension release drops `k1`, so do step 3 at once and ask AMO for an expedited review. Until then, the anti-rollback version guard helps a little: publish a high version number so an attacker would have to beat it.

## The agent's Claude login

The agent container needs `CLAUDE_CODE_OAUTH_TOKEN`. Create a long-lived one on the server once:

```sh
claude setup-token        # interactive; copy the token it prints
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' '<token>' > ~/.config/rebound-twitch/agent.env && chmod 600 ~/.config/rebound-twitch/agent.env
```

Without it, the orchestrator borrows the host login's access token, first refreshing it (by using the host's `claude` once) if it would not outlive the 90-minute budget. If that fails too the run fails, the failure is logged in `state.json`, and the next timer tick tries again.

## Run things by hand

```sh
node monitor/run.js --channels 3 --no-state                  # a monitor run that doesn't touch state/status
node monitor/run.js --channel somechannel --save-all         # keep artifacts even on PASS
node monitor/run.js --fault --channels 2 --no-state          # injected wrong hash: should FAIL(D)
node fixers/run.js --dry-run                                 # fixers, without pushing candidates
node agent/orchestrate.js --force --reason "..."             # start the agent now
node agent/orchestrate.js --scenario <name> --no-push      # replay a historical breakage (names: ls agent/scenarios)
```

## Reading a monitor verdict

`PASS`: the control saw ads and the extension blocked them, with no ad UI, normal playback and no errors. `INCONCLUSIVE`: everything passed, but Twitch served no ads to compare against. `FAIL(X)`:

- **A**: ad segments reached the player (`leakedPlaylists > 0`). Look at `m3u8/test-N-before/after.m3u8`. A new ad marker means 4b. Otherwise it's code.
- **B**: content didn't play (frozen > 8s, under 60% of real time, or no frames rendered). Look at `samples.json`, `console-test-ad-debug.log` and `screenshot.png`. This is the player-behaviour class, most of BREAKAGE-LOG.
- **C**: ad UI visible (`video-ad-label`, `video-ad-countdown`, SDA, or an extra non-MediaSource `<video>`). Usually CSAI.
- **D**: our errors. `PersistedQueryNotFound` or `operation with name ... not found` means a stale hash or operation name, which 4a handles. A page error naming vaft functions means code.

A breakage is confirmed after two consecutive runs that each FAIL on two or more channels. Fixers start immediately (rollback check first). The agent starts 30 minutes after confirmation if the breakage is still unresolved, and again every 6 hours until it is.
