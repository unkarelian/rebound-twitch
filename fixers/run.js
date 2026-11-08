#!/usr/bin/env node
// Rebound deterministic fixers (Phase 4). No agent, no code changes: config only.
//
//   node fixers/run.js [--trigger breakage|hourly] [--dry-run] [--only hash,signifiers,playertypes]
//
// 4a hash/client-ID: if OUR PlaybackAccessToken hash or client ID is rejected by
//    Twitch while the values Twitch's own player uses work, build a candidate,
//    live-test it on 3 channels, and auto-publish (the live test is the gate).
// 4b signifiers: DATERANGE classes seen only in ad playlists (and current
//    signifiers seen in clean ones) -> config PR with evidence. Auto-publish only
//    after a 5-channel PASS including playback (check B).
// 4c player types: probe each backup player type for ad-free playlists; propose
//    a better order with evidence (5-channel gate, as 4b).
//
// Publishing = pushing a branch config-candidates/<id> containing
// candidate/config.json + candidate/evidence.json. The publish-config workflow,
// which alone holds the signing key, enforces what may auto-publish.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runSession } = require('../monitor/lib/session.js');
const { gql, liveChannels, pickChannels, PUBLIC_CLIENT_ID, UA } = require('../monitor/lib/twitch.js');
const stateLib = require('../monitor/lib/state.js');
const { validateConfig } = require('../extension/src/shared/config.js');

const ROOT = path.resolve(__dirname, '..');
const flag = (n) => process.argv.includes(n);
function arg(name, def) { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; }
const log = (...a) => console.error(new Date().toISOString(), '[fixers]', ...a);
const only = (arg('--only', 'hash,signifiers,playertypes')).split(',');
const dryRun = flag('--dry-run');
const trigger = arg('--trigger', 'hourly');

// ------------------------------------------------------------------ helpers
const patOp = (cfg) => cfg.gql.playbackAccessToken.operationName || 'PlaybackAccessToken';
async function patWorks(login, hash, clientId, playerType = 'site', operationName = 'PlaybackAccessToken') {
    const r = await gql({
        operationName,
        variables: { isLive: true, login, isVod: false, vodID: '', playerType, platform: playerType === 'autoplay' ? 'android' : 'web' },
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }, clientId).catch((e) => ({ errors: [{ message: String(e) }] }));
    const tok = r && r.data && r.data.streamPlaybackAccessToken;
    return { ok: !!tok, token: tok, errors: (r && r.errors || []).map((e) => e.message) };
}

