// Pre-generate email verification for SDR drafts (item C — Derek asked to route "these drip
// sequences" [plural, unqualified] through NeverBounce; the permit path shipped behind
// PERMIT_NB_VERIFY (lib/permitNbVerify.js), this closes the matching gap on the SDR path).
//
// Hooks into POST /api/sdr/drafts/generate, one step BEFORE the always-on verification block
// already wired into POST /api/sdr/drafts/:id/approve-and-send (server.js, "Pre-send email
// verification" block) — not a replacement for it, an earlier checkpoint. Reuses the exact
// cache-then-live pattern that block already uses (same sdr_lead_state cache columns via
// readVerifyCache/writeVerifyCache, same STALE_MS freshness window) rather than inventing a
// second mechanism, and gates through canonicalVerdict() so it's correct for whichever provider
// resolves.
//
// OFF by default via SDR_DRAFT_VERIFY, independent of PERMIT_NB_VERIFY. Read at call time (not
// module load) so toggling the flag takes effect without a restart, and so `sdrDraftVerifyEnabled()`
// unset keeps POST /api/sdr/drafts/generate byte-identical to its pre-change behaviour — the
// caller short-circuits before this module does anything.
//
// Gates on the RESOLVED provider (activeProvider()), never on key presence: resolveProvider() in
// emailVerify.js prefers MillionVerifier over NeverBounce when both keys are set, so a
// presence-only check ("is NEVERBOUNCE_API_KEY set?") would silently verify against a DIFFERENT
// provider than the one you think is gating. This must work correctly for whichever of the three
// providers actually resolves, not only NeverBounce.
import { verifyEmail, activeProvider, canonicalVerdict } from "./emailVerify.js";
import { readVerifyCache, writeVerifyCache, STALE_MS } from "./emailVerifyRefresh.js";

// Hard per-run cap on LIVE (credit-spending) verify calls this gate makes, mirroring the pattern
// in lib/permitNbVerify.js (NB_VERIFY_MAX_PER_RUN). "Run" = this server process's lifetime — a
// simple safety ceiling against a runaway backfill/loop spending unbounded credits (a redeploy
// resets it). Population sized at ~96 backlog rows + ~30/day sustained, so 50 comfortably covers
// a normal burst of drafts while still being a real, enforced ceiling. Cache hits (fresh verdict
// already on file) do NOT count against this cap — only live provider calls do.
export const SDR_DRAFT_VERIFY_MAX_PER_RUN = 50;

let liveVerifyCount = 0;
/** Test-only escape hatch — resets the process-lifetime counter between test cases. */
export function _resetLiveVerifyCountForTests() {
  liveVerifyCount = 0;
}

/** True only when the flag is explicitly on AND some provider actually resolves (any of the
 * three — MillionVerifier, NeverBounce, or ZeroBounce). Absence of either is a no-op: zero
 * verify calls, zero credits. */
export function sdrDraftVerifyEnabled() {
  if (process.env.SDR_DRAFT_VERIFY !== "true") return false;
  const { provider, hasKey } = activeProvider();
  return !!provider && hasKey;
}

/**
 * Cache-then-live pre-generate check for a single lead's contact email.
 * Returns { blocked: null | { status, sub_status, suggestion } }. Never throws —
 * verifyEmail() is itself fail-open (no key / API error / timeout → skipped, never blocks).
 *
 * deps (all optional, for testing without network/DB):
 *   readVerifyCache, writeVerifyCache — same signatures as lib/emailVerifyRefresh.js
 *   verifyEmail                       — same signature as lib/emailVerify.js
 *   now                               — () => ms, defaults to Date.now
 */
export async function checkDraftEmail(pool, { leadId, email }, deps = {}) {
  const _readVerifyCache = deps.readVerifyCache || readVerifyCache;
  const _writeVerifyCache = deps.writeVerifyCache || writeVerifyCache;
  const _verifyEmail = deps.verifyEmail || verifyEmail;
  const now = deps.now || Date.now;

  // Prefer a fresh cached verdict for this exact address (set by the refresh pass, or by this
  // same gate on a previous call) — no API spend.
  const cache = leadId ? await _readVerifyCache(pool, leadId) : null;
  const cacheFresh =
    cache && cache.email_verified_value === email && cache.email_verified_at &&
    now() - new Date(cache.email_verified_at).getTime() < STALE_MS;

  if (cacheFresh) {
    if (canonicalVerdict(cache.email_verify_status) === "hard_fail") {
      return { blocked: { status: cache.email_verify_status, sub_status: null, suggestion: null } };
    }
    return { blocked: null };
  }

  if (liveVerifyCount >= SDR_DRAFT_VERIFY_MAX_PER_RUN) {
    console.warn(
      `[sdr-draft-verify] per-run cap (${SDR_DRAFT_VERIFY_MAX_PER_RUN}) reached — skipping live verify for lead ${leadId}, allowing through (fail-open)`,
    );
    return { blocked: null };
  }
  liveVerifyCount++;

  const v = await _verifyEmail(email);
  if (v && !v.skipped && leadId) {
    // Persist the CANONICAL verdict, not the raw provider string — same rule as the cache-read
    // branch above (canonicalVerdict() normalizes MillionVerifier / NeverBounce / ZeroBounce's
    // differing vocabularies into the closed valid|soft|hard_fail|skipped set). v.status is
    // always set here (we're in the !v.skipped branch), but canonicalVerdict() is
    // idempotent/fail-open on any input, so this is safe even if that ever changes.
    await _writeVerifyCache(pool, leadId, {
      status: canonicalVerdict(v.status || (v.ok ? "valid" : "invalid")),
      verifiedValue: email,
    }).catch((e) => console.error("sdr-draft-verify cache write failed:", e.message));
  }
  if (v && !v.ok) {
    return { blocked: { status: v.status, sub_status: v.sub_status, suggestion: v.suggestion } };
  }
  return { blocked: null };
}
