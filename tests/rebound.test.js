// Rebound tests: remote config validation, signatures, and that config values
// actually reach the worker blob. Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadVaft, workerAccessTokenRequest, ROOT } = require('./helpers/vaft-harness.js');
const { validateConfig, verifyConfig, compareVersions } = require('../extension/src/shared/config.js');

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/defaults.json'), 'utf8'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/schema.json'), 'utf8'));
const VAFT_FILES = ['vaft/vaft.user.js', 'vaft/vaft-ublock-origin.js'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function cfgWith(mut) {
    const c = clone(DEFAULTS);
    c.version = 10;
    mut(c);
    return c;
}

// ---------------------------------------------------------------- patches
test('Rebound patches are present in both synced vaft files', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/apply-rebound-patches.js'), '--check'], { stdio: 'pipe' });
});

for (const file of VAFT_FILES) {
    test(`${file}: bundled defaults.json matches the script's built-in values`, () => {
        const v = loadVaft({ file });
        const w = v.spawnTwitchWorker();
        const g = (name) => JSON.parse(w.eval('JSON.stringify(' + name + ')'));
        assert.equal(g('PlaybackAccessTokenHash'), DEFAULTS.gql.playbackAccessToken.sha256Hash);
        assert.equal(g('PlaybackAccessTokenOperation'), DEFAULTS.gql.playbackAccessToken.operationName);
        assert.equal(g('RecordAdEventHash'), DEFAULTS.gql.recordAdEvent.sha256Hash);
        assert.equal(g('ClientID'), DEFAULTS.clientId);
        assert.deepEqual(g('AdSignifiers'), DEFAULTS.adSignifiers);
        assert.deepEqual(g('KnownNonAdSignifiers'), DEFAULTS.knownNonAdSignifiers);
        assert.deepEqual(g('AdSegmentURLPatterns'), DEFAULTS.adSegmentUrlPatterns);
        assert.deepEqual(g('BackupPlayerTypes'), DEFAULTS.backupPlayerTypes);
        assert.equal(g('ForceAccessTokenPlayerType'), DEFAULTS.defaultPlayerType);
        assert.deepEqual(JSON.parse(v.eval('JSON.stringify(OverlaySelectors)')), DEFAULTS.overlaySelectors);
    });

    test(`${file}: worker uses the hash from config present at startup`, () => {
        const v = loadVaft({ file, remoteConfig: cfgWith((c) => { c.gql.playbackAccessToken.sha256Hash = HASH_B; c.clientId = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'; }) });
        const w = v.spawnTwitchWorker();
        const req = workerAccessTokenRequest(w, 'somechannel', 'site');
        assert.equal(req.body.extensions.persistedQuery.sha256Hash, HASH_B);
        assert.equal(req.headers['Client-ID'], 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
        assert.ok(!w.logs.some((l) => l.startsWith('ERROR')), 'worker logged an error: ' + w.logs.join('\n'));
    });

    test(`${file}: worker sends the configured operationName with the hash`, () => {
        const v = loadVaft({ file, remoteConfig: cfgWith((c) => { c.gql.playbackAccessToken = { operationName: 'PlaybackAccessToken_Template', sha256Hash: HASH_B }; }) });
        const req = workerAccessTokenRequest(v.spawnTwitchWorker(), 'somechannel', 'popout');
        assert.equal(req.body.operationName, 'PlaybackAccessToken_Template');
        assert.equal(req.body.extensions.persistedQuery.sha256Hash, HASH_B);
    });

    test(`${file}: worker without config uses the default hash`, () => {
        const w = loadVaft({ file }).spawnTwitchWorker();
        assert.equal(workerAccessTokenRequest(w, 'c', 'site').body.extensions.persistedQuery.sha256Hash, DEFAULTS.gql.playbackAccessToken.sha256Hash);
    });

    test(`${file}: config arriving after the worker exists reaches the worker`, () => {
        const v = loadVaft({ file });
        const w = v.spawnTwitchWorker();
        v.postToPage({ type: 'rebound-config', config: cfgWith((c) => { c.gql.playbackAccessToken.sha256Hash = HASH_C; }) });
        const msg = w.base.posted.find((m) => m.key === 'UpdateRemoteConfig');
        assert.ok(msg, 'main thread did not forward config to the worker');
        w.send(msg); // deliver what the main thread posted
        assert.equal(workerAccessTokenRequest(w, 'c', 'site').body.extensions.persistedQuery.sha256Hash, HASH_C);
        assert.equal(v.eval('PlaybackAccessTokenHash'), HASH_C);
    });

    test(`${file}: older or equal config versions are ignored`, () => {
        const v = loadVaft({ file, remoteConfig: cfgWith((c) => { c.gql.playbackAccessToken.sha256Hash = HASH_B; }) });
        v.postToPage({ type: 'rebound-config', config: cfgWith((c) => { c.version = 9; c.gql.playbackAccessToken.sha256Hash = HASH_C; }) });
        v.postToPage({ type: 'rebound-config', config: cfgWith((c) => { c.version = 10; c.gql.playbackAccessToken.sha256Hash = HASH_C; }) });
        assert.equal(v.eval('PlaybackAccessTokenHash'), HASH_B);
        assert.equal(v.eval('RemoteConfigVersion'), 10);
    });

    test(`${file}: page-side type checks drop malformed values (defense in depth)`, () => {
        const v = loadVaft({ file, remoteConfig: cfgWith((c) => {
            c.gql.playbackAccessToken.sha256Hash = 'not-a-hash';
            c.adSignifiers = [42];
            c.overlaySelectors = ['div[class*="overlay"]'];
            c.defaultPlayerType = 'site<script>';
        }) });
        assert.equal(v.eval('PlaybackAccessTokenHash'), DEFAULTS.gql.playbackAccessToken.sha256Hash);
        assert.deepEqual(JSON.parse(v.eval('JSON.stringify(AdSignifiers)')), DEFAULTS.adSignifiers);
        assert.deepEqual(JSON.parse(v.eval('JSON.stringify(OverlaySelectors)')), DEFAULTS.overlaySelectors);
        assert.equal(v.eval('ForceAccessTokenPlayerType'), 'popout');
    });

    test(`${file}: user's localStorage player type beats config defaultPlayerType`, () => {
        const v = loadVaft({ file, localStorage: { twitchAdSolutions_playerType: 'embed' }, remoteConfig: cfgWith((c) => { c.defaultPlayerType = 'site'; }) });
        assert.equal(v.eval('ForceAccessTokenPlayerType'), 'embed');
        const w = v.spawnTwitchWorker();
        assert.equal(w.eval('ForceAccessTokenPlayerType'), 'embed');
        v.postToPage({ type: 'rebound-config', config: cfgWith((c) => { c.version = 11; c.defaultPlayerType = 'mobile_web'; }) });
        assert.equal(v.eval('ForceAccessTokenPlayerType'), 'embed');
    });

    test(`${file}: config ad signifiers are what the worker strips on`, async () => {
        // A made-up marker that only the config knows about.
        const v = loadVaft({ file, localStorage: { twitchAdSolutions_monitor: 'true' }, remoteConfig: cfgWith((c) => { c.adSignifiers = ['rebound-test-ad']; }) });
        const w = v.spawnTwitchWorker({ autoAnswerGql: true, routes: [
            { match: '/channel/hls/', body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",FRAME-RATE=30.000\nhttps://pl.example/v1/playlist/720.m3u8\n' },
            { match: '/720.m3u8', body: '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-DATERANGE:ID="x",CLASS="rebound-test-ad",START-DATE="2026-11-08T00:00:00Z"\n#EXTINF:2.000,ad\nhttps://seg.example/ad1.ts\n' },
        ] });
        await w.playerFetch('https://usher.ttvnw.net/api/channel/hls/testchan.m3u8?x=1');
        await w.playerFetch('https://pl.example/v1/playlist/720.m3u8');
        const ev = w.monitorEvents();
        assert.equal(ev.length, 1);
        assert.equal(ev[0].rawHasAds, true, 'config-only signifier was not detected');
        assert.equal(ev[0].configVersion, 10);
    });

    test(`${file}: replay real pre-roll fixture - no ad segment leaks to the player`, async () => {
        const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/preroll-stitched-ad-2026-11-08.json'), 'utf8'));
        const v = loadVaft({ file, localStorage: { twitchAdSolutions_monitor: 'true' } });
        const w = v.spawnTwitchWorker({ autoAnswerGql: true, routes: [
            { match: '/channel/hls/', body: fx.master },
            { match: fx.variantUrl.split('/').pop(), bodies: fx.mediaPolls },
        ] });
        await w.playerFetch('https://usher.ttvnw.net/api/channel/hls/' + fx.channel + '.m3u8?x=1');
        for (let i = 0; i < fx.mediaPolls.length; i++) await w.playerFetch(fx.variantUrl);
        const ev = w.monitorEvents();
        assert.equal(ev.length, fx.mediaPolls.length);
        assert.ok(ev.every((e) => e.rawHasAds === fx.expect.rawHasAds), 'fixture should be detected as ads');
        assert.deepEqual(ev.map((e) => e.leakedAdSegments), ev.map(() => fx.expect.leakedAdSegments), 'ad segments leaked');
        assert.ok(w.posted.some((m) => m.key === 'FetchRequest'), 'expected a backup access-token attempt');
    });
}

// ---------------------------------------------------------------- schema
const INVALID = {
    'unknown top-level key': (c) => { c.script = 'alert(1)'; },
    'wrong schemaVersion': (c) => { c.schemaVersion = 2; },
    'short hash': (c) => { c.gql.playbackAccessToken.sha256Hash = 'abc'; },
    'uppercase hash': (c) => { c.gql.playbackAccessToken.sha256Hash = 'A'.repeat(64); },
    'unknown gql op': (c) => { c.gql.other = { sha256Hash: HASH_B }; },
    'operationName with punctuation': (c) => { c.gql.playbackAccessToken.operationName = 'PlaybackAccessToken{x}'; },
    'operationName on recordAdEvent': (c) => { c.gql.recordAdEvent.operationName = 'X'; },
    'missing clientId': (c) => { delete c.clientId; },
    'empty adSignifiers': (c) => { c.adSignifiers = []; },
    'too many adSignifiers': (c) => { c.adSignifiers = Array.from({ length: 33 }, (_, i) => 'sig-' + i); },
    'duplicate signifier': (c) => { c.adSignifiers = ['stitched-ad', 'stitched-ad']; },
    'signifier with newline': (c) => { c.adSignifiers = ['a\nb-c']; },
    'url pattern is a full URL': (c) => { c.adSegmentUrlPatterns = ['https://evil.example/']; },
    'fuzzy overlay selector': (c) => { c.overlaySelectors = ['[class*="overlay"]']; },
    'player type with spaces': (c) => { c.defaultPlayerType = 'site popout'; },
    'version zero': (c) => { c.version = 0; },
    'version float': (c) => { c.version = 1.5; },
    'bad minExtensionVersion': (c) => { c.minExtensionVersion = '1.0'; },
    'note too long': (c) => { c.note = 'x'.repeat(281); },
};

test('defaults.json is valid', () => {
    const r = validateConfig(DEFAULTS);
    assert.ok(r.ok, r.errors.join('; '));
});

for (const [name, mut] of Object.entries(INVALID)) {
    test('validateConfig rejects: ' + name, () => {
        const c = clone(DEFAULTS);
        mut(c);
        assert.equal(validateConfig(c).ok, false);
    });
}

test('hand validator and config/schema.json agree on every fixture', () => {
    const Ajv = require('ajv/dist/2020');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(SCHEMA);
    const cases = [['defaults', clone(DEFAULTS)], ...Object.entries(INVALID).map(([n, m]) => { const c = clone(DEFAULTS); m(c); return [n, c]; })];
    for (const [name, c] of cases) {
        assert.equal(validateConfig(c).ok, validate(c), 'disagreement on: ' + name + ' ' + JSON.stringify(validate.errors));
    }
});

// ---------------------------------------------------------------- signatures
function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}
function sign(bytes, privateKey, keyId) {
    return JSON.stringify({ keyId, signature: crypto.sign(null, bytes, privateKey).toString('base64') });
}
const enc = (o) => new Uint8Array(Buffer.from(JSON.stringify(o)));
const OPTS = { crypto: crypto.webcrypto };

test('verifyConfig accepts a correctly signed config', async () => {
    const k = keypair();
    const bytes = enc(DEFAULTS);
    const r = await verifyConfig(bytes, sign(bytes, k.privateKey, 'k1'), [{ id: 'k1', key: k.pub }], OPTS);
    assert.ok(r.ok, r.error);
    assert.equal(r.config.version, DEFAULTS.version);
});

test('verifyConfig accepts the pre-shipped next key (rotation)', async () => {
    const k1 = keypair(), k2 = keypair();
    const bytes = enc(DEFAULTS);
    const r = await verifyConfig(bytes, sign(bytes, k2.privateKey, 'k2'), [{ id: 'k1', key: k1.pub }, { id: 'k2', key: k2.pub }], OPTS);
    assert.ok(r.ok, r.error);
});

test('verifyConfig rejects tampered bytes', async () => {
    const k = keypair();
    const bytes = enc(DEFAULTS);
    const sig = sign(bytes, k.privateKey, 'k1');
    const tampered = enc({ ...DEFAULTS, clientId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const r = await verifyConfig(tampered, sig, [{ id: 'k1', key: k.pub }], OPTS);
    assert.equal(r.ok, false);
    assert.match(r.error, /bad signature/);
});

test('verifyConfig rejects a signature from an unknown key', async () => {
    const k = keypair(), attacker = keypair();
    const bytes = enc(DEFAULTS);
    const r1 = await verifyConfig(bytes, sign(bytes, attacker.privateKey, 'k1'), [{ id: 'k1', key: k.pub }], OPTS);
    assert.equal(r1.ok, false);
    const r2 = await verifyConfig(bytes, sign(bytes, attacker.privateKey, 'k9'), [{ id: 'k1', key: k.pub }], OPTS);
    assert.match(r2.error, /unknown signing key/);
});

test('verifyConfig rejects unsigned / garbage signature files', async () => {
    const k = keypair();
    for (const sig of ['', 'null', '{}', 'not json', JSON.stringify({ keyId: 'k1', signature: 'AAAA' })]) {
        const r = await verifyConfig(enc(DEFAULTS), sig, [{ id: 'k1', key: k.pub }], OPTS);
        assert.equal(r.ok, false, 'accepted signature: ' + sig);
    }
});

test('verifyConfig rejects a validly signed config with the wrong schemaVersion', async () => {
    const k = keypair();
    const bytes = enc({ ...DEFAULTS, schemaVersion: 2 });
    const r = await verifyConfig(bytes, sign(bytes, k.privateKey, 'k1'), [{ id: 'k1', key: k.pub }], OPTS);
    assert.equal(r.ok, false);
    assert.match(r.error, /schemaVersion/);
});

test('verifyConfig rejects a validly signed config that fails schema', async () => {
    const k = keypair();
    const bytes = enc({ ...DEFAULTS, overlaySelectors: ['.player-overlay-background'] });
    const r = await verifyConfig(bytes, sign(bytes, k.privateKey, 'k1'), [{ id: 'k1', key: k.pub }], OPTS);
    assert.equal(r.ok, false);
});

test('verifyConfig enforces anti-rollback and minExtensionVersion', async () => {
    const k = keypair();
    const bytes = enc({ ...DEFAULTS, version: 5, minExtensionVersion: '0.3.0' });
    const sig = sign(bytes, k.privateKey, 'k1');
    const keys = [{ id: 'k1', key: k.pub }];
    assert.equal((await verifyConfig(bytes, sig, keys, { ...OPTS, currentVersion: 5 })).stale, true);
    assert.equal((await verifyConfig(bytes, sig, keys, { ...OPTS, currentVersion: 4, extensionVersion: '0.2.9' })).ok, false);
    assert.equal((await verifyConfig(bytes, sig, keys, { ...OPTS, currentVersion: 4, extensionVersion: '0.3.0' })).ok, true);
});

test('compareVersions', () => {
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
    assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
    assert.equal(compareVersions('1.0.0', '1.2.0'), -1);
});

// ---------------------------------------------------------------- publish tool
test('config-tool publish signs with next version and output verifies; rollback re-signs old content', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rebound-'));
    const k = crypto.generateKeyPairSync('ed25519');
    const pub = k.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    // Run the tool against a scratch copy of the repo pieces it needs.
    for (const rel of ['tools/config-tool.js', 'extension/src/shared/config.js', 'config/defaults.json']) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
    }
    fs.mkdirSync(path.join(tmp, 'config/published'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension/src/shared/keys.js'), `globalThis.REBOUND_PUBLIC_KEYS = [{ id: 'k1', key: '${pub}' }];`);
    const env = { ...process.env, REBOUND_SIGNING_KEY: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const run = (...a) => execFileSync(process.execPath, [path.join(tmp, 'tools/config-tool.js'), ...a], { env, cwd: tmp, encoding: 'utf8' });
    const cand = cfgWith((c) => { c.gql.playbackAccessToken.sha256Hash = HASH_B; });
    fs.writeFileSync(path.join(tmp, 'cand.json'), JSON.stringify(cand));
    run('publish', path.join(tmp, 'cand.json'), '--out', path.join(tmp, 'live'), '--note', 'test');
    const v0 = DEFAULTS.version;
    assert.match(run('verify', path.join(tmp, 'live/config.json')), new RegExp('OK: config v' + (v0 + 1)));
    run('publish', path.join(tmp, 'cand.json'), '--out', path.join(tmp, 'live'));
    run('rollback', String(v0 + 1), '--out', path.join(tmp, 'live'));
    const live = JSON.parse(fs.readFileSync(path.join(tmp, 'live/config.json'), 'utf8'));
    assert.equal(live.version, v0 + 3);
    assert.match(live.note, new RegExp('v' + (v0 + 1)));
    assert.match(run('verify', path.join(tmp, 'live/config.json')), new RegExp('OK: config v' + (v0 + 3)));
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- publish gate
const { decide } = require('../tools/publish-gate.js');
const passRun = (n) => ({ pass: true, run: { results: Array.from({ length: n }, (_, i) => ({ channel: 'c' + i, verdict: 'PASS', B: { ok: true } })) } });

test('publish gate: hash-only change with 3-channel PASS auto-publishes', () => {
    const live = cfgWith(() => {});
    const cand = cfgWith((c) => { c.version = 11; c.gql.playbackAccessToken.sha256Hash = HASH_B; });
    assert.equal(decide(cand, { kind: 'hash', liveTest: passRun(3) }, live).decision, 'auto');
});

test('publish gate: "hash" candidate that also touches signifiers needs a human', () => {
    const live = cfgWith(() => {});
    const cand = cfgWith((c) => { c.gql.playbackAccessToken.sha256Hash = HASH_B; c.adSignifiers = ['x-y-z']; });
    const d = decide(cand, { kind: 'hash', liveTest: passRun(3) }, live);
    assert.equal(d.decision, 'human');
    assert.match(d.reasons.join(), /outside hash scope: adSignifiers/);
});

test('publish gate: signifier change needs 5 channels with playback', () => {
    const live = cfgWith(() => {});
    const cand = cfgWith((c) => { c.adSignifiers = [...c.adSignifiers, 'EXT-X-DATERANGE:CLASS="twitch-new-ad"']; });
    assert.equal(decide(cand, { kind: 'signifiers', liveTest: passRun(3) }, live).decision, 'human');
    assert.equal(decide(cand, { kind: 'signifiers', liveTest: passRun(5) }, live).decision, 'auto');
    const noPlayback = passRun(5); noPlayback.run.results[2].B.ok = false;
    assert.equal(decide(cand, { kind: 'signifiers', liveTest: noPlayback }, live).decision, 'human');
});

test('publish gate: player types may only be reordered automatically', () => {
    const live = cfgWith(() => {});
    const reorder = cfgWith((c) => { c.backupPlayerTypes = ['embed', 'site', 'popout', 'mobile_web']; });
    const add = cfgWith((c) => { c.backupPlayerTypes = ['autoplay', 'site', 'popout', 'mobile_web', 'embed']; });
    assert.equal(decide(reorder, { kind: 'playertypes', liveTest: passRun(5) }, live).decision, 'auto');
    assert.equal(decide(add, { kind: 'playertypes', liveTest: passRun(5) }, live).decision, 'human');
});

test('publish gate: all-inconclusive live test is not a pass; invalid candidate is rejected', () => {
    const live = cfgWith(() => {});
    const cand = cfgWith((c) => { c.clientId = 'abcdefghijklmnopqrstuvwxyz0123'; });
    const incon = { pass: true, run: { results: [1, 2, 3].map((i) => ({ verdict: 'INCONCLUSIVE', B: { ok: true } })) } };
    assert.equal(decide(cand, { kind: 'hash', liveTest: incon }, live).decision, 'human');
    assert.equal(decide({ ...cand, clientId: 'BAD!' }, { kind: 'hash', liveTest: passRun(3) }, live).decision, 'reject');
});

// ---------------------------------------------------------------- monitor verdict logic
const { evaluate, checkPlayback } = require('../monitor/lib/evaluate.js');
function samples(fn, n = 80) {
    return Array.from({ length: n }, (_, i) => ({ at: i * 1000, hasVideo: true, ...fn(i) }));
}

test('check B: steady playback passes', () => {
    const r = checkPlayback({ samples: samples((i) => ({ currentTime: i, frames: i * 30, paused: false })) });
    assert.ok(r.ok, r.reason);
});

test('check B: an end-of-break player reload (currentTime resets) is not a failure', () => {
    // Regression: "last minus first" scored 72s of real playback as 0.3s.
    const r = checkPlayback({ samples: samples((i) => (i < 75 ? { currentTime: i, frames: i * 30 } : { currentTime: (i - 75) * 0.5, frames: 2250 + (i - 75) * 15 })) });
    assert.ok(r.ok, r.reason);
});

test('check B: frozen playhead or stream that never starts fails', () => {
    assert.equal(checkPlayback({ samples: samples((i) => ({ currentTime: i < 30 ? i : 30, frames: Math.min(i, 30) * 30 })) }).ok, false);
    assert.equal(checkPlayback({ samples: samples(() => ({ currentTime: 0, frames: 0, paused: true })) }).ok, false);
});

test('check B: audio-only (time advances, no frames) fails', () => {
    assert.equal(checkPlayback({ samples: samples((i) => ({ currentTime: i, frames: 10 })) }).ok, false);
});

test('verdict: no failures but no ads in control is INCONCLUSIVE, never PASS', () => {
    const okTest = { samples: samples((i) => ({ currentTime: i, frames: i * 30 })), extState: { workers: 1 }, monitorLog: [{ kind: 'playlist', leakedAdSegments: 0 }], console: [], pageErrors: [] };
    assert.equal(evaluate({ control: { observed: { playlists: [{ adSegs: 0 }] } }, test: okTest, probe: { adsSeen: false } }).verdict, 'INCONCLUSIVE');
    assert.equal(evaluate({ control: { observed: { playlists: [{ adSegs: 3 }] } }, test: okTest, probe: null }).verdict, 'PASS');
    const leaky = { ...okTest, monitorLog: [{ kind: 'playlist', leakedAdSegments: 2 }] };
    assert.equal(evaluate({ control: { observed: { playlists: [] } }, test: leaky, probe: null }).verdict, 'FAIL(A)');
    const stale = { ...okTest, monitorLog: [...okTest.monitorLog, { kind: 'gql', status: 200, errors: ['PersistedQueryNotFound'] }] };
    assert.equal(evaluate({ control: null, test: stale, probe: null }).verdict, 'FAIL(D)');
});

// ---------------------------------------------------------------- adaptive schedule
test('schedule: stable -> full runs every 12h; unstable -> every time', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rebound-sched-'));
    const script = `
        const s = require(${JSON.stringify(path.join(ROOT, 'monitor/lib/schedule.js'))});
        const st = require(${JSON.stringify(path.join(ROOT, 'monitor/lib/state.js'))});
        const now = Date.parse('2026-11-10T12:00:00Z');
        const out = {};
        const hist = (v) => { for (let i = 0; i < 6; i++) st.appendHistory({ runVerdict: v }); };
        st.writeJson('state.json', { breaking: null }); hist('PASS');
        st.writeJson('schedule.json', { monitor: '2026-11-10T06:00:00Z' });
        out.stableRecent = s.shouldRunFull('monitor', now).run;
        st.writeJson('schedule.json', { monitor: '2026-11-09T23:00:00Z' });
        out.stableDue = s.shouldRunFull('monitor', now).run;
        st.writeJson('schedule.json', { monitor: '2026-11-10T11:50:00Z' });
        st.writeJson('state.json', { breaking: { since: '2026-11-10T11:00:00Z' } });
        out.breaking = s.shouldRunFull('monitor', now).run;
        st.writeJson('state.json', { breaking: null, lastResolved: { resolvedAt: '2026-11-10T02:00:00Z' } });
        out.recentlyResolved = s.shouldRunFull('monitor', now).run;
        st.writeJson('state.json', { breaking: null });
        st.writeJson('probe.json', { ok: false, error: 'PersistedQueryNotFound' });
        out.probeFailed = s.shouldRunFull('monitor', now).run;
        st.writeJson('probe.json', { ok: true });
        st.appendHistory({ runVerdict: 'DEGRADED' });
        out.degraded = s.shouldRunFull('monitor', now).run;
        console.log(JSON.stringify(out));`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, REBOUND_STATE_DIR: tmp }, encoding: 'utf8' }));
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.deepEqual(out, { stableRecent: false, stableDue: true, breaking: true, recentlyResolved: true, probeFailed: true, degraded: true });
});
