// Shared quota ledger + circuit breaker for ONE Apollo route:
// POST /api/v1/emailer_messages/search.
//
// Apollo meters per ENDPOINT, not per key-wide (verified live 2026-07-27 — the 429 body
// names the path: "the maximum number of api calls allowed for
// api/v1/emailer_messages/search is 2000 times per day"). So every caller of this one route
// shares a single 2000/day bucket, and a ledger that lives inside any one caller is wrong.
//
// Three callers hit this route:
//   1. lib/apolloEngagementPoll.js   — the 15-min engagement cron (the big one)
//   2. server.js GET /api/sdr/outbox — read path, 5-min cache => <=288/day
//   3. lib/permitEngagementSync.js   — permit channel sweep (env-gated, default OFF)
// Before this module only (1) counted its own calls and only (1) honoured retry-after, so
// the ledger under-reported and a 429 raised by (2) or (3) left the cron happily calling.
//
// State is in-memory and per-process. That is a deliberate limit, not an oversight: the
// ledger is an optimisation to stay clear of the cap, while `retry-after` from Apollo is the
// authoritative backstop and is re-learned on the very next 429 after a restart.
export const DAILY_CAP = 2000;               // Apollo's own cap for this route
export const DAILY_CALL_CEILING = 1500;      // our self-imposed ceiling (75% of cap)
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

let callLedger = [];         // ms timestamps
let rateLimitedUntilMs = 0;  // breaker; set from Apollo's retry-after
let lastLimitInfo = null;

/** Record one outbound call to /emailer_messages/search. Call it around EVERY such call. */
export function recordCall() {
  const now = Date.now();
  callLedger.push(now);
  if (callLedger.length > 4000) callLedger = callLedger.filter((t) => now - t < ROLLING_WINDOW_MS);
}

/** Calls made in the trailing 24h (prunes as a side effect). */
export function callsInWindow() {
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  callLedger = callLedger.filter((t) => t >= cutoff);
  return callLedger.length;
}

/** Headroom left under our ceiling (never negative). */
export function remaining() {
  return Math.max(0, DAILY_CALL_CEILING - callsInWindow());
}

/** True while Apollo's retry-after window is still open. */
export function isRateLimited() {
  return Date.now() < rateLimitedUntilMs;
}

export function rateLimitedForSec() {
  return isRateLimited() ? Math.ceil((rateLimitedUntilMs - Date.now()) / 1000) : 0;
}

/**
 * Open the breaker from a 429. `err` is an apolloClient error carrying `retryAfterSec` and
 * `rateLimit` (see lib/apolloClient.js). Returns a describable object for logs/return values.
 */
export function noteRateLimit(err, who = "unknown") {
  const waitSec = err?.retryAfterSec || 15 * 60;
  rateLimitedUntilMs = Math.max(rateLimitedUntilMs, Date.now() + waitSec * 1000);
  lastLimitInfo = {
    reason: "apollo_429",
    raised_by: who,
    retry_after_sec: waitSec,
    retry_at: new Date(rateLimitedUntilMs).toISOString(),
    ...(err?.rateLimit || {}),
  };
  console.error(
    `[apollo-budget] 429 on /emailer_messages/search raised by ${who} — breaker open ${waitSec}s (until ${lastLimitInfo.retry_at})`,
  );
  return lastLimitInfo;
}

export function snapshot() {
  return {
    callsLast24h: callsInWindow(),
    ceiling: DAILY_CALL_CEILING,
    cap: DAILY_CAP,
    remaining: remaining(),
    rateLimited: isRateLimited(),
    rateLimitedForSec: rateLimitedForSec(),
    lastLimitInfo,
  };
}

/** Test-only. */
export function _reset() {
  callLedger = [];
  rateLimitedUntilMs = 0;
  lastLimitInfo = null;
}
