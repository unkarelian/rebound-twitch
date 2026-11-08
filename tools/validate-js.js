#!/usr/bin/env node
// Same checks as upstream's validate.yml (acorn, ES2022), runnable locally.
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const ROOT = path.resolve(__dirname, '..');
const files = ['vaft/vaft.user.js', 'vaft/vaft_testing.user.js', 'video-swap-new/video-swap-new.user.js', 'strip/strip.user.js',
    'vaft/vaft-ublock-origin.js', 'vaft/vaft-testing-ublock-origin.js', 'video-swap-new/video-swap-new-ublock-origin.js', 'video-swap-new/video-swap-new-ublock-origin-testing.js'];
let bad = 0;
for (const f of files) {
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f.includes('ublock')) src = src.slice(src.indexOf('\n') + 1); // uBlock resource header
    try { acorn.parse(src, { ecmaVersion: 2022 }); console.log('ok   ' + f); } catch (e) { bad++; console.error('FAIL ' + f + ': ' + e.message); }
}
process.exit(bad ? 1 : 0);
