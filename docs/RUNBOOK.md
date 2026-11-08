# Runbook

## Where things are

| Piece | Location |
|---|---|
| Repo | `github.com/unkarelian/rebound-twitch` (fork of `ryanbr/TwitchAdSolutions`, default branch `master`, protected) |
| Live signed config | branch `live`: `config.json`, `config.json.sig`, `history/vN.json(.sig)` |
| Public status | branch `status`: `status.json` (force-pushed by the monitor) |
| Monitor, fixers, agent | `kurvaz@home-server:~/Projects/rebound-twitch`, user systemd timers `rebound-*` |
| Monitor state | `~/Projects/rebound-twitch/monitor/state/` (`state.json`, `history.jsonl`, `observed.json`, `last-run.json`) |
| Failure artifacts | `~/Projects/rebound-twitch/monitor/artifacts/<runId>/<channel>/` (14-day retention, redacted) |
| Agent runs | `~/Projects/rebound-twitch/agent/work/<id>/` (`OUTCOME.json`, `FINAL_PR.md`, `agent-transcript.jsonl`) |
| Signing keys | `k1`: GitHub environment secret `REBOUND_SIGNING_KEY` in `config-auto` and `config-human`. Offline copies of `k1` and `k2` at `~/.config/rebound-twitch/keys/` on the desktop. Never on the server. |
| Deploy key | server `~/.ssh/rebound_deploy` (write access; cannot push `master`) |

Quick health check (server):

```sh
systemctl --user list-timers 'rebound-*'
journalctl --user -u rebound-monitor -n 30 --no-pager
cat ~/Projects/rebound-twitch/monitor/state/state.json
tail -5 ~/Projects/rebound-twitch/monitor/state/history.jsonl
```

## Approve things

- **Agent PR** (label `agent`): the top of the PR has an independent re-check (live verdicts per channel, tests, lint). If it's green and the diff makes sense, merge. Users don't get a code change until you also run **Actions → Release extension** (the `release` environment asks you to approve). Use the userscript in the GitHub Release as a stopgap while store review is pending.
- **Config needing a human** (signifier or player-type changes that didn't meet the auto gate, or anything outside the auto rules): **Actions → Publish config → the waiting run → Review deployments → Approve**. The run summary shows the gate's reasons, the diff keys and the live-test table. This works from the GitHub mobile app.
- **Config sync PRs** (`config-sync/vN`): informational only. The config is already live. Merge when convenient.
- **Upstream sync PRs** (weekly, label `upstream-sync`): check the table. Before merging, run the monitor once against the branch on the server: `git fetch && git checkout upstream-sync/<date> && node monitor/run.js --channels 3 --no-state`.

## Roll back a config

Every published version is in `live:history/`. To make the content of `vN` live again:

- One click: **Actions → Rollback config → Run workflow → `to_version` = N**, then approve. This re-signs vN's content as a new, higher version, because extensions refuse lower versions.
- CLI, from the desktop: `gh workflow run rollback-config.yml -f to_version=N -R unkarelian/rebound-twitch`

Extensions pick it up within 15 minutes (their alarm), and new page loads get it immediately after that.

## Pause automation

Everything (server):

```sh
systemctl --user stop rebound-monitor.timer rebound-fixers.timer rebound-agent.timer
```

Only auto-publishing of config: in **Settings → Environments → config-auto**, add yourself as a required reviewer. Every candidate then waits for you.

Only the agent: `systemctl --user stop rebound-agent.timer`. A running agent: `docker kill $(docker ps -q --filter name=rebound-agent)`.

Resume with `systemctl --user start ...`, or by removing the reviewer.

## Rotate the signing key

The extension ships `k1` (current) and `k2` (next) in `extension/src/shared/keys.js`.

1. Put `k2`'s private key (`~/.config/rebound-twitch/keys/k2.private.pem` on the desktop) into both environments' `REBOUND_SIGNING_KEY` secret, and set the repo variable `REBOUND_SIGNING_KEY_ID=k2`:
   ```sh
   for e in config-auto config-human; do gh secret set REBOUND_SIGNING_KEY --env $e -R unkarelian/rebound-twitch < ~/.config/rebound-twitch/keys/k2.private.pem; done
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

Without it, the orchestrator falls back to the host login's current access token, but only if that token outlives the 90-minute budget. Otherwise the run fails, and the failure is logged in `state.json`.

## Run things by hand

```sh
node monitor/run.js --channels 3 --no-state                  # a monitor run that doesn't touch state/status
node monitor/run.js --channel somechannel --save-all         # keep artifacts even on PASS
node monitor/run.js --fault --channels 2 --no-state          # injected wrong hash: should FAIL(D)
node fixers/run.js --dry-run                                 # fixers, without pushing candidates
node agent/orchestrate.js --force --reason "..."             # start the agent now
node agent/orchestrate.js --scenario worker-serialization --no-push   # replay a historical breakage
```

## Reading a monitor verdict

`PASS`: the control saw ads and the extension blocked them, with no ad UI, normal playback and no errors. `INCONCLUSIVE`: everything passed, but Twitch served no ads to compare against. `FAIL(X)`:

- **A**: ad segments reached the player (`leakedPlaylists > 0`). Look at `m3u8/test-N-before/after.m3u8`. A new ad marker means 4b. Otherwise it's code.
- **B**: content didn't play (frozen > 8s, under 60% of real time, or no frames rendered). Look at `samples.json`, `console-test-ad-debug.log` and `screenshot.png`. This is the player-behaviour class, most of BREAKAGE-LOG.
- **C**: ad UI visible (`video-ad-label`, `video-ad-countdown`, SDA, or an extra non-MediaSource `<video>`). Usually CSAI.
- **D**: our errors. `PersistedQueryNotFound` or `operation with name ... not found` means a stale hash or operation name, which 4a handles. A page error naming vaft functions means code.

A breakage is confirmed after two consecutive runs that each FAIL on two or more channels. Fixers start immediately. The agent starts 30 minutes after confirmation if the breakage is still unresolved.
