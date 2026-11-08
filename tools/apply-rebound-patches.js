#!/usr/bin/env node
// Applies Rebound's changes to the upstream vaft scripts (both synced files).
//
// Why a script instead of only hand-edits: upstream ships often (800+ commits
// since the pixeltris archive). After an upstream merge, re-running this proves
// every anchor still exists. If one is gone, it fails loudly with the patch name
// and you (or the agent) update the anchor. Already-applied patches are skipped,
// so re-running is safe.
//
// Usage: node tools/apply-rebound-patches.js [--check]
//   --check  exit 1 if any file is missing a patch (CI uses this)

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js'];
const checkOnly = process.argv.includes('--check');

const PATCHES = [
    {
        name: 'declare-config-values',
        marker: 'scope.PlaybackAccessTokenHash =',
        anchor: /(\n(\s*)scope\.AdSegmentURLPatterns = \[[^\n]*\];)/,
        replace: (m, line, ind) => `${line}
${ind}// Rebound: values Twitch rotates. Defaults below; overridden by signed remote
${ind}// config via applyRemoteConfig(). Read by serialized worker functions, so
${ind}// they must live here (see CLAUDE.md "Worker Blob Serialization").
${ind}scope.PlaybackAccessTokenHash = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
${ind}scope.RecordAdEventHash = '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b';
${ind}scope.OverlaySelectors = ['[data-test-selector="sda-wrapper"]'];// exact attribute selectors only
${ind}scope.RemoteConfig = null;
${ind}scope.RemoteConfigVersion = 0;
${ind}scope.MonitorMode = false;// Rebound live monitor instrumentation (localStorage twitchAdSolutions_monitor=true)`,
    },
    {
        name: 'apply-remote-config-fn',
        marker: 'function applyRemoteConfig(scope, cfg)',
        anchor: /(\n(\s*)function pruneStreamInfos\(\) \{)/,
        replace: (m, line, ind) => `
${ind}// Rebound: apply a remote config object onto a scope (window or worker self).
${ind}// Serialized into the worker blob, so it may only touch its arguments.
${ind}// The extension has already verified the signature and schema; this re-checks
${ind}// types so a malformed object can never put a non-string into a hot path.
${ind}// Returns true if applied. Older or equal versions are ignored.
${ind}function applyRemoteConfig(scope, cfg) {
${ind}    if (!cfg || typeof cfg !== 'object' || typeof cfg.version !== 'number') return false;
${ind}    if (cfg.version <= scope.RemoteConfigVersion) return false;
${ind}    const isHash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
${ind}    const strList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0);
${ind}    const gql = cfg.gql || {};
${ind}    if (gql.playbackAccessToken && isHash(gql.playbackAccessToken.sha256Hash)) scope.PlaybackAccessTokenHash = gql.playbackAccessToken.sha256Hash;
${ind}    if (gql.recordAdEvent && isHash(gql.recordAdEvent.sha256Hash)) scope.RecordAdEventHash = gql.recordAdEvent.sha256Hash;
${ind}    if (typeof cfg.clientId === 'string' && /^[a-z0-9]{20,40}$/.test(cfg.clientId)) scope.ClientID = cfg.clientId;
${ind}    if (strList(cfg.adSignifiers)) scope.AdSignifiers = cfg.adSignifiers.slice();
${ind}    if (Array.isArray(cfg.knownNonAdSignifiers) && cfg.knownNonAdSignifiers.every((s) => typeof s === 'string')) scope.KnownNonAdSignifiers = cfg.knownNonAdSignifiers.slice();
${ind}    if (strList(cfg.adSegmentUrlPatterns)) scope.AdSegmentURLPatterns = cfg.adSegmentUrlPatterns.slice();
${ind}    if (strList(cfg.backupPlayerTypes)) scope.BackupPlayerTypes = cfg.backupPlayerTypes.slice();
${ind}    if (typeof cfg.defaultPlayerType === 'string' && /^[a-z_]{1,32}$/.test(cfg.defaultPlayerType)) scope.ForceAccessTokenPlayerType = cfg.defaultPlayerType;
${ind}    if (Array.isArray(cfg.overlaySelectors) && cfg.overlaySelectors.every((s) => typeof s === 'string' && /^\\[data-[a-z-]+="[A-Za-z0-9_-]+"\\]$/.test(s))) scope.OverlaySelectors = cfg.overlaySelectors.slice();
${ind}    scope.RemoteConfig = cfg;
${ind}    scope.RemoteConfigVersion = cfg.version;
${ind}    console.log('[AD DEBUG] Rebound config v' + cfg.version + ' applied');
${ind}    return true;
${ind}}${line}`,
    },
    {
        name: 'pat-hash-from-config',
        marker: 'sha256Hash: PlaybackAccessTokenHash',
        anchor: /sha256Hash:\s*"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"/,
        replace: () => 'sha256Hash: PlaybackAccessTokenHash',
    },
    {
        name: 'ad-event-hash-from-config',
        marker: 'sha256Hash: RecordAdEventHash',
        anchor: /sha256Hash: '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b'/,
        replace: () => 'sha256Hash: RecordAdEventHash',
    },
    {
        name: 'serialize-apply-fn',
        marker: '${applyRemoteConfig.toString()}',
        anchor: /(\n(\s*)\$\{declareOptions\.toString\(\)\})/,
        replace: (m, line, ind) => `${line}\n${ind}\${applyRemoteConfig.toString()}`,
    },
    {
        name: 'blob-inject-config',
        marker: 'applyRemoteConfig(self, ${JSON.stringify(RemoteConfig)});',
        anchor: /(\n(\s*)declareOptions\(self\);)/,
        replace: (m, line, ind) => `${line}
${ind}applyRemoteConfig(self, \${JSON.stringify(RemoteConfig)});
${ind}MonitorMode = \${MonitorMode};`,
    },
    {
        name: 'worker-config-message',
        marker: "e.data.key == 'UpdateRemoteConfig'",
        anchor: /(\n(\s*)\} else if \(e\.data\.key == 'FetchResponse'\) \{)/,
        replace: (m, line, ind) => `
${ind}} else if (e.data.key == 'UpdateRemoteConfig') {
${ind}    applyRemoteConfig(self, e.data.value.config);
${ind}    ForceAccessTokenPlayerType = e.data.value.forceAccessTokenPlayerType;${line}`,
    },
    {
        name: 'worker-monitor-playlist',
        marker: "key: 'MonitorPlaylist'",
        anchor: /resolve\(new Response\(await processM3U8\(url, await response\.text\(\), realFetch\)\)\);/,
        replace: () => `const rawText = await response.text();
                                const processedText = await processM3U8(url, rawText, realFetch);
                                if (MonitorMode) {
                                    // Rebound monitor: did ad media survive our processing? Strip mode keeps the
                                    // DATERANGE tags and serves BLANK_MP4 for cached ad segment URLs, so the honest
                                    // measure is non-live segments in the output that are NOT in AdSegmentCache.
                                    try {
                                        const outLines = String(processedText).split(/\\r?\\n/);
                                        let leaked = 0;
                                        for (let li = 0; li < outLines.length - 1; li++) {
                                            if (outLines[li].startsWith('#EXTINF') && (!outLines[li].includes(',live') || AdSegmentURLPatterns.some((p) => outLines[li + 1].includes(p))) && !AdSegmentCache.has(outLines[li + 1])) leaked++;
                                        }
                                        const rawAds = hasAdTags(rawText);
                                        postMessage({ key: 'MonitorPlaylist', value: {
                                            at: Date.now(), rawHasAds: rawAds, outHasAds: hasAdTags(String(processedText)), leakedAdSegments: leaked,
                                            signifiers: getMatchedAdSignifiers(rawText), configVersion: RemoteConfigVersion,
                                            raw: rawAds ? rawText.slice(0, 30000) : null, out: rawAds ? String(processedText).slice(0, 30000) : null
                                        } });
                                    } catch {}
                                }
                                resolve(new Response(processedText));`,
    },
    {
        name: 'main-monitor-log',
        marker: "e.data.key == 'MonitorPlaylist'",
        anchor: /(\n(\s*)\} else if \(e\.data\.key == 'PauseResumePlayer'\) \{)/,
        replace: (m, line, ind) => `
${ind}} else if (e.data.key == 'MonitorPlaylist') {
${ind}    reboundMonitorPush('playlist', e.data.value);${line}`,
    },
    {
        name: 'overlay-selectors-from-config',
        marker: 'OverlaySelectors.join',
        anchor: /document\.querySelectorAll\('\[data-test-selector="sda-wrapper"\]'\)/,
        replace: () => "(OverlaySelectors.length ? document.querySelectorAll(OverlaySelectors.join(',')) : [])",
    },
    {
        name: 'monitor-gql-errors',
        marker: "reboundMonitorPush('gql'",
        anchor: /(\n(\s*)const responseBody = await response\.text\(\);)/,
        replace: (m, line, ind) => `${line}
${ind}if (MonitorMode && fetchRequest.options && typeof fetchRequest.options.body === 'string' && fetchRequest.options.body.includes('PlaybackAccessToken')) {
${ind}    let gqlErrors = null;
${ind}    try { const parsed = JSON.parse(responseBody); gqlErrors = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r && r.errors ? r.errors.map((x) => x.message) : []); } catch { gqlErrors = ['unparseable response']; }
${ind}    reboundMonitorPush('gql', { at: Date.now(), status: response.status, errors: gqlErrors, playerType: (fetchRequest.options.body.match(/"playerType":"([a-z_]+)"/) || [])[1] || null });
${ind}}`,
    },
    {
        // Persisted-query hashes are bound to an operation name (Twitch answers
        // "operation with name 'X' not found" otherwise), so the name is config too.
        name: 'declare-pat-operation',
        marker: 'scope.PlaybackAccessTokenOperation =',
        anchor: /(\n(\s*)scope\.PlaybackAccessTokenHash = '[a-f0-9]{64}';)/,
        replace: (m, line, ind) => `\n${ind}scope.PlaybackAccessTokenOperation = 'PlaybackAccessToken';${line}`,
    },
    {
        name: 'apply-pat-operation',
        marker: 'scope.PlaybackAccessTokenOperation = gql.playbackAccessToken.operationName',
        anchor: /(\n(\s*)if \(gql\.playbackAccessToken && isHash\(gql\.playbackAccessToken\.sha256Hash\)\) scope\.PlaybackAccessTokenHash = gql\.playbackAccessToken\.sha256Hash;)/,
        replace: (m, line, ind) => `${line}\n${ind}if (gql.playbackAccessToken && typeof gql.playbackAccessToken.operationName === 'string' && /^[A-Za-z_]{1,64}$/.test(gql.playbackAccessToken.operationName)) scope.PlaybackAccessTokenOperation = gql.playbackAccessToken.operationName;`,
    },
    {
        name: 'pat-operation-from-config',
        marker: 'operationName: PlaybackAccessTokenOperation,',
        anchor: /(function getAccessToken\(channelName, playerType\) \{\s*const body = \{\s*)operationName: 'PlaybackAccessToken',/,
        replace: (m, pre) => `${pre}operationName: PlaybackAccessTokenOperation,`,
    },
    {
        name: 'main-apply-and-listen',
        marker: "e.data.type !== 'rebound-config'",
        anchor: /(\n(\s*)declareOptions\(window\);\n)/,
        replace: (m, line, ind) => `${line}${ind}// Rebound: remote config. The extension's content script sets
${ind}// window.__reboundRemoteConfig (signature already verified) before this runs,
${ind}// and posts later updates. Userscript/uBlock builds keep the defaults above.
${ind}applyRemoteConfig(window, window.__reboundRemoteConfig || null);
${ind}function reboundMonitorPush(kind, value) {
${ind}    const log = window.__reboundMonitorLog || (window.__reboundMonitorLog = []);
${ind}    log.push({ kind: kind, ...value });
${ind}    if (log.length > 400) log.splice(0, log.length - 400);
${ind}}
${ind}window.__reboundState = () => ({ configVersion: RemoteConfigVersion, playbackAccessTokenHash: PlaybackAccessTokenHash, clientId: ClientID, monitorMode: MonitorMode, workers: twitchWorkers.length });
${ind}window.addEventListener('message', function(e) {
${ind}    if (e.source !== window || !e.data || e.data.type !== 'rebound-config') return;
${ind}    if (applyRemoteConfig(window, e.data.config)) {
${ind}        try {
${ind}            const lsPlayerTypeLate = localStorage.getItem('twitchAdSolutions_playerType');
${ind}            if (lsPlayerTypeLate !== null) ForceAccessTokenPlayerType = lsPlayerTypeLate;
${ind}        } catch {}
${ind}        postTwitchWorkerMessage('UpdateRemoteConfig', { config: e.data.config, forceAccessTokenPlayerType: ForceAccessTokenPlayerType });
${ind}    }
${ind}});
${ind}try { MonitorMode = localStorage.getItem('twitchAdSolutions_monitor') === 'true'; } catch {}
`,
    },
];

let missing = 0;
for (const rel of FILES) {
    const file = path.join(ROOT, rel);
    let src = fs.readFileSync(file, 'utf8');
    const original = src;
    for (const p of PATCHES) {
        if (src.includes(p.marker)) continue;
        if (checkOnly) {
            console.error(`MISSING ${rel}: ${p.name}`);
            missing++;
            continue;
        }
        if (!p.anchor.test(src)) {
            console.error(`ANCHOR NOT FOUND ${rel}: ${p.name} (${p.anchor}) - upstream changed this code; update the patch`);
            process.exit(2);
        }
        src = src.replace(p.anchor, p.replace);
        if (!src.includes(p.marker)) {
            console.error(`PATCH DID NOT TAKE ${rel}: ${p.name}`);
            process.exit(2);
        }
        console.log(`applied ${rel}: ${p.name}`);
    }
    if (!checkOnly && src !== original) fs.writeFileSync(file, src);
}
if (checkOnly) {
    if (missing) process.exit(1);
    console.log('all Rebound patches present in ' + FILES.join(', '));
}
