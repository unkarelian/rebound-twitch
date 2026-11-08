// Monitor state machine, history and public status.json.
// Confirmed breakage = 2 consecutive runs that each FAIL on 2+ channels.
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.REBOUND_STATE_DIR || path.resolve(__dirname, '..', 'state');

function p(name) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    return path.join(STATE_DIR, name);
}

function readJson(name, def) {
    try { return JSON.parse(fs.readFileSync(p(name), 'utf8')); } catch { return def; }
}

function writeJson(name, obj) {
    const f = p(name);
    fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(f + '.tmp', f);
}

function appendHistory(entry) {
    fs.appendFileSync(p('history.jsonl'), JSON.stringify(entry) + '\n');
}

function recentHistory(n) {
    try {
        return fs.readFileSync(p('history.jsonl'), 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l));
    } catch { return []; }
}

// run: { runId, at, results: [{ channel, verdict }] }
function summarize(run) {
    const fails = run.results.filter((r) => r.verdict.startsWith('FAIL')).length;
    const passes = run.results.filter((r) => r.verdict === 'PASS').length;
    const incon = run.results.filter((r) => r.verdict === 'INCONCLUSIVE').length;
    let runVerdict;
    if (fails >= 2) runVerdict = 'FAIL';
    else if (fails === 1) runVerdict = 'DEGRADED';
    else if (passes >= 1) runVerdict = 'PASS';
    else runVerdict = 'INCONCLUSIVE';
    return { fails, passes, inconclusive: incon, runVerdict };
}

function update(run, opts = {}) {
    const s = readJson('state.json', { consecutiveFails: 0, lastPassAt: null, breaking: null, runs: 0 });
    const sum = summarize(run);
    s.runs++;
    s.lastRunAt = run.at;
    s.lastRunVerdict = sum.runVerdict;
    if (sum.runVerdict === 'PASS') s.lastPassAt = run.at;
    s.consecutiveFails = sum.runVerdict === 'FAIL' ? s.consecutiveFails + 1 : 0;
    let newlyConfirmed = false;
    if (s.consecutiveFails >= 2 && !s.breaking) {
        s.breaking = { since: run.at, confirmedRunId: run.runId, failures: [...new Set(run.results.flatMap((r) => r.failures || []))], fixerAttempts: 0, agentTriggered: false };
        newlyConfirmed = true;
    }
    if (s.breaking && sum.runVerdict === 'PASS') {
        s.lastResolved = { ...s.breaking, resolvedAt: run.at, minutesToFix: Math.round((Date.parse(run.at) - Date.parse(s.breaking.since)) / 60000) };
        s.breaking = null;
    }
    if (!opts.dryRun) {
        writeJson('state.json', s);
        appendHistory({ runId: run.runId, at: run.at, ...sum, results: run.results.map((r) => ({ channel: r.channel.login, verdict: r.verdict })), configVersion: run.configVersion, injectedFault: !!run.injectedFault });
        writeJson('status.json', publicStatus(s));
    }
    return { state: s, summary: sum, newlyConfirmed };
}

// Public, display-only. Nothing about the monitor host or IP.
function publicStatus(s) {
    const recent = recentHistory(96).filter((h) => !h.injectedFault);
    const total = recent.length || 1;
    return {
        state: s.breaking ? 'FAIL' : s.lastRunVerdict || 'UNKNOWN',
        lastPassAt: s.lastPassAt,
        updatedAt: new Date().toISOString(),
        breakingSince: s.breaking ? s.breaking.since : null,
        lastProbe: (() => { const pr = readJson('probe.json', null); return pr ? { ok: !!pr.ok, at: pr.at } : null; })(),
        lastResolved: s.lastResolved ? { since: s.lastResolved.since, resolvedAt: s.lastResolved.resolvedAt, minutesToFix: s.lastResolved.minutesToFix } : null,
        last24h: {
            runs: recent.length,
            pass: recent.filter((h) => h.runVerdict === 'PASS').length,
            fail: recent.filter((h) => h.runVerdict === 'FAIL').length,
            inconclusiveRate: Math.round((recent.filter((h) => h.runVerdict === 'INCONCLUSIVE').length / total) * 100) / 100,
        },
    };
}

module.exports = { STATE_DIR, readJson, writeJson, update, summarize, recentHistory, publicStatus, appendHistory };
