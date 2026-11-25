#!/usr/bin/env node
// Firefox self-hosted update manifest for one signed build.
//   node tools/updates-json.js <version> <file.xpi> <download-url>   > updates.json
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const [version, file, url] = process.argv.slice(2);
if (!version || !file || !url) { console.error('usage: updates-json.js <version> <file.xpi> <download-url>'); process.exit(2); }
const path = require('path');
const GECKO_ID = require(path.resolve(__dirname, '../extension/dist/firefox/manifest.json')).browser_specific_settings.gecko.id;
const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
process.stdout.write(JSON.stringify({ addons: { [GECKO_ID]: { updates: [{ version, update_link: url, update_hash: 'sha256:' + hash }] } } }, null, 2) + '\n');
