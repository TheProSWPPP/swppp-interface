// Polls Apollo for per-lead REPLIES and BOUNCES on active sequences and feeds them
// into the existing /api/sdr/events/ingest pipeline (which dedups by event id and runs
// the reply→remove-from-sequence + Pipedrive-note side effects). Runs as a backend cron
// every ~2 min — NOT in n8n (would be thousands of executions/day).
//
// NOTE: Apollo's API exposes replies/bounces per message but NOT per-lead opens/clicks
// (those are aggregate-only on Basic, or require the Professional webhook). So this
// covers the high-value signals — replies especially (a reply = a hot lead).
import * as apollo from "./apolloClient.js";

let running = false;

// Only emit per-step "sent" events for follow-ups completed recently. The poll runs every
// ~2 min so fresh sends are always caught well within this window; the cutoff prevents the
// first poll after deploy from back-filling a Pipedrive activity for every historical
// follow-up (which would blast hundreds of activities onto Derek's leads at once).
const STEP_SENT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export async function pollEngagement(pool, { baseUrl, callbackSecret, force = false } = {}) {
  if (running && !force) return { skipped: "already_running" };
  if (!process.env.APOLLO_API_KEY) return { skipped: "no_apollo_key" };
  running = true;
  let scanned = 0;
  let emitted = 0;
  const byType = {};
  try {
    // Distinct active sequences from recent sends.
    const { rows: seqRows } = await pool.query(
      `SELECT DISTINCT apollo_sequence_id FROM sdr_sends
       WHERE apollo_sequence_id IS NOT NULL
         AND status IN ('enrolled','sent','replied')
         AND sent_at > NOW() - INTERVAL '45 days'`,
    );
    const ingestUrl = `${baseUrl}/api/sdr/events/ingest?callback_secret=${encodeURIComponent(callbackSecret)}`;
    const emit = async (ev) => {
      try {
        const r = await fetch(ingestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ev),
        });
        if (r.ok) {
          emitted++;
          byType[ev.type] = (byType[ev.type] || 0) + 1;
        }
      } catch {
        /* individual emit failure is non-fatal — next poll retries (idempotent) */
      }
    };

    // Per-contact step aggregates (Apollo `campaign_position` = step number).
    // contactId → { steps:Set, doneMax, nextAt, nextPos, status }
    const stepAgg = new Map();
    const seqStepCount = new Map(); // seqId → Set of distinct step ids (total steps)

    for (const { apollo_sequence_id: seqId } of seqRows) {
      if (!seqStepCount.has(seqId)) seqStepCount.set(seqId, new Set());
      for (let page = 1; page <= 20; page++) {
        let res;
        try {
          res = await apollo.searchEmailerMessages({ campaignIds: [seqId], page, perPage: 100 });
        } catch (e) {
          console.error(`[engagement-poll] message search failed for ${seqId}:`, e.message);
          break;
        }
        const msgs = res.emailer_messages || [];
        for (const m of msgs) {
          scanned++;
          const base = {
            sequence_id: seqId,
            email: m.to_email,
            emailer_message_id: m.id,
            created_at: m.completed_at || m.created_at,
          };
          // Stable synthetic ids → re-polling is idempotent (ingest does ON CONFLICT DO NOTHING).
          if (m.replied) await emit({ ...base, type: "email_replied", id: `poll:${m.id}:replied` });
          if (m.bounce) await emit({ ...base, type: "email_bounced", id: `poll:${m.id}:bounced` });
          if (m.spam_blocked) await emit({ ...base, type: "email_bounced", id: `poll:${m.id}:spam` });

          // Per-step follow-up send (Apollo campaign_position is 1-indexed: 1 = first email
          // logged at enrollment, >=2 = follow-ups). Emit recent ones so Pipedrive logs every
          // touch, not just the first. Idempotent on the stable id; recent-only avoids a blast.
          const stepPos = Number(m.campaign_position) || 0;
          if (m.completed_at && stepPos >= 2) {
            const completedMs = Date.parse(m.completed_at) || 0;
            if (completedMs && completedMs > Date.now() - STEP_SENT_MAX_AGE_MS) {
              await emit({ ...base, type: "email_sent", step: stepPos, id: `poll:${m.id}:sent` });
            }
          }

          // ---- Step tracking ----
          if (m.emailer_step_id) seqStepCount.get(seqId).add(m.emailer_step_id);
          const cid = m.contact_id;
          if (cid) {
            let a = stepAgg.get(cid);
            if (!a) { a = { seqId, doneMax: 0, nextAt: null, nextPos: null, lastStatus: null }; stepAgg.set(cid, a); }
            const pos = Number(m.campaign_position) || 0;
            if (m.completed_at && pos > a.doneMax) a.doneMax = pos;
            if (m.status === "scheduled" && m.due_at) {
              if (!a.nextAt || new Date(m.due_at) < new Date(a.nextAt)) { a.nextAt = m.due_at; a.nextPos = pos; }
            }
            if (m.replied) a.lastStatus = "replied";
            else if (m.bounce) a.lastStatus = "bounced";
            else if (m.status === "scheduled" && !a.lastStatus) a.lastStatus = "scheduled";
            else if (m.completed_at && a.lastStatus !== "replied" && a.lastStatus !== "bounced") a.lastStatus = "sent";
          }
        }
        const pg = res.pagination || {};
        if (!msgs.length || page >= (pg.total_pages || 1)) break;
      }
    }

    // Persist step tracking onto sdr_sends (matched by apollo_contact_id).
    let stepsUpdated = 0;
    for (const [cid, a] of stepAgg) {
      const total = seqStepCount.get(a.seqId)?.size || null;
      // current step = highest completed position, or the next scheduled position if nothing sent yet.
      const current = a.doneMax || a.nextPos || null;
      try {
        const r = await pool.query(
          `UPDATE sdr_sends SET current_step = $1, total_steps = $2, next_send_at = $3, step_status = $4, updated_at = NOW()
           WHERE apollo_contact_id = $5`,
          [current, total, a.nextAt, a.lastStatus, cid],
        );
        stepsUpdated += r.rowCount;
      } catch (e) {
        console.error("[engagement-poll] step update failed:", e.message);
      }
    }

    return { sequences: seqRows.length, scanned, emitted, byType, stepsUpdated };
  } finally {
    running = false;
  }
}
