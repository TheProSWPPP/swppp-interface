// Auto-outreach engine. When enabled (sdr_settings.auto_outreach_enabled), fills each
// ACTIVE mailbox's remaining daily cap with the top lead-score eligible leads (fresh +
// has a trigger), rotating across senders. Default mode 'queue' only creates drafts — a
// human still approves before anything sends (approve-and-send does the live dedup). All
// existing guardrails (warmup ramp, unique-draft index) apply.
import { buildDraftFromLead } from "./sdrDraftGenerator.js";
import { dailyCap } from "./sendRamp.js";

// Prune queued drafts that went stale: the contact got emailed in Pipedrive AFTER we
// queued the draft (person last_outgoing_mail_time moved past the draft's created_at).
// Auto-rejects them so a rep never approves an already-contacted lead. Returns the count.
export async function pruneStaleQueuedDrafts(pool) {
  const { rowCount } = await pool.query(`
    UPDATE sdr_drafts d
       SET status = 'rejected',
           reject_reason = 'auto: contact emailed in Pipedrive after this was queued',
           updated_at = NOW()
      FROM sdr_lead_state s
     WHERE d.pipedrive_lead_id = s.pipedrive_lead_id
       AND d.status IN ('pending','approved','edited')
       AND s.last_outgoing_mail_time IS NOT NULL
       AND s.last_outgoing_mail_time > d.created_at
  `);
  return rowCount || 0;
}

// Run one auto-outreach pass. `mailboxSentToday(id)` → today's send count for a mailbox
// (the shared SDR+permit daily counter). Creates drafts only (queue mode).
export async function runAutoOutreach(pool, { mailboxSentToday }) {
  const { rows: srows } = await pool.query(`SELECT * FROM sdr_settings WHERE id = 1`);
  const settings = srows[0];
  if (!settings || !settings.auto_outreach_enabled) return { skipped: "disabled" };

  // Active, Apollo-linked mailboxes + remaining capacity under the warmup ramp.
  const { rows: mbs } = await pool.query(
    `SELECT id, email, owner_user_id, warmup_started_at
       FROM sdr_mailboxes
      WHERE active = TRUE AND apollo_mailbox_id IS NOT NULL AND owner_user_id IS NOT NULL`,
  );
  const perMailbox = [];
  for (const m of mbs) {
    const cap = dailyCap(m.warmup_started_at);
    const used = await mailboxSentToday(m.id);
    const remaining = Math.max(0, cap - used);
    if (remaining > 0) perMailbox.push({ mb: m, remaining });
  }
  if (!perMailbox.length) return { created: 0, note: "no remaining capacity" };

  // Rotate senders: round-robin one slot per mailbox per pass until each is exhausted.
  const rotated = [];
  let added = true;
  while (added) {
    added = false;
    for (const p of perMailbox) {
      if (p.remaining > 0) { rotated.push(p.mb); p.remaining--; added = true; }
    }
  }

  // Eligible leads: fresh (no prior contact), has a trigger, score floor honored, no open
  // draft already. Highest lead-score first.
  const minScore = settings.auto_min_score;
  const { rows: leads } = await pool.query(
    `SELECT s.pipedrive_lead_id, s.trigger_type
       FROM sdr_lead_state s
      WHERE s.outreach_status = 'clear'
        AND s.trigger_type IS NOT NULL
        AND ($1::float8 IS NULL OR s.lead_score >= $1)
        AND NOT EXISTS (
          SELECT 1 FROM sdr_drafts d
           WHERE d.pipedrive_lead_id = s.pipedrive_lead_id
             AND d.status IN ('pending','approved','edited','sent')
        )
      ORDER BY s.lead_score DESC NULLS LAST, s.synced_at ASC
      LIMIT $2`,
    [minScore ?? null, rotated.length],
  );

  let created = 0;
  const createdDrafts = []; // [{ id, assigned_user_id }] — for send-mode enrollment by the caller
  const errors = [];
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const mb = rotated[i];
    try {
      const payload = await buildDraftFromLead({
        pipedriveLeadId: lead.pipedrive_lead_id,
        triggerType: lead.trigger_type,
        pool,
        assignedUserId: mb.owner_user_id, // rotation chooses the sender, not Launch_Sequence
      });
      const ins = await pool.query(
        `INSERT INTO sdr_drafts (
           pipedrive_lead_id, pipedrive_contact_id, pipedrive_org_id,
           contact_id_snapshot, contact_email_snapshot, org_id_snapshot,
           trigger_type, apollo_sequence_id, subject, body,
           assigned_mailbox_id, assigned_user_id, initiated_by, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'automatic',$13)
         ON CONFLICT (pipedrive_lead_id, trigger_type)
           WHERE status IN ('pending','approved','edited') DO NOTHING
         RETURNING id, assigned_user_id`,
        [payload.pipedrive_lead_id, payload.pipedrive_contact_id, payload.pipedrive_org_id,
         payload.contact_id_snapshot, payload.contact_email_snapshot, payload.org_id_snapshot,
         payload.trigger_type, payload.apollo_sequence_id, payload.subject, payload.body,
         payload.assigned_mailbox_id, payload.assigned_user_id, payload.metadata],
      );
      if (ins.rows[0]) {
        created++;
        createdDrafts.push(ins.rows[0]);
      }
    } catch (e) {
      errors.push({ lead: lead.pipedrive_lead_id, error: e.message });
    }
  }
  return {
    mode: settings.auto_outreach_mode,
    created,
    createdDrafts,
    eligible: leads.length,
    capacity: rotated.length,
    errors: errors.slice(0, 5),
  };
}
