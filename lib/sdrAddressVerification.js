// Only address evidence is shared. Every lead keeps its own recipient, flags and outreach controls.
import { canonicalVerdict, looksLikeEmail, verifyEmail } from "./emailVerify.js";
import { normalEmail } from "./recentReply.js";

export const STALE_MS = 90 * 86400000;
export const SOFT_RECHECK_MS = 7 * 86400000;

export function softRecheckDue({ verifyStatus, email, verifiedValue, verifiedAt, softRecheckedAt, now }) {
  if (canonicalVerdict(verifyStatus) !== "soft" || !email || normalEmail(verifiedValue) !== normalEmail(email) || !verifiedAt) return false;
  return now - verifiedAt >= SOFT_RECHECK_MS && !(softRecheckedAt >= verifiedAt && softRecheckedAt <= now);
}

export function lockSdrAddress(db, email) {
  return db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["sdr-address:" + normalEmail(email)]);
}

const noVerdict = () => ({ ok: true, skipped: true, cached: false });

export async function checkSdrAddressInTransaction(db, { leadId, email, companyId }, {
  verifyEmail: verify = verifyEmail, requireCurrent = false, alternateFor, cacheOnly = false, readOnly = false,
} = {}) {
  const address = normalEmail(email);
  if (!readOnly) await lockSdrAddress(db, address);
  const target = (await db.query(
    `SELECT pipedrive_lead_id, crm_company_id, person_email, email_flag, resolved_email
       FROM sdr_lead_state WHERE pipedrive_lead_id=$1 ${readOnly ? "" : "FOR UPDATE"}`,
    [String(leadId)],
  )).rows[0];
  const current = target && normalEmail(target.person_email) === address;
  const alternate = alternateFor !== undefined && target && normalEmail(target.person_email) === normalEmail(alternateFor);
  if ((requireCurrent && !current) || (alternateFor !== undefined && !alternate)) return noVerdict();
  if (companyId !== undefined && (!current || !companyId || target.crm_company_id !== String(companyId))) return noVerdict();

  // An exact verified_value is the identity of the checked mailbox, even if its old lead
  // has since changed recipients. A lead with unknown company can use only its own evidence.
  const matches = !target || !looksLikeEmail(address) ? [] : (await db.query(
    `SELECT pipedrive_lead_id, email_verify_status, email_verified_at::text AS observed_at,
            CASE WHEN email_soft_rechecked_at BETWEEN email_verified_at AND clock_timestamp()
                 THEN email_soft_rechecked_at::text END AS rechecked_at,
            clock_timestamp() - email_verified_at >= interval '7 days' AS week_old
       FROM sdr_lead_state
      WHERE (pipedrive_lead_id=$1 OR (crm_company_id=$2 AND nullif(btrim($2),'') IS NOT NULL))
        AND lower(regexp_replace(email_verified_value,'^[[:space:]]+|[[:space:]]+$','','g'))=$3
        AND email_verified_at > statement_timestamp() - interval '90 days' AND email_verified_at <= statement_timestamp()
      ORDER BY email_verified_at DESC FETCH FIRST 1 ROW WITH TIES`,
    [String(leadId), current || alternate ? target.crm_company_id : null, address],
  )).rows;

  // Inspect all tied observations. A hard fail blocks; disagreement or unrecognized
  // statuses cannot corroborate a positive verdict. A live check can resolve the tie.
  const verdicts = new Set(matches.map(r => canonicalVerdict(r.email_verify_status)));
  const best = matches.find(r => canonicalVerdict(r.email_verify_status) === "hard_fail")
    || (verdicts.size === 1 && !verdicts.has("skipped") ? matches[0] : null);
  const recheck = best && matches.find(r => canonicalVerdict(r.email_verify_status) === canonicalVerdict(best.email_verify_status) && r.rechecked_at)?.rechecked_at;
  const due = Boolean(best && canonicalVerdict(best.email_verify_status) === "soft" && best.week_old && !recheck);

  let result;
  if (best && (!due || cacheOnly || readOnly)) {
    const status = best.email_verify_status;
    result = { ok: canonicalVerdict(status) !== "hard_fail", status, cached: true,
      verifiedAt: best.observed_at, softRecheckedAt: recheck || null, recheckDue: due };
  } else {
    if (cacheOnly || readOnly) return noVerdict();
    const v = await verify(address);
    const verdict = canonicalVerdict(v?.status);
    if (!v || v.skipped || verdict === "skipped" || v.ok !== (verdict !== "hard_fail")) return noVerdict();
    const observed = (await db.query("SELECT clock_timestamp()::text AS at")).rows[0].at;
    result = { ...v, ok: verdict !== "hard_fail", cached: false, verifiedAt: observed, softRecheckedAt: due ? observed : null, recheckDue: false };
  }
  if (current && !readOnly && alternateFor === undefined) {
    // Preserve the exact DB timestamp (pg's JS Date parser truncates microseconds), the target's
    // original address spelling, and all columns unrelated to address verification.
    await db.query(
      `UPDATE sdr_lead_state SET email_verify_status=$2, email_verified_value=person_email,
              email_verified_at=$3::timestamptz, email_soft_rechecked_at=$4::timestamptz
        WHERE pipedrive_lead_id=$1 AND
              (email_verify_status,email_verified_value,email_verified_at,email_soft_rechecked_at)
              IS DISTINCT FROM ($2,person_email,$3::timestamptz,$4::timestamptz)`,
      [String(leadId), canonicalVerdict(result.status), result.verifiedAt, result.softRecheckedAt],
    );
  }
  return { ...result, email_flag: target?.email_flag ?? null, resolved_email: target?.resolved_email ?? null };
}

export async function checkSdrAddress(pool, target, options) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await checkSdrAddressInTransaction(client, target, options);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
