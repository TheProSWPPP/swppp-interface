// Automatic switching records review proposals. Conditional generation removal is unverified.
import * as apolloClient from "./apolloClient.js";
import { stopOwnedEnrollment } from "./sdrProviderOperations.js";

// Triggers whose day-0 template already congratulates the recipient on winning
// (LBA: "Saw y'all were low on this one, congrats"; AGC: "Congrats on winning the award").
const AWARD_TRIGGERS = new Set(["AGC", "LBA"]);

let running = false;

export function autoSwitchEnabled() {
  return process.env.SDR_AUTO_SWITCH !== "off"; // on unless explicitly killed
}

// Apollo sequence holding a single award email and no follow-ups: "SWPPP - AGC Award Only
// (1 step)", built 2026-07-30, active, 1 step, template on our own merge fields.
// Defaulted rather than env-gated so it needs no Railway change to work. Kill with
// APOLLO_SEQ_AGC_AWARD_ONLY=off, or point it at a different sequence with an id.
const AWARD_ONLY_SEQUENCE = "6a6b93d210d3bd00105e3b7f";

export function awardOnlySequenceId() {
  const v = process.env.APOLLO_SEQ_AGC_AWARD_ONLY;
  if (v && v.trim().toLowerCase() === "off") return null;
  return v?.trim() || AWARD_ONLY_SEQUENCE;
}

/**
 * What should happen when a lead's state moved under an active enrollment?
 *
 * Derek, 2026-07-29: "we need to ensure when the Project Stage changes that we are not
 * dripping another sequence on top of the LBA, if the GC didn't change we would maybe just
 * send one award email... if the GC did change, then obviously the drip is good."
 *
 * Reading the two sequences side by side settles what "one award email" has to mean:
 *
 *   LBA d0  "Saw y'all were low on this one, congrats... use our number, right?"
 *   LBA d3  "Do y'all have the ENV/SWPPP scope covered on this one?"
 *   LBA d6  "We sent you a bid and called a few times... Where do we go from here?"
 *   AGC d0  "Congrats on winning the award... you should have a bid from us on it"
 *   AGC d3  "Y'all are going to carry our number on this one, right?"
 *   AGC d6  "We sent you a bid and called several times... Where do we go from here?"
 *
 * Days 3 and 6 are the same ask twice, and d6 is near word-for-word. Those are what make it
 * "another sequence on top of the LBA". Day 0 is the only one that is not a repeat: winning
 * is a different milestone from being low bidder, and the AGC copy carries an offer the LBA
 * copy does not ("let us know if you need a fresh copy" of the bid).
 *
 * So a won job at the same GC gets AGC day 0 and nothing after it.
 *
 * The 2026-07-28 guard suppressed this hop outright, which left the prospect never hearing
 * that we knew they had won while the LBA drip carried on. That is further from what Derek
 * asked for than sending the single email.
 *
 * @returns "switch"      full re-enrollment into the new sequence (the GC or contact moved)
 *          "award-only"  stop the LBA drip, send one award email, stop
 *          "skip"        leave the enrollment alone
 */
export function classifyHop({
  enrolledTrigger,
  curTrigger,
  personChanged,
  orgChanged,
  awardOnlySequence = awardOnlySequenceId(),
}) {
  const triggerChanged = !!(enrolledTrigger && curTrigger && enrolledTrigger !== curTrigger);
  // A hop between two award-framed triggers re-congratulates the same contact at the same
  // company. Hopping from a pre-award trigger into an award one is a real new beat: PB asks
  // "did y'all win this one?", so AGC is the natural answer rather than a repeat.
  const redundantAwardHop =
    triggerChanged && AWARD_TRIGGERS.has(enrolledTrigger) && AWARD_TRIGGERS.has(curTrigger);

  if (triggerChanged && !redundantAwardHop) return "switch";

  // Only LBA -> AGC, and only when the GC and the contact both stayed put. AGC -> LBA is
  // moving backwards out of an award and has nothing to announce.
  if (
    redundantAwardHop &&
    enrolledTrigger === "LBA" &&
    curTrigger === "AGC" &&
    !personChanged &&
    !orgChanged &&
    awardOnlySequence
  ) {
    return "award-only";
  }

  if (personChanged || orgChanged) return "switch";
  return "skip";
}

