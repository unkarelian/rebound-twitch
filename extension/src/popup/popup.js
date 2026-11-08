'use strict';
const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
let state = null;

function ago(ts) {
    if (!ts) return 'never';
    const t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(t)) return 'unknown';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return s + 's ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
}

function render() {
    $('enabled').checked = state.enabled;
    $('version').textContent = state.extensionVersion;
    $('config').textContent = state.configVersion
        ? 'v' + state.configVersion + ' (' + (state.configSource === 'remote' ? 'signed update' : 'bundled') + ')'
        : 'built-in defaults';
    $('config').title = state.configNote || '';
    $('verified').textContent = state.status && state.status.lastPassAt ? ago(state.status.lastPassAt) : 'unknown';
    $('state').textContent = state.status ? state.status.state : 'unknown';
    $('state').className = state.status ? 'state-' + state.status.state.toLowerCase() : '';
    $('fetched').textContent = ago(state.lastFetch);
    $('error').hidden = !state.lastError;
    $('error').textContent = state.lastError ? 'Last update failed: ' + state.lastError : '';
}

async function load() {
    state = await api.runtime.sendMessage({ type: 'rebound-popup-state' });
    render();
}

$('enabled').addEventListener('change', async (e) => {
    await api.runtime.sendMessage({ type: 'rebound-set-enabled', enabled: e.target.checked });
    $('reload-hint').hidden = false;
    load();
});

$('refresh').addEventListener('click', async () => {
    $('refresh').disabled = true;
    await api.runtime.sendMessage({ type: 'rebound-refresh' });
    await load();
    $('refresh').disabled = false;
});

// Opens a prefilled issue. Nothing is sent automatically: the user sees and edits
// the text on GitHub before submitting. Only versions are included.
$('report').addEventListener('click', () => {
    const body = [
        '**What happened?** (ads shown, black screen, stuck loading, error #…)',
        '',
        '**Channel(s) and roughly when:**',
        '',
        '**Browser:**',
        '',
        '---',
        'Extension: ' + state.extensionVersion,
        'Config: ' + (state.configVersion ? 'v' + state.configVersion + ' (' + state.configSource + ')' : 'defaults'),
        'Monitor status when reported: ' + (state.status ? state.status.state : 'unknown'),
        '',
        '_Optional: open the browser console on the Twitch tab, filter for `[AD DEBUG]`, and paste the lines here. Remove anything you consider private._',
    ].join('\n');
    const url = 'https://github.com/' + state.repo + '/issues/new?labels=broken&title=' + encodeURIComponent('Broken: ') + '&body=' + encodeURIComponent(body);
    api.tabs.create({ url });
    window.close();
});

load();
