// One browser session: a fresh Firefox profile watching one channel.
//   withExtension=false -> CONTROL: observer preload, nothing blocked.
//   withExtension=true  -> TEST: the built extension (monitor build), no observer.
'use strict';
const puppeteer = require('puppeteer');
const { reboundObserver } = require('./observer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ad UI the TEST run must never show (check C). Exact attribute selectors only,
// the same rule upstream applies to overlay hiding.
const AD_UI_SELECTORS = [
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    '[data-test-selector="ad-banner-default-text"]',
    '[data-test-selector="sda-wrapper"]',
];
const GATE_BUTTONS = [
    '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
    '[data-a-target="player-overlay-mature-accept"]',
    'button[data-a-target="consent-banner-accept"]',
];

async function launch({ extensionDir, headless }) {
    const browser = await puppeteer.launch({
        browser: 'firefox',
        headless: headless !== false,
        protocolTimeout: 60000,
        extraPrefsFirefox: {
            'media.autoplay.default': 0,
            'media.autoplay.blocking_policy': 0,
            'media.block-autoplay-until-in-foreground': false,
            'dom.webdriver.enabled': false,
            'privacy.trackingprotection.enabled': false,
        },
    });
    if (extensionDir) await browser.installExtension(extensionDir);
    return browser;
}

// In-page sampler: video progress, rendered frames, spinner time, ad UI visibility.
function pageSampler(adSelectors) {
    const pick = () => {
        const vids = [...document.querySelectorAll('video')];
        return vids.find((v) => (v.currentSrc || v.src || '').startsWith('blob:')) || vids[0] || null;
    };
    const visible = (el) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
    };
    const s = window.__reboundSample || (window.__reboundSample = { frames: 0, hooked: null });
    const v = pick();
    if (v && s.hooked !== v && typeof v.requestVideoFrameCallback === 'function') {
        s.hooked = v;
        const cb = () => { s.frames++; v.requestVideoFrameCallback(cb); };
        v.requestVideoFrameCallback(cb);
    }
    const adUi = adSelectors.filter((sel) => [...document.querySelectorAll(sel)].some(visible));
    // A visible, playing <video> that is NOT the MediaSource player is a CSAI ad video.
    const extraVideos = [...document.querySelectorAll('video')].filter((x) => x !== v && visible(x) && !x.paused && !(x.currentSrc || '').startsWith('blob:')).length;
    const spinner = [...document.querySelectorAll('[data-a-target="player-overlay-loading-spinner"], .tw-loading-spinner')].some(visible);
    return {
        t: Date.now(),
        currentTime: v ? v.currentTime : null,
        paused: v ? v.paused : null,
        readyState: v ? v.readyState : null,
        frames: s.frames,
        spinner,
        adUi,
        extraVideos,
        hasVideo: !!v,
    };
}

async function dismissGates(page) {
    for (const sel of GATE_BUTTONS) {
        try {
            const el = await page.$(sel);
            if (el) { await el.click(); await sleep(500); }
        } catch {}
    }
}

// opts: { channel, withExtension, extensionDir, durationSec, simulateAdsAtSec, headless, screenshotPath }
async function runSession(opts) {
    const started = Date.now();
    const result = { channel: opts.channel, withExtension: !!opts.withExtension, samples: [], console: [], pageErrors: [], network: [], error: null, playClicks: 0 };
    let browser;
    try {
        browser = await launch({ extensionDir: opts.withExtension ? opts.extensionDir : null, headless: opts.headless });
        result.browserVersion = await browser.version();
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        if (!opts.withExtension) await page.evaluateOnNewDocument(reboundObserver);
        page.on('console', (m) => { const t = m.text(); if (result.console.length < 2000) result.console.push({ at: Date.now() - started, type: m.type(), text: t.slice(0, 2000) }); });
        page.on('pageerror', (e) => result.pageErrors.push({ at: Date.now() - started, message: String(e && e.message || e).slice(0, 1000), stack: String(e && e.stack || '').slice(0, 2000) }));
        page.on('response', (r) => {
            try {
                const req = r.request();
                if (result.network.length < 3000) result.network.push({ at: Date.now() - started, method: req.method(), url: r.url(), status: r.status(), type: req.resourceType() });
            } catch {}
        });
        await page.goto('https://www.twitch.tv/' + opts.channel, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const end = started + opts.durationSec * 1000;
        let simulated = false, unsimulated = false;
        while (Date.now() < end) {
            await sleep(1000);
            await dismissGates(page);
            const s = await page.evaluate(pageSampler, AD_UI_SELECTORS).catch((e) => ({ t: Date.now(), error: String(e) }));
            result.samples.push({ ...s, at: Date.now() - started });
            // Autoplay can be refused in automation; a viewer would press play once.
            if (s.hasVideo && s.paused && result.playClicks < 3 && Date.now() - started > 8000 && (result.samples.filter((x) => x.paused).length % 5 === 0)) {
                result.playClicks++;
                await page.evaluate(() => { const b = document.querySelector('[data-a-target="player-play-pause-button"]'); if (b) b.click(); else { const v = document.querySelector('video'); if (v) v.play().catch(() => {}); } }).catch(() => {});
            }
            // Active probe of the backup path (exercises the configured PAT hash
            // and client ID even when no real ad break happens during the run).
            const elapsed = (Date.now() - started) / 1000;
            if (opts.withExtension && opts.simulateAdsAtSec && !simulated && elapsed >= opts.simulateAdsAtSec) {
                simulated = true;
                result.simulatedAdsAt = Date.now() - started;
                await page.evaluate(() => window.simulateAds && window.simulateAds(1)).catch(() => {});
            }
            if (simulated && !unsimulated && elapsed >= opts.simulateAdsAtSec + 12) {
                unsimulated = true;
                await page.evaluate(() => window.simulateAds && window.simulateAds(0)).catch(() => {});
            }
        }
        if (opts.withExtension) {
            result.extState = await page.evaluate(() => (window.__reboundState ? window.__reboundState() : null)).catch(() => null);
            result.monitorLog = await page.evaluate(() => window.__reboundMonitorLog || []).catch(() => []);
        } else {
            result.observed = await page.evaluate(() => window.__reboundObs || null).catch(() => null);
        }
        if (opts.screenshotPath) await page.screenshot({ path: opts.screenshotPath }).catch(() => {});
    } catch (e) {
        result.error = String(e && e.stack || e).slice(0, 2000);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
    result.durationMs = Date.now() - started;
    return result;
}

module.exports = { runSession, AD_UI_SELECTORS };
