// Rebound for Twitch: content script (isolated world, document_start).
// Firefox build: REBOUND_BOOT (registered just before this file) carries the
//   newest verified config. We inject vaft into the page synchronously with that
//   config already set, so the very first worker gets it.
// Chrome build: vaft already runs in the MAIN world (page/vaft.js); this file only
//   relays config.
// Both: later config updates are posted to the page; vaft applies them live.
(function () {
    'use strict';
    const api = globalThis.browser || globalThis.chrome;
    const boot = typeof REBOUND_BOOT !== 'undefined' ? REBOUND_BOOT : null; // eslint-disable-line no-undef
    const post = (config) => {
        if (config) window.postMessage({ type: 'rebound-config', config }, window.location.origin);
    };

    if (typeof REBOUND_PAGE_SRC === 'string') { // eslint-disable-line no-undef
        try {
            if (boot && boot.monitor) localStorage.setItem('twitchAdSolutions_monitor', 'true');
        } catch {}
        const s = document.createElement('script');
        s.textContent = 'window.__reboundRemoteConfig = ' + JSON.stringify((boot && boot.config) || null) + ';\n' + REBOUND_PAGE_SRC; // eslint-disable-line no-undef
        (document.head || document.documentElement).appendChild(s);
        s.remove();
    }

    // Covers the Chrome path, and a Firefox page that loaded before a fresh config
    // was registered.
    try {
        Promise.resolve(api.runtime.sendMessage({ type: 'rebound-get-config' }))
            .then((r) => { if (r && r.config) post(r.config); })
            .catch(() => {});
    } catch {}
    api.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'rebound-config-updated') post(msg.config);
    });
})();
