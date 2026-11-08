#!/usr/bin/env node
// Rebound live monitor. One run = N channels; for each, a CONTROL session (no
// extension; does Twitch serve ads to us right now?) and a TEST session (the
// extension exactly as users get it, plus the latest signed config) in parallel,
// plus a cheap Node-level ad probe.
//
//   node monitor/run.js [--channels 3] [--duration 90] [--control-duration 60]
//                       [--candidate cfg.json] [--fault] [--no-state] [--out result.json]
//                       [--channel login]... [--headed]
//
// --candidate  test this (unsigned) config instead of the live one; used by the
//              fixers before anything is signed. Implies --no-state.
// --fault      inject a wrong PlaybackAccessToken hash (acceptance test for detection).
// --no-state   do not touch monitor state/status (verification runs).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { runSession } = require('./lib/session.js');
const { evaluate } = require('./lib/evaluate.js');
const { saveArtifacts } = require('./lib/artifacts.js');
const { liveChannels, pickChannels, probeAds } = require('./lib/twitch.js');
const stateLib = require('./lib/state.js');
const schedule = require('./lib/schedule.js');
const { verifyConfig } = require('../extension/src/shared/config.js');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = process.env.REBOUND_ARTIFACTS_DIR || path.join(__dirname, 'artifacts');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : def;
}
function args(name) {
    const out = [];
    process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]); });
    return out;
}
const flag = (n) => process.argv.includes(n);
const log = (...a) => console.error(new Date().toISOString(), ...a);

function loadPublicKeys() {
    const sandbox = {};
    new Function('globalThis', fs.readFileSync(path.join(ROOT, 'extension/src/shared/keys.js'), 'utf8'))(sandbox);
    return sandbox.REBOUND_PUBLIC_KEYS;
}

// What users run right now: the newest verified published config, else defaults.
async function liveConfig() {
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/defaults.json'), 'utf8'));
    const constants = {};
    new Function('globalThis', fs.readFileSync(path.join(ROOT, 'extension/src/shared/constants.js'), 'utf8'))(constants);
    const url = constants.REBOUND.CONFIG_URL;
    try {
        const [c, s] = await Promise.all([fetch(url + '?t=' + Date.now(), { signal: AbortSignal.timeout(15000) }), fetch(url + '.sig?t=' + Date.now(), { signal: AbortSignal.timeout(15000) })]);
        if (c.ok && s.ok) {
            const res = await verifyConfig(new Uint8Array(await c.arrayBuffer()), await s.text(), loadPublicKeys(), { crypto: crypto.webcrypto });
            if (res.ok && res.config.version > defaults.version) return { config: res.config, source: 'live' };
            if (!res.ok) log('live config rejected:', res.error);
        }
    } catch (e) {
        log('live config fetch failed:', e.message);
    }
    return { config: defaults, source: 'defaults' };
}

function buildExtension(configPath, outDir) {
    execFileSync(process.execPath, [path.join(ROOT, 'extension/build.js'), '--target', 'firefox', '--out', outDir, '--defaults', configPath, '--no-remote', '--monitor'], { stdio: 'pipe' });
    return path.join(outDir, 'firefox');
}

