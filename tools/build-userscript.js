#!/usr/bin/env node
// Escape-hatch userscript for GitHub Releases: the same patched vaft core the
// extension runs, with bundled defaults only (remote config is an extension
// feature). Writes extension/dist/rebound-vaft.user.js.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const src = fs.readFileSync(path.join(ROOT, 'vaft/vaft.user.js'), 'utf8');
const vaftVersion = src.match(/@version\s+(\S+)/)[1];
const url = 'https://github.com/unkarelian/rebound-twitch/releases/latest/download/rebound-vaft.user.js';
const header = `// ==UserScript==
// @name         Rebound for Twitch (vaft userscript)
// @namespace    https://github.com/unkarelian/rebound-twitch
// @version      ${vaftVersion}-rebound.${pkg.version}
// @description  Blocks Twitch video ads. TwitchAdSolutions vaft core with Rebound patches. Not affiliated with Twitch.
// @updateURL    ${url}
// @downloadURL  ${url}
// @author       TwitchAdSolutions Contributors (https://github.com/ryanbr/TwitchAdSolutions); Rebound
// @license      MIT
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;
const body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, '');
fs.mkdirSync(path.join(ROOT, 'extension/dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'extension/dist/rebound-vaft.user.js'), header + body);
console.log('wrote extension/dist/rebound-vaft.user.js (' + vaftVersion + '-rebound.' + pkg.version + ')');
