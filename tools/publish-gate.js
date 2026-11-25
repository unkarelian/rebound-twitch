#!/usr/bin/env node
// Decides whether a config candidate is published. There is no human step:
// the answer is "auto" (sign and publish) or "reject" (drop it; the fixers try
// again with fresh evidence on their next run).
//
//   node tools/publish-gate.js <candidate.json> <evidence.json> [<live.json>]
//   prints {"decision":"auto"|"reject","reasons":[...]} and exits 0.
//
// The rules check the DIFF against the live config, not just what the evidence
// claims. A candidate whose diff goes beyond its kind's keys is held to the
// widest rule ("any").
//
// | kind        | allowed diff                         | gate                              |
// |-------------|--------------------------------------|-----------------------------------|
// | hash        | gql.*, clientId                      | live test PASS on >=3 channels    |
// | signifiers  | adSignifiers, knownNonAdSignifiers   | PASS on >=5 channels incl. B      |
// | playertypes | backupPlayerTypes (same set, reorder)| PASS on >=5 channels incl. B      |
// | any (other kinds, rollback, wider diffs, first publication)                      |
// |             | any schema-valid data                | PASS on >=5 channels incl. B      |
//
// Never published, whatever the evidence: an invalid config, no change, more
// than one ad signifier removed at once, or a player type added or removed.
'use strict';
const fs = require('fs');
const { validateConfig } = require('../extension/src/shared/config.js');

const IGNORED = new Set(['version', 'publishedAt', 'note']);
const RULES = {
    hash: { keys: ['gql', 'clientId'], minChannels: 3 },
    signifiers: { keys: ['adSignifiers', 'knownNonAdSignifiers'], minChannels: 5 },
    playertypes: { keys: ['backupPlayerTypes'], minChannels: 5 },
};
const ANY = { minChannels: 5 };

function changedKeys(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => !IGNORED.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function decide(candidate, evidence, live) {
    const reasons = [];
    const v = validateConfig(candidate);
    if (!v.ok) return { decision: 'reject', reasons: ['schema: ' + v.errors.join('; ')] };
    const changed = live ? changedKeys(live, candidate) : Object.keys(candidate).filter((k) => !IGNORED.has(k));
    if (!changed.length) return { decision: 'reject', reasons: ['no change from live config'] };
    const kind = evidence && evidence.kind;
    let rule = RULES[kind];
    // Outside a named rule's keys (or no named rule): the widest rule applies.
    if (!live || !rule || changed.some((k) => !rule.keys.includes(k))) rule = ANY;
    if (live) {
        const a = [...live.backupPlayerTypes].sort().join(), b = [...candidate.backupPlayerTypes].sort().join();
        if (a !== b) reasons.push('player types added/removed (only reordering may publish)');
        if (candidate.adSignifiers.length < live.adSignifiers.length - 1) reasons.push('removes more than one ad signifier at once');
    }
    const lt = (evidence && evidence.liveTest) || {};
    const results = (lt.run && lt.run.results) || [];
    const passes = results.filter((r) => r.verdict === 'PASS').length;
    const fails = results.filter((r) => String(r.verdict).startsWith('FAIL')).length;
    const playback = results.length > 0 && results.every((r) => r.B && r.B.ok);
    if (!lt.pass) reasons.push('live test did not pass');
    if (results.length < rule.minChannels) reasons.push(`live test covered ${results.length} channels, need ${rule.minChannels}`);
    if (fails) reasons.push(fails + ' channel(s) failed');
    if (!passes) reasons.push('no channel PASSed (all inconclusive)');
    if (!playback) reasons.push('playback check B not ok on every channel');
    return { decision: reasons.length ? 'reject' : 'auto', reasons, changed, rule: rule === ANY ? 'any' : kind };
}

if (require.main === module) {
    const [candPath, evPath, livePath] = process.argv.slice(2);
    const read = (p) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
    process.stdout.write(JSON.stringify(decide(read(candPath), read(evPath), read(livePath))) + '\n');
}

module.exports = { decide, changedKeys };
