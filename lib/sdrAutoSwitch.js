// Auto-switch engine — when a lead changes mid-sequence, stop the wrong sequence and enroll the
// right one. Three triggers, all detected by diffing the lead's CURRENT state (refreshed by the
// Pipedrive sync) against the snapshot we stored on sdr_sends at enroll time:
//   1. Bid stage change → a different trigger/sequence (AGC↔LBA↔CM↔PB)
//   2. Contact (person) change → the person we were emailing is no longer the lead's contact
//   3. Company (organization) change → the lead moved to a different org
//
// Ordering is STOP-then-enroll: we remove the contact from the old Apollo sequence, clear
// Sequence_Started, and mark the send 'switched' FIRST, then enroll the new sequence. This never
// double-touches a lead (the old sequence is dead before the new one starts). If the re-enroll
// then fails, the lead is left safely stopped with a visible note for manual follow-up.
//
// ON by default (this is the intended behavior). Kill switch: set SDR_AUTO_SWITCH=off to disable
// instantly in prod without a redeploy.

import * as apolloClient from "./apolloClient.js";
import * as pipedriveClient from "./pipedriveClient.js";
import { buildDraftFromLead } from "./sdrDraftGenerator.js";

const SEQUENCE_STARTED_FIELD = "48c4bb758e8642d6372c7fff9df3c0ea716170f1"; // PD "Sequence_Started"
const VALID_TRIGGERS = new Set(["AGC", "LBA", "CM", "PB"]);
// Triggers whose day-0 template already congratulates the recipient on winning
// (LBA: "Saw y'all were low on this one, congrats"; AGC: "Congrats on winning the award").
const AWARD_TRIGGERS = new Set(["AGC", "LBA"]);

let running = false;

export function autoSwitchEnabled() {
  return process.env.SDR_AUTO_SWITCH !== "off"; // on unless explicitly killed
}

