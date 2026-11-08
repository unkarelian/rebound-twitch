# Breakage Log

What has broken in vaft / video-swap-new / strip, sorted by type, so the automated fixing system knows which fixers to build first and so an agent can diagnose a new breakage by comparing it with past ones.

## Scope, method, caveats

**Analysed:** every entry in `CHANGELOG.md` from **v42.0.0 (2026-03-24)** to **v68.5.7 (2026-08-27)**, about five months and ~45 releases. I also read `CLAUDE.md` and `issues.md`. The `[AD DEBUG]` log strings quoted below were checked with grep against `vaft/vaft.user.js` (68.5.7).

**Method.** Each changelog bullet that responds to a Twitch-side change or a user-visible breakage gets exactly one type. Rules:

- **Excluded** (listed at the end): pure refactors, docs, tests, perf-only work, logging- or diagnostic-only changes, memory or console-noise hygiene with no user symptom, and new features that don't respond to a breakage (for example the ad-completion spoofing roll-out).
- **Counted once:**
  - A fix that shipped for both vaft and video-swap-new is one entry, marked "both", including when the video-swap-new port came in a later release (v58.0.1 #107 → v60.0.0 #132; v58.0.0 #94 → v60.0.0 #133).
  - A later default flip of a fix already counted is folded into the original entry (v62.0.0 PreferLowQualityBackup default-on; v68.0.0 FastAutoplayFirstTry default-on).
  - The same bullet repeated in two releases is counted once (v58.0.0/v58.0.1 LL-HLS bullets; v56.0.0/v58.0.0 PiP downgrade).
- **"(?)"** marks a type I had to guess because the changelog is ambiguous.

**Trigger tag** on every entry. This matters because a monitor that only watches Twitch will miss most of these:

- `[T]`: Twitch-side change. The changelog says Twitch changed something: a new marker, a new response shape, new DOM, a player-type behaviour change.
- `[R]`: regression, or a side effect of this fork's own earlier change. The entry names the PR or version it repairs, or the cause is clearly our own code.
- `[F]`: breakage seen in the field (user report or maintainer log) with no cause attributed to either side.
- `[P]`: prophylactic, or ported from GosuDRM/TTV-AB with no local field report.

**Config-fixable?** asks whether a remote-config change alone could have shipped the fix. The configurable values are: `playbackAccessToken` hash, `recordAdEvent` hash, `clientId`, `adSignifiers`, `knownNonAdSignifiers`, `adSegmentUrlPatterns`, `backupPlayerTypes` (order and contents), `defaultPlayerType` (= `ForceAccessTokenPlayerType`), and `overlaySelectors` (exact `[data-*="…"]` only). Answers are **Y**, **N**, or **partial** (config gets part of the fix; the rest needs code). Note that `FallbackPlayerType`, cooldowns, thresholds and localStorage feature flags are *not* in the config.

**Caveats:**

- The changelog often doesn't say what triggered a fix. It describes the fix, and "field log on X" is as close as it gets to a cause. Many `[F]` entries could really be `[T]` (Twitch changed ad delivery) or `[R]`. The tag reflects only what is written.
- Releases v43, v68.5.2–v68.5.5 and v60.2.0 have no headings. CLAUDE.md mentions a v68.5.5 change (the iOS token-refresh split) that is logged under v68.5.6 here. An untitled `### Bug Fixes` block sits between v60.3.0 and v60.1.0; I treat it as ~v60.2.0.
- Early releases (v42–v57) don't tag which script a change applies to. Unless stated otherwise, assume vaft.
- Counts are of *fixes*, not *incidents*. One Twitch change (for example the extra `<video>` ad elements, #249) produced 3 counted entries across v68.5.1 and v68.5.6. One self-inflicted change (the PR #144 soft-reload switch) produced 4 follow-up fixes.
- Bullet-level judgement is involved. Another reader might move ±5 entries between types 5 and 6, or between included and excluded. The headline conclusion doesn't change.

## Summary

146 classified entries.

| # | Type | Count | % | Config-fixable? | Example versions |
|---|---|---|---|---|---|
| 1 | Hash rotation / client ID / GQL shape | 1 | 0.7% | 0 of 1. **No hash or client-ID rotation appears anywhere in the history.** The one entry is a response-shape change, which needs code | v63.0.0 (#169) |
| 2 | New / changed ad signifier | 11 | 7.5% | **9 Y**, 2 N | v46.0.0, v53.0.0, v61.0.0, v63.0.0 (#166), v66.0.0 (#207) |
| 3 | Player-type change | 14 | 9.6% | 2 Y, 5 partial, 7 N | v58.0.1 (#107), v63.0.0 (#171), v64.0.0 (#178), v65.3.0 (#198) |
| 4 | Worker / injection / extension conflict | 13 | 8.9% | 0 | v51.0.0, v55.0.0 (#78), v58.0.1 (#109), v62.0.0 (#160, #161) |
| 5 | Player behaviour / buffering / reload / mute | 89 | 61.0% | 0 | v58.0.0 (#94, #96), v60.1.0 (#146), v65.0.0 (#194), v68.5.0 (#251), v68.5.1 (#248) |
| 6 | Other (codec 5, overlay/DOM ads 5, ad-state machine 3, LL-HLS 2, playlist URL format 1, player-internal discovery 1, detection evasion 1) | 18 | 12.3% | 1 partial | v59.0.0 (#118), v64.0.0 (#186), v68.5.0 (AV1), v68.5.6 (#249) |
| | **Total** | **146** | 100% | **11 Y (7.5%) + 6 partial (4.1%)** | |

**Trigger split across all 146:** `[F]` 71, `[R]` 41, `[T]` 23, `[P]` 11. Only 23 entries (16%) were explicitly caused by Twitch changing something, and only 6 of those were fully config-fixable (all signifier or URL-pattern changes; 3 more were partial player-type changes). More than a quarter (28%) were repairs of this fork's own earlier changes. Type 5 alone holds 32 of the 41 `[R]` entries.

## Priority order for automation

Ranked by how often each class actually occurred and how much of it config can fix.

**Phase 4 deterministic fixers, in order:**

1. **`adSignifiers` / `knownNonAdSignifiers` fixer.** This is the only class where config does most of the work: 9 of 11 entries. It must handle **both directions**: 7 entries add markers Twitch introduced (v42, v44 ×2, v46 ×2, v63, v66) and 4 remove markers that false-positived (v53, v56, v59, v61).
   - It needs hysteresis. `twitch-trigger` was added in v46.0.0, removed in v61.0.0 as a lingering post-ad marker, then re-added in v66.0.0 after weeks of observation showed it only ever appears inside breaks. The v66 change only shipped after that observation period, across 8+ channels, and the fixer should demand similar evidence before promoting a string.
   - Prefer prefix signifiers (`twitch-stitched`, v63.0.0) over enumerating variants.
   - Never add bare substrings that can hit CDN hostnames or metadata: `stitched` (v59.0.0) and `maf-ad` (v53.0.0) both caused false positives.
   - The `adSegmentUrlPatterns` half of this fixer has one historical data point (v44.0.0). Cheap to include.
2. **`backupPlayerTypes` order/contents fixer.** 2 Y + 5 partial out of 14.
   - Historical config-only wins: dropping `autoplay` (v58.0.1/v60.0.0) and moving `embed` last when it returned `server error` (v63.0.0).
   - In the partial cases, a static reorder captures some of the benefit, but the behaviour that actually shipped was dynamic: in-break contamination reorder, lockout, autoplay-first-when-last-break-exhausted.
   - The fixer should act on *persistent per-type* failure or contamination across sessions. Leave in-break dynamics to code.
3. **GQL hash / `clientId` fixer.** **Zero occurrences in five months**, so this is insurance, not volume. Still worth keeping, because it is cheap, fully deterministic, and the failure is total (every backup search fails, see Signals below).
   - Keep `recordAdEvent` lowest priority. Spoofing has been off by default since v68.3.0, so a rotation there is invisible by default and affects only opt-in users.
4. **`overlaySelectors`.** 1 partial entry (v59.0.0 SDA wrapper). Low volume.
   - The two overlay regressions (v60.0.0 #141, #143) both came from *non*-attribute selectors that the schema already forbids. Restricting config to exact selectors is a guard against that, not a fixer workload.

**Must go to the code-fixing agent (~88% of entries):**

- **Type 5 (89 entries).** Reload routing (hard vs soft, cooldowns, early-reload budgets), buffer-monitor thresholds, mute/unmute across `setSrc`, drift correction, platform quirks (iOS, Edge, Firefox PiP, hidden tabs).
  - This is overwhelmingly the fork's own state machine. 32 of the 89 are `[R]`, more than any other type, and chains of 3–5 consecutive fixes are common:
    - #144 → #146 → #148 → #149
    - #194 → #195 → #199 → #208
    - #189 → #201 → #206 → #219 → #248 → #249
  - **Give the agent the changelog chain for the code region it touches.** The usual failure mode is a fix that reopens an older bug.
- **Type 4 (13).** Worker hooking, blob handling, IVS WASM, frame and userscript-manager injection, other extensions (TwitchNoSub, FFZ, BTTV, other ad blockers).
- **Type 6 (18).** Codec swaps (HEVC/AV1), the ad-start/end state machine, LL-HLS leaks, Usher URL format, React player discovery, out-of-m3u8 DOM ads.
- **The remainder of type 3 (7 N + the code half of 5 partial).** Backup-search logic: lockouts, cycling, pinning, cooldowns.
- **Type 1 response-shape changes.** A third `streamPlaybackAccessToken` shape would need code, like v63.0.0 did.

**Implication for the monitor:** `[T]` entries are rare (23), and only 6 of them are fully fixable from config. A monitor that watches only for Twitch-side drift would have caught a small minority of this history. It should also run a regression watch around this project's own releases: compare the frequency of reload, early-reload, backstop and buffering lines against the previous version.

## Per-type entries

Format: `version [trigger] config — description (scripts, refs)`. Config is Y / N / partial. Scripts default to vaft.

### 1. Hash rotation / client ID / GQL request shape (1)

- v63.0.0 [T] N — Accept `streamPlaybackAccessToken` at the top level as well as under `data`; embed returned the other shape and was being silently dropped. both (#169)

### 2. New / changed ad signifier (11)

- v42.0.0 [T] Y (?) — Initial multi-signifier set: SCTE-35, `stitched-ad`, `X-TV-TWITCH-AD`, `EXT-X-CUE-OUT`, `EXT-X-DATERANGE`.
- v44.0.0 [T] Y (?) — Add `SCTE35-OUT` signifier.
- v44.0.0 [T] Y — Add ad segment URL patterns `/adsquared/`, `/_404/`, `/processing`.
- v46.0.0 [T] Y — Add `maf-ad` plus DATERANGE classes `twitch-stream-source`, `twitch-trigger`, `twitch-maf-ad`, `twitch-ad-quartile` (taken from a uBO rule).
- v46.0.0 [T] N — Generalise the `X-TV-TWITCH-AD-*-URL` beacon rewrite regex to catch new attribute names (it's a regex, not a signifier).
- v53.0.0 [R] Y — Remove bare `maf-ad`: it matched MAF metadata and caused false ad detection every 2–3 min. both (#69)
- v56.0.0 [R] N — Revert the v55 `hasAdTags` regex to `Array.some`; shortened alternations caused false detections on subscribed channels (#82).
- v59.0.0 [F] Y — Drop bare `stitched`, which matched CDN hostnames. both (#120)
- v61.0.0 [P] Y — Narrow `AdSignifiers` to 4 ad-start markers; markers that linger post-ad caused false re-entry (from the TTV-AB changelog). both (#152)
- v63.0.0 [T] Y — `twitch-stitched-ad` → prefix `twitch-stitched` to catch the `-mid`/`-pod` variants. both (#166)
- v66.0.0 [T] Y — Re-add `EXT-X-DATERANGE:CLASS="twitch-trigger"`, seen only in ad polls across 8+ channels; fixes a first-poll false-recovery loop. both (#207)

### 3. Player-type change (14)

- v44.0.0 [F] N — Track failed backup player types and skip them for the rest of the break.
- v44.0.0 [F] Y (?) — Add `mobile_web` to backup player types.
- v48.0.0 [F] N — `FailedBackupPlayerTypes` expire after 15s instead of lasting the whole break, so transient failures don't exclude a type.
- v57.0.0 [F] N — Fast-exit the backup search on known CSAI-only channels (3+ zero-strip breaks); previously a ~2 min stall.
- v58.0.0 [F] N — Cycle through backup types during a recovery freeze when the first backup is ad-laden (#95).
- v58.0.1 [F] Y — Remove `autoplay` from `BackupPlayerTypes`: its variant ladder causes endless loading circles. both (#107; video-swap-new #132 in v60.0.0)
- v58.0.2 [R] N — Revert #89 (commit the first ad-laden backup): Twitch staggers ads across types, and the early commit caused 2+ min freezes (#116, fixes #112).
- v60.3.0 [F] partial — PreferLowQualityBackup: `autoplay` (360p) as last-resort backup plus a sticky escape hatch for SSAI-heavy freezes; default-on in v62.0.0 (#149, #159). Appending `autoplay` is config; the escape hatch is code.
- v63.0.0 [T] partial — Move `embed` to the end (its access token returns `server error` from the twitch.tv origin) and set `FallbackPlayerType` to `site`. both (#171). The reorder is config; `FallbackPlayerType` is not.
- v64.0.0 [T] partial — Lock out types whose GQL returns `server error` (embed/autoplay were retried ~34×/break) (#178). Dropping `embed` is config; the generic lockout is code.
- v64.0.0 [F] partial — Contamination-aware reorder within a break: types already ad-laden this break go last (`site` contaminated on `warn`) (#177).
- v65.0.0 [R] N — Don't auto-pin `autoplay`: pinning moved it to position 0 and broke the last-resort fallback (#192).
- v65.3.0 [T] (?) partial — FastAutoplayFirstTry: try `autoplay` first when the last break exhausted every Source type (#197/#198). Default-on in v68.0.0 after surveillance showed Twitch had moved to CSAI delivery while keeping SSAI markers, with every Source type ad-laden (#222).
- v68.2.0 [P] N (?) — Backup-retry cooldown 15s → 5s: types recover within seconds under the CSAI-flip pattern (TTV-AB v8.0.0 tuning).

### 4. Worker / injection / extension conflict (13)

- v42.0.0 [F] N (?) — Wrap the `document.hasFocus` override in try/catch for WebKit.
- v51.0.0 [T] (?) N — Hook `URL.revokeObjectURL` so Twitch can't revoke our injected worker blob.
- v51.0.0 [F] N — Walk the Worker prototype chain to remove conflicting overrides and re-insert compatible ones (TwitchNoSub).
- v55.0.0 [F] N — Fall back to the unmodified worker when the synchronous XHR fails; fixes a page reload loop on iOS Safari. all scripts (#78)
- v55.0.0 [F] (?) N — `getCleanWorker` null guard (`class extends null` TypeError). video-swap-new, strip
- v58.0.1 [F] N — Skip injection in nested cross-origin frames; 4+ racing instances fought for the player. both (#109)
- v58.0.1 [R] N — Tampermonkey: `window !== window.top` was true on the top frame, so vaft never loaded; use `window.frameElement`. both (#113, fixes #112)
- v62.0.0 [F] N — IVS WASM worker `RuntimeError: index out of bounds` crash → deduped hard reload. both (#160)
- v62.0.0 [P] N — Worker-bridge fake `Response` was missing `url`/`ok`/`redirected`/`type`; IVS WASM threw NetworkError and halted (TTV-AB port). both (#161)
- v64.0.0 [F] N — Remove the visibility getter spoofs (broke BTTV "Mute Invisible Player"); skip the clip editor. both (#185)
- v65.3.0 [F] (?) N — FFZ recreates `<video>` on load, which cascaded into buffer-stall escalation; reset counters on element change. The fix lives in the buffer monitor (#199).
- v66.0.0 [P] N — Per-link try/catch on `Object.setPrototypeOf` when another extension froze `Worker.prototype`. both (#203)
- v68.5.6 [P] N — Don't re-inject hooks into a blob that already carries them (multiple ad blockers delegating through each other). all three (TTV-AB#63)

### 5. Player behaviour / buffering / reload / mute (89)

Reload and freeze recovery:

- v44.0.0 [F] N — Segment recovery cache to avoid a black screen when every segment is stripped.
- v45.0.0 [F] N — Buffer-fix escalation: 3 consecutive failures → full reload.
- v45.0.0 [F] N — `readyState` guard: don't seek during an active rebuffer.
- v46.0.0 [R] N — Recovery injection now rewrites `EXT-X-MEDIA-SEQUENCE`; the player was replaying or rejecting segments.
- v47.0.0 [F] N — Retry `play()` within 10s when the player stays paused after a pause/play fix.
- v47.0.0 [F] N — 30s reload cooldown to break CSAI reload cascades.
- v48.0.0 [F] N — One reload per recovery window (infinite reload loops).
- v48.0.0 [F] N — 15s post-reload grace before the buffer monitor acts.
- v48.0.0 [F] (?) N — Reset buffer-monitor state on channel change.
- v48.0.0 [F] (?) N — Force reload after a break that stripped real segments, even inside the cooldown.
- v49.0.0 [F] N — Invalidate the cached player ref on reload; a stale ref caused a black screen after ad-end reloads.
- v49.0.0 [F] (?) N — `pendingTick` guard against duplicate buffer-monitor scheduling on tab return.
- v50.0.0 [T] (?) N — Skip the reload on CSAI-only (0 stripped) breaks; ended an endless reload cascade.
- v50.0.0 [F] N — Auto-escalate the cooldown 30s → 90s after 3+ reloads in 5 min.
- v50.0.0 [F] N — 10s grace after a backup switch before buffer fixes.
- v51.0.0 [P] (?) N — 15s timeout on worker GQL fetches (hung backup lookups).
- v51.0.0 [R] N — Fresh player lookup on every tick (the v49 stale-ref fix was incomplete).
- v51.0.0 [F] N — Seek past buffer gaps at ad transitions instead of stalling.
- v51.0.0 [R] N — Respect the reload cooldown when segments were stripped (v48 forced it).
- v52.0.0 [F] N — No pause/play on CSAI-only breaks; it made Twitch seek back ~10s and repeat video.
- v53.0.0 [F] N — Extend the backup-switch grace to cover the ad-end micro-stall.
- v55.0.0 [F] N — Set the current playing quality before reload to avoid an ABR ramp from 360p. all scripts
- v56.0.0 [F] N — Downgrade reload to pause/play in PiP (`setSrc` exits PiP). all scripts
- v57.0.0 [F] N — Skip the buffer monitor and position-jump drift during ad breaks (thin backup buffer).
- v58.0.0 [T] (?) N — CSAI fast path: when every segment is live, skip the backup search (20–40s rebuffer on pure-CSAI breaks). both (#90, #103)
- v58.0.0 [F] N — Early reload after ~10s of strip+recovery freeze, pod-aware budget. both (#94; video-swap-new #133 in v60.0.0)
- v58.0.0 [F] N — Loading-circle health check: reload after ~3s of `readyState<3` during strip (#96).
- v58.0.0 [R] N — Cross-channel cooldown leak blocked the first end-of-break reload on a new channel (#97, #102).
- v58.0.0 [F] N — Skip the buffer monitor when the player has no data loaded (#92).
- v58.0.0 [F] N — Health guard: skip reload when the player is already playing fine.
- v58.0.1 [R] N — #96 misfired on initial load (`readyState=0` is normal); gate on `hasHadData` (#111).
- v58.0.1 [R] N — #98 skipped end-of-break reloads on natural recovery; restrict it to real cycle switches (#101).
- v59.0.0 [F] N — Latency-aware post-ad reload: reload if >7s behind live (#128, fixes #127).
- v59.0.0 [P] N — Snapshot the last clean native m3u8 for all-stripped recovery (TTV-AB `LastCleanNativeM3U8`). both (#125)
- v59.0.0 [F] (?) N — Sticky CSAI fast path for the whole break, plus a stale-backup-commit guard after a channel switch (#124).
- v59.1.0 [F] N — Thin recovery cache (<3 segments, prerolls): early reload after 1 poll instead of 5 (#130).
- v60.0.0 [F] N — Soft post-ad reload (`setSrc` without a new instance): 1–3s black screen → ~0.5–1s (#144).
- v60.1.0 [F] N — Early-reload budget `max(2, PodLength)` when the cache is thin; heavy-SSAI freezes (#134, issue #129).
- v60.1.0 [R] N — Reset `EarlyReloadTriggered` on a "still ads" result so the budget can fire again (#134, #147).
- v60.1.0 [R] N — Mid-break early reloads go back to hard: #144's soft reload kept the same ad-decision session (#146).
- ~v60.2.0 [R] N — Post-ad hard reload after strip activity: #144 caused accumulating A/V desync (#148).
- v60.3.0 [R] N — Loading-circle health check routed to hard reload (still soft after #144) (#149).
- v60.4.0 [R] N — De-escalate the auto-boosted cooldown once the burst subsides (it was permanent). video-swap-new (#150)
- v60.4.0 [R] (?) N — Normal backup-search path gets the same thin-cache budget as the sticky path (#151).
- v62.0.0 [F] N — Sticky escape hatch 6 → 4 polls (2-ad heavy-SSAI breaks ended before it fired) (#158).
- v62.0.0 [F] N — Exempt post-ad reload from the cooldown; stalled at `readyState=2 paused` on karq (#162).
- v62.0.0 [R] N — Hard reload after an autoplay (360p) fallback to restore the Source ladder; viewers were stuck at 360p (#163).
- v62.1.0 [R] N — Don't fire the loading-circle reload during an in-flight reload (triple reload on aspen) (#164).
- v62.1.0 [F] N — Force reload after *any* committed backup; mixed-source MSE desync compounds (#165).
- v63.0.0 [F] N — BackupSwapFirst default-on: swap to backup on detect instead of strip+BLANK_MP4 (loading circles, A/V desync) (#168).
- v64.1.0 [R] N — video-swap-new: early reload (`kind:'early'`) bypasses the cooldown gate that blocked freeze recovery (#188).
- v65.0.0 [F] N — Buffer-stall misfire every 8s: Twitch updates `state.position` in batches; now also require `currentTime` frozen (#193/#194).
- v65.1.0 [R] N — Post-MSE-init 0/0/paused state caused a reload loop after #194; skip when `readyState<2 || paused` (#195).
- v65.2.0 [F] N — `EarlyReloadPollThreshold` 5 → 3 (~6s) on SSAI-uniform channels (#196).
- v65.3.0 [R] N — Stall trigger OR → AND; healthy thin-buffer breathing fired pause/play → reload cycles (#199).
- v66.1.0 [R] N — `PlayerBufferingDangerZone` 1 → 0.5s; pause/play at 0.5–1s cascaded backwards (#208).
- v66.2.0 [P] (?) N — 5s AbortController timeout on the worker→main GQL bridge (a hung GQL froze breaks for ~30s). both (#217)
- v67.0.0 [R] N — Worker early-reload flags wedged after the main thread's healthy-skip; send `ReloadSkipped`.
- v68.1.0 [R] N — Defer `notifyAdComplete` off the playlist path (ad-break stutter after spoofing went to release).
- v68.4.0 [F] N — No hidden-tab poll backoff during a break; Firefox "stuck loading" until refocus (#237, issue #129).
- v68.4.0 [P] N — Skip the clean-snapshot serve on re-entry within 8s (stale replay; TTV-AB v9.1.3) (#236).
- v68.4.0 [F] N — iOS/iPadOS: downgrade hard reload to soft; a new media element isn't gesture-blessed → black screen + play icon (#238).
- v68.5.0 [F] N — Post-break video wedge (audio advancing, frames frozen) → nudge, then hard reload (TTV-AB v12.0.0) (#251).
- v68.5.0 [F] N — Desktop post-ad black screen + play icon on no-strip breaks: soft reload when nothing was stripped (#129, #251).
- v68.5.6 [R] N — iOS stuck at 360p after the escape hatch: the token refresh was tied to the hard-reload flag that iOS forces off.

Drift / position:

- v45.0.0 [F] N — Live drift correction after reload (seek if >2s behind).
- v49.0.0 [R] N — Clear the stale 30s drift timeout (premature `playbackRate` reset on back-to-back reloads).
- v49.0.0 [R] N — Gradual 1.1× drift catch-up instead of a jarring instant seek.
- v51.0.0 [F] N — Start drift correction on position jumps >1.5s.
- v52.0.0 [F] N — Skip position-jump drift during breaks (backup switch gaps falsely triggered 1.1×).
- v52.0.0 [R] N — Guard drift restart (perpetual 1.1× from repeated jumps).
- v53.0.0 [R] N — Drift jump threshold 1.5 → 5s (Twitch's own 2–3s repositioning).
- v57.0.0 [F] N — 10s backup-switch grace on position-jump detection.
- v57.0.0 [R] N — Reset position tracking on ad-end (race with the grace message).
- v59.1.0 [R] N — Restart drift correction on re-entry instead of ignoring it (#131).
- v61.0.0 [F] N — Hard-seek to the live edge after a hard reload when drift >5s (1.1× would take 5–10 min) (#154).
- v64.0.0 [R] N — Rate-limit position-jump drift re-arm to once per 30s (overlapping intervals) (#183).

Pause intent / mute / audio:

- v44.0.0 [F] (?) N — Auto-resume on tab return regardless of muted state.
- v49.0.0 [F] N — Track user pause intent; don't auto-resume a user pause.
- v59.1.0 [R] N — Only reset `weJustPaused` when not already paused (retry fired against user intent) (#131).
- v61.0.0 [F] N — Always run post-reload recovery (unmute) even when Twitch hadn't written LS keys. both (#155)
- v61.0.0 [R] N — Respect user mute intent (`{"default":true}`) in the post-reload unmute. both (#156)
- v64.0.0 [F] N — Preserve `lowLatencyModeEnabled`/`persistenceEnabled` across reloads (low-latency reset). both (#172)
- v64.1.0 [F] N — Pre-mute across hard reload to hide the MSE-teardown audio click. both (#189)
- v65.4.0 [R] N — The #189 `canplay` restore listener was on the detached `<video>`; listen on `document` (Edge stayed muted). both (#201, issue #200)
- v66.0.0 [R] N — Edge still muted: add `loadeddata`/`playing`, 4000ms safety, 5500ms backstop. both (#206)
- v66.2.0 [T] N — Recover from Twitch silently re-muting between breaks (`vaftEverUnmuted`) (#219, issue #200).
- v68.5.1 [T] N — Pre-mute leaked onto a different `<video>` (Twitch's extra ad `<video>`s; Firefox PiP) → audio stayed muted (#248, #253).
- v68.5.6 [T] N — `querySelector('video')` could resolve to a side/chat ad; 5 call sites (unmute, backstop, drift) → `getPlayerVideoElement()` (#249).

### 6. Other (18)

Codec (HEVC/AV1), 5:

- v60.0.0 [F] (?) N — Null `lowResInf` in the HEVC→AVC substitution threw TypeError and aborted the loop. video-swap-new (#135)
- v64.0.0 [P] N — HEVC→AVC rewrite now copies `AUDIO`/`VIDEO`/`SUBTITLES` groups (desync / black screen at handoff; TTV-AB v6.7.5) (#187).
- v65.0.0 [R] N — Post-ad HEVC reload loop: `IsUsingModifiedM3U8` reset re-fired the reload; 8s guard (#191).
- v68.5.0 [T] N — AV1 (`av0*`) 1440p enhanced streams went black for the whole break; treat AV1 as enhanced, swap to AVC only (#251).
- v68.5.6 [R] N — The media-playlist reload trigger still matched only `hev`/`hvc`, so AV1 never switched to the AVC swap.

Overlay / DOM-delivered ads, 5:

- v44.0.0 [T] N — Rename `.adblock-overlay` → `.tas-adblock-overlay` (collision with Twitch CSS) (#19).
- v59.0.0 [T] (?) partial — Hide ad-break card / Turbo promo / SDA overlays (opt-in). Only the SDA `[data-test-selector]` part is config-expressible (#68).
- v60.0.0 [R] N — Remove the `.player-overlay-background` promo hide (generic scrim → black screen, missing controls) (#143).
- v60.0.0 [R] N — Remove the "taking an ad break" text-match + parent-walk hide (could hide player controls) (#141).
- v68.5.6 [T] N — Since ~Jul 2026 Twitch renders standalone `<video>` ads beside the player and in chat (Amazon CDN); hide, mute and pause them. Includes the same-release `dataset.tasAdHidden=''` marker fix (#249).

Ad-start/end state machine (marker flicker), 3:

- v50.0.0 [F] N — Require 2+ clean playlists before ad-end (m3u8 metadata flicker).
- v64.0.0 [F] N — Require 3 consecutive clean polls; brief clean windows mid-break caused re-entry 1–3s later (#184).
- v64.0.0 [T] N — Bounce-tolerant ad-end + 12s slow-path max wait: Twitch flips markers faster than the poll cadence and wedged playback on the backup. both (#186)

LL-HLS ad leak, 2:

- v58.0.1 [F] (?) N — Strip `#EXT-X-PART:` lines that carry ad URLs (ads leaked via LL-HLS parts). both (#105; also listed under v58.0.0)
- v59.0.0 [F] N — Strip prefetch hints on the *first* ad-tagged poll (the player prefetched ad content). both (#119)

Playlist / URL format, 1:

- v59.0.0 [T] N — The v2 API returns variant URLs without `.m3u8`; accept absolute URLs in every variant-detection path. both (#118)

Player-internal discovery, 1:

- v51.0.0 [P] N — React fallback discovery (structural match) and the TTV-AB `playerMode` path, for when Twitch renames `setPlayerActive`/`mediaPlayerInstance`.

Detection evasion, 1:

- v68.3.0 [F] (?) N — Ad-spoofing default on → off; a Twitch ad overlay with countdown appeared on `warn` despite full pod coverage. The suspicion is that the beacon pattern fingerprints.

### Excluded (not counted)

Logging and diagnostics only:
- v42 [AD DEBUG] logging; v44/v46/v57 logs; v45 7TV warning.
- v55 zero-strip warning; v58 debug logs, CSAI false-positive warning guard (#103) and `TotalAllStrippedPolls` counter.
- v59 "Player not found" debounce (#126); v60 `HasLoggedAdAttributes` reset (#138) and cancel-error silencing (#140, #142).
- v61 unknown-marker diagnostic (#153); v63 GQL `errors` logging (#170) and substring diagnostic (#167).
- v64 autoplay commit wording (#181) and `ConsecutiveZeroStripBreaks` reset (#180).
- v64.1.0 video-swap-new CSAI fast-path log (#188 second bullet).
- v66.0.0 worker `eval` guard (#204: it surfaces a failure, it doesn't fix one); v66.2.0 offline-shape and token-failure trackers (#209).
- v67.0.0 backstop logs; v68.2.0 cold/warm instrumentation; v68.5.7 CSAI request counting.

Features not responding to a breakage:
- v44 pinning; v48 visibility backoff (CPU); v51 auto-pin, PinBackupPlayerType default.
- v52 skip grace on CSAI-only (speed); v58 skip end-of-break reload on cycle switch (#98) and #89 fast-exit (later reverted); v54 video-swap-new hardening port.
- v68.0.0 spoofing to release (#223), pod coverage (#225), fast-autoplay re-probe (folded into #198).
- Default flips folded into their originals.

Perf / refactor: v42, v49, v54, v55 regex (its regression is counted at v56), v59 (#121–#123), v64 (#174–#176), the v53 HEVC sort.

Hygiene with no described user symptom:
- v42 bug-fix block (Map.forEach order, null guards, discarded tracking-URL replace); v51 `parseAttributes`; v52 idempotent `revokeObjectURL`; v55 `toString` masking.
- v60 `RequestedAds` clear (#137), prefetch promise rejection (#136).
- v65.0.0 `AdSegmentCache` bound (#191); v65.3.0 orphaned blob URLs (#139).
- v58.0.1 `EXT-X-PRELOAD-HINT` (#104, forward-compat only); v68.5.6 missing `CODECS` ("not observed in the field").

## Signals that identify each type

All strings below are from `vaft/vaft.user.js` 68.5.7 and carry the `[AD DEBUG]` prefix unless noted. A trailing `…` marks where a value gets concatenated in. Two things are worth knowing up front:

- `Attempt to fix buffering position:…` has **no** prefix.
- `GQL fetch timeout (5s)` is not a log line itself. It is the error string the main-thread bridge returns, so it surfaces inside `Access token failed for <type>: …`.

### 1. Hash rotation / client ID / GQL shape

- **The key discriminator is that failures are uniform across *all* player types at once,** including the primary. Compare type 3, where one or two types fail.
- `Token fetch failed N times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting` (fires at 3+).
- `GQL response missing streamPlaybackAccessToken for <type>. Response keys: […] errors: […]`:
  - The `errors` payload (first 300 chars) is where the cause shows. A stale persisted-query hash should return Twitch's standard persisted-query-not-found error here.
  - That is inferred from how the code logs, **not** observed in this changelog, which has no hash rotation.
  - A shape change like v63.0.0 shows up as unexpected `Response keys` with no `errors`.
- `Access token HTTP <status> for <type>` with `(integrity: present|missing)` on 403. A bad `clientId` would most plausibly appear here as a 4xx on every type (inferred).
- Downstream effects:
  - `No ad-free backup stream found — ads may leak. Tried: …` on every break.
  - Ads play through, because no backup can be fetched.
- `recordAdEvent` only shows up through `notifyAdComplete: GQL response status <n> — spoof may be rejected/rate-limited`, and only when spoofing is enabled (off by default since v68.3.0).

### 2. New / changed ad signifier

- **Missing signifier (Twitch added one):**
  - The user sees an ad, or the stream stalls, with no `Ad detected — type: …` line for that break.
  - `Potential ad markers seen but not in AdSignifiers: … (candidates for future inclusion)` lists the new `EXT-X-DATERANGE:CLASS="twitch-*"` / `SCTE35-*` / `EXT-X-CUE-*` candidates. This is how `twitch-trigger` was found for v66.0.0.
  - `Unknown ad-related tags found: …`.
  - First-poll false recovery: break detected one poll late (v66.0.0).
  - Caution: `CSAI ad request (…) — type: … with NO break detected — vaft never saw this ad` means the ad came by CSAI, outside the m3u8. That is not evidence of a missing m3u8 signifier on its own, unless the m3u8 for that poll also carried a new marker.
- **False-positive signifier (a string matches non-ad content):**
  - `Warning: N consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers`.
  - `Ad detected` lines recurring every 2–3 min (v53 #69) whose `signifiers: …` field names the same single string each time.
  - Re-entry right after `Finished blocking ads` (v61).
- **URL-pattern path:** `Ad segment detected via URL pattern: <url>`.
- **Playlist shape:** ad DATERANGE lines present. `X-TV-TWITCH-AD-POD-LENGTH`, `X-TV-TWITCH-AD-RADS-TOKEN` and `X-TV-TWITCH-AD-AD-SESSION-ID` are the confirmed-ad attributes; `Ad tracking attributes seen: …` lists the names, and a new beacon name means a type-2 N fix like v46.

### 3. Player-type change

- Failures or ads are **per type**, not universal:
  - `Backup stream (<type>) also has ads` for some types but not others.
  - `GQL response missing streamPlaybackAccessToken for <one type> … errors: […"server error"…]` (the embed case, v63/v64).
  - `Backup stream fetch failed for <type> (status n)`.
- All Source types contaminated:
  - `All backup player types ad-laden — taking <type> as last-resort fallback (strip+recovery path will engage)`.
  - `Autoplay backup committed — 360p fallback after N Source type(s) ad-laden (PreferLowQualityBackup)`.
  - `Fast-autoplay first-try — prior break exhausted Source-tier; probing autoplay first`.
- Search cost and order:
  - `Blocking ads (<type>) — backup found in Nms (cold cache: N token fetches|warm cache)`. Rising ms or more cold fetches means the order is wasting round trips.
  - `Contamination-aware reorder — trying […] before known-contaminated […]`.
  - `Skipping fallback to <type> — marked contaminated this break`.
- **A type that "works" but breaks playback** (autoplay, v58.0.1) shows up as type-5 loading-circle lines right after `Blocking ads (autoplay)`. Correlate the committed type with the symptom.

### 4. Worker / injection / extension conflict

- **Absence** of `hookWorkerFetch (vaft)` after a refresh: the script didn't inject at all (issues.md).
- Interception problems:
  - `Worker intercepted — injecting ad-block hooks` missing, or `Non-Twitch worker skipped: <url>`. Watch for this if Twitch changes the worker URL scheme.
  - `Worker rejected — conflict string found: …` (another extension's hook string).
  - `Worker already hooked — reusing without re-injection` (another ad blocker delegating, v68.5.6).
  - `Failed to fetch worker JS — falling back to unmodified worker` (sync XHR blocked, iOS, v55). Ads will play.
  - `Worker eval failed — Twitch player logic not loaded: <err>` (Twitch worker blob format change).
  - `IVS WASM worker crashed: <msg> — triggering hard reload to recover` / `Worker crash recovery failed: …`.
- Injection scope:
  - `vaft skipped — nested frame on <host><path>`, or several `TwitchAdSolutions vaft v… loading` lines per page (racing instances, v58.0.1).
  - `CONFLICT: vaft v… skipped — another script already active (v…). Remove duplicate scripts.`
- Known extension:
  - `Warning: 7TV extension detected — may cause black screen or buffering issues…`.
  - FFZ/BTTV conflicts produce no dedicated line. They show as buffering escalation right after a `<video>` element swap (v65.3.0), or another extension's feature not working (BTTV, v64).

### 5. Player behaviour / buffering / reload / mute

- Twitch-facing lines look healthy:
  - `Ad detected` and `Blocking ads (<type>)` appear.
  - No token, GQL or worker errors.
  - Playlists are normal.
- The problem is in the **cadence of main-thread recovery lines**.
- Freeze and loading:
  - `Attempt to fix buffering position:… bufferDuration:…` (no prefix).
  - `Video state: readyState=… networkState=… buffered=… currentTime=… paused=…`.
  - `Loading circle detected during ad break (Ns stall, readyState=n) — early reload`.
  - `Early reload triggered — N consecutive all-stripped polls … [k/max]`, then `Early reload result: still ads|partial|clean`.
  - `Sticky CSAI escape hatch — stuck N polls …`.
  - `Backup stream has no live segments — forcing immediate reload`.
  - `Ad break stats: … freeze duration: …`.
- Reload cascades (the usual `[R]` signature):
  - Several `Reloading Twitch player` lines within seconds.
  - `Skipping reload — last reload was Ns ago (cooldown: …, auto-escalated …)`.
  - `Skipping reload — player healthy (readyState=…`.
  - `Reload skipped by main thread (player healthy) — early reload state cleared, can retry`.
  - A shrinking `currentTime` across successive `Attempt to fix buffering` lines (v66.1.0).
- Black screen after a break:
  - `CSAI-only ad break (stripped 0) — clearing backup without player action`, or `End-of-break reload: …`, followed by `readyState` stuck below 2.
  - iOS: `iOS/iPadOS: downgrading hard reload to soft …`.
- Video wedge: `Post-break video wedge — playhead advancing at …s but only N decoded frame(s) …` / `Post-break wedge reload SUPPRESSED …`.
- Mute:
  - `Hard reload backstop unmute fired — element was still muted at 5500ms (initial: …)`.
  - `Hard reload backstop SKIPPED — element muted at 5500ms but userPauseIntent set …`.
  - `Restore — cleared leaked pre-mute on the original element …` / `Backstop — cleared leaked pre-mute …` (#248).
  - `Respecting user pause intent — skipping auto-resume`.
  - `Downgraded reload to pause/play to preserve PiP`.
- Drift:
  - `Position jumped Ns — starting drift correction`.
  - `Drift correction: catching up at 1.1x…` repeating, without `Drift correction complete`.
  - `Post-hard-reload seek to live — Ns behind …`.
  - `Post-reload live drift correction: …`.

### 6. Other

- **Codec:**
  - The master playlist has `CODECS` beginning `hev1`/`hvc1` (HEVC) or `av01` (AV1, matched as `av0`) on 1440p/enhanced variants. `videoCodecFamily()` classifies these.
  - The symptom is a black screen for the whole break on enhanced streams only, or a reload loop right after a break on those streams (v65.0.0).
  - No dedicated log line.
- **Ad-state machine:**
  - `Ad detected` / `Finished blocking ads — stripped N ad segments, duration: Ns` alternating within seconds.
  - `Slow-path ad-end escalation — N marker bounces, Ns since first clean poll`.
- **LL-HLS leak:** `Ad detected` fires but ad frames still show. The playlist carries `#EXT-X-PART:`, `#EXT-X-TWITCH-PREFETCH` or `#EXT-X-PRELOAD-HINT` lines pointing at ad URLs.
- **Playlist / URL format:** `No resolutions parsed from encodings m3u8 — Twitch may have changed the format`. Variant lines lacking `.m3u8` (v59.0.0) also broke stream-info sync.
- **Player internals:**
  - `Player not found for 10s+ — Twitch may have renamed setPlayerActive/mediaPlayerInstance`.
  - `Player state not found for 10s+ — Twitch may have renamed setSrc/setInitialPlaybackSettings`.
- **Overlay / DOM ads:**
  - `Hidden Twitch stream display ad`.
  - `Hidden separate Twitch video ad (<host>) — issue #249`.
  - `Restored recycled <video> — source is no longer an ad (#249)`.
  - A user-visible ad with **no** `Ad detected` and a `CSAI ad request … with NO break detected` line points to DOM or CSAI delivery, not the m3u8.
- **Detection evasion:**
  - Ad overlays or countdowns despite clean blocking.
  - `notifyAdComplete: GQL response status <n> …`.
  - `Stream ended / offline shape detected — m3u8 has #EXT-X-ENDLIST with no segments. Possible Twitch detection response…` mid-watch.
  - Rising `Token fetch failed N times consecutively …` with integrity `missing` on 403s.
