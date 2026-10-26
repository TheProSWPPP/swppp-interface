// Bid follow-up clock for bid-sheet leads (Lead Origin "Bid Invite...").
//
// Nothing here sends email. The clock does the date math and puts a Pipedrive TASK on the
// lead, assigned to the lead's current owner, with the follow-up email written out in the
// task note. The owner reads it, edits it and sends it from Pipedrive (or skips it):
//
//   "Bid follow-up 1"  due 2 business days before the bid date: check our bid came through
//   "Bid follow-up 2"  due 5 business days after the bid date: ask how the bid went
//
// Task 1 is skipped when someone already emailed that contact about the SAME project from
// Pipedrive in the 21 days before the bid (same lead, or same person on a lead with the same
// title), or when the lead arrives too late to land before bid day. Task 2 is skipped when
// the contact has written in since Task 1 was due (or 2 business days before the bid when
// Task 1 was skipped); older mail, like plans sent weeks ahead, doesn't count. A lead is only
// ever given each task once (bid_followup_marks). The note greets the contact by first name.
//
// Activities are CREATED, never edited: existing Pipedrive leads stay behind
// sdrCrmWriteProtection. Off unless BID_FOLLOWUP_ENABLED=true.
import { isBidInviteOrigin } from "./bidInviteGuard.js";
import { refreshFollowupTaskStates } from "./followupOutcomeReadout.js";

export const BID_FU1_SUBJECT = "Bid follow-up 1: check our bid came through";
export const BID_FU2_SUBJECT = "Bid follow-up 2: ask how the bid went";
export const TEAM_TOUCH_DAYS = 21;
const HOW_TO = "Nothing has been sent. If this still makes sense, send it to the contact on this lead from Pipedrive (reply in the bid thread if there is one), edit it as you like, then mark this task done. Skip it if you already spoke to them.";
const para = (lines) => lines.map((l) => `<p>${l}</p>`).join("");
// "rodger caffey" -> "Rodger"; no usable name (blank, an address) -> "Hey," with no name.
const greeting = (personName) => {
  const first = String(personName ?? "").trim().split(/\s+/)[0] || "";
  if (!first || first.includes("@")) return "Hey,";
  const name = first === first.toLowerCase() ? first[0].toUpperCase() + first.slice(1) : first;
  return `Hey ${name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")},`;
};
export const bidFu1Note = (personName) => para([
  HOW_TO,
  "<b>Ready to send</b> (also saved as the email template \"Bid FU #1\"):",
  greeting(personName),
  "You should have a bid from us on the SWPPP scope on this one... just wanted to make sure it came through before bid day.",
  "Let us know if you need anything adjusted or a fresh copy.",
  "We appreciate your business.",
  "Regards,",
]);
export const bidFu2Note = (personName) => para([
  HOW_TO,
  "<b>Ready to send</b> (also saved as the email template \"Bid FU #2\"):",
  greeting(personName),
  "How'd the bid go on this one?",
  "If it's been awarded, who should we talk to about the SWPPP scope?",
  "Regards,",
]);
const TZ = "America/Chicago";
// A task due "today" created after 07:00 Chicago lands after the owner has started their day,
// so it is pushed to the next business day instead.
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

// Earliest due date for a task created right now.
function earliestDue({ today, hour }) {
  const d = utcDate(today);
  if (hour < LAST_SAFE_HOUR && !isWeekend(d)) return today;
  return addBusinessDays(today, 1);
}

/**
 * Task 1 decision for one lead right now. marks: steps already handled ("fu1", "fu2").
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

export function planAfterBid({ bidDate, now, marks = new Set(), repliedSinceBid = false }) {
  if (!bidDate || marks.has("fu2")) return null;
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
 * One pass. pd = { addActivity, getPerson, getLead }. Returns counts.
 */
