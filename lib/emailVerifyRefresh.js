// lib/emailVerifyRefresh.js
// Contacts-refresh email verification: decides WHO to verify (lazy + cached), classifies the
// verifier result, and (Task 5) runs the dead-address recovery cascade. Kept separate from
// syncLeadState so the decision logic is pure + unit-testable.

export const STALE_MS = 90 * 24 * 60 * 60 * 1000; // re-verify addresses older than 90 days
export const DEFAULT_TITLE_PRIORITY = [
  "owner", "president", "principal", "project manager", "estimator", "superintendent", "manager",
];

// Verify only outreach-eligible leads, and only when we have no fresh result for THIS address.
export function needsVerify({ status, triggerType, email, verifiedValue, verifiedAt, now }) {
  if (status !== "clear" || !triggerType || !email) return false;
  if (verifiedValue !== email) return true;              // never verified, or the address changed
  if (!verifiedAt) return true;
  return now - verifiedAt > STALE_MS;                     // stale
}

// Map emailVerify.verifyEmail() output to a coarse action.
export function classifyVerifyResult(v) {
  if (!v || v.skipped) return "skip";                    // fail-open (no key / API error / bad input)
  if (v.ok === false) return "hard_fail";                // confident-bad (invalid/disposable)
  return "pass";                                         // valid, or soft catchall/unknown
}

export function emailDomain(email) {
  const m = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(String(email || "").trim());
  return m ? m[1].toLowerCase() : null;
}

// From [{email, title}], keep those with a usable (unlocked) email, then prefer the best title.
export function pickBestCandidate(candidates, titlePriority = DEFAULT_TITLE_PRIORITY) {
  const usable = (candidates || []).filter(
    (c) => c && c.email && !/email_not_unlocked/i.test(c.email) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email),
  );
  if (!usable.length) return null;
  const rank = (title) => {
    const t = String(title || "").toLowerCase();
    const i = titlePriority.findIndex((p) => t.includes(p));
    return i === -1 ? titlePriority.length : i;
  };
  return usable.slice().sort((a, b) => rank(a.title) - rank(b.title))[0];
}

export async function readVerifyCache(pool, leadId) {
  const { rows } = await pool.query(
    `SELECT email_verify_status, email_verified_at, email_verified_value, resolved_email, email_flag
       FROM sdr_lead_state WHERE pipedrive_lead_id = $1`,
    [String(leadId)],
  );
  return rows[0] || null;
}

// Upsert-style write of the verification result. flag === null explicitly clears email_flag;
// flag === undefined leaves it untouched. resolvedEmail === undefined leaves resolved_email untouched.
export async function writeVerifyCache(pool, leadId, { status, verifiedValue, resolvedEmail, flag }) {
  await pool.query(
    `UPDATE sdr_lead_state
        SET email_verify_status = $2,
            email_verified_at = NOW(),
            email_verified_value = $3,
            resolved_email = CASE WHEN $4::bool THEN $5 ELSE resolved_email END,
            email_flag = CASE WHEN $6::bool THEN $7 ELSE email_flag END
      WHERE pipedrive_lead_id = $1`,
    [
      String(leadId), status ?? null, verifiedValue ?? null,
      resolvedEmail !== undefined, resolvedEmail ?? null,
      flag !== undefined, flag ?? null,
    ],
  );
}
