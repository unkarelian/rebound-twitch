// Redaction for anything we persist (monitor artifacts, test fixtures, agent inputs).
// Twitch playlists carry USER-IP, signed tokens and per-viewer session ids; HAR
// files carry cookies and auth headers. None of that may leave the machine.
'use strict';
const crypto = require('crypto');

const short = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

// Keep URL structure (host, path shape) for diagnosis, drop the opaque payloads.
function redactUrl(u) {
    return u.replace(/^(https?:\/\/[^/\s"]+)(\/[^\s"]*)?$/, (m, host, p) => {
        if (!p) return host;
        const [pathPart] = p.split('?');
        const segs = pathPart.split('/').map((s) => (s.length > 32 ? 'R' + short(s) + (/\.[a-z0-9]{2,4}$/.test(s) ? s.slice(s.lastIndexOf('.')) : '') : s));
        return host + segs.join('/');
    });
}

function redactM3u8(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/USER-IP="[^"]*"/g, 'USER-IP="0.0.0.0"')
        .replace(/\b(C|E|SERVING-ID|VIDEO-SESSION-ID|X-TV-TWITCH-SESSIONID|X-TV-TWITCH-AD-RADS-TOKEN|X-TV-TWITCH-AD-AD-SESSION-ID|X-TV-TWITCH-AD-CLICK-BEACON-ID)="[^"]*"/g, '$1="REDACTED"')
        .replace(/https?:\/\/[^\s",]+/g, (u) => redactUrl(u));
}

const SECRET_HEADER = /^(cookie|set-cookie|authorization|client-integrity|x-device-id|device-id|client-session-id)$/i;

function redactHeaders(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) out[k] = SECRET_HEADER.test(k) ? 'REDACTED' : v;
    return out;
}

// GQL bodies: keep operation, variables and hash; drop token values and signatures.
function redactGqlResponse(obj) {
    return JSON.parse(JSON.stringify(obj, (k, v) => {
        if ((k === 'value' || k === 'signature') && typeof v === 'string' && v.length > 20) return 'REDACTED(' + v.length + ')';
        return v;
    }));
}

function redactText(s) {
    if (typeof s !== 'string') return s;
    return s
        .replace(/OAuth [a-z0-9]+/gi, 'OAuth REDACTED')
        .replace(/("?(?:auth-token|Authorization|Client-Integrity)"?\s*[:=]\s*"?)[^",;\s]+/gi, '$1REDACTED')
        .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '0.0.0.0');
}

module.exports = { redactM3u8, redactUrl, redactHeaders, redactGqlResponse, redactText };
