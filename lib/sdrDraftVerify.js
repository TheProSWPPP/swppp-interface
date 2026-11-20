// Pre-generate email verification for SDR drafts (item C — Derek asked to route "these drip
// sequences" [plural, unqualified] through NeverBounce; the permit path shipped behind
// PERMIT_NB_VERIFY (lib/permitNbVerify.js), this closes the matching gap on the SDR path).
//
// Hooks into POST /api/sdr/drafts/generate, one step BEFORE the always-on verification block
// already wired into POST /api/sdr/drafts/:id/approve-and-send (server.js, "Pre-send email
// verification" block). Both gates use the same company-scoped exact-address evidence and
// freshness rules through checkSdrAddress.
//
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
import { verifyEmail, activeProvider } from "./emailVerify.js";
import { checkSdrAddress } from "./sdrAddressVerification.js";

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

export async function checkDraftEmail(pool, { leadId, email }, deps = {}) {
  const check = deps.checkSdrAddress || checkSdrAddress;
  const result = await check(pool, { leadId, email }, {
    verifyEmail: async address => {
      if (liveVerifyCount >= SDR_DRAFT_VERIFY_MAX_PER_RUN) {
        console.warn(`[sdr-draft-verify] per-run cap reached — skipping live verify for lead ${leadId}`);
        return { ok: true, skipped: true };
      }
      liveVerifyCount++;
      return (deps.verifyEmail || verifyEmail)(address);
    },
  });
  return { blocked: result.ok ? null : {
    status: result.status, sub_status: result.sub_status ?? null, suggestion: result.suggestion ?? null,
  } };
}
