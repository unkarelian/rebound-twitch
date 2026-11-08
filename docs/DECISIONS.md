# Decisions

These are the places where the implementation differs from `twitch-adblock-plan.md`, or where it settles something the plan left open. Each entry says what was found in the code or on live Twitch that drove the choice. Newest first within each section.

## Remote config

**Config values reach vaft through `applyRemoteConfig(scope, cfg)`, a new serialized function.** It runs right after `declareOptions(window)` on the main thread, and in the worker blob as `applyRemoteConfig(self, ${JSON.stringify(RemoteConfig)})` straight after `declareOptions(self)`. That position is deliberate. The existing injection lines (`ForceAccessTokenPlayerType = '...'` and so on) come after it, so a user's localStorage overrides still beat remote config. Config that arrives later reaches running workers through a new `UpdateRemoteConfig` worker message. `tests/rebound.test.js` checks all of this against the real script: `tests/helpers/vaft-harness.js` loads `vaft.user.js`, lets it hook `Worker`, captures the blob it builds, and runs that blob.

**The PAT operation name is config too (`gql.playbackAccessToken.operationName`).** The plan lists only the hash. Testing on live Twitch (2026-11-08) showed two things:
1. A persisted hash is bound to its operation name. Sending it under another name returns `operation with name 'X' not found`.
2. Twitch's own web player doesn't use a persisted query for `PlaybackAccessToken`. It sends the raw query `PlaybackAccessToken_Template`, and `sha256(query text)` is accepted as a persisted hash (APQ) under that operation name.

So when vaft's hash goes stale, the 4a fixer can switch to `{operationName: "PlaybackAccessToken_Template", sha256Hash: sha256(observed query)}`. That needs the name to be configurable. It is still pure data: a name matching `^[A-Za-z_]{1,64}$`.

**The schema is enforced in two places, and a test keeps them in agreement.** `config/schema.json` is the documentation and CI artifact. `extension/src/shared/config.js` is a hand-written validator with no dependencies, so the extension carries no ajv and no code generation. A test runs both against every fixture and fails if they disagree. vaft's `applyRemoteConfig` type-checks every field again, as defence in depth.

**Anti-rollback.** The extension refuses any config whose `version` is not greater than the one it has. A replayed old signed config, for example from a compromised CDN, therefore does nothing. Rollback means re-signing old content under a new version (`rollback-config.yml`).

**Key rotation: two keys ship in the extension.** `k1` is current: its private key lives only in the GitHub environment secrets `config-auto` and `config-human`. `k2` is the next key: its private key is kept offline. Rotation steps are in `RUNBOOK.md`.

**The config CDN is `raw.githubusercontent.com`, branch `live`.** It is written only by the publish workflow, and the signature is what makes this safe. A deploy key that could push `live` still can't produce a valid signature. GitHub Pages would mean a second publishing path for no gain.

**Status is published to an orphan `status` branch as one force-pushed commit.** A history of every 12-minute status would bloat the repo. Status is display-only and unsigned. The extension whitelists three fields and length-limits them.

## Extension packaging

**Firefox MV2 injects with `browser.contentScripts.register()` plus an inline `<script>`.** At startup and on every config change, the background registers `[{code: 'var REBOUND_BOOT = {verified config}'}, {file: 'content.js'}]`. The content script injects vaft into the page synchronously with the config already set, so the first worker gets it. twitch.tv sends no CSP header (checked 2026-11-08), so inline injection works. The background page is persistent because `contentScripts.register` registrations die with the page that made them.

**The witchblock `filterResponseData` worker patch was evaluated and not adopted for v1.** It would only replace the worker half of vaft's hooks. vaft also needs the main thread: window `fetch` (GQL header capture and player-type forcing), `localStorage`, DOM overlay handling and the buffering monitor. Patching the worker script at the network layer would need a second channel for config and would split the logic across two contexts. It is worth revisiting if Twitch ever blocks `Worker` constructor hooking (type 4 in BREAKAGE-LOG).

**Chrome MV3 is best-effort.** It uses `chrome.scripting.registerContentScripts` with `world: 'MAIN'` for `page/boot.js` and `page/vaft.js` (the bundled defaults), plus an isolated relay. MV3 cannot register a code string, so newer remote config always arrives through the relay a few milliseconds after `document_start`. That is before Twitch's bundles create the player worker in practice, and running workers get it via `UpdateRemoteConfig` anyway. Smoke-tested on 2026-11-08 in Chrome 156 (Puppeteer, headless, live channel): vaft loads in the MAIN world, applies config v2, hooks the player worker, and the stream plays. The full monitor still runs on Firefox only.

**Minimum versions are Firefox 140 and Chrome 137.** Both have Ed25519 in WebCrypto. Firefox 140 (ESR) is also the first version that supports the `data_collection_permissions` key AMO now expects. With these settings, `web-ext lint` (listed mode) reports 0 errors and 0 warnings.

