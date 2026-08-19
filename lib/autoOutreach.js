// Auto-outreach engine. When enabled (sdr_settings.auto_outreach_enabled), fills each
// ACTIVE mailbox's remaining daily cap with the top lead-score eligible leads (fresh +
// has a trigger), rotating across senders. Default mode 'queue' only creates drafts — a
// human still approves before anything sends (approve-and-send does the live dedup). All
// existing guardrails (warmup ramp, unique-draft index) apply.
import { buildDraftFromLead } from "./sdrDraftGenerator.js";
import { dailyCap, mailboxBounceHealth } from "./sendRamp.js";

// A queued draft names a specific bid on a specific project. Two weeks on, the bid is
// decided and the copy is wrong, so a draft nobody approved by then is not one anybody
// should be able to approve later. Matches sdr_settings.contact_cooldown_days.
export const DRAFT_EXPIRY_DAYS = 14;

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

// Auto-reject queued drafts that simply aged out. Without this they sit in the Queue
// forever — 92 of them on 2026-08-06, the oldest from June 28 — where a rep can still
// approve one and send bid copy about a job that closed a month ago.
export async function expireStaleQueuedDrafts(pool, { days = DRAFT_EXPIRY_DAYS } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE sdr_drafts
        SET status = 'rejected',
            reject_reason = 'auto: expired unapproved after ' || $1::int || ' days',
            updated_at = NOW()
      WHERE status IN ('pending','approved','edited')
        AND created_at < NOW() - make_interval(days => $1::int)`,
    [days],
  );
  return rowCount || 0;
}

// Run one auto-outreach pass. `mailboxSentToday(id)` → today's send count for a mailbox
// (the shared SDR+permit daily counter). Creates drafts only (queue mode).
export async function runAutoOutreach(pool, { mailboxSentToday, maxDrafts } = {}) {
  const { rows: srows } = await pool.query(`SELECT * FROM sdr_settings WHERE id = 1`);
  const settings = srows[0];
  if (!settings || !settings.auto_outreach_enabled) return { skipped: "disabled" };

  // Active, Apollo-linked mailboxes + remaining capacity under the warmup ramp.
  const { rows: mbs } = await pool.query(
    `SELECT id, email, owner_user_id, warmup_started_at, daily_send_limit
       FROM sdr_mailboxes
      WHERE active = TRUE AND apollo_mailbox_id IS NOT NULL AND owner_user_id IS NOT NULL`,
  );
  // One query for the whole rotation: a mailbox that has been bouncing gets held back a
  // rung or two, so the engine simply asks for fewer leads for it this pass.
  const health = await mailboxBounceHealth(pool);
  const perMailbox = [];
  for (const m of mbs) {
    const cap = dailyCap(m.warmup_started_at, { target: m.daily_send_limit, health: health.get(m.id) });
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
  // Optional cap (used by the manual "Run now" trigger to create a small test batch).
  if (maxDrafts && rotated.length > maxDrafts) rotated.length = maxDrafts;

  // Auto-switch drafts get first claim on today's capacity.
  //
  // When a lead's stage/contact moves, sdrAutoSwitch stops the old sequence and drafts the
  // replacement, then enrolls it immediately. If that enroll hits the daily cap the draft is
  // left `pending` and NOTHING retries it: the switched send is no longer in the auto-switch
  // candidate set, and this engine only ever creates new drafts. The lead sits stopped in
  // Apollo until a human approves it, or until expireStaleQueuedDrafts rejects it at 14 days.
  // 17 leads were in that state on 2026-08-10, accruing ~9/day once the bounce gate lowered
  // the caps. Draining them first is also the right priority: a stopped lead is mid-conversation,
  // a fresh lead has not been touched.
  const { rows: resumable } = await pool.query(
    `SELECT d.id, d.assigned_user_id
       FROM sdr_drafts d
      WHERE d.status = 'pending'
        AND d.initiated_by = 'auto-switch'
        AND d.assigned_mailbox_id IS NOT NULL
      ORDER BY d.created_at ASC
      LIMIT $1`,
    [rotated.length],
  );
  // Each one consumes a rotation slot, so we never promise more sends than the caps allow.
  rotated.splice(0, resumable.length);

  // Eligible leads: fresh (no prior contact), has a trigger, score floor honored, no open
  // draft already, and the project START date is in the future — the work hasn't begun, so
  // they still need SWPPP. Past-start projects are already underway; we don't auto-chase
  // those. Manual sends ignore this gate.
  //
  // Both gates widen from sdr_settings, and both default to the original hardcoded behaviour
  // (see the column comments in server.js). 'clear' alone is a permanent lockout because
  // nothing ever converts 'contacted_stale' back — recontact_after_days is what expires it.
  const minScore = settings.auto_min_score;
  const recontactAfterDays = settings.recontact_after_days ?? null;
  const startGraceDays = settings.start_date_grace_days ?? 0;
  const { rows: leads } = await pool.query(
    `SELECT s.pipedrive_lead_id, s.trigger_type
       FROM sdr_lead_state s
      WHERE (
              s.outreach_status = 'clear'
              OR ($3::int IS NOT NULL
                  AND s.outreach_status = 'contacted_stale'
                  AND s.last_outgoing_mail_time < NOW() - make_interval(days => $3::int))
            )
        AND s.trigger_type IS NOT NULL
        AND ($1::float8 IS NULL OR s.lead_score >= $1)
        AND s.start_date >= CURRENT_DATE - $4::int
        AND NOT EXISTS (
          SELECT 1 FROM sdr_drafts d
           WHERE d.pipedrive_lead_id = s.pipedrive_lead_id
             AND d.status IN ('pending','approved','edited','sent')
        )
        -- Don't retry a lead we recently FAILED to enroll or rejected. Apollo permanently
        -- refuses some contacts (job-change flag, already active in another campaign) and the
        -- verifier rejects bad addresses — retrying every cycle just spams failed drafts and
        -- inflates the failure KPI. Skip for 30 days after the last failed/rejected attempt.
        AND NOT EXISTS (
          SELECT 1 FROM sdr_drafts d
           WHERE d.pipedrive_lead_id = s.pipedrive_lead_id
             AND d.status IN ('failed','rejected','cancelled')
             AND d.created_at > NOW() - INTERVAL '30 days'
        )
        -- Belt-and-suspenders: never re-outreach a lead we've EVER sent to, in ANY
        -- state (enrolled/sent/replied/bounced/unsubscribed). A reply CLEARS the
        -- Pipedrive Sequence_Started field, which flips outreach_status back to 'clear';
        -- without this guard a replied lead would become re-eligible and get chased again.
        AND NOT EXISTS (
          SELECT 1 FROM sdr_sends x WHERE x.pipedrive_lead_id = s.pipedrive_lead_id
        )
        -- AUTHORITATIVE dedup: the outreach ledger captures EVERY send, including a rep's
        -- manual Pipedrive email (source 'pipedrive') that never stamped the person's
        -- last_outgoing_mail_time (so outreach_status read 'clear' and the lead looked fresh).
        -- This is the guard that stops auto-outreach double-touching an already-emailed lead.
        AND NOT EXISTS (
          SELECT 1 FROM sdr_outreach_log ol
           WHERE ol.pipedrive_lead_id = s.pipedrive_lead_id
             AND ol.sent_at > NOW() - INTERVAL '60 days'
        )
      ORDER BY s.lead_score DESC NULLS LAST, s.synced_at ASC
      LIMIT $2`,
    [minScore ?? null, rotated.length, recontactAfterDays, startGraceDays],
  );

  let created = 0;
  // [{ id, assigned_user_id }] — for send-mode enrollment by the caller. Seeded with the
  // stalled auto-switch drafts so they enroll on this pass alongside anything new.
  const createdDrafts = [...resumable];
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
    resumed: resumable.length,
    createdDrafts,
    eligible: leads.length,
    capacity: rotated.length,
    errors: errors.slice(0, 5),
  };
}
