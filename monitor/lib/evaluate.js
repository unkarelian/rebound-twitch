// Turns a control session + test session (+ node probe) into a verdict:
//   PASS | FAIL(A|B|C|D...) | INCONCLUSIVE
// A ad media reached the player    B content did not play
// C ad UI visible                  D script errors / GQL errors on our requests
'use strict';

const STALL_LIMIT_MS = 8000;
// Our functions; a page error whose stack names one of these is ours.
const OUR_FUNCS = /applyRemoteConfig|processM3U8|stripAdSegments|hookWorkerFetch|hookWindowWorker|getAccessToken|gqlRequest|monitorPlayerBuffering|doTwitchPlayerTask|hideTwitchAdOverlays|reboundMonitorPush|handleWorkerFetchRequest|vaft/;
// GQL errors that mean our persisted-query hash / client ID went stale.
const STALE_GQL = /PersistedQueryNotFound|persisted ?query|unknown operation|operation with name|invalid client|client.?id/i;

function controlSawAds(control, probe) {
    const pls = (control && control.observed && control.observed.playlists) || [];
    const browserAds = pls.some((p) => p.adSegs > 0);
    const nodeAds = !!(probe && probe.adsSeen);
    return { any: browserAds || nodeAds, browserAds, nodeAds, playlists: pls.length };
}

function checkPlayback(test) {
    const s = (test.samples || []).filter((x) => !x.error);
    const withVideo = s.filter((x) => x.hasVideo && typeof x.currentTime === 'number');
    if (withVideo.length < 5) return { ok: false, reason: 'no player video element found', maxStallMs: null, advancedSec: 0, frames: 0 };
    // Ignore the first 12s (page load, pre-roll handling, play click).
    const steady = withVideo.filter((x) => x.at > 12000);
    let maxStall = 0, stallStart = null, last = null;
    for (const x of steady) {
        if (last && x.currentTime > last.currentTime + 0.05) {
            stallStart = null;
        } else if (last) {
            if (stallStart === null) stallStart = last.at;
            maxStall = Math.max(maxStall, x.at - stallStart);
        }
        last = x;
    }
    // Sum forward progress sample-to-sample. A player reload (vaft reloads after
    // every ad break) resets currentTime and may swap the <video> element, so
    // "last minus first" would undercount; only forward steps count, and jumps
    // over 5s (seek to live edge) count as one second.
    const span = steady.length >= 2 ? steady : withVideo;
    let advancedSec = 0, frames = 0;
    for (let i = 1; i < span.length; i++) {
        const dt = span[i].currentTime - span[i - 1].currentTime;
        if (dt > 0) advancedSec += Math.min(dt, 5);
        const df = (span[i].frames || 0) - (span[i - 1].frames || 0);
        if (df > 0) frames += df;
    }
    const wallSec = Math.max(1, (span[span.length - 1].at - span[0].at) / 1000);
    const reasons = [];
    if (maxStall > STALL_LIMIT_MS) reasons.push(`playhead frozen ${(maxStall / 1000).toFixed(1)}s`);
    if (advancedSec < wallSec * 0.6) reasons.push(`only ${advancedSec.toFixed(1)}s of video in ${wallSec.toFixed(0)}s`);
    // requestVideoFrameCallback guards against "audio runs, picture frozen".
    if (frames < wallSec * 5) reasons.push(`only ${frames} frames rendered`);
    return { ok: reasons.length === 0, reason: reasons.join('; '), maxStallMs: maxStall, advancedSec, wallSec, frames };
}

function evaluate({ control, test, probe }) {
    const failures = [];
    const details = {};

    if (test.error) {
        failures.push('D');
        details.D = ['session error: ' + test.error.split('\n')[0]];
    }

    // A: ad segments that our processing let through.
    const playlistEvents = (test.monitorLog || []).filter((e) => e.kind === 'playlist');
    const leaked = playlistEvents.filter((e) => e.leakedAdSegments > 0);
    details.A = { playlists: playlistEvents.length, leakedPlaylists: leaked.length, rawAdPlaylists: playlistEvents.filter((e) => e.rawHasAds).length };
    if (leaked.length) failures.push('A');

    // B: content plays.
    details.B = checkPlayback(test);
    if (!details.B.ok) failures.push('B');

    // C: ad UI.
    const adUiHits = (test.samples || []).filter((x) => (x.adUi && x.adUi.length) || x.extraVideos > 0);
    details.C = { hits: adUiHits.length, selectors: [...new Set(adUiHits.flatMap((x) => x.adUi || []))], extraVideoSamples: adUiHits.filter((x) => x.extraVideos > 0).length };
    // Two consecutive seconds, so a one-frame flash during teardown is not a failure.
    if (adUiHits.length >= 2) failures.push('C');

    // D: our errors.
    const d = details.D = details.D || [];
    if (!test.extState) d.push('vaft did not load (no __reboundState)');
    else if (!test.extState.workers) d.push('player worker was never hooked');
    if (test.extState && playlistEvents.length === 0) d.push('no playlists passed through vaft');
    for (const e of test.pageErrors || []) if (OUR_FUNCS.test(e.stack) || OUR_FUNCS.test(e.message)) d.push('page error: ' + e.message);
    for (const c of test.console || []) if (/\[AD DEBUG\].*(failed|Worker eval failed)/i.test(c.text) && !/Failed to fetch worker JS/.test(c.text)) d.push('console: ' + c.text.slice(0, 200));
    const gqlEvents = (test.monitorLog || []).filter((e) => e.kind === 'gql');
    const staleGql = gqlEvents.filter((e) => (e.errors || []).some((m) => STALE_GQL.test(m)));
    if (staleGql.length) d.push(`GQL rejected our PlaybackAccessToken request ${staleGql.length}x: ${staleGql[0].errors.join(', ')}`);
    if (gqlEvents.length >= 3 && gqlEvents.every((e) => (e.errors || []).length || e.status !== 200)) d.push('every backup access-token request failed');
    details.gqlRequests = gqlEvents.length;
    if (d.length) failures.push('D');

    const ads = controlSawAds(control, probe);
    details.control = { ...ads, controlError: control && control.error ? control.error.split('\n')[0] : null, probe: probe ? { adsSeen: probe.adsSeen, error: probe.error } : null };

    let verdict;
    if (failures.length) verdict = 'FAIL(' + [...new Set(failures)].join('|') + ')';
    else if (!ads.any) verdict = 'INCONCLUSIVE';
    else verdict = 'PASS';
    return { verdict, failures: [...new Set(failures)], details };
}

module.exports = { evaluate, checkPlayback, controlSawAds };
