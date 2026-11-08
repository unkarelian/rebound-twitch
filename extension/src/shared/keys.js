// Ed25519 public keys that may sign remote config. k1 is the current release key
// (private half lives only in the GitHub Actions secret REBOUND_SIGNING_KEY).
// k2 is the pre-shipped next key for rotation (private half kept offline).
// Rotation steps are in docs/RUNBOOK.md.
globalThis.REBOUND_PUBLIC_KEYS = [
    {"id":"k1","key":"vkP0S0fzOcapUSXuVWoFaRASwQlbgXu2GeVxOTew4FE="},
    {"id":"k2","key":"3pYtSmW5WTUcPWTVm4SDp7tkhMCdyONqT+FAY594UUU="},
];
