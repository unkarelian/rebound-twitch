// Adaptive cadence for the browser-based monitor and fixers.
//
// The systemd timers fire often (monitor every ~13 min, fixers hourly) but each
// --scheduled invocation first asks shouldRunFull():
//   unstable -> full browser run every time (fast detection while things are moving)
//   stable   -> full browser run only every REBOUND_STABLE_INTERVAL_H hours (default 12,
//               i.e. twice a day); in between, a cheap browser-free probe (one GQL call
//               + one playlist fetch) checks that the live config's PAT operation/hash
//               and client ID still work. A failed probe makes the system unstable again
//               and the full run happens immediately.
//
// "Stable" = no open breakage, nothing resolved in the last REBOUND_STABLE_AFTER_H
// hours (default 24), and none of the last 6 runs FAIL or DEGRADED.
'use strict';
const stateLib = require('./state.js');

const STABLE_INTERVAL_H = Number(process.env.REBOUND_STABLE_INTERVAL_H || 12);
const STABLE_AFTER_H = Number(process.env.REBOUND_STABLE_AFTER_H || 24);
const H = 3600e3;

function stability(now = Date.now()) {
    const st = stateLib.readJson('state.json', {});
    const recent = stateLib.recentHistory(6).filter((h) => !h.injectedFault);
    const reasons = [];
    if (st.breaking) reasons.push('open breakage since ' + st.breaking.since);
    if (st.lastResolved && now - Date.parse(st.lastResolved.resolvedAt) < STABLE_AFTER_H * H) reasons.push('breakage resolved ' + Math.round((now - Date.parse(st.lastResolved.resolvedAt)) / 60000) + ' min ago');
    const bad = recent.filter((h) => h.runVerdict === 'FAIL' || h.runVerdict === 'DEGRADED');
    if (bad.length) reasons.push(bad.length + ' of the last ' + recent.length + ' runs FAIL/DEGRADED');
    if (recent.length < 3) reasons.push('fewer than 3 runs recorded');
    const probe = stateLib.readJson('probe.json', null);
    if (probe && !probe.ok) reasons.push('last cheap probe failed: ' + probe.error);
    return { stable: reasons.length === 0, reasons, lastRunAt: st.lastRunAt || null };
}

// kind: 'monitor' | 'fixers' (separate "last full run" clocks).
function shouldRunFull(kind, now = Date.now()) {
    const s = stability(now);
    if (!s.stable) return { run: true, why: 'unstable: ' + s.reasons.join('; ') };
    const last = stateLib.readJson('schedule.json', {})[kind];
    if (!last || now - Date.parse(last) >= STABLE_INTERVAL_H * H) return { run: true, why: `stable; last full ${kind} run ${last || 'never'} (>= ${STABLE_INTERVAL_H}h ago)` };
    const next = new Date(Date.parse(last) + STABLE_INTERVAL_H * H).toISOString();
    return { run: false, why: `stable; next full ${kind} run due ${next}` };
}

function markFullRun(kind, at = new Date().toISOString()) {
    const s = stateLib.readJson('schedule.json', {});
    s[kind] = at;
    stateLib.writeJson('schedule.json', s);
}

module.exports = { stability, shouldRunFull, markFullRun, STABLE_INTERVAL_H, STABLE_AFTER_H };
