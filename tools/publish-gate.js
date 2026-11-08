#!/usr/bin/env node
// Decides whether a config candidate may publish without a human.
//
//   node tools/publish-gate.js <candidate.json> <evidence.json> [<live.json>]
//   prints {"decision":"auto"|"human"|"reject","reasons":[...]} and exits 0.
//
// The rules check the DIFF against the live config, not just what the evidence
// claims, so a compromised monitor host can only auto-publish the narrow change
// types below. Everything else waits for one-click approval in the
// `config-human` environment.
//
// | kind        | allowed diff                         | gate                              |
// |-------------|--------------------------------------|-----------------------------------|
// | hash        | gql.*, clientId                      | live test PASS on >=3 channels    |
// | signifiers  | adSignifiers, knownNonAdSignifiers   | PASS on >=5 channels incl. B      |
// | playertypes | backupPlayerTypes (same set, reorder)| PASS on >=5 channels incl. B      |
'use strict';
const fs = require('fs');
const { validateConfig } = require('../extension/src/shared/config.js');

const IGNORED = new Set(['version', 'publishedAt', 'note']);
const RULES = {
    hash: { keys: ['gql', 'clientId'], minChannels: 3 },
    signifiers: { keys: ['adSignifiers', 'knownNonAdSignifiers'], minChannels: 5 },
    playertypes: { keys: ['backupPlayerTypes'], minChannels: 5 },
};

function changedKeys(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => !IGNORED.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function decide(candidate, evidence, live) {
    const reasons = [];
    const v = validateConfig(candidate);
    if (!v.ok) return { decision: 'reject', reasons: ['schema: ' + v.errors.join('; ')] };
    if (!live) return { decision: 'human', reasons: ['no live config to diff against (first publication)'] };
    const changed = changedKeys(live, candidate);
    if (!changed.length) return { decision: 'reject', reasons: ['no change from live config'] };
    const rule = RULES[evidence && evidence.kind];
    if (!rule) return { decision: 'human', reasons: ['kind "' + (evidence && evidence.kind) + '" has no auto rule'], changed };
    const outside = changed.filter((k) => !rule.keys.includes(k));
    if (outside.length) reasons.push('changes outside ' + evidence.kind + ' scope: ' + outside.join(', '));
    if (evidence.kind === 'playertypes') {
        const a = [...live.backupPlayerTypes].sort().join(), b = [...candidate.backupPlayerTypes].sort().join();
        if (a !== b) reasons.push('player types added/removed (only reordering may auto-publish)');
    }
    if (evidence.kind === 'signifiers' && candidate.adSignifiers.length < live.adSignifiers.length - 1) reasons.push('removes more than one ad signifier at once');
    const lt = evidence.liveTest || {};
    const results = (lt.run && lt.run.results) || [];
    const passes = results.filter((r) => r.verdict === 'PASS').length;
    const fails = results.filter((r) => String(r.verdict).startsWith('FAIL')).length;
    const playback = results.length > 0 && results.every((r) => r.B && r.B.ok);
    if (!lt.pass) reasons.push('live test did not pass');
    if (results.length < rule.minChannels) reasons.push(`live test covered ${results.length} channels, need ${rule.minChannels}`);
    if (fails) reasons.push(fails + ' channel(s) failed');
    if (!passes) reasons.push('no channel PASSed (all inconclusive)');
    if (!playback) reasons.push('playback check B not ok on every channel');
    return { decision: reasons.length ? 'human' : 'auto', reasons, changed };
}

if (require.main === module) {
    const [candPath, evPath, livePath] = process.argv.slice(2);
    const read = (p) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
    process.stdout.write(JSON.stringify(decide(read(candPath), read(evPath), read(livePath))) + '\n');
}

module.exports = { decide, changedKeys };
