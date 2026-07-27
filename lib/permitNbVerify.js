// NeverBounce verification writer for newly revealed permit operator emails.
//
// PROBLEM: `permit_operator_email.nb_result` was populated ONCE, out-of-repo, by a manual
// NeverBounce batch job on 2026-07-24 (see memory/project_permit_lead_engine.md). No code
// path has ever written it since. `lib/permitAuto.js:43` treats `nb_result IS NULL` as
// sendable ("backward compat"), so any operator email found from now on via the Apollo
// reveal path (`POST /api/permits/find-emails` → `findEmailsForPromoted()` in
// `lib/permitEmailFind.js`) enters the sendable pool completely unverified, forever, until
// someone remembers to re-run a manual batch.
//
// FIX: after `findEmailsForPromoted()` persists new rows, optionally verify each newly
// probed email against the configured verifier (NeverBounce, via the SAME provider-agnostic
// `verifyEmail()` used by the SDR lead-verify path in `lib/emailVerify.js` — no new HTTP
// client here) and write the verdict back to `nb_result`/`nb_checked_at` immediately, so the
// column is never silently stale for a new find.
//
// SAFETY:
//   - OFF by default. Requires BOTH `PERMIT_NB_VERIFY=true` AND a NeverBounce key present
//     (`NEVERBOUNCE_API_KEY`, or `EMAIL_VERIFY_PROVIDER=neverbounce` + `EMAIL_VERIFY_API_KEY`).
//     Absence of either is a no-op — zero verify calls, zero credits.
//   - Hard per-run cap: NB_VERIFY_MAX_PER_RUN. Enforced in SQL (LIMIT) AND in the loop
//     bound, so a bug in one can't blow the cap on its own.
//   - Fail-safe: `verifyEmail()` is itself fail-open (network/timeout/no-key → `skipped:true`).
//     A skipped result is NEVER written — the row is left NULL and logged, never guessed.
//   - Verdict vocabulary matches the live column exactly (confirmed 2026-07-27 against
//     `permit_operator_email.nb_result`, distinct values counted): null 4183, valid 764,
//     unknown 322, catchall 228, invalid 21. `verifyEmail()`'s NeverBounce branch already
//     returns lowercase `valid|invalid|disposable|catchall|unknown` — the same vocabulary
//     the schema comment in `lib/permitDrafts.js:145-148` documents — so no mapping/translation
//     layer is needed; the raw `status`/`soft` string is written as-is.
import { verifyEmail } from "./emailVerify.js";

// Hard per-run credit cap. NeverBounce bills ~1 credit per address checked (matches the
// Apollo-reveal cap pattern already used one file over in `permitEmailFind.js`/`permitRoutes.js`
// — "cap + single-flight so credit spend stays bounded"). Kept well under the Apollo
// find-emails route's own 100-row cap so a single request can never spend more than this
// on verification, no matter how many emails were just found.
export const NB_VERIFY_MAX_PER_RUN = 100;

/** True only when the flag is explicitly on AND a NeverBounce key is actually present. */
export function permitNbVerifyEnabled() {
  if (process.env.PERMIT_NB_VERIFY !== "true") return false;
  const explicit = (process.env.EMAIL_VERIFY_PROVIDER || "").toLowerCase();
  const hasNbKey = !!process.env.NEVERBOUNCE_API_KEY;
  const hasGenericNb = explicit === "neverbounce" && !!process.env.EMAIL_VERIFY_API_KEY;
  return hasNbKey || hasGenericNb;
}

/**
 * Verify + write nb_result for permit_operator_email rows that were newly (re)probed at or
 * after `probedSince` and still carry nb_result IS NULL. No-op unless permitNbVerifyEnabled().
 * Never throws on a per-row verify failure — logs and leaves that row NULL instead.
 *
 * @returns {Promise<{ranAt: string, eligible:number, verified:number, softFail:number, hardFail:number, leftNull:number, cappedAt:number}>}
 */
export async function verifyNewlyRevealedEmails(pool, { probedSince, cap = NB_VERIFY_MAX_PER_RUN } = {}) {
  if (!permitNbVerifyEnabled()) return { skipped: "disabled" };
  if (!probedSince) return { skipped: "no_probed_since" };

  const runCap = Math.min(NB_VERIFY_MAX_PER_RUN, Math.max(1, parseInt(cap, 10) || NB_VERIFY_MAX_PER_RUN));

  const { rows } = await pool.query(
    `SELECT operator_key, email FROM permit_operator_email
      WHERE email IS NOT NULL AND email <> ''
        AND nb_result IS NULL
        AND probed_at >= $1
      ORDER BY probed_at ASC
      LIMIT $2`,
    [probedSince, runCap],
  );

  let verified = 0, softFail = 0, hardFail = 0, leftNull = 0;
  for (const row of rows.slice(0, runCap)) {
    let v;
    try {
      v = await verifyEmail(row.email);
    } catch (e) {
      console.error("[permit-nb-verify] verifyEmail threw for", row.operator_key, e.message);
      leftNull++;
      continue; // fail safe: never guess, leave NULL
    }
    if (v.skipped) {
      // No key resolved, provider errored, or timed out — verifyEmail is fail-open by
      // design. Do NOT write a verdict; leave nb_result NULL for a future retry.
      leftNull++;
      continue;
    }
    const verdict = v.ok ? (v.soft || v.status) : v.status; // valid | unknown | catchall | invalid | disposable
    if (!verdict) { leftNull++; continue; }
    try {
      await pool.query(
        `UPDATE permit_operator_email SET nb_result = $2, nb_checked_at = NOW() WHERE operator_key = $1`,
        [row.operator_key, verdict],
      );
      verified++;
      if (!v.ok) hardFail++; else if (v.soft) softFail++;
    } catch (e) {
      console.error("[permit-nb-verify] write failed for", row.operator_key, e.message);
      leftNull++;
    }
  }

  return {
    ranAt: new Date().toISOString(),
    eligible: rows.length,
    verified,
    softFail,
    hardFail,
    leftNull,
    cappedAt: runCap,
  };
}
