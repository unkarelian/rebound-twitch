// Loads the REAL vaft script into a Node vm with a minimal mocked browser, lets it
// hook window.Worker, constructs a "Twitch" worker, captures the blob source vaft
// builds, then runs that blob in a second vm that stands in for the worker scope.
// This tests the actual serialization path (declareOptions(self) + injection),
// not hand-copied functions, so it catches the outer-scope ReferenceError class
// of bug described in CLAUDE.md.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

function readVaft(rel) {
    let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (src.startsWith('twitch-videoad.js')) src = src.slice(src.indexOf('\n') + 1); // uBlock resource header
    return src;
}

function makeStorage(init) {
    const m = new Map(Object.entries(init || {}));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
    };
}

const noopTimer = () => 0;
const quietConsole = (logs) => ({
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push('ERROR ' + a.join(' ')),
    info: () => {}, debug: () => {},
});

// opts: { file, remoteConfig, localStorage, twitchWorkerJs }
function loadVaft(opts) {
    opts = opts || {};
    const logs = [];
    const blobs = new Map();
    let blobSeq = 0;
    const createdWorkers = [];
    const messageListeners = [];

    class Blob {
        constructor(parts) { this.text = parts.map(String).join(''); }
    }
    const URLShim = class extends URL {};
    URLShim.createObjectURL = (b) => { const u = 'blob:https://www.twitch.tv/test-' + (++blobSeq); blobs.set(u, b.text); return u; };
    URLShim.revokeObjectURL = () => {};

    // Base Worker: vaft extends this. Its toString must not contain the conflict strings.
    class Worker {
        constructor(url) { this.url = url; this.listeners = []; this.posted = []; createdWorkers.push(this); }
        addEventListener(type, fn) { this.listeners.push({ type, fn }); }
        postMessage(m) { this.posted.push(m); }
    }
    const twitchWorkerJs = opts.twitchWorkerJs || 'self.__twitchWorkerLoaded = true;';
    class XMLHttpRequest {
        open(method, url) { this.url = url; }
        overrideMimeType() {}
        send() { this.responseText = twitchWorkerJs; }
    }
    const el = () => ({ style: { setProperty() {} }, dataset: {}, appendChild() {}, remove() {}, setAttribute() {} });
    const document = {
        location: { hostname: 'www.twitch.tv', pathname: '/somechannel', href: 'https://www.twitch.tv/somechannel' },
        readyState: 'loading',
        hidden: false,
        visibilityState: 'visible',
        addEventListener() {}, removeEventListener() {},
        getElementById: () => null,
        getElementsByTagName: () => [],
        getElementsByClassName: () => [],
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: el,
        head: el(),
        documentElement: el(),
        body: el(),
    };
    const win = {
        console: quietConsole(logs),
        document,
        location: document.location,
        frameElement: null,
        navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', platform: 'Linux x86_64', maxTouchPoints: 0, vendor: '' },
        localStorage: makeStorage(opts.localStorage),
        URL: URLShim, Blob, Worker, XMLHttpRequest,
        fetch: async () => ({ status: 200, text: async () => '' }),
        setTimeout: noopTimer, setInterval: noopTimer, clearTimeout() {}, clearInterval() {},
        requestAnimationFrame: noopTimer,
        addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn); },
        removeEventListener() {},
        MutationObserver: class { observe() {} disconnect() {} },
        atob, btoa, TextEncoder, TextDecoder, AbortController, Response, Headers,
        performance: { now: () => Date.now() },
    };
    win.window = win;
    win.self = win;
    win.top = win;
    win.__reboundRemoteConfig = opts.remoteConfig || undefined;
    const ctx = vm.createContext(win);
    vm.runInContext(readVaft(opts.file || 'vaft/vaft.user.js'), ctx, { filename: opts.file || 'vaft.user.js' });

    function postToPage(data) {
        const source = vm.runInContext('window', ctx); // the context's view of window (a proxy, not `win`)
        for (const fn of messageListeners) fn({ source, data });
    }

    // Construct a worker the way Twitch's player does, then boot the blob vaft built.
    // workerOpts.routes: [{ match, body, status }] answers the worker's own fetch()
    //   (usher master playlist, media playlists, backup playlists) by URL substring.
    //   A route may have `bodies: [...]` to return successive responses.
    // workerOpts.gql: [{ match, body }] answers FetchRequests the worker relays to
    //   the main thread (GQL access tokens) by request-body substring. Unmatched GQL
    //   requests get a GQL error, as Twitch would for a bad hash.
    function spawnTwitchWorker(workerOpts) {
        workerOpts = workerOpts || {};
        const W = win.Worker; // vaft's hooked class (via defineProperty getter)
        const w = new W('blob:https://www.twitch.tv/twitch-player-worker');
        const base = createdWorkers[createdWorkers.length - 1];
        const blobSrc = blobs.get(base.url);
        if (!blobSrc) throw new Error('vaft did not inject a blob (url ' + base.url + ')');
        const workerLogs = [];
        const posted = [];
        const listeners = [];
        const routes = (workerOpts.routes || []).map((r) => ({ ...r, i: 0 }));
        const gqlRoutes = workerOpts.gql || [];
        const fetchLog = [];
        const workerFetch = async (url) => {
            url = String(url);
            fetchLog.push(url);
            const r = routes.find((x) => url.includes(x.match));
            if (!r) return new Response('', { status: 404 });
            const body = r.bodies ? r.bodies[Math.min(r.i++, r.bodies.length - 1)] : r.body;
            return new Response(body, { status: r.status || 200 });
        };
        const deliver = (data) => setImmediate(() => listeners.forEach((fn) => fn({ data })));
        const wscope = {
            console: quietConsole(workerLogs),
            postMessage: (m) => {
                posted.push(m);
                if (workerOpts.autoAnswerGql && m && m.key === 'FetchRequest') {
                    const reqBody = m.value.options.body;
                    const g = gqlRoutes.find((x) => reqBody.includes(x.match));
                    const body = g ? (typeof g.body === 'string' ? g.body : JSON.stringify(g.body)) : JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] });
                    deliver({ key: 'FetchResponse', value: { id: m.value.id, status: 200, statusText: 'OK', headers: {}, body } });
                }
            },
            addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
            fetch: workerFetch,
            XMLHttpRequest, URL, Blob, Response, Headers, atob, btoa, TextEncoder, TextDecoder, AbortController,
            // Real timeouts (processM3U8 awaits some); intervals are no-ops so nothing loops.
            setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, workerOpts.maxTimeoutMs ?? 50)),
            setInterval: noopTimer, clearTimeout: (t) => clearTimeout(t), clearInterval() {},
        };
        wscope.self = wscope;
        const wctx = vm.createContext(wscope);
        vm.runInContext(blobSrc, wctx, { filename: 'vaft-worker-blob.js' });
        return {
            hooked: w,
            base,
            blobSrc,
            logs: workerLogs,
            posted,
            scope: wctx,
            eval: (code) => vm.runInContext(code, wctx),
            send: (data) => listeners.forEach((fn) => fn({ data })),
            fetchLog,
            // fetch() as the Twitch player inside the worker would call it (hooked by vaft).
            playerFetch: async (url) => {
                const res = await vm.runInContext('fetch', wctx)(url);
                return { status: res.status, text: await res.text() };
            },
            monitorEvents: () => posted.filter((m) => m && m.key === 'MonitorPlaylist').map((m) => m.value),
        };
    }

    return { win, ctx, logs, postToPage, spawnTwitchWorker, eval: (code) => vm.runInContext(code, ctx) };
}

// Calls getAccessToken inside the worker scope and returns the GQL body it would send.
function workerAccessTokenRequest(worker, channel, playerType) {
    const before = worker.posted.length;
    worker.eval(`getAccessToken(${JSON.stringify(channel)}, ${JSON.stringify(playerType)}).catch(() => {})`);
    const msg = worker.posted.slice(before).find((m) => m && m.key === 'FetchRequest');
    if (!msg) throw new Error('worker did not post a FetchRequest');
    return { body: JSON.parse(msg.value.options.body), headers: msg.value.options.headers };
}

module.exports = { loadVaft, workerAccessTokenRequest, ROOT };
