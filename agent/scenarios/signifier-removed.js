// Replay of the ad-signifier breakage class (CHANGELOG v63.0.0 #166 / v66.0.0 #207):
// the markers on Twitch's stitched-ad DATERANGE are no longer matched, so ad
// segments pass through as content. Expected fix: config-only (adSignifiers).
'use strict';
const fs = require('fs');
const path = require('path');
module.exports = {
    name: 'signifier-removed',
    // What the breaking commit looks like to the agent: an ordinary-looking change,
    // as these breakages historically were. The title above is never shown to it.
    commitMessage: 'config: narrow ad signifiers to reduce false positives on clean playlists',
    title: 'Ad signifiers no longer match Twitch\'s stitched-ad markers',
    apply(repo) {
        const p = path.join(repo, 'config/defaults.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        c.adSignifiers = c.adSignifiers.filter((s) => !/stitched|maf-ad|trigger/.test(s));
        c.note = 'replay scenario';
        fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
    },
    check(repo) {
        const c = JSON.parse(fs.readFileSync(path.join(repo, 'config/defaults.json'), 'utf8'));
        return { stitchedRestored: c.adSignifiers.some((s) => s.includes('stitched')) };
    },
};