/** Apollo sequence holding a single award email and no follow-ups. Unset = feature off. */
export function awardOnlySequenceId() {
  return process.env.APOLLO_SEQ_AGC_AWARD_ONLY || null;
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

/**
 * @param pool pg pool
 * @param deps.enrollDrafts async ([{id, assigned_user_id}]) => {enrolled, skipped}
 *        Must enroll with the dedup-override ON (re-contacting a just-emailed lead is intended).
 */
export async function runAutoSwitch(pool, { enrollDrafts }) {
  if (!autoSwitchEnabled()) return { skipped: "disabled" };
  if (running) return { skipped: "already_running" };
  running = true;
  let stopped = 0;
  let reEnrolled = 0;
  let reEnrollFailed = 0;
  let duplicatesSuppressed = 0;
  const events = [];
  try {
    // Active enrollments whose stored snapshot can be compared to the lead's current state.
    const { rows } = await pool.query(
      `SELECT s.id AS send_id, s.pipedrive_lead_id, s.apollo_sequence_id, s.apollo_contact_id,
              s.enrolled_trigger, s.enrolled_person_id, s.enrolled_org_id,
              ls.trigger_type AS cur_trigger, ls.pipedrive_person_id AS cur_person,
              ls.pipedrive_org_id AS cur_org, ls.lead_title, mb.owner_user_id
         FROM sdr_sends s
         JOIN sdr_lead_state ls ON ls.pipedrive_lead_id = s.pipedrive_lead_id
         LEFT JOIN sdr_mailboxes mb ON mb.id = s.mailbox_id
        WHERE s.status IN ('enrolled','sent')
          AND s.enrolled_trigger IS NOT NULL`,
    );

    for (const r of rows) {
      const triggerChanged = !!(r.cur_trigger && r.enrolled_trigger && r.cur_trigger !== r.enrolled_trigger);
      const personChanged = !!(r.cur_person && r.enrolled_person_id && String(r.cur_person) !== String(r.enrolled_person_id));
      const orgChanged = !!(r.cur_org && r.enrolled_org_id && String(r.cur_org) !== String(r.enrolled_org_id));
      // See classifyHop for why LBA→AGC at the same GC sends a single award email.
      const action = classifyHop({
        enrolledTrigger: r.enrolled_trigger,
        curTrigger: r.cur_trigger,
        personChanged,
        orgChanged,
      });
      if (action === "skip") continue;
      const awardOnly = action === "award-only";

      const reasons = awardOnly
        ? `awarded at the same GC (${r.enrolled_trigger}→${r.cur_trigger}) — one award email, no follow-ups`
        : [
            triggerChanged && `stage/trigger ${r.enrolled_trigger}→${r.cur_trigger}`,
            personChanged && `contact changed`,
            orgChanged && `company changed`,
          ]
            .filter(Boolean)
            .join(", ");
      // The new sequence = the lead's current trigger. On a pure contact/company change the
      // trigger may be unchanged → we re-enroll the SAME sequence against the new contact.
      const newTrigger = r.cur_trigger && VALID_TRIGGERS.has(r.cur_trigger) ? r.cur_trigger : r.enrolled_trigger;

      // 1. STOP the current sequence (remove from Apollo, clear marker, mark send switched).
      try {
        if (r.apollo_contact_id && r.apollo_sequence_id && process.env.APOLLO_API_KEY) {
          await apolloClient.removeContactsFromSequence(r.apollo_sequence_id, [r.apollo_contact_id], "remove");
        }
      } catch (e) {
        console.error(`[auto-switch] Apollo remove failed (lead ${r.pipedrive_lead_id}):`, e.message);
      }
      await pool.query(
        `UPDATE sdr_sends SET status = 'switched', switched_at = NOW(), last_status_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [r.send_id],
      );
      stopped++;
      try {
        if (process.env.PIPEDRIVE_API_TOKEN) {
          await pipedriveClient.updateLead(r.pipedrive_lead_id, { [SEQUENCE_STARTED_FIELD]: "" });
          await pipedriveClient.addNote({
            leadId: r.pipedrive_lead_id,
            content: awardOnly
              ? `[Auto] Job awarded and the GC did not change. Stopped the ${r.enrolled_trigger} drip and sending a single award email, no follow-ups.`
              : `[Auto] Sequence switched: ${reasons}. Stopped ${r.enrolled_trigger} sequence, re-enrolling in ${newTrigger}.`,
          });
        }
      } catch (e) {
        console.error(`[auto-switch] Pipedrive stop-note failed (lead ${r.pipedrive_lead_id}):`, e.message);
      }

      // 2. RE-ENROLL into the new sequence (needs a valid trigger + a mailbox owner to send as).
      if (!VALID_TRIGGERS.has(newTrigger) || !r.owner_user_id) {
        events.push({ lead: r.pipedrive_lead_id, reasons, action: "stopped-only" });
        continue;
      }
      try {
        const payload = await buildDraftFromLead({
          pipedriveLeadId: r.pipedrive_lead_id,
          triggerType: newTrigger,
          pool,
          assignedUserId: r.owner_user_id,
          // Award-only keeps the AGC day-0 copy and swaps the destination for a one-step
          // Apollo sequence, so the congratulations goes out and nothing follows it.
          ...(awardOnly ? { apolloSequenceId: awardOnlySequenceId() } : {}),
        });

        // Never send the same sequence to the same inbox twice. See isDuplicateEnrolment.
        // Checked here because this is the first point where both the resolved sequence and
        // the resolved recipient email exist. The old sequence is already stopped above,
        // which is correct: the lead ends up cleanly out of the wrong sequence and does not
        // receive a repeat of one it has already had.
        const { rows: priorSends } = await pool.query(
          `SELECT s.apollo_sequence_id, d.contact_email_snapshot
             FROM sdr_sends s LEFT JOIN sdr_drafts d ON d.id = s.draft_id
            WHERE s.pipedrive_lead_id = $1 AND s.sent_at IS NOT NULL`,
          [r.pipedrive_lead_id],
        );
        if (isDuplicateEnrolment(priorSends, payload)) {
          duplicatesSuppressed++;
          events.push({
            lead: r.pipedrive_lead_id,
            reasons,
            action: "duplicate-suppressed",
            newTrigger,
            detail: `already sent sequence ${payload.apollo_sequence_id} to ${payload.contact_email_snapshot}`,
          });
          if (process.env.PIPEDRIVE_API_TOKEN) {
            try {
              await pipedriveClient.addNote({
                leadId: r.pipedrive_lead_id,
                content:
                  `[Auto] Stopped the ${r.enrolled_trigger} sequence (${reasons}) and did NOT re-enrol: ` +
                  `${payload.contact_email_snapshot} has already had this sequence. ` +
                  `Enrol manually if this one genuinely needs sending again.`,
              });
            } catch {
              /* note is best-effort */
            }
          }
          continue;
        }

        const ins = await pool.query(
          `INSERT INTO sdr_drafts (
             pipedrive_lead_id, pipedrive_contact_id, pipedrive_org_id,
             contact_id_snapshot, contact_email_snapshot, org_id_snapshot,
             trigger_type, apollo_sequence_id, subject, body,
             assigned_mailbox_id, assigned_user_id, initiated_by, metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'auto-switch',$13)
           ON CONFLICT (pipedrive_lead_id, trigger_type)
             WHERE status IN ('pending','approved','edited') DO NOTHING
           RETURNING id, assigned_user_id`,
          [
            payload.pipedrive_lead_id, payload.pipedrive_contact_id, payload.pipedrive_org_id,
            payload.contact_id_snapshot, payload.contact_email_snapshot, payload.org_id_snapshot,
            payload.trigger_type, payload.apollo_sequence_id, payload.subject, payload.body,
            payload.assigned_mailbox_id, payload.assigned_user_id, payload.metadata,
          ],
        );
        if (!ins.rows[0]) {
          // An open draft for this trigger already exists → leave it for the normal queue.
          events.push({ lead: r.pipedrive_lead_id, reasons, action: "draft-exists" });
          continue;
        }
        const res = await enrollDrafts([ins.rows[0]]);
        if (res?.enrolled) {
          reEnrolled++;
          events.push({ lead: r.pipedrive_lead_id, reasons, action: "re-enrolled", newTrigger });
        } else {
          reEnrollFailed++;
          events.push({ lead: r.pipedrive_lead_id, reasons, action: "re-enroll-skipped", newTrigger });
          if (process.env.PIPEDRIVE_API_TOKEN) {
            try {
              await pipedriveClient.addNote({
                leadId: r.pipedrive_lead_id,
                content: `[Auto] Auto-switch: re-enroll into ${newTrigger} did not complete (cap/guard). Needs manual enroll.`,
              });
            } catch {
              /* note is best-effort */
            }
          }
        }
      } catch (e) {
        reEnrollFailed++;
        console.error(`[auto-switch] re-enroll failed (lead ${r.pipedrive_lead_id}):`, e.message);
        events.push({ lead: r.pipedrive_lead_id, reasons, action: "re-enroll-error" });
      }
    }

    return {
      candidates: rows.length,
      stopped,
      reEnrolled,
      reEnrollFailed,
      duplicatesSuppressed,
      events: events.slice(0, 15),
    };
  } finally {
    running = false;
  }
}
