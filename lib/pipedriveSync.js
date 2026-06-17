// Mirrors Pipedrive lead + linked-person outreach state into Postgres (sdr_lead_state)
// so the interface always knows who has already been contacted and can dedup.
// Backend cron (server.js) runs this ~every 6h; also exposed as POST /api/sdr/sync/leads.
import * as pd from "./pipedriveClient.js";
import { inferTriggerType } from "./sdrDraftGenerator.js";

// Stable Pipedrive lead custom-field hashes.
const F = {
  LOWBID: "2908c43ea1003ced2ab0f15a90e3549c9542807a", // "Low Bidder Follow Up Email Sent"
  SEQ: "48c4bb758e8642d6372c7fff9df3c0ea716170f1", // "Sequence_Started" (our marker)
  STAGE: "7c1852c27664d1118f75660223a6af9e99d10f2c", // "Project Stage"
};
const RECENT_DAYS = 60;
const MAX_PAGES = 60; // safety cap (~6000 leads)

// Map a Pipedrive "Project Stage" value → SDR trigger/sequence. Lets the Leads
// view offer one-click Outreach for the ~99% of leads that have a stage but no
// explicit Trigger_* field set by the legacy n8n flow. Keyed uppercase/trimmed.
// "CD" and "Miscellaneous - *" intentionally map to null (do not auto-outreach).
const STAGE_TRIGGER = {
  AGC: "AGC",
  LBA: "LBA",
  CM: "CM",
  PB: "PB",
  OB: "PB",
  "PRE-BID": "PB",
};

// trigger_type precedence: an explicit Pipedrive Trigger_* field (a human set it)
// wins; otherwise derive from the synced Project Stage; else null.
export function resolveTriggerType(lead, stage) {
  return (
    inferTriggerType(lead) ||
    STAGE_TRIGGER[(stage || "").trim().toUpperCase()] ||
    null
  );
}

function personEmail(p) {
  if (!p) return null;
  if (Array.isArray(p.email)) {
    const primary = p.email.find((e) => e.primary) || p.email[0];
    return primary?.value || null;
  }
  return p.primary_email || (typeof p.email === "string" ? p.email : null);
}

// Pipedrive timestamps look like "2026-06-10 14:23:01" (UTC, space-separated).
export function daysSince(ts) {
  if (!ts) return null;
  const iso = ts.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? "" : "Z");
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export function deriveStatus({ lastOutgoing, seqStarted }) {
  if (seqStarted) return "sequenced";
  const d = daysSince(lastOutgoing);
  if (d === null) return "clear";
  return d <= RECENT_DAYS ? "contacted_recent" : "contacted_stale";
}

let running = false;

export async function syncLeadState(pool, { force = false } = {}) {
  if (running && !force) return { skipped: "already_running" };
  running = true;
  const personCache = new Map();
  let scanned = 0;
  let upserted = 0;
  const byStatus = {};
  try {
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data: leads, pagination } = await pd.listLeads({ start, limit: 100 });
      if (!leads.length) break;
      for (const lead of leads) {
        if (/E2E (SDR )?TEST|E2E Test/i.test(lead.title || "")) continue; // skip test artifacts
        scanned++;
        const personId = lead.person_id || null;
        let person = null;
        if (personId != null) {
          if (personCache.has(personId)) {
            person = personCache.get(personId);
          } else {
            try {
              person = await pd.getPerson(personId);
            } catch {
              person = null;
            }
            personCache.set(personId, person);
          }
        }
        const lastOutgoing = person?.last_outgoing_mail_time || null;
        const seqStarted = lead[F.SEQ] || null;
        const stage = lead[F.STAGE] || null;
        const triggerType = resolveTriggerType(lead, stage);
        const status = deriveStatus({ lastOutgoing, seqStarted });
        byStatus[status] = (byStatus[status] || 0) + 1;

        await pool.query(
          `INSERT INTO sdr_lead_state (
             pipedrive_lead_id, pipedrive_person_id, person_name, person_email,
             last_outgoing_mail_time, email_messages_count, last_activity_date,
             lowbid_flag, sequence_started, project_stage, trigger_type, lead_title,
             outreach_status, synced_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
           ON CONFLICT (pipedrive_lead_id) DO UPDATE SET
             pipedrive_person_id = EXCLUDED.pipedrive_person_id,
             person_name = EXCLUDED.person_name,
             person_email = EXCLUDED.person_email,
             last_outgoing_mail_time = EXCLUDED.last_outgoing_mail_time,
             email_messages_count = EXCLUDED.email_messages_count,
             last_activity_date = EXCLUDED.last_activity_date,
             lowbid_flag = EXCLUDED.lowbid_flag,
             sequence_started = EXCLUDED.sequence_started,
             project_stage = EXCLUDED.project_stage,
             trigger_type = EXCLUDED.trigger_type,
             lead_title = EXCLUDED.lead_title,
             outreach_status = EXCLUDED.outreach_status,
             synced_at = NOW()`,
          [
            String(lead.id),
            personId != null ? String(personId) : null,
            person?.name || null,
            personEmail(person),
            lastOutgoing,
            person?.email_messages_count ?? null,
            person?.last_activity_date || null,
            !!lead[F.LOWBID],
            seqStarted,
            stage,
            triggerType,
            lead.title || null,
            status,
          ],
        );
        upserted++;
      }
      if (!pagination.more_items_in_collection) break;
      start = pagination.next_start;
    }
    return { scanned, upserted, byStatus };
  } finally {
    running = false;
  }
}
