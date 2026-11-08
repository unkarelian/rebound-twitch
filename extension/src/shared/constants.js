// Build-time constants. extension/build.js overwrites the marked values for dev,
// monitor and candidate builds; the defaults here are the production values.
globalThis.REBOUND = {
    REPO: 'unkarelian/rebound-twitch',
    // Signed config: written only by .github/workflows/publish-config.yml.
    CONFIG_URL: 'https://raw.githubusercontent.com/unkarelian/rebound-twitch/live/config.json',
    // Public monitor status, written by the live monitor. Display only, unsigned.
    STATUS_URL: 'https://raw.githubusercontent.com/unkarelian/rebound-twitch/status/status.json',
    REMOTE_ENABLED: true, /* @build:REMOTE_ENABLED */
    MONITOR_MODE: false, /* @build:MONITOR_MODE */
    FETCH_INTERVAL_MINUTES: 15,
};
