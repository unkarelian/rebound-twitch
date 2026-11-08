// Logged-out Twitch helpers for the monitor and fixers (Node side, no browser).
// Everything here is what an anonymous viewer can do; no credentials, ever.
'use strict';

const PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

async function gql(body, clientId) {
    const r = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': clientId || PUBLIC_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': UA },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
    return r.json();
}

// Live channel pool from the public directory. Raw (non-persisted) query; if
// Twitch ever blocks it, run.js falls back to scraping /directory in the browser.
async function liveChannels() {
    // One query: top categories, 15 streams each. Covers categories and a wide
    // spread of audience sizes. (Paging the flat streams list with a cursor trips
    // Twitch's integrity check for anonymous clients; this shape does not.)
    const res = await gql({ query: 'query { games(first: 20) { edges { node { name streams(first: 15) { edges { node { broadcaster { login } viewersCount } } } } } } }' });
    const games = res && res.data && res.data.games && res.data.games.edges;
    if (!Array.isArray(games)) throw new Error('directory query failed: ' + JSON.stringify(res).slice(0, 200));
    const out = [];
    for (const g of games) {
        for (const e of (g.node.streams && g.node.streams.edges) || []) {
            if (e.node && e.node.broadcaster) out.push({ login: e.node.broadcaster.login, viewers: e.node.viewersCount, game: g.node.name });
        }
    }
    return out;
}

// Pick n channels across different categories and audience sizes, avoiding
// channels used in the last few runs (recent: Set of logins).
function pickChannels(pool, n, recent, rand = Math.random) {
    const buckets = [[], [], []]; // big / mid / small by viewer count
    for (const c of pool) buckets[c.viewers >= 20000 ? 0 : c.viewers >= 3000 ? 1 : 2].push(c);
    for (const b of buckets) b.sort(() => rand() - 0.5);
    const out = [];
    const games = new Set();
    let bi = Math.floor(rand() * 3);
    for (let guard = 0; out.length < n && guard < 500; guard++, bi = (bi + 1) % 3) {
        const b = buckets[bi];
        const idx = b.findIndex((c) => !recent.has(c.login) && !games.has(c.game));
        const i = idx !== -1 ? idx : b.findIndex((c) => !recent.has(c.login));
        if (i === -1) continue;
        const [c] = b.splice(i, 1);
        out.push(c);
        games.add(c.game);
    }
    // Pool exhausted by the recency filter: ignore recency.
    for (const c of pool) if (out.length < n && !out.includes(c)) out.push(c);
    return out;
}

// Node-level control probe: request a normal 'site' token as a logged-out web
// viewer, then poll the media playlist for ad markers. A cheap second opinion on
// "is Twitch serving ads to this IP right now", independent of the browser.
async function probeAds(login, { hash, operationName = 'PlaybackAccessToken', signifiers, polls = 5, intervalMs = 2000 } = {}) {
    const out = { login, tokenOk: false, adsSeen: false, signifiers: [], error: null };
    try {
        const t = await gql({
            operationName,
            variables: { isLive: true, login, isVod: false, vodID: '', playerType: 'site', platform: 'web' },
            extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        });
        const tok = t && t.data && t.data.streamPlaybackAccessToken;
        if (!tok) { out.error = 'token: ' + JSON.stringify(t && t.errors).slice(0, 200); return out; }
        out.tokenOk = true;
        const p = new URLSearchParams({ sig: tok.signature, token: tok.value, allow_source: 'true', fast_bread: 'true', p: String(Math.floor(Math.random() * 1e7)), player_backend: 'mediaplayer', playlist_include_framerate: 'true', supported_codecs: 'av1,h265,h264', cdm: 'wv' });
        const master = await (await fetch(`https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?${p}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).text();
        const media = master.split('\n').find((l) => l.startsWith('https://'));
        if (!media) { out.error = 'no media playlist in master'; return out; }
        for (let i = 0; i < polls; i++) {
            const pl = await (await fetch(media, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).text();
            const hit = signifiers.filter((s) => pl.includes(s));
            if (hit.length) { out.adsSeen = true; out.signifiers = hit; break; }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    } catch (e) {
        out.error = String(e && e.message || e);
    }
    return out;
}

module.exports = { gql, liveChannels, pickChannels, probeAds, PUBLIC_CLIENT_ID, UA };