async function main() {
    const nChannels = Number(arg('--channels', 3));
    const duration = Number(arg('--duration', 90));
    const controlDuration = Number(arg('--control-duration', 60));
    const candidatePath = arg('--candidate');
    const fault = flag('--fault');
    const noState = flag('--no-state') || !!candidatePath;
    const runId = new Date().toISOString().replace(/[:.]/g, '-') + (candidatePath ? '-candidate' : fault ? '-fault' : '');
    // --scheduled (systemd timer): full browser runs only when due; see lib/schedule.js.
    if (flag('--scheduled') && !candidatePath && !fault) {
        const due = schedule.shouldRunFull('monitor');
        if (!due.run) {
            const probe = await cheapProbe();
            stateLib.writeJson('probe.json', probe);
            if (probe.ok) {
                log(`skip full run (${due.why}); cheap probe ok on ${probe.channel}`);
                writeStatus();
                return;
            }
            log(`cheap probe FAILED (${probe.error}) -> full browser run now`);
        } else {
            log('full run: ' + due.why);
        }
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebound-mon-'));

    let config, source;
    if (candidatePath) {
        config = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        source = 'candidate';
    } else {
        ({ config, source } = await liveConfig());
    }
    if (fault) {
        config = JSON.parse(JSON.stringify(config));
        config.gql.playbackAccessToken.sha256Hash = crypto.createHash('sha256').update('rebound-injected-fault').digest('hex');
        config.note = 'INJECTED FAULT: wrong PlaybackAccessToken hash';
        source += '+fault';
    }
    // The control probe asks "does Twitch serve ads to this IP?", so it needs a
    // working hash even when we deliberately broke the one under test.
    const probePat = fault ? JSON.parse(fs.readFileSync(path.join(ROOT, 'config/defaults.json'), 'utf8')).gql.playbackAccessToken : config.gql.playbackAccessToken;
    const probeHash = probePat.sha256Hash, probeOp = probePat.operationName || 'PlaybackAccessToken';
    const cfgPath = path.join(tmp, 'config-under-test.json');
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    const extDir = buildExtension(cfgPath, path.join(tmp, 'ext'));
    log(`run ${runId}: config v${config.version} (${source})`);

    // Channels: explicit, else rotate through the live directory.
    const st = stateLib.readJson('channels.json', { recent: [] });
    let channels;
    if (args('--channel').length) {
        channels = args('--channel').map((login) => ({ login, viewers: null, game: null }));
    } else {
        const pool = (await liveChannels()).filter((c) => c.viewers >= 300);
        channels = pickChannels(pool, nChannels, new Set(st.recent));
        if (!noState) stateLib.writeJson('channels.json', { recent: [...channels.map((c) => c.login), ...st.recent].slice(0, 24) });
    }
    log('channels:', channels.map((c) => `${c.login}(${c.game || '?'}, ${c.viewers || '?'})`).join(', '));

    const results = [];
    const runDir = path.join(ARTIFACTS, runId);
    for (const channel of channels) {
        log(`[${channel.login}] control + test + probe`);
        const [control, test, probe] = await Promise.all([
            runSession({ channel: channel.login, withExtension: false, durationSec: controlDuration, headless: !flag('--headed') }),
            runSession({ channel: channel.login, withExtension: true, extensionDir: extDir, durationSec: duration, simulateAdsAtSec: Math.round(duration * 0.45), headless: !flag('--headed'), screenshotPath: path.join(tmp, channel.login + '.png') }),
            probeAds(channel.login, { hash: probeHash, operationName: probeOp, signifiers: config.adSignifiers }),
        ]);
        const ev = evaluate({ control, test, probe });
        const r = { channel, verdict: ev.verdict, failures: ev.failures, details: ev.details };
        // Hash scraper data comes free with every control session.
        r.observed = control.observed ? { hashes: dedupeHashes(control.observed.gql, control.observed.rawQueries), clientIds: control.observed.clientIds, adClasses: adClasses(control.observed.playlists) } : null;
        if (ev.verdict !== 'PASS' && ev.verdict !== 'INCONCLUSIVE' || flag('--save-all')) {
            const dir = saveArtifacts(runDir, { channel, control, test, probe, verdict: ev, versions: { extension: require('../package.json').version, config: config.version, configSource: source, browser: test.browserVersion } });
            fs.copyFileSync(path.join(tmp, channel.login + '.png'), path.join(dir, 'screenshot.png'));
            r.artifacts = path.relative(ROOT, dir);
        }
        log(`[${channel.login}] ${ev.verdict}  A=${JSON.stringify(ev.details.A)} B=${ev.details.B.ok ? 'ok' : ev.details.B.reason} C=${ev.details.C.hits} D=${JSON.stringify(ev.details.D)} control=${JSON.stringify(ev.details.control)}`);
        results.push(r);
    }

    const run = { runId, at: new Date().toISOString(), configVersion: config.version, configSource: source, injectedFault: fault, candidate: !!candidatePath, results };
    const summary = stateLib.summarize(run);
    run.summary = summary;
    if (!noState) {
        if (!fault) stateLib.writeJson('live-config.json', config);
        const { state, newlyConfirmed } = stateLib.update(run);
        schedule.markFullRun('monitor', run.at);
        if (summary.runVerdict === 'PASS') stateLib.writeJson('probe.json', { ok: true, at: run.at, via: 'full run' });
        stateLib.writeJson('last-run.json', run);
        mergeObserved(results);
        log(`run verdict ${summary.runVerdict}; consecutive FAIL runs: ${state.consecutiveFails}${state.breaking ? '; BREAKAGE since ' + state.breaking.since : ''}`);
        if (newlyConfirmed && !process.env.REBOUND_NO_TRIGGER) {
            log('confirmed breakage -> starting fixers');
            // Under systemd a oneshot unit's cgroup dies with this process, so a
            // detached child would be killed; hand off to the fixers unit instead.
            if (process.env.INVOCATION_ID) {
                try { execFileSync('systemctl', ['--user', 'start', '--no-block', 'rebound-fixers-breakage.service']); } catch (e) { log('could not start fixers unit:', String(e).slice(0, 200)); }
            } else {
                spawn(process.execPath, [path.join(ROOT, 'fixers/run.js'), '--trigger', 'breakage'], { detached: true, stdio: 'ignore' }).unref();
            }
        }
        publishStatus();
    } else {
        log(`run verdict ${summary.runVerdict} (state untouched)`);
    }
    const out = arg('--out');
    if (out) fs.writeFileSync(out, JSON.stringify(run, null, 2));
    process.stdout.write(JSON.stringify({ runId, summary, results: results.map((r) => ({ channel: r.channel.login, verdict: r.verdict, artifacts: r.artifacts })) }) + '\n');
    fs.rmSync(tmp, { recursive: true, force: true });
}

// { operationName: [hash...] } from persisted queries, plus sha256(query) for raw ones.
function publishStatus() {
    if (process.env.REBOUND_PUBLISH_STATUS !== '1') return;
    try { execFileSync(path.join(ROOT, 'tools/publish-status.sh'), [path.join(stateLib.STATE_DIR, 'status.json')], { stdio: 'pipe' }); } catch (e) { log('status publish failed:', String(e.stderr || e).slice(0, 300)); }
}

function writeStatus() {
    stateLib.writeJson('status.json', stateLib.publicStatus(stateLib.readJson('state.json', {})));
    publishStatus();
}

// Browser-free check between full runs: does the live config's PAT operation +
// hash + client ID still return a token, and does the playlist load? Catches the
// fully automatable breakage class (rotations) within minutes even when stable.
async function cheapProbe() {
    const at = new Date().toISOString();
    try {
        const { config } = await liveConfig();
        const pool = (await liveChannels()).filter((c) => c.viewers >= 1000);
        const ch = pool[Math.floor(Math.random() * Math.min(15, pool.length))];
        const r = await probeAds(ch.login, { hash: config.gql.playbackAccessToken.sha256Hash, operationName: config.gql.playbackAccessToken.operationName || 'PlaybackAccessToken', signifiers: config.adSignifiers, polls: 1, intervalMs: 0 });
        return { ok: r.tokenOk && !r.error, at, channel: ch.login, configVersion: config.version, error: r.error || null };
    } catch (e) {
        return { ok: false, at, error: String(e && e.message || e).slice(0, 200) };
    }
}

function dedupeHashes(gql, rawQueries) {
    const m = {};
    for (const g of gql || []) { (m[g.op] = m[g.op] || new Set()).add(g.hash); }
    for (const [op, q] of Object.entries(rawQueries || {})) { (m[op] = m[op] || new Set()).add(crypto.createHash('sha256').update(q).digest('hex')); }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
}

// DATERANGE classes seen in playlists with ad segments vs. without (Phase 4b input).
function adClasses(pls) {
    const inAd = new Set(), inClean = new Set(), attrs = new Set();
    for (const p of pls || []) {
        for (const c of p.classes || []) (p.adSegs > 0 ? inAd : inClean).add(c);
        if (p.adSegs > 0) for (const a of p.adAttrs || []) attrs.add(a);
    }
    return { inAd: [...inAd], inClean: [...inClean], adAttrs: [...attrs], adPlaylists: (pls || []).filter((p) => p.adSegs > 0).length, playlists: (pls || []).length };
}

// Rolling record of what Twitch's own player is using, for the fixers.
function mergeObserved(results) {
    const o = stateLib.readJson('observed.json', { hashes: {}, clientIds: {}, classes: {} });
    const now = new Date().toISOString();
    for (const r of results) {
        if (!r.observed) continue;
        for (const [op, hs] of Object.entries(r.observed.hashes)) for (const h of hs) { o.hashes[op] = o.hashes[op] || {}; o.hashes[op][h] = now; }
        for (const c of r.observed.clientIds) o.clientIds[c] = now;
        for (const c of r.observed.adClasses.inAd) { o.classes[c] = o.classes[c] || { inAd: 0, inClean: 0 }; o.classes[c].inAd++; o.classes[c].lastSeen = now; }
        for (const c of r.observed.adClasses.inClean) { o.classes[c] = o.classes[c] || { inAd: 0, inClean: 0 }; o.classes[c].inClean++; o.classes[c].lastSeen = now; }
    }
    stateLib.writeJson('observed.json', o);
}

main().catch((e) => { log(e.stack || e); process.exit(1); });