export async function runBidFollowUpClock(pool, { pd, now = new Date(), limit = 50 } = {}) {
  await ensureTable(pool);
  // Whether each task made earlier is still open (feeds the weekly outcome card).
  try {
    await refreshFollowupTaskStates(pool, { pd, table: "bid_followup_marks" });
  } catch (e) {
    console.warn("[bid-followup] task status check failed", e.message);
  }
  const clock = chicagoNow(now);
  // Leads waiting for Task 1 and leads waiting for Task 2 get a window each, so one kind can
  // never fill the other's: 50 older bids waiting for Task 2 used to starve a new bid's Task 1.
  // Task 2 is never due before bid day + 4 calendar days, so earlier bids aren't read for it.
  const select = (step) => pool.query(
    `SELECT s.pipedrive_lead_id, s.pipedrive_person_id, lower(btrim(s.person_email)) AS email,
            s.person_name, s.lead_origin, to_char(s.bid_date,'YYYY-MM-DD') AS bid_date,
            m1.outcome AS fu1_outcome, to_char(m1.due_date,'YYYY-MM-DD') AS fu1_due,
            (m2.pipedrive_lead_id IS NOT NULL) AS has_fu2,
            EXISTS (
              SELECT 1 FROM sdr_outreach_log o
                JOIN sdr_lead_state t ON t.pipedrive_lead_id = o.pipedrive_lead_id
               WHERE o.source = 'pipedrive'
                 AND o.sent_at >= s.bid_date - make_interval(days => $2)
                 AND (t.pipedrive_lead_id = s.pipedrive_lead_id
                      OR (s.person_email IS NOT NULL AND s.lead_title IS NOT NULL
                          AND lower(btrim(t.person_email)) = lower(btrim(s.person_email))
                          AND lower(btrim(t.lead_title)) = lower(btrim(s.lead_title))))
            ) AS team_touched
       FROM sdr_lead_state s
       LEFT JOIN bid_followup_marks m1 ON m1.pipedrive_lead_id = s.pipedrive_lead_id AND m1.step = 'fu1'
       LEFT JOIN bid_followup_marks m2 ON m2.pipedrive_lead_id = s.pipedrive_lead_id AND m2.step = 'fu2'
      WHERE lower(btrim(coalesce(s.lead_origin,''))) LIKE 'bid invite%'
        AND s.bid_date IS NOT NULL
        AND s.bid_date BETWEEN $1::date - 14 AND $1::date + 60
        AND coalesce(s.crm_status,'active') = 'active'
        AND s.pipedrive_person_id IS NOT NULL
        AND ${step === "fu1" ? "m1.pipedrive_lead_id IS NULL" : "m1.pipedrive_lead_id IS NOT NULL AND m2.pipedrive_lead_id IS NULL AND s.bid_date <= $1::date - 4"}
      ORDER BY s.bid_date
      LIMIT $3`,
    [clock.today, TEAM_TOUCH_DAYS, limit],
  );
  const rows = [...(await select("fu1")).rows, ...(await select("fu2")).rows];

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
          // Only mail since Task 1 was due counts as an answer about this bid.
          replied = !!last && iso(last) >= (r.fu1_due || addBusinessDays(r.bid_date, -2));
        } catch (e) {
          out.failed++;
          console.warn("[bid-followup] person read failed", r.pipedrive_lead_id, e.message);
          continue;
        }
      }
      plan = planAfterBid({ bidDate: r.bid_date, now: clock, marks, repliedSinceBid: replied });
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
      // The task goes to whoever owns the lead now. A refused assignment fails here and is
      // retried next run, never re-posted on the token owner (a second copy on the wrong list).
      const lead = await pd.getLead(r.pipedrive_lead_id);
      const activity = await pd.addActivity({
        leadId: r.pipedrive_lead_id,
        personId: r.pipedrive_person_id,
        subject: plan.subject,
        type: "task",
        dueDate: plan.dueDate,
        userId: lead?.owner_id ?? undefined,
        strictAssignee: true,
        note: plan.step === "fu1" ? bidFu1Note(r.person_name) : bidFu2Note(r.person_name),
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
