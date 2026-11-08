// Rebound for Twitch: background.
// Fetches the signed config every 15 minutes, verifies it (Ed25519 + schema +
// anti-rollback + minExtensionVersion), caches it, and makes sure every new Twitch
// page starts with the newest verified config.
//
// Firefox (MV2, persistent page): browser.contentScripts.register() with the
//   verified config inlined as a code snippet, so it is available synchronously at
//   document_start before vaft runs. Re-registered whenever the config changes.
// Chrome (MV3, service worker): chrome.scripting.registerContentScripts() runs vaft
//   in the MAIN world with the bundled defaults; an isolated relay script posts the
//   cached config moments later and vaft applies it live (UpdateRemoteConfig).
'use strict';
if (typeof globalThis.ReboundConfig === 'undefined' && typeof importScripts === 'function') {
    importScripts('shared/config.js', 'shared/keys.js', 'shared/constants.js', 'shared/defaults.js');
}

const api = globalThis.browser || globalThis.chrome;
const IS_FIREFOX_MV2 = typeof browser !== 'undefined' && !!(browser.contentScripts && browser.contentScripts.register);
const MATCHES = ['*://*.twitch.tv/*'];
const EXT_VERSION = api.runtime.getManifest().version;
const { verifyConfig } = globalThis.ReboundConfig;
const C = globalThis.REBOUND;

let firefoxRegistration = null;

async function getState() {
    const s = await api.storage.local.get(['enabled', 'configBytes', 'configSig', 'lastFetch', 'lastError', 'status', 'statusFetchedAt']);
    return { enabled: s.enabled !== false, ...s };
}

// The cached config is stored as the exact signed bytes and re-verified on load,
// so tampering with extension storage cannot inject unsigned values.
async function loadVerifiedCached(state) {
    if (!state.configBytes || !state.configSig) return null;
    const res = await verifyConfig(new Uint8Array(state.configBytes), state.configSig, globalThis.REBOUND_PUBLIC_KEYS, { extensionVersion: EXT_VERSION });
    return res.ok ? res.config : null;
}

// Fallback chain: last valid cached config -> bundled defaults -> vaft constants.
async function currentConfig() {
    const state = await getState();
    const cached = await loadVerifiedCached(state);
    const bundled = globalThis.REBOUND_BUNDLED_DEFAULTS;
    if (cached && (!bundled || cached.version > bundled.version)) return { config: cached, source: 'remote' };
    return { config: bundled || null, source: 'bundled' };
}

// Serialize registrations: onInstalled and startup can race.
let registrationChain = Promise.resolve();
function registerScripts() {
    registrationChain = registrationChain.then(doRegisterScripts, doRegisterScripts);
    return registrationChain;
}

async function doRegisterScripts() {
    const state = await getState();
    const { config } = await currentConfig();
    if (IS_FIREFOX_MV2) {
        if (firefoxRegistration) {
            try { await firefoxRegistration.unregister(); } catch {}
            firefoxRegistration = null;
        }
        if (!state.enabled) return;
        const boot = { config, monitor: !!C.MONITOR_MODE };
        firefoxRegistration = await browser.contentScripts.register({
            matches: MATCHES,
            allFrames: true,
            runAt: 'document_start',
            js: [{ code: 'var REBOUND_BOOT = ' + JSON.stringify(boot) + ';' }, { file: 'content.js' }],
        });
        return;
    }
    const ids = ['rebound-main', 'rebound-relay'];
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    if (!state.enabled) return;
    await chrome.scripting.registerContentScripts([
        { id: 'rebound-main', matches: MATCHES, allFrames: true, runAt: 'document_start', world: 'MAIN', js: ['page/boot.js', 'page/vaft.js'], persistAcrossSessions: true },
        { id: 'rebound-relay', matches: MATCHES, allFrames: true, runAt: 'document_start', js: ['content.js'], persistAcrossSessions: true },
    ]);
}

