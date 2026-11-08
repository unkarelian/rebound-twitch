// Replay of the GQL request-shape breakage class (CHANGELOG v63.0.0 #169): backup
// access-token requests go out in a shape Twitch rejects, here without the
// Client-ID header, so every backup player-type token fails and ad breaks fall back
// to stripping. Expected fix: code (restore the header in gqlRequest).
'use strict';
const fs = require('fs');
const path = require('path');
const FILES = ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js'];
module.exports = {
    name: 'gql-client-id-header',
    title: 'Backup PlaybackAccessToken requests sent without Client-ID',
    apply(repo) {
        for (const f of FILES) {
            const p = path.join(repo, f);
            let s = fs.readFileSync(p, 'utf8');
            const before = s;
            s = s.replace("            'Client-ID': ClientID,\n", '');
            if (s === before) throw new Error('scenario anchor missing in ' + f);
            fs.writeFileSync(p, s);
        }
    },
    check(repo) {
        const s = fs.readFileSync(path.join(repo, 'vaft/vaft.user.js'), 'utf8');
        const fn = s.slice(s.indexOf('function gqlRequest('), s.indexOf('function gqlRequest(') + 800);
        return { clientIdHeaderRestored: /Client-ID/.test(fn) };
    },
};
