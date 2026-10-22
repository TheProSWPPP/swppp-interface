// Bid follow-up clock for bid-sheet leads (Lead Origin "Bid Invite...").
//
// Pipedrive sends the emails, from the activity assignee's mailbox, through two automations
// Derek owns ("Bid Invite Follow Up (before bid)" / "(after bid)"). Both start on an
// ACTIVITY due date, because Pipedrive date triggers cannot read a lead field and its delays
// cannot count to a date. This clock only does the date math and creates that activity:
//
//   "Bid follow-up 1"  due 2 business days before the bid date -> Email 1, then Email 2
//                      7 business days later in the same thread unless they replied
//   "Bid follow-up 2"  due 5 business days after the bid date  -> Email 2 only, used when
//                      Email 1 was skipped
//
// Email 1 is skipped when the team already emailed that contact from Pipedrive in the 21 days
// before the bid (the hand-sent "Bid Conf" message says the same thing), or when the lead
// arrives too late to land before bid day. Email 2 is skipped when the contact has written in
// since then. A lead is only ever given each activity once (bid_followup_marks).
//
// Activities are CREATED, never edited: existing Pipedrive leads stay behind
// sdrCrmWriteProtection. Off unless BID_FOLLOWUP_ENABLED=true.
import { isBidInviteOrigin } from "./bidInviteGuard.js";

export const BID_FU1_SUBJECT = "Bid follow-up 1 (before bid date)";
export const BID_FU2_SUBJECT = "Bid follow-up 2 (after bid date)";
export const TEAM_TOUCH_DAYS = 21;
const TZ = "America/Chicago";
// The automations fire at 08:00 Chicago. An activity due "today" created after this hour
// would miss today's run, so it is pushed to the next business day instead.
const LAST_SAFE_HOUR = 7;

const iso = (d) => d.toISOString().slice(0, 10);
const utcDate = (ymd) => new Date(`${ymd}T00:00:00Z`);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

export function addBusinessDays(ymd, n) {
  const d = utcDate(ymd);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    if (!isWeekend(d)) left--;
  }
  return iso(d);
}

export function chicagoNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// Earliest due date an activity created right now can still fire on.
function earliestDue({ today, hour }) {
  const d = utcDate(today);
  if (hour < LAST_SAFE_HOUR && !isWeekend(d)) return today;
  return addBusinessDays(today, 1);
}

/**
 * Email 1 decision for one lead right now. marks: steps already handled ("fu1", "fu2").
 * Returns { step, subject, dueDate } | { step, skip: reason } | null (nothing yet).
 */
export function planBidFollowUp({ bidDate, now, marks = new Set(), teamTouchedRecently = false }) {
  if (!bidDate) return null;
  const clock = now?.today ? now : chicagoNow(now);
  const due = earliestDue(clock);

  if (!marks.has("fu1")) {
    const target = addBusinessDays(bidDate, -2);
    const dueDate = target > due ? target : due;
    if (dueDate >= bidDate) return { step: "fu1", skip: "too_late_for_before_bid" };
    if (teamTouchedRecently) return { step: "fu1", skip: "team_already_emailed" };
    // Create it the business day before it is due, so the team-email check is as fresh as possible.
    if (clock.today < addBusinessDays(dueDate, -1)) return null;
    return { step: "fu1", subject: BID_FU1_SUBJECT, dueDate };
  }
  return null;
}

