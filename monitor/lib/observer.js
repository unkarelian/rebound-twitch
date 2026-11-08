// Preload script for the CONTROL browser (no extension). It is pure observation
// and changes nothing Twitch sees:
//  - wraps window.Worker so the player worker reports every media playlist it
//    fetches (ad markers, DATERANGE classes, X-TV-TWITCH-AD* attributes)
//  - wraps window.fetch to record Twitch's own GQL persisted-query hashes and the
//    Client-ID header (the hash/client-ID scraper, Phase 4a)
// Results accumulate in window.__reboundObs, which the monitor reads via evaluate().
//
// This function is serialized with toString() and must not reference outer scope.
function reboundObserver() {
    if (window.__reboundObs) return;
    const obs = window.__reboundObs = { playlists: [], gql: [], clientIds: [], errors: [] };
    const push = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max); };

    // ---- GQL hash scraper
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('gql.twitch.tv/gql') && init && typeof init.body === 'string') {
                const headers = init.headers || {};
                const cid = headers['Client-ID'] || headers['Client-Id'] || headers['client-id'];
                if (cid && !obs.clientIds.includes(cid)) obs.clientIds.push(cid);
                let body;
                try { body = JSON.parse(init.body); } catch { body = null; }
                for (const op of Array.isArray(body) ? body : body ? [body] : []) {
                    const h = op && op.extensions && op.extensions.persistedQuery && op.extensions.persistedQuery.sha256Hash;
                    if (op && op.operationName && h) {
                        push(obs.gql, { op: op.operationName, hash: h, playerType: op.variables && op.variables.playerType, at: Date.now() }, 300);
                    } else if (op && op.operationName && typeof op.query === 'string' && /PlaybackAccessToken|RecordAdEvent/.test(op.operationName)) {
                        // Twitch's web player sends PlaybackAccessToken_Template as raw query
                        // text; sha256(query) is the persisted hash for that operation (APQ).
                        if (!obs.rawQueries) obs.rawQueries = {};
                        obs.rawQueries[op.operationName] = op.query.slice(0, 8000);
                    }
                }
            }
        } catch (e) { push(obs.errors, String(e), 20); }
        return realFetch.apply(this, arguments);
    };

    // ---- playlist observer (runs inside the player worker)
    function workerHook() {
        const rf = self.fetch;
        self.fetch = async function (url) {
            const res = await rf.apply(this, arguments);
            try {
                const u = typeof url === 'string' ? url : (url && url.url) || '';
                if (/\.m3u8(\?|$)/.test(u.trim()) && !u.includes('/channel/hls/')) {
                    res.clone().text().then((t) => {
                        const lines = t.split(/\r?\n/);
                        let adSegs = 0, liveSegs = 0;
                        for (const l of lines) if (l.startsWith('#EXTINF')) { if (l.includes(',live')) liveSegs++; else adSegs++; }
                        const classes = [...new Set((t.match(/CLASS="[^"]+"/g) || []).map((x) => x.slice(7, -1)))];
                        const adAttrs = [...new Set(t.match(/X-TV-TWITCH-AD[A-Z-]*(?==)/g) || [])];
                        const cue = [...new Set(t.match(/#EXT-X-(?:CUE|SCTE35|DATERANGE-?[A-Z]*)[A-Z-]*/g) || [])];
                        postMessage({ __reboundObs: 1, at: Date.now(), adSegs, liveSegs, classes, adAttrs, cue, raw: adSegs > 0 ? t.slice(0, 30000) : null });
                    }).catch(() => {});
                }
            } catch {}
            return res;
        };
    }
    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker {
        constructor(url, opts) {
            let u = url;
            try {
                if (String(url).startsWith('blob:')) {
                    // Twitch revokes the blob URL right after new Worker(), so the
                    // source must be read synchronously now (same reason vaft does).
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', String(url), false);
                    xhr.send();
                    if (xhr.status === 200 || xhr.status === 0) {
                        const src = '(' + workerHook.toString() + ')();\n' + xhr.responseText;
                        u = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                    }
                }
            } catch {}
            super(u, opts);
            this.addEventListener('message', (e) => {
                if (e.data && e.data.__reboundObs) {
                    const { __reboundObs, ...rest } = e.data;
                    push(obs.playlists, rest, 200);
                }
            });
        }
    };
}

module.exports = { reboundObserver };
