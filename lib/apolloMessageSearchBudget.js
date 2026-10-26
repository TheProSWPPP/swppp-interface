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
// State lives in memory and is PERSISTED to sdr_apollo_poll_state (scope
// 'message_search_budget') by the engagement poll: hydrate() once per process before the
// first budget decision, persist() at the end of every poll pass. A purely in-memory
// ledger reset to 0 on every deploy, so a deploy day could spend the cap twice over.
// Calls are stored as per-minute counts (at most 1,440 buckets). Persistence is best
// effort: if the table is missing the ledger keeps working in memory, and Apollo's
// `retry-after` stays the authoritative backstop.
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

const PERSIST_SCOPE = "message_search_budget";
let hydrated = false;

/** Load the persisted ledger once per process. Never throws. */
export async function hydrate(pool) {
  if (hydrated) return { hydrated: false, reason: "already_hydrated" };
  try {
    const { rows } = await pool.query("SELECT state FROM sdr_apollo_poll_state WHERE scope=$1", [PERSIST_SCOPE]);
    hydrated = true;
    const state = rows[0]?.state || {};
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    let restored = 0;
    for (const bucket of Array.isArray(state.calls) ? state.calls : []) {
      const [minute, count] = Array.isArray(bucket) ? bucket.map(Number) : [];
      if (!Number.isFinite(minute) || !Number.isInteger(count) || count < 1 || count > 2000 || minute < cutoff || minute > Date.now()) continue;
      for (let i = 0; i < count; i++) callLedger.push(minute);
      restored += count;
    }
    callLedger.sort((a, b) => a - b);
    const until = Number(state.rateLimitedUntilMs);
    if (Number.isFinite(until) && until > rateLimitedUntilMs) {
      rateLimitedUntilMs = until;
      lastLimitInfo = state.lastLimitInfo && typeof state.lastLimitInfo === "object" ? state.lastLimitInfo : lastLimitInfo;
    }
    return { hydrated: true, restored };
  } catch {
    // Table missing / DB down: keep counting in memory and try again next pass.
    return { hydrated: false, reason: "unavailable" };
  }
}

/** Save the current ledger as per-minute counts. Never throws. */
export async function persist(pool) {
  try {
    const buckets = new Map();
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    for (const t of callLedger) {
      if (t < cutoff) continue;
      const minute = t - (t % 60_000);
      buckets.set(minute, (buckets.get(minute) || 0) + 1);
    }
    const state = { calls: [...buckets], rateLimitedUntilMs: rateLimitedUntilMs || null, lastLimitInfo, savedAt: new Date().toISOString() };
    await pool.query(`INSERT INTO sdr_apollo_poll_state(scope,state) VALUES($1,$2::jsonb)
      ON CONFLICT(scope) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`, [PERSIST_SCOPE, JSON.stringify(state)]);
    return true;
  } catch {
    return false;
  }
}

/** Test-only. */
export function _reset() {
  callLedger = [];
  rateLimitedUntilMs = 0;
  lastLimitInfo = null;
  hydrated = false;
}