**Versioning.** The vaft `@version` and `ourTwitchAdSolutionsVersion` are left at upstream's 68.5.7/93. `ourTwitchAdSolutionsVersion` is a conflict guard shared with upstream installs: bumping it to 94 would collide with upstream's next release and make two scripts fight. The Rebound changes are versioned by the extension version (`package.json`) and by the userscript build (`68.5.7-rebound.0.1.0`). This departs from upstream's "bump both" rule on purpose.

## Monitor

**Check A measures leaked ad segments, not leftover signifiers.** The plan says "no playlist delivered to the player still contains configured ad signifiers". vaft's strip mode keeps the DATERANGE tags by design and serves a blank MP4 for each ad segment URL it has cached. So the honest measure is non-live `#EXTINF` segments in the output that are not in `AdSegmentCache`. The worker computes this per playlist in `MonitorMode`.

**The test run actively exercises the backup path.** vaft forces the `popout` player type, so the configured PAT hash is only used during ad breaks. A broken hash could go unnoticed through any run with no ad break. At about 45% of the run, the monitor calls vaft's existing `simulateAds(1)` hook for 12 seconds. That forces backup access-token requests, so a stale hash or client ID shows up as FAIL(D). Measured on 2026-11-08: an injected wrong hash was detected on the first run (`PersistedQueryNotFound` ×20).

**The browser is real Firefox (Puppeteer 25, WebDriver BiDi), headless.** Puppeteer can install the unsigned extension via BiDi `webExtension.install`. Playwright's patched Firefox can't load extensions. Headless was enough to get ads served and video decoded in testing. If Twitch starts fingerprinting headless sessions, switch to headed mode under Xvfb (`--headed` + `xvfb-run`).

**The control observer wraps `Worker` and reads the worker source synchronously.** Twitch revokes the worker's blob URL right after `new Worker()`. An `importScripts(blobUrl)` wrapper loads nothing and silently kills playback (seen on 2026-11-08), which is the same reason vaft prefetches with a synchronous XHR.

**The channel pool comes from a single query: `games(first: 20) { streams(first: 15) }`.** That gives about 300 channels across categories and a wide range of audience sizes. Paging the flat `streams` list with a cursor fails Twitch's integrity check for anonymous clients, and `first` is capped at 30.

**Network: the monitor runs from the home server's residential connection.** The plan budgets for a residential proxy in two regions. The home IP gets pre-roll ads reliably (control saw ads on every channel tested on 2026-11-08), so there is one region (US) and no proxy for now. If INCONCLUSIVE goes above 30%, add an EU proxy. `runSession` takes a launch option for it.

**Object storage means local disk on the monitor host.** Artifacts go to `monitor/artifacts/<runId>/<channel>/` and are kept for 14 days (pruned by the service). They are redacted before writing (`monitor/lib/redact.js`): USER-IP, session IDs, tokens and signatures, cookies and auth headers.

**The verdict counts a failure in any check as FAIL, even when the control saw no ads.** INCONCLUSIVE is reserved for "every check passed but Twitch served no ads to compare against". A broken stream (B) or a GQL rejection (D) is a real failure whether or not ads ran.

## Fixers and the agent

**History says hash rotation is rare. Signifiers and player behaviour are where breakages actually come from.** BREAKAGE-LOG.md classifies 146 fixes and finds zero hash rotations. 61% were player behaviour or buffering, and about 8% could be fixed by config alone. All of the plan's fixers are built, but most real breakages will reach the agent, so the agent loop, replay scenarios and verification got the extra investment.

**Auto-publish is decided by the diff, not by trusting the evidence.** `tools/publish-gate.js` runs inside the workflow. It checks which keys actually changed against the live config before allowing auto-publish (hash or client ID with ≥3 channels; signifiers or reorder-only player types with ≥5 channels and check B on all). A compromised monitor host could therefore push only those narrow change types without a human. Anything else waits for one-click approval in the `config-human` environment.

**The agent sandbox is the `rebound-agent` Docker image.** The orchestrator mounts only a credential-free clone of the repo, the redacted artifacts and a Claude token. The sandbox has no SSH or deploy key, no signing key and no GitHub token. After the agent finishes, a second clean container repeats every check, including a 3-channel live run, and that independent result goes at the top of the PR. The agent's own claims are not trusted.

**PR metadata travels in an empty tip commit.** The host has no GitHub API token, so `auto-pr.yml` reads the title, body and labels from the branch's last commit. That keeps PR-only files out of the tree that gets merged.

**Weekly upstream sync merges, re-checks patches and opens a PR.** If upstream changed code that a Rebound patch anchors on, `tools/apply-rebound-patches.js` fails loudly and names the patch. That beats a silent mis-merge.
