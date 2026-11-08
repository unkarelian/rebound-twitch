// Failure artifacts: everything a human or the fix agent needs to reproduce a
// breakage, redacted. Stored under monitor/artifacts/<runId>/<channel>/ on the
// monitor host (the "object storage" of the plan; see docs/DECISIONS.md).
'use strict';
const fs = require('fs');
const path = require('path');
const { redactM3u8, redactUrl, redactText, redactGqlResponse } = require('./redact.js');

function writeJson(dir, name, obj) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

// Minimal HAR 1.2 from the response log (no bodies, no headers, URLs redacted).
function toHar(session) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'rebound-monitor', version: '1' },
            entries: (session.network || []).map((n) => ({
                startedDateTime: new Date(Date.now() - session.durationMs + n.at).toISOString(),
                time: 0,
                request: { method: n.method, url: redactUrl(n.url), httpVersion: '', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
                response: { status: n.status, statusText: '', httpVersion: '', headers: [], cookies: [], content: { size: -1, mimeType: n.type || '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
                cache: {}, timings: { send: 0, wait: 0, receive: 0 },
            })),
        },
    };
}

function saveArtifacts(baseDir, { channel, control, test, probe, verdict, versions }) {
    const dir = path.join(baseDir, channel.login);
    fs.mkdirSync(path.join(dir, 'm3u8'), { recursive: true });
    writeJson(dir, 'verdict.json', { channel, verdict, versions });
    // Playlists before/after our processing (test) and as Twitch served them (control).
    let n = 0;
    for (const e of (test.monitorLog || []).filter((x) => x.kind === 'playlist' && (x.raw || x.out))) {
        if (n >= 12) break;
        n++;
        if (e.raw) fs.writeFileSync(path.join(dir, 'm3u8', `test-${n}-before.m3u8`), redactM3u8(e.raw));
        if (e.out) fs.writeFileSync(path.join(dir, 'm3u8', `test-${n}-after.m3u8`), redactM3u8(e.out));
    }
    let c = 0;
    for (const p of ((control && control.observed && control.observed.playlists) || []).filter((x) => x.raw)) {
        if (c >= 6) break;
        c++;
        fs.writeFileSync(path.join(dir, 'm3u8', `control-${c}.m3u8`), redactM3u8(p.raw));
    }
    writeJson(dir, 'gql.json', {
        test: (test.monitorLog || []).filter((e) => e.kind === 'gql'),
        controlHashes: control && control.observed ? control.observed.gql : [],
        controlClientIds: control && control.observed ? control.observed.clientIds.map(() => 'seen') : [],
        probe: probe ? redactGqlResponse(probe) : null,
    });
    const consoleLines = (s) => (s.console || []).map((l) => `${(l.at / 1000).toFixed(1)}s ${l.type} ${redactText(l.text)}`).join('\n');
    fs.writeFileSync(path.join(dir, 'console-test.log'), consoleLines(test));
    fs.writeFileSync(path.join(dir, 'console-test-ad-debug.log'), (test.console || []).filter((l) => l.text.includes('[AD DEBUG]')).map((l) => `${(l.at / 1000).toFixed(1)}s ${redactText(l.text)}`).join('\n'));
    if (control) fs.writeFileSync(path.join(dir, 'console-control.log'), consoleLines(control));
    writeJson(dir, 'page-errors.json', { test: test.pageErrors, control: control ? control.pageErrors : [] });
    writeJson(dir, 'samples.json', { test: test.samples, control: control ? control.samples : [] });
    writeJson(dir, 'test.har', toHar(test));
    if (control) writeJson(dir, 'control.har', toHar(control));
    return dir;
}

module.exports = { saveArtifacts };