async function broadcast(config) {
    const tabs = await api.tabs.query({ url: MATCHES });
    for (const t of tabs) {
        try { await api.tabs.sendMessage(t.id, { type: 'rebound-config-updated', config }); } catch {}
    }
}

async function fetchText(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
    return r;
}

async function refreshConfig() {
    if (!C.REMOTE_ENABLED) return { ok: false, error: 'remote config disabled in this build' };
    const now = Date.now();
    try {
        const [cfgRes, sigRes] = await Promise.all([fetchText(C.CONFIG_URL), fetchText(C.CONFIG_URL + '.sig')]);
        const bytes = new Uint8Array(await cfgRes.arrayBuffer());
        const sig = await sigRes.text();
        const { config: cur } = await currentConfig();
        const res = await verifyConfig(bytes, sig, globalThis.REBOUND_PUBLIC_KEYS, { extensionVersion: EXT_VERSION, currentVersion: cur ? cur.version : 0 });
        if (!res.ok) {
            // A stale (same or older) version is the normal case between publishes.
            await api.storage.local.set({ lastFetch: now, lastError: res.stale ? null : res.error });
            return res;
        }
        await api.storage.local.set({ configBytes: Array.from(bytes), configSig: sig, lastFetch: now, lastError: null });
        await registerScripts();
        await broadcast(res.config);
        return res;
    } catch (e) {
        await api.storage.local.set({ lastFetch: now, lastError: String(e && e.message || e) });
        return { ok: false, error: String(e) };
    }
}

async function refreshStatus() {
    try {
        const r = await fetchText(C.STATUS_URL);
        const status = await r.json();
        // Display-only: keep a small whitelisted subset.
        const clean = {
            state: ['PASS', 'FAIL', 'INCONCLUSIVE', 'DEGRADED'].includes(status.state) ? status.state : 'UNKNOWN',
            lastPassAt: typeof status.lastPassAt === 'string' ? status.lastPassAt.slice(0, 32) : null,
            updatedAt: typeof status.updatedAt === 'string' ? status.updatedAt.slice(0, 32) : null,
        };
        await api.storage.local.set({ status: clean, statusFetchedAt: Date.now() });
        return clean;
    } catch {
        return null;
    }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (msg && msg.type === 'rebound-get-config') {
            const { config } = await currentConfig();
            return { config };
        }
        if (msg && msg.type === 'rebound-popup-state') {
            const state = await getState();
            const { config, source } = await currentConfig();
            if (!state.statusFetchedAt || Date.now() - state.statusFetchedAt > 5 * 60 * 1000) state.status = (await refreshStatus()) || state.status;
            return {
                enabled: state.enabled,
                extensionVersion: EXT_VERSION,
                configVersion: config ? config.version : null,
                configPublishedAt: config ? config.publishedAt : null,
                configNote: config ? config.note || '' : '',
                configSource: source,
                lastFetch: state.lastFetch || null,
                lastError: state.lastError || null,
                status: state.status || null,
                repo: C.REPO,
            };
        }
        if (msg && msg.type === 'rebound-set-enabled') {
            await api.storage.local.set({ enabled: !!msg.enabled });
            await registerScripts();
            return { ok: true };
        }
        if (msg && msg.type === 'rebound-refresh') {
            const r = await refreshConfig();
            return { ok: r.ok, error: r.ok ? null : r.error };
        }
        return null;
    })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
});

api.alarms.onAlarm.addListener((a) => {
    if (a.name === 'rebound-refresh') { refreshConfig(); refreshStatus(); }
});

async function init() {
    api.alarms.create('rebound-refresh', { periodInMinutes: C.FETCH_INTERVAL_MINUTES, delayInMinutes: 0.1 });
    await registerScripts();
}

api.runtime.onInstalled.addListener(() => { init(); });
if (IS_FIREFOX_MV2) init(); // persistent page: runs on every browser start
else api.runtime.onStartup.addListener(() => { init(); });
