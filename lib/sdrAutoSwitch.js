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
      // A hop between two award-framed triggers re-sends a congratulations to the same
      // contact at the same company, which is the one case we never want. Hopping from a
      // pre-award trigger into an award one is still worth sending: PB asks "did y'all win
      // this one?", so the AGC congratulations is the natural next beat, not a repeat.
      const redundantAwardHop =
        triggerChanged && AWARD_TRIGGERS.has(r.enrolled_trigger) && AWARD_TRIGGERS.has(r.cur_trigger);
      const meaningfulTriggerChange = triggerChanged && !redundantAwardHop;
      if (!meaningfulTriggerChange && !personChanged && !orgChanged) continue;

      const reasons = [
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
            content: `[Auto] Sequence switched — ${reasons}. Stopped ${r.enrolled_trigger} sequence, re-enrolling in ${newTrigger}.`,
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
        });
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

    return { candidates: rows.length, stopped, reEnrolled, reEnrollFailed, events: events.slice(0, 15) };
  } finally {
    running = false;
  }
}
