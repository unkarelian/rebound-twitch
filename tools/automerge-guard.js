#!/usr/bin/env node
// Which automation branches may merge into master with no human looking.
//
//   node tools/automerge-guard.js [<base-ref>]     (default origin/master)
//   exits 0 and prints {"ok":true,...}, or exits 1 with the offending paths.
//
// The monitor host verifies a branch (clean container, live run) and pushes it
// with the label `verified`. That claim is all the merge workflow has, so this
// guard limits what such a branch can change to the ad-blocking code and its
// data. It cannot change what runs with credentials: the workflows, the signing
// and publishing tools, the keys and URLs the extension trusts, the monitor that
// judges fixes, the code the host executes, or the dependencies.
'use strict';
const { execFileSync } = require('child_process');

const ALLOWED = [
    /^vaft\//, /^video-swap-new\//, /^strip\//,
    /^tests\//, /^docs\//, /^config\//,
    /^extension\/src\//,
    /^tools\/apply-rebound-patches\.js$/,
    /^[^/]+\.md$/,
];
const DENIED = [
    /^extension\/src\/shared\/keys\.js$/,
    /^extension\/src\/shared\/constants\.js$/,
    /^config\/schema\.json$/,
];

function check(paths) {
    const blocked = paths.filter((p) => DENIED.some((r) => r.test(p)) || !ALLOWED.some((r) => r.test(p)));
    return { ok: blocked.length === 0 && paths.length > 0, files: paths.length, blocked };
}

if (require.main === module) {
    const base = process.argv[2] || 'origin/master';
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', base + '...HEAD'], { encoding: 'utf8' });
    const res = check(out.split('\n').filter(Boolean));
    console.log(JSON.stringify(res));
    process.exit(res.ok ? 0 : 1);
}

module.exports = { check };
