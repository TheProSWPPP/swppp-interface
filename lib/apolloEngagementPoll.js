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

    for (const { apollo_sequence_id: seqId } of seqRows) {
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
        }
        const pg = res.pagination || {};
        if (!msgs.length || page >= (pg.total_pages || 1)) break;
      }
    }
    return { sequences: seqRows.length, scanned, emitted, byType };
  } finally {
    running = false;
  }
}