async function mediaPlaylistHasAds(login, tok, signifiers, polls = 4) {
    const p = new URLSearchParams({ sig: tok.signature, token: tok.value, allow_source: 'true', fast_bread: 'true', p: String(Math.floor(Math.random() * 1e7)), player_backend: 'mediaplayer', playlist_include_framerate: 'true', supported_codecs: 'h264', cdm: 'wv' });
    const master = await (await fetch(`https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?${p}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).text();
    const media = master.split('\n').find((l) => l.startsWith('https://'));
    if (!media) return { ok: false, error: 'no variant' };
    for (let i = 0; i < polls; i++) {
        const pl = await (await fetch(media, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).text();
        if (signifiers.some((s) => pl.includes(s))) return { ok: true, ads: true };
        await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: true, ads: false };
}

// The config users currently run, as last fetched and verified by the monitor.
function currentLiveConfig() {
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/defaults.json'), 'utf8'));
    const lc = stateLib.readJson('live-config.json', null);
    return lc && validateConfig(lc).ok && lc.version >= defaults.version ? lc : defaults;
}

function liveTest(candidate, channels) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebound-fix-'));
    const cand = path.join(tmp, 'candidate.json');
    fs.writeFileSync(cand, JSON.stringify(candidate, null, 2));
    const out = path.join(tmp, 'result.json');
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'monitor/run.js'), '--candidate', cand, '--channels', String(channels), '--out', out], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 30 * 60 * 1000 });
    } catch (e) {
        log('live test crashed:', String(e).slice(0, 200));
        return { pass: false, run: null };
    }
    const run = JSON.parse(fs.readFileSync(out, 'utf8'));
    const fails = run.results.filter((r) => r.verdict.startsWith('FAIL')).length;
    const passes = run.results.filter((r) => r.verdict === 'PASS').length;
    const playbackOk = run.results.every((r) => r.details && r.details.B && r.details.B.ok);
    fs.rmSync(tmp, { recursive: true, force: true });
    return { pass: fails === 0 && passes >= 1 && playbackOk, passes, fails, playbackOk, run: { runId: run.runId, results: run.results.map((r) => ({ channel: r.channel.login, verdict: r.verdict, B: r.details.B })) } };
}

function nextCandidate(base, changes, note) {
    const c = JSON.parse(JSON.stringify(base));
    Object.assign(c, changes);
    c.note = note.slice(0, 280);
    const v = validateConfig(c);
    if (!v.ok) throw new Error('candidate invalid: ' + v.errors.join('; '));
    return c;
}

// Push config-candidates/<id> with the candidate + evidence. The workflow takes it from there.
function submitCandidate(kind, candidate, evidence) {
    const id = kind + '-' + new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(stateLib.STATE_DIR, 'candidates', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(candidate, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify({ kind, trigger, createdAt: new Date().toISOString(), ...evidence }, null, 2) + '\n');
    if (dryRun) { log(`dry run: candidate ${id} written to ${dir}`); return { id, dir, pushed: false }; }
    try {
        execFileSync(path.join(ROOT, 'tools/push-candidate.sh'), [dir, 'config-candidates/' + id], { stdio: 'inherit' });
        log(`pushed candidate branch config-candidates/${id}`);
        return { id, dir, pushed: true };
    } catch (e) {
        log('push failed:', String(e).slice(0, 300));
        return { id, dir, pushed: false };
    }
}

// ------------------------------------------------------------------ 4a
async function fixHashes(cfg) {
    const pool = (await liveChannels()).filter((c) => c.viewers >= 500);
    const probeLogin = pool[Math.floor(Math.random() * Math.min(20, pool.length))].login;
    const ours = await patWorks(probeLogin, cfg.gql.playbackAccessToken.sha256Hash, cfg.clientId, 'site', patOp(cfg));
    log(`4a: our PAT hash ${ours.ok ? 'works' : 'FAILS (' + ours.errors.join(', ') + ')'} on ${probeLogin}`);
    // Watch Twitch's own player (no extension) to learn what it uses right now.
    const chans = pickChannels(pool, 2, new Set());
    // pat: Map "operationName|hash" for every PlaybackAccessToken* operation seen.
    const observed = { pat: new Set(), ClientSideAdEventHandling_RecordAdEvent: new Set(), clientIds: new Set() };
    const addOps = (hashesByOp) => {
        for (const [op, hs] of Object.entries(hashesByOp || {})) {
            for (const h of hs) {
                if (/^PlaybackAccessToken/.test(op)) observed.pat.add(op + '|' + h);
                else if (op === 'ClientSideAdEventHandling_RecordAdEvent') observed.ClientSideAdEventHandling_RecordAdEvent.add(h);
            }
        }
    };
    for (const ch of chans) {
        const s = await runSession({ channel: ch.login, withExtension: false, durationSec: 40 });
        const byOp = {};
        for (const g of (s.observed && s.observed.gql) || []) (byOp[g.op] = byOp[g.op] || []).push(g.hash);
        for (const [op, q] of Object.entries((s.observed && s.observed.rawQueries) || {})) (byOp[op] = byOp[op] || []).push(crypto.createHash('sha256').update(q).digest('hex'));
        addOps(byOp);
        for (const c of (s.observed && s.observed.clientIds) || []) observed.clientIds.add(c);
    }
    // Plus anything the monitor saw in the last day.
    const mon = stateLib.readJson('observed.json', { hashes: {}, clientIds: {} });
    const fresh = (m) => Object.entries(m || {}).filter(([, at]) => Date.now() - Date.parse(at) < 24 * 3600e3).map(([k]) => k);
    addOps(Object.fromEntries(Object.entries(mon.hashes || {}).map(([op, m]) => [op, fresh(m)])));
    fresh(mon.clientIds).forEach((c) => observed.clientIds.add(c));
    log('4a observed:', JSON.stringify({ pat: [...observed.pat], adEvent: [...observed.ClientSideAdEventHandling_RecordAdEvent], clientIds: [...observed.clientIds] }));

    const changes = {};
    const why = [];
    const cur = { op: patOp(cfg), hash: cfg.gql.playbackAccessToken.sha256Hash, cid: cfg.clientId };
    let next = { ...cur };
    if (!ours.ok) {
        // Try every observed (operation, hash) x client ID; first that works wins.
        const pairs = [...observed.pat].map((x) => { const [op, hash] = x.split('|'); return { op, hash }; }).concat([{ op: cur.op, hash: cur.hash }]);
        const cids = [...new Set([...observed.clientIds, cur.cid, PUBLIC_CLIENT_ID])];
        search:
        for (const p of pairs) for (const c of cids) {
            if (!/^[a-f0-9]{64}$/.test(p.hash) || !/^[A-Za-z_]{1,64}$/.test(p.op) || !/^[a-z0-9]{20,40}$/.test(c)) continue;
            const r = await patWorks(probeLogin, p.hash, c, 'site', p.op);
            if (r.ok) { next = { op: p.op, hash: p.hash, cid: c }; break search; }
        }
        if (next.hash === cur.hash && next.cid === cur.cid && next.op === cur.op) {
            log('4a: our hash fails and no observed value works -> needs the agent');
            return { status: 'unresolved', reason: 'no working hash/client-ID observed', ours };
        }
    }
    if (next.hash !== cur.hash || next.op !== cur.op) why.push(`PlaybackAccessToken ${cur.op}/${cur.hash.slice(0, 8)}→${next.op}/${next.hash.slice(0, 8)}`);
    if (next.cid !== cur.cid) why.push(`clientId ${cur.cid.slice(0, 6)}…→${next.cid.slice(0, 6)}…`);
    // RecordAdEvent: only used with opt-in spoofing; adopt what Twitch's player sends
    // when it differs (passive, cannot be probed without sending fake ad events).
    const adEv = [...observed.ClientSideAdEventHandling_RecordAdEvent];
    let newAd = cfg.gql.recordAdEvent.sha256Hash;
    if (adEv.length === 1 && adEv[0] !== newAd) { newAd = adEv[0]; why.push(`RecordAdEvent hash ${cfg.gql.recordAdEvent.sha256Hash.slice(0, 8)}→${newAd.slice(0, 8)}`); }
    if (!why.length) return { status: 'ok', ours };

    const candidate = nextCandidate(cfg, { clientId: next.cid, gql: { playbackAccessToken: { operationName: next.op, sha256Hash: next.hash }, recordAdEvent: { sha256Hash: newAd } } }, 'Auto-fix (4a): ' + why.join('; '));
    log('4a candidate:', why.join('; '), '-> live test on 3 channels');
    const lt = liveTest(candidate, 3);
    log('4a live test:', JSON.stringify({ pass: lt.pass, passes: lt.passes, fails: lt.fails }));
    if (!lt.pass) return { status: 'candidate-failed-live-test', why, liveTest: lt };
    const sub = submitCandidate('hash', candidate, { why, observed: { pat: [...observed.pat], adEvent: adEv, clientIdCount: observed.clientIds.size }, ourProbe: ours, liveTest: lt });
    return { status: sub.pushed ? 'published' : 'submit-failed', why, candidate: sub.id };
}

// ------------------------------------------------------------------ 4b
function discoverSignifiers(cfg) {
    const obs = stateLib.readJson('observed.json', { classes: {} });
    const covered = (c) => cfg.adSignifiers.some((s) => c.includes(s) || ('EXT-X-DATERANGE:CLASS="' + c + '"').includes(s)) || cfg.knownNonAdSignifiers.some((s) => c.includes(s));
    const adds = [], removes = [];
    for (const [cls, st] of Object.entries(obs.classes || {})) {
        if (st.inAd >= 3 && st.inClean === 0 && !covered(cls) && /^[A-Za-z0-9_.-]{3,60}$/.test(cls)) adds.push({ signifier: 'EXT-X-DATERANGE:CLASS="' + cls + '"', evidence: st });
    }
    // A signifier that keeps matching clean playlists strips real content (PR #120 history).
    for (const s of cfg.adSignifiers) {
        const hits = Object.entries(obs.classes || {}).filter(([cls]) => ('EXT-X-DATERANGE:CLASS="' + cls + '"').includes(s) || cls.includes(s));
        const clean = hits.reduce((n, [, st]) => n + st.inClean, 0), inAd = hits.reduce((n, [, st]) => n + st.inAd, 0);
        if (clean >= 5 && inAd === 0) removes.push({ signifier: s, evidence: { inClean: clean, inAd } });
    }
    return { adds, removes };
}

async function fixSignifiers(cfg) {
    const { adds, removes } = discoverSignifiers(cfg);
    if (!adds.length && !removes.length) { log('4b: no new signifier candidates'); return { status: 'ok' }; }
    const next = cfg.adSignifiers.filter((s) => !removes.some((r) => r.signifier === s)).concat(adds.map((a) => a.signifier)).slice(0, 32);
    if (!next.length) return { status: 'refused', reason: 'would empty adSignifiers' };
    const why = [...adds.map((a) => '+' + a.signifier), ...removes.map((r) => '-' + r.signifier)];
    const candidate = nextCandidate(cfg, { adSignifiers: next }, 'Signifier update (4b): ' + why.join(' '));
    log('4b candidate:', why.join(' '), '-> 5-channel live test');
    const lt = liveTest(candidate, 5);
    const sub = submitCandidate('signifiers', candidate, { why, adds, removes, liveTest: lt, autoApprovable: lt.pass });
    return { status: lt.pass ? 'submitted-auto' : 'submitted-needs-human', why, candidate: sub.id };
}

// ------------------------------------------------------------------ 4c
async function fixPlayerTypes(cfg) {
    const pool = pickChannels((await liveChannels()).filter((c) => c.viewers >= 500), 4, new Set());
    const types = [...new Set([...cfg.backupPlayerTypes, 'autoplay'])];
    const score = Object.fromEntries(types.map((t) => [t, { clean: 0, ads: 0, errors: 0 }]));
    for (const ch of pool) {
        for (const t of types) {
            const tok = await patWorks(ch.login, cfg.gql.playbackAccessToken.sha256Hash, cfg.clientId, t, patOp(cfg));
            if (!tok.ok) { score[t].errors++; continue; }
            const r = await mediaPlaylistHasAds(ch.login, tok.token, cfg.adSignifiers, 3).catch(() => ({ ok: false }));
            if (!r.ok) score[t].errors++; else if (r.ads) score[t].ads++; else score[t].clean++;
        }
    }
    const history = stateLib.readJson('playertypes.json', { runs: [] });
    history.runs.push({ at: new Date().toISOString(), channels: pool.map((c) => c.login), score });
    history.runs = history.runs.slice(-48);
    stateLib.writeJson('playertypes.json', history);
    log('4c scores:', JSON.stringify(score));
    // Aggregate the last 6 probes; order by clean ratio, stable on ties (current order wins).
    const agg = Object.fromEntries(cfg.backupPlayerTypes.map((t) => [t, { clean: 0, total: 0 }]));
    for (const run of history.runs.slice(-6)) for (const t of cfg.backupPlayerTypes) if (run.score[t]) { agg[t].clean += run.score[t].clean; agg[t].total += run.score[t].clean + run.score[t].ads + run.score[t].errors; }
    const enough = cfg.backupPlayerTypes.every((t) => agg[t].total >= 8);
    if (!enough) return { status: 'collecting', score };
    const ratio = (t) => agg[t].clean / agg[t].total;
    const proposed = [...cfg.backupPlayerTypes].sort((a, b) => (ratio(b) - ratio(a) > 0.25 ? 1 : ratio(a) - ratio(b) > 0.25 ? -1 : 0));
    if (proposed.join() === cfg.backupPlayerTypes.join()) return { status: 'ok', score };
    const candidate = nextCandidate(cfg, { backupPlayerTypes: proposed }, 'Player-type order (4c): ' + proposed.join(','));
    const lt = liveTest(candidate, 5);
    const sub = submitCandidate('playertypes', candidate, { proposed, previous: cfg.backupPlayerTypes, aggregate: agg, liveTest: lt, autoApprovable: lt.pass });
    return { status: lt.pass ? 'submitted-auto' : 'submitted-needs-human', proposed, candidate: sub.id };
}

// ------------------------------------------------------------------ main
async function main() {
    const lockFile = path.join(stateLib.STATE_DIR, 'fixers.lock');
    fs.mkdirSync(stateLib.STATE_DIR, { recursive: true });
    try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
    } catch {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age < 45 * 60 * 1000) { log('another fixer run is active; exiting'); return; }
        fs.writeFileSync(lockFile, String(process.pid));
    }
    try {
        const cfg = currentLiveConfig();
        log(`trigger=${trigger} config v${cfg.version}`);
        const report = { at: new Date().toISOString(), trigger, configVersion: cfg.version };
        if (only.includes('hash')) report.hash = await fixHashes(cfg).catch((e) => ({ status: 'error', error: String(e.stack || e) }));
        if (only.includes('signifiers')) report.signifiers = await fixSignifiers(cfg).catch((e) => ({ status: 'error', error: String(e.stack || e) }));
        // Player-type probing costs ~20 GQL calls; hourly is plenty, skip on breakage runs.
        if (only.includes('playertypes') && trigger !== 'breakage') report.playertypes = await fixPlayerTypes(cfg).catch((e) => ({ status: 'error', error: String(e.stack || e) }));
        const st = stateLib.readJson('state.json', {});
        if (st.breaking && trigger === 'breakage') {
            st.breaking.fixerAttempts = (st.breaking.fixerAttempts || 0) + 1;
            st.breaking.lastFixer = { at: report.at, hash: report.hash && report.hash.status, signifiers: report.signifiers && report.signifiers.status };
            stateLib.writeJson('state.json', st);
        }
        stateLib.writeJson('last-fixers.json', report);
        console.log(JSON.stringify(report, null, 2));
    } finally {
        fs.rmSync(lockFile, { force: true });
    }
}

main().catch((e) => { log(e.stack || e); process.exit(1); });
