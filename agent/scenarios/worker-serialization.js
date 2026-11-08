// Replay of the worker-serialization breakage class (CLAUDE.md "Regex hoisting or
// referencing outer-scope variables from these functions causes ReferenceError";
// see the v51/v55 worker entries in docs/BREAKAGE-LOG.md): a serialized worker function
// references a window-scope constant, so the injected worker throws on its first
// ad playlist. Expected fix: code (move the value into declareOptions).
'use strict';
const fs = require('fs');
const path = require('path');
const FILES = ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js'];
module.exports = {
    name: 'worker-serialization',
    // What the breaking commit looks like to the agent: an ordinary-looking change,
    // as these breakages historically were. The title above is never shown to it.
    commitMessage: 'perf: precompile ad-tag matchers instead of substring scans per poll',
    title: 'Hoisted ad-tag check references outer scope from a serialized worker function',
    apply(repo) {
        for (const f of FILES) {
            const p = path.join(repo, f);
            let s = fs.readFileSync(p, 'utf8');
            s = s.replace(/(\n(\s*)function hasAdTags\(textStr\) \{\n\s*)return AdSignifiers\.some\(\(s\) => s && textStr\.includes\(s\)\);/,
                '\n$2const AdTagMatchers = [/stitched/, /EXT-X-CUE-OUT/, /twitch-maf-ad/, /twitch-trigger/];// perf: precompiled$1return AdTagMatchers.some((re) => re.test(textStr));');
            if (!s.includes('AdTagMatchers')) throw new Error('scenario anchor missing in ' + f);
            fs.writeFileSync(p, s);
        }
    },
    check(repo) {
        const s = fs.readFileSync(path.join(repo, 'vaft/vaft.user.js'), 'utf8');
        const fn = s.slice(s.indexOf('function hasAdTags('), s.indexOf('function hasAdTags(') + 300);
        return { outerRefRemovedFromHasAdTags: !/AdTagMatchers/.test(fn) || /scope\.AdTagMatchers/.test(s) };
    },
};
