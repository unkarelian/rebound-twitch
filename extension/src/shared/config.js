// Rebound for Twitch: remote config validation and signature verification.
// Shared by the extension background script and the Node tools/tests, so it is
// plain script with no imports. It hand-mirrors config/schema.json. A test checks
// that both accept and reject the same fixtures, so update the two together.
(function (root) {
    'use strict';

    const SCHEMA_VERSION = 1;
    const TOP_KEYS = ['schemaVersion', 'version', 'minExtensionVersion', 'publishedAt', 'note', 'gql', 'clientId',
        'adSignifiers', 'knownNonAdSignifiers', 'adSegmentUrlPatterns', 'backupPlayerTypes', 'defaultPlayerType', 'overlaySelectors'];
    const OPTIONAL_KEYS = ['note'];
    const RE = {
        hash: /^[a-f0-9]{64}$/,
        operationName: /^[A-Za-z_]{1,64}$/,
        semver: /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/,
        date: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/,
        clientId: /^[a-z0-9]{20,40}$/,
        signifier: /^[A-Za-z0-9:="_.,-]{3,100}$/,
        urlPattern: /^\/[A-Za-z0-9_./-]{1,63}$/,
        playerType: /^[a-z_]{1,32}$/,
        selector: /^\[data-[a-z-]{1,40}="[A-Za-z0-9_-]{1,60}"\]$/,
    };

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    function checkList(errors, name, v, re, min, max) {
        if (!Array.isArray(v)) { errors.push(name + ': must be an array'); return; }
        if (v.length < min) errors.push(name + ': needs at least ' + min + ' item(s)');
        if (v.length > max) errors.push(name + ': at most ' + max + ' items');
        if (new Set(v).size !== v.length) errors.push(name + ': items must be unique');
        v.forEach((s, i) => {
            if (typeof s !== 'string' || !re.test(s)) errors.push(name + '[' + i + ']: invalid value');
        });
    }

    function checkPersistedQuery(errors, name, v, allowOperationName) {
        if (!isPlainObject(v)) { errors.push(name + ': must be an object'); return; }
        for (const k of Object.keys(v)) if (k !== 'sha256Hash' && !(allowOperationName && k === 'operationName')) errors.push(name + ': unknown key ' + k);
        if ('operationName' in v && (typeof v.operationName !== 'string' || !RE.operationName.test(v.operationName))) errors.push(name + '.operationName: invalid');
        if (typeof v.sha256Hash !== 'string' || !RE.hash.test(v.sha256Hash)) errors.push(name + '.sha256Hash: must be 64 lowercase hex chars');
    }

    // Returns { ok: boolean, errors: string[] }.
    function validateConfig(cfg) {
        const errors = [];
        if (!isPlainObject(cfg)) return { ok: false, errors: ['config must be a JSON object'] };
        for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) errors.push('unknown key: ' + k);
        for (const k of TOP_KEYS) if (!OPTIONAL_KEYS.includes(k) && !(k in cfg)) errors.push('missing key: ' + k);
        if (cfg.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion: must be ' + SCHEMA_VERSION);
        if (!Number.isInteger(cfg.version) || cfg.version < 1 || cfg.version > 2147483647) errors.push('version: must be a positive integer');
        if (typeof cfg.minExtensionVersion !== 'string' || !RE.semver.test(cfg.minExtensionVersion)) errors.push('minExtensionVersion: must be x.y.z');
        if (typeof cfg.publishedAt !== 'string' || !RE.date.test(cfg.publishedAt)) errors.push('publishedAt: must be an ISO-8601 UTC timestamp');
        if ('note' in cfg && (typeof cfg.note !== 'string' || cfg.note.length > 280)) errors.push('note: string up to 280 chars');
        if (!isPlainObject(cfg.gql)) {
            errors.push('gql: must be an object');
        } else {
            for (const k of Object.keys(cfg.gql)) if (k !== 'playbackAccessToken' && k !== 'recordAdEvent') errors.push('gql: unknown key ' + k);
            checkPersistedQuery(errors, 'gql.playbackAccessToken', cfg.gql.playbackAccessToken, true);
            checkPersistedQuery(errors, 'gql.recordAdEvent', cfg.gql.recordAdEvent);
        }
        if (typeof cfg.clientId !== 'string' || !RE.clientId.test(cfg.clientId)) errors.push('clientId: invalid');
        checkList(errors, 'adSignifiers', cfg.adSignifiers, RE.signifier, 1, 32);
        checkList(errors, 'knownNonAdSignifiers', cfg.knownNonAdSignifiers, RE.signifier, 0, 64);
        checkList(errors, 'adSegmentUrlPatterns', cfg.adSegmentUrlPatterns, RE.urlPattern, 1, 16);
        checkList(errors, 'backupPlayerTypes', cfg.backupPlayerTypes, RE.playerType, 1, 8);
        if (typeof cfg.defaultPlayerType !== 'string' || !RE.playerType.test(cfg.defaultPlayerType)) errors.push('defaultPlayerType: invalid');
        checkList(errors, 'overlaySelectors', cfg.overlaySelectors, RE.selector, 0, 8);
        return { ok: errors.length === 0, errors };
    }

    function compareVersions(a, b) {
        const pa = String(a).split('.').map(Number);
        const pb = String(b).split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d !== 0) return d < 0 ? -1 : 1;
        }
        return 0;
    }

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // Verify a detached Ed25519 signature over the exact config bytes, then parse
    // and validate. publicKeys: [{ id, key }] where key is base64 of the 32-byte
    // raw public key. Shipping two keys (current and next) allows rotation.
    // sigText is the .sig file: JSON { keyId, signature } with base64 signature.
    // Returns { ok, config?, error? }.
    async function verifyConfig(configBytes, sigText, publicKeys, opts) {
        opts = opts || {};
        const subtle = (opts.crypto || root.crypto).subtle;
        let sig;
        try { sig = JSON.parse(sigText); } catch { return { ok: false, error: 'signature file is not JSON' }; }
        if (!sig || typeof sig.keyId !== 'string' || typeof sig.signature !== 'string') return { ok: false, error: 'signature file missing keyId/signature' };
        const pk = publicKeys.find((k) => k.id === sig.keyId);
        if (!pk) return { ok: false, error: 'unknown signing key ' + sig.keyId };
        let valid = false;
        try {
            const key = await subtle.importKey('raw', b64ToBytes(pk.key), { name: 'Ed25519' }, false, ['verify']);
            valid = await subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(sig.signature), configBytes);
        } catch (e) {
            return { ok: false, error: 'signature check failed: ' + (e && e.message) };
        }
        if (!valid) return { ok: false, error: 'bad signature' };
        let cfg;
        try { cfg = JSON.parse(new TextDecoder().decode(configBytes)); } catch { return { ok: false, error: 'config is not JSON' }; }
        const v = validateConfig(cfg);
        if (!v.ok) return { ok: false, error: 'schema: ' + v.errors.join('; ') };
        if (opts.extensionVersion && compareVersions(opts.extensionVersion, cfg.minExtensionVersion) < 0) {
            return { ok: false, error: 'config needs extension >= ' + cfg.minExtensionVersion };
        }
        if (typeof opts.currentVersion === 'number' && cfg.version <= opts.currentVersion) {
            return { ok: false, error: 'stale: version ' + cfg.version + ' <= current ' + opts.currentVersion, stale: true };
        }
        return { ok: true, config: cfg };
    }

    const api = { SCHEMA_VERSION, validateConfig, verifyConfig, compareVersions };
    root.ReboundConfig = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