export function planAfterBid({ bidDate, now, marks = new Set(), fu1Outcome, repliedSinceBid = false }) {
  if (!bidDate || marks.has("fu2")) return null;
  // Email 2 already rides on Email 1's automation when Email 1 was sent.
  if (fu1Outcome === "created") return null;
  if (!marks.has("fu1")) return null;
  const clock = now?.today ? now : chicagoNow(now);
  const target = addBusinessDays(bidDate, 5);
  if (clock.today < addBusinessDays(target, -1)) return null;
  if (repliedSinceBid) return { step: "fu2", skip: "contact_replied" };
  const due = earliestDue(clock);
  return { step: "fu2", subject: BID_FU2_SUBJECT, dueDate: target > due ? target : due };
}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS bid_followup_marks (
    pipedrive_lead_id TEXT NOT NULL,
    step TEXT NOT NULL CHECK (step IN ('fu1','fu2')),
    outcome TEXT NOT NULL,
    due_date DATE,
    activity_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pipedrive_lead_id, step)
  )`);
}

/**
 * One pass. pd = { addActivity, getPerson }. Returns counts.
 */
export async function runBidFollowUpClock(pool, { pd, now = new Date(), limit = 50 } = {}) {
  await ensureTable(pool);
  const clock = chicagoNow(now);
  const { rows } = await pool.query(
    `SELECT s.pipedrive_lead_id, s.pipedrive_person_id, lower(btrim(s.person_email)) AS email,
            s.lead_origin, to_char(s.bid_date,'YYYY-MM-DD') AS bid_date,
            m1.outcome AS fu1_outcome, (m2.pipedrive_lead_id IS NOT NULL) AS has_fu2,
            EXISTS (
              SELECT 1 FROM sdr_outreach_log o
                JOIN sdr_lead_state t ON t.pipedrive_lead_id = o.pipedrive_lead_id
               WHERE o.source = 'pipedrive'
                 AND o.sent_at >= s.bid_date - make_interval(days => $2)
                 AND (t.pipedrive_lead_id = s.pipedrive_lead_id
                      OR (s.person_email IS NOT NULL AND lower(btrim(t.person_email)) = lower(btrim(s.person_email))))
            ) AS team_touched
       FROM sdr_lead_state s
       LEFT JOIN bid_followup_marks m1 ON m1.pipedrive_lead_id = s.pipedrive_lead_id AND m1.step = 'fu1'
       LEFT JOIN bid_followup_marks m2 ON m2.pipedrive_lead_id = s.pipedrive_lead_id AND m2.step = 'fu2'
      WHERE lower(btrim(coalesce(s.lead_origin,''))) LIKE 'bid invite%'
        AND s.bid_date IS NOT NULL
        AND s.bid_date BETWEEN $1::date - 14 AND $1::date + 60
        AND coalesce(s.crm_status,'active') = 'active'
        AND s.pipedrive_person_id IS NOT NULL
        AND (m1.pipedrive_lead_id IS NULL OR (m2.pipedrive_lead_id IS NULL AND m1.outcome <> 'created'))
      ORDER BY s.bid_date
      LIMIT $3`,
    [clock.today, TEAM_TOUCH_DAYS, limit],
  );

  const out = { checked: rows.length, created: 0, skipped: 0, failed: 0 };
  for (const r of rows) {
    if (!isBidInviteOrigin(r.lead_origin)) continue;
    const marks = new Set(r.fu1_outcome ? ["fu1"] : []);
    if (r.has_fu2) marks.add("fu2");
    let plan = planBidFollowUp({ bidDate: r.bid_date, now: clock, marks, teamTouchedRecently: r.team_touched });
    if (!plan && marks.has("fu1")) {
      let replied = false;
      const due = addBusinessDays(r.bid_date, 5);
      if (clock.today >= addBusinessDays(due, -1)) {
        try {
          const person = await pd.getPerson(r.pipedrive_person_id);
          const last = person?.last_incoming_mail_time ? new Date(`${String(person.last_incoming_mail_time).replace(" ", "T")}Z`) : null;
          replied = !!last && iso(last) >= addBusinessDays(r.bid_date, -15);
        } catch (e) {
          out.failed++;
          console.warn("[bid-followup] person read failed", r.pipedrive_lead_id, e.message);
          continue;
        }
      }
      plan = planAfterBid({ bidDate: r.bid_date, now: clock, marks, fu1Outcome: r.fu1_outcome, repliedSinceBid: replied });
    }
    if (!plan) continue;

    // Claim the step first so two processes can never create the same activity twice.
    const claim = await pool.query(
      `INSERT INTO bid_followup_marks (pipedrive_lead_id, step, outcome, due_date)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`,
      [r.pipedrive_lead_id, plan.step, plan.skip ? `skipped:${plan.skip}` : "pending", plan.dueDate || null],
    );
    if (!claim.rowCount) continue;
    if (plan.skip) { out.skipped++; continue; }
    try {
      const activity = await pd.addActivity({
        leadId: r.pipedrive_lead_id,
        personId: r.pipedrive_person_id,
        subject: plan.subject,
        type: "email",
        dueDate: plan.dueDate,
        note: "Created by the interface. The Bid Invite Follow Up automation in Pipedrive sends the email on the due date.",
      });
      await pool.query(
        `UPDATE bid_followup_marks SET outcome='created', activity_id=$3 WHERE pipedrive_lead_id=$1 AND step=$2`,
        [r.pipedrive_lead_id, plan.step, activity?.id != null ? String(activity.id) : null],
      );
      out.created++;
    } catch (e) {
      await pool.query(`DELETE FROM bid_followup_marks WHERE pipedrive_lead_id=$1 AND step=$2 AND outcome='pending'`, [r.pipedrive_lead_id, plan.step]);
      out.failed++;
      console.warn("[bid-followup] activity create failed", r.pipedrive_lead_id, e.message);
    }
  }
  return out;
}