/**
 * Would re-enrolling send the SAME sequence to the SAME human a second time?
 *
 * Measured 2026-07-30 across all 995 sends: 38 pairs of sends put a lead into the same
 * Apollo sequence twice. 32 of those went to a DIFFERENT email address, which is the whole
 * point of the auto-switch — the contact moved on and the new person still needs the email.
 * The remaining 6 went to the SAME address, every one of them `initiated_by='auto-switch'`.
 *
 * Those 6 happen because the trigger for re-enrolment is a change in Pipedrive's
 * `person_id` or `org_id`, and Pipedrive holds duplicate records for the same entity
 * (15,791 org rows for 13,086 distinct company names; Crossland Construction alone has 34).
 * So an id can flip to a sibling record while the human and their inbox are unchanged, and
 * the engine reads that as "the contact changed" and sends again.
 *
 * The stage-based `redundantAwardHop` guard cannot see this: a same-stage re-enrolment is
 * not a hop. Compare the identity that actually reaches a person, which is the email
 * address, against what we have already sent for that sequence.
 *
 * @param history [{apollo_sequence_id, contact_email_snapshot}] prior SENT sends for this lead
 * @param next    {apollo_sequence_id, contact_email_snapshot} the enrolment being considered
 * @returns true when it is a duplicate and must be suppressed
 */
export function isDuplicateEnrolment(history, next) {
  const seq = next?.apollo_sequence_id;
  const email = next?.contact_email_snapshot;
  // Unknown sequence or unknown recipient: we cannot prove it is a duplicate, and refusing
  // on missing data would silently stop legitimate sends. Fail open, deliberately.
  if (!seq || !email) return false;
  const target = String(email).trim().toLowerCase();
  if (!target) return false;
  return (history || []).some(
    (h) =>
      h &&
      h.apollo_sequence_id === seq &&
      String(h.contact_email_snapshot || "").trim().toLowerCase() === target,
  );
}

// CRM edits invalidate context; they do not authorize stopping or replacing an enrollment.
// Stop proposals retain the exact local send identity and stay reviewable in the ledger.
export async function runAutoSwitch(pool, { apollo = apolloClient, stopEnrollment = stopOwnedEnrollment } = {}) {
  if (!autoSwitchEnabled()) return { skipped: 'disabled' };
  if (running) return { skipped: 'already_running' };
  running = true;
  const events=[];
  let unresolvedRemovals=0;
  try {
    const {rows}=await pool.query(`SELECT s.id AS send_id,s.pipedrive_lead_id,s.apollo_sequence_id,s.apollo_contact_id,
      s.enrolled_trigger,s.enrolled_person_id,s.enrolled_org_id,
      ls.trigger_type AS cur_trigger,ls.pipedrive_person_id AS cur_person,ls.pipedrive_org_id AS cur_org
      FROM sdr_sends s JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=s.pipedrive_lead_id
      WHERE s.status IN ('enrolled','sent') AND s.enrolled_trigger IS NOT NULL`);
    for (const r of rows) {
      const norm=v=>v==null ? null : String(v);
      if (norm(r.enrolled_trigger)===norm(r.cur_trigger) && norm(r.enrolled_person_id)===norm(r.cur_person) && norm(r.enrolled_org_id)===norm(r.cur_org)) continue;
      let result;
      try {
        result=await stopEnrollment({pool,apollo,actionId:`auto-switch:${r.send_id}`,expected:{
          contactId:r.apollo_contact_id,campaignId:r.apollo_sequence_id,membershipId:null,addedAt:null,
          sendId:r.send_id,leadId:r.pipedrive_lead_id,
        }});
      } catch { result={status:'unresolved',reason:'provider_stop_review_unavailable'}; }
      unresolvedRemovals++;
      await pool.query(`INSERT INTO sdr_engagement_events(source,event_type,apollo_event_id,apollo_sequence_id,
        pipedrive_lead_id,occurred_at,payload,process_status,process_error)
        VALUES('apollo','sequence_stop_unconfirmed',$1,$2,$3,NOW(),$4::jsonb,'error',$5)
        ON CONFLICT(apollo_event_id) DO UPDATE SET payload=EXCLUDED.payload,process_error=EXCLUDED.process_error`,
      [`auto-switch-stop:${r.send_id}`,r.apollo_sequence_id,r.pipedrive_lead_id,JSON.stringify(result),result.reason || result.status]);
      events.push({lead:r.pipedrive_lead_id,action:'review-required',providerStopStatus:'unresolved',...result});
    }
    return {candidates:rows.length,stopped:0,reEnrolled:0,reEnrollFailed:0,duplicatesSuppressed:0,unresolvedRemovals,events:events.slice(0,15)};
  } finally { running=false; }
}
