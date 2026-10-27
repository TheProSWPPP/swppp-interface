// Automatic outreach to catch-all / unknown ("soft") addresses, with two brakes.
//
// Ivan, 2026-10-27: people on a bid list are usually real, so automation also emails a soft
// verdict; only confident-bad addresses stay blocked (invalid, disposable, spamtrap, abuse,
// do_not_mail, an earlier bounce or spam block, a value that is not an address).
//
// Soft addresses bounced at 8.3% against 3.4% for valid ones, and Apollo pauses a sequence on
// its own when its bounce rate climbs (SWPPP - PB at 8.03% on 2026-09-16, LBA at 6.5% on
// 2026-10-10), which stopped every send in it for weeks. So:
//   - at most sdr_settings.soft_verdict_daily_cap soft enrollments a day (default 40), valid
//     addresses first and never counted against it;
//   - no soft enrollment into a sequence whose last-7-day bounce rate (Apollo bounces over
//     attempted sends, from sdr_reporting_messages) is 4% or more, until it drops back.

export const DEFAULT_SOFT_DAILY_CAP = 40;
export const BOUNCE_GUARD_RATE = 0.04;
export const BOUNCE_GUARD_DAYS = 7;
// Raw values a soft verdict is stored under (canonicalVerdict in lib/emailVerify.js).
export const SOFT_VERDICT_VALUES = ['soft', 'catchall', 'catch_all', 'catch-all', 'unknown'];
export const VALID_VERDICT_VALUES = ['ok', 'valid'];

export function softDailyCap(settings) {
  const cap = Number(settings?.soft_verdict_daily_cap);
  return Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_SOFT_DAILY_CAP;
}

// Start of the current America/Chicago day, as SQL (the business day the send ramp counts in).
const CHICAGO_DAY_START = "(date_trunc('day', NOW() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago')";

// Per-sequence bounce rate over the last BOUNCE_GUARD_DAYS. An attempted send is a completed
// Apollo message or one that bounced or was spam-blocked after an attempt (a pre-send refusal
// carries no occurred_at and is not an attempt).
export async function sequenceBounceRates(db, { days = BOUNCE_GUARD_DAYS, threshold = BOUNCE_GUARD_RATE } = {}) {
  const { rows } = await db.query(
    `SELECT campaign_id AS sequence_id,
            count(*) FILTER (WHERE bounce IS TRUE)::int AS bounced,
            count(*)::int AS attempted
       FROM sdr_reporting_messages
      WHERE provider = 'apollo' AND direction = 'out' AND campaign_id IS NOT NULL
        AND occurred_at > NOW() - make_interval(days => $1::int)
        AND (provider_status = 'completed' OR bounce IS TRUE OR spam_blocked IS TRUE)
      GROUP BY campaign_id`,
    [days],
  );
  return rows.map(r => {
    const rate = r.attempted ? r.bounced / r.attempted : 0;
    return { sequenceId: String(r.sequence_id), bounced: r.bounced, attempted: r.attempted, rate, paused: r.attempted > 0 && rate >= threshold };
  });
}

export async function bounceGuardedSequences(db, options) {
  const rates = await sequenceBounceRates(db, options);
  return new Map(rates.filter(r => r.paused).map(r => [r.sequenceId, r]));
}

// A draft was written for a soft address: its metadata says so (since 2026-10-27), or, for an
// older draft, the lead's current verdict for that exact address is soft.
const softDraft = d => `(${d}.metadata->>'email_verdict' = 'soft' OR (${d}.metadata->>'email_verdict' IS NULL AND EXISTS(
  SELECT 1 FROM sdr_lead_state sv WHERE sv.pipedrive_lead_id = ${d}.pipedrive_lead_id AND sv.email_verified_value = ${d}.contact_email_snapshot
    AND lower(btrim(sv.email_verify_status)) = ANY(ARRAY['${SOFT_VERDICT_VALUES.join("','")}']))))`;

// Soft enrollments Apollo accepted today (the send-time cap).
export async function softEnrolledToday(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM sdr_sends s JOIN sdr_drafts d ON d.id = s.draft_id
      WHERE s.created_at >= ${CHICAGO_DAY_START} AND ${softDraft('d')}`,
  );
  return rows[0]?.n || 0;
}

// Soft drafts automation wrote today that are queued or sent (the drafting cap, so a pass
// never drafts more soft leads than the day can enroll).
export async function softDraftedToday(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM sdr_drafts d
      WHERE d.created_at >= ${CHICAGO_DAY_START} AND d.initiated_by = 'automatic'
        AND d.status IN ('pending','approved','edited','sent') AND ${softDraft('d')}`,
  );
  return rows[0]?.n || 0;
}

// Everything one pass needs to decide on soft leads. When any of it cannot be read (a missing
// table, a failed query), soft leads are not drafted this pass: the brakes must be readable
// before soft sends happen. Valid leads are unaffected.
export async function softGuardState(db, settings) {
  const cap = softDailyCap(settings);
  try {
    const used = Math.max(await softDraftedToday(db), await softEnrolledToday(db));
    const bouncing = await bounceGuardedSequences(db);
    return { available: true, cap, used, remaining: Math.max(0, cap - used), bouncing };
  } catch (error) {
    console.warn(`[soft-verdict] guard unavailable, soft leads skipped this pass: ${error.code || error.message}`);
    return { available: false, cap, used: null, remaining: 0, bouncing: new Map() };
  }
}
