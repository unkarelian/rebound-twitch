#!/usr/bin/env node
// Rebound config tooling: keygen, sign, verify, publish, rollback.
//
//   node tools/config-tool.js keygen <outDir> <keyId>
//   node tools/config-tool.js validate <config.json>
//   node tools/config-tool.js sign <config.json> [--key-id k1]       key from $REBOUND_SIGNING_KEY (PKCS8 PEM)
//   node tools/config-tool.js verify <config.json> [<sig>]
//   node tools/config-tool.js publish <candidate.json> --out <liveDir> [--note "..."]
//   node tools/config-tool.js rollback <version> --out <liveDir>
//
// publish/rollback assign the next version number, stamp publishedAt, sign, and
// write config/published/v<N>.json(+.sig) plus <liveDir>/config.json(+.sig).
// Only the release workflow should hold REBOUND_SIGNING_KEY (see docs/RUNBOOK.md).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateConfig, verifyConfig } = require('../extension/src/shared/config.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLISHED = path.join(ROOT, 'config', 'published');

function loadPublicKeys() {
    const src = fs.readFileSync(path.join(ROOT, 'extension/src/shared/keys.js'), 'utf8');
    const sandbox = {};
    new Function('globalThis', src)(sandbox);
    return sandbox.REBOUND_PUBLIC_KEYS;
}

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : def;
}

function die(msg) {
    console.error(msg);
    process.exit(1);
}

function signBytes(bytes, keyId) {
    const pem = process.env.REBOUND_SIGNING_KEY;
    if (!pem) die('REBOUND_SIGNING_KEY is not set (PKCS8 PEM of the Ed25519 private key)');
    const key = crypto.createPrivateKey(pem);
    const signature = crypto.sign(null, bytes, key).toString('base64');
    return JSON.stringify({ keyId, signature }) + '\n';
}

function serialize(cfg) {
    return Buffer.from(JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function publishedVersions() {
    if (!fs.existsSync(PUBLISHED)) return [];
    return fs.readdirSync(PUBLISHED).map((f) => /^v(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

function writePublished(cfg, keyId, liveDir) {
    const bytes = serialize(cfg);
    const v = validateConfig(cfg);
    if (!v.ok) die('refusing to publish invalid config:\n  ' + v.errors.join('\n  '));
    const sig = signBytes(bytes, keyId);
    fs.mkdirSync(PUBLISHED, { recursive: true });
    fs.writeFileSync(path.join(PUBLISHED, 'v' + cfg.version + '.json'), bytes);
    fs.writeFileSync(path.join(PUBLISHED, 'v' + cfg.version + '.json.sig'), sig);
    if (liveDir) {
        fs.mkdirSync(liveDir, { recursive: true });
        fs.writeFileSync(path.join(liveDir, 'config.json'), bytes);
        fs.writeFileSync(path.join(liveDir, 'config.json.sig'), sig);
    }
    console.log('published config v' + cfg.version + (liveDir ? ' -> ' + liveDir : ''));
}

function nextVersion() {
    const vs = publishedVersions();
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/defaults.json'), 'utf8'));
    return Math.max(defaults.version, vs.length ? vs[vs.length - 1] : 0) + 1;
}

async function main() {
    const [cmd, a1, a2] = process.argv.slice(2);
    const keyId = arg('--key-id', process.env.REBOUND_SIGNING_KEY_ID || 'k1');
    switch (cmd) {
        case 'keygen': {
            if (!a1 || !a2) die('usage: keygen <outDir> <keyId>');
            const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
            fs.mkdirSync(a1, { recursive: true, mode: 0o700 });
            const priv = path.join(a1, a2 + '.private.pem');
            fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
            const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
            fs.writeFileSync(path.join(a1, a2 + '.public.b64'), raw + '\n');
            console.log(JSON.stringify({ id: a2, key: raw }));
            break;
        }
        case 'validate': {
            const v = validateConfig(JSON.parse(fs.readFileSync(a1, 'utf8')));
            if (!v.ok) die('INVALID:\n  ' + v.errors.join('\n  '));
            console.log('valid');
            break;
        }
        case 'sign': {
            fs.writeFileSync(a1 + '.sig', signBytes(fs.readFileSync(a1), keyId));
            console.log('wrote ' + a1 + '.sig');
            break;
        }
        case 'verify': {
            const res = await verifyConfig(new Uint8Array(fs.readFileSync(a1)), fs.readFileSync(a2 || a1 + '.sig', 'utf8'), loadPublicKeys(), { crypto: crypto.webcrypto });
            if (!res.ok) die('REJECTED: ' + res.error);
            console.log('OK: config v' + res.config.version);
            break;
        }
        case 'publish': {
            const cand = JSON.parse(fs.readFileSync(a1, 'utf8'));
            cand.version = nextVersion();
            cand.publishedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
            const note = arg('--note');
            if (note) cand.note = note.slice(0, 280);
            writePublished(cand, keyId, arg('--out'));
            break;
        }
        case 'rollback': {
            const src = path.join(PUBLISHED, 'v' + Number(a1) + '.json');
            if (!fs.existsSync(src)) die('no published config v' + a1);
            const cfg = JSON.parse(fs.readFileSync(src, 'utf8'));
            cfg.version = nextVersion();
            cfg.publishedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
            cfg.note = 'Rollback to the content of v' + Number(a1);
            writePublished(cfg, keyId, arg('--out'));
            break;
        }
        default:
            die('commands: keygen, validate, sign, verify, publish, rollback');
    }
}

main().catch((e) => die(e.stack || String(e)));
