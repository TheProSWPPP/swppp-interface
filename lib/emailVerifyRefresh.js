// lib/emailVerifyRefresh.js
// Contacts-refresh email verification: decides WHO to verify (lazy + cached), classifies the
// verifier result, and (Task 5) runs the dead-address recovery cascade. Kept separate from
// syncLeadState so the decision logic is pure + unit-testable.

import * as pipedriveClient from "./pipedriveClient.js";
import * as apolloClient from "./apolloClient.js";

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

const primaryEmailOf = (p) => (p?.email || []).find((e) => e.primary)?.value || p?.email?.[0]?.value || null;

// Dependency-injected so the cascade is unit-testable without network. Returns the address to
// use + how we got it.
export async function resolveContact(lead, deps) {
  const v = await deps.verify(lead.email);
  const cls = classifyVerifyResult(v);
  if (cls !== "hard_fail") return { outcome: "ok", email: lead.email };

  const adopt = async (newEmail, source) => {
    await deps.setPrimaryEmail(lead.personId, newEmail, { keepOld: lead.email });
    await deps.addNote({
      leadId: lead.leadId,
      content: `[Auto] Primary email ${lead.email} failed verification; switched to ${newEmail} (source: ${source}).`,
    });
    return { outcome: "recovered", email: newEmail, source };
  };

  // 1. FREE: other persons on the same Pipedrive org.
  const orgPersons = await deps.listOrgPersons(lead.orgId);
  const orgCands = (orgPersons || [])
    .map((p) => ({ email: primaryEmailOf(p), title: p.title }))
    .filter((c) => c.email && c.email.toLowerCase() !== String(lead.email).toLowerCase());
  const best = pickBestCandidate(orgCands);
  // pickBestCandidate returns the single best; verify candidates best-first until one passes.
  for (const c of orgCands.slice().sort((a, b) => {
    if (best && a.email === best.email) return -1;
    if (best && b.email === best.email) return 1;
    return 0;
  })) {
    if (classifyVerifyResult(await deps.verify(c.email)) === "pass") return adopt(c.email, "pd_org");
  }

  // 2. PAID (capped): Apollo people-search by domain.
  if (deps.canUseApollo()) {
    const domain = emailDomain(lead.email);
    if (domain) {
      const cands = await deps.searchPeopleByDomain(domain, { titles: DEFAULT_TITLE_PRIORITY });
      const pick = pickBestCandidate(cands);
      if (pick && classifyVerifyResult(await deps.verify(pick.email)) === "pass") return adopt(pick.email, "apollo");
    }
  }

  return { outcome: "flagged" };
}

// Stop outreach to a confirmed-dead address: reject open drafts, pull any live Apollo enrollment,
// clear Sequence_Started. Mirrors inboxReplyWatch.js:246-310.
export async function cancelInFlightOutreach(pool, lead, deps = {}) {
  const removeFromSeq = deps.removeContactsFromSequence || apolloClient.removeContactsFromSequence;
  const updateLead = deps.updateLead || pipedriveClient.updateLead;
  const SEQ_FIELD = "48c4bb758e8642d6372c7fff9df3c0ea716170f1"; // PD Sequence_Started

  const { rowCount: cancelledDrafts } = await pool.query(
    `UPDATE sdr_drafts SET status = 'rejected',
        reject_reason = 'auto: email failed verification, no alternate found'
      WHERE pipedrive_lead_id = $1 AND status IN ('pending','approved','edited')`,
    [String(lead.leadId)],
  );

  const { rows: sends } = await pool.query(
    `SELECT id, apollo_sequence_id, apollo_contact_id FROM sdr_sends
      WHERE pipedrive_lead_id = $1 AND status = 'enrolled'`,
    [String(lead.leadId)],
  );
  let removedEnrollments = 0;
  for (const s of sends) {
    try {
      if (s.apollo_sequence_id && s.apollo_contact_id) {
        await removeFromSeq(s.apollo_sequence_id, [s.apollo_contact_id], "remove");
      }
      await pool.query(`UPDATE sdr_sends SET status = 'failed' WHERE id = $1`, [s.id]);
      removedEnrollments++;
    } catch (e) {
      console.error("cancelInFlightOutreach: Apollo remove failed", e.message);
    }
  }
  if (removedEnrollments && lead.leadId) {
    try { await updateLead(lead.leadId, { [SEQ_FIELD]: "" }); } catch (e) { console.error(e.message); }
  }
  return { cancelledDrafts, removedEnrollments };
}
