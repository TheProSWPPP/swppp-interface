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
  BID: "2fdb3cb21d7c6fddf7c504854af51cbbc6781fb9", // "Bid" (date)
  START: "4255e2f6f4fcd7097f292e9f3ad01c2b6e00c96c", // "Start" (date)
};
const RECENT_DAYS = 60;
const MAX_PAGES = 150; // safety cap (~15000 leads — covers the full ~8k Pipedrive book)
const PERSON_MAX_PAGES = 60; // 500/page → ~30k persons (well above the book)

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

// Sweep every Pipedrive person into a Map(id → person) in pages of 500. This is
// the budget fix: one /persons page (500 people) replaces 500 individual
// getPerson calls. ~8k people → ~16 calls instead of ~8000.
async function loadPersonMap() {
  const map = new Map();
  let start = 0;
  for (let page = 0; page < PERSON_MAX_PAGES; page++) {
    let res;
    try {
      res = await pd.listPersons({ start, limit: 500 });
    } catch {
      break; // on a person-sweep error, fall back to per-lead getPerson below
    }
    for (const p of res.data) map.set(p.id, p);
    if (!res.pagination?.more_items_in_collection) break;
    start = res.pagination.next_start;
  }
  return map;
}

let running = false;

export async function syncLeadState(pool, { force = false } = {}) {
  if (running && !force) return { skipped: "already_running" };
  running = true;
  const personCache = new Map();
  let scanned = 0;
  let upserted = 0;
  let personFetchFallbacks = 0;
  const byStatus = {};
  try {
    // Bulk-load persons up front (cheap); only fall back to getPerson for misses.
    const personMap = await loadPersonMap();
    // Map owner_id → name (one cheap /users call) so we can show who owns each lead.
    const ownerMap = new Map();
    try {
      for (const u of await pd.listUsers()) ownerMap.set(u.id, u.name || u.email || null);
    } catch {
      /* non-fatal — fall back to no owner name */
    }
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
          if (personMap.has(personId)) {
            person = personMap.get(personId);
          } else if (personCache.has(personId)) {
            person = personCache.get(personId);
          } else {
            // Person wasn't in the bulk sweep (e.g. created since) — fetch individually.
            try {
              person = await pd.getPerson(personId);
            } catch {
              person = null;
            }
            personCache.set(personId, person);
            personFetchFallbacks++;
          }
        }
        const lastOutgoing = person?.last_outgoing_mail_time || null;
        const seqStarted = lead[F.SEQ] || null;
        const stage = lead[F.STAGE] || null;
        const bidDate = lead[F.BID] || null;
        const startDate = lead[F.START] || null;
        const triggerType = resolveTriggerType(lead, stage);
        const status = deriveStatus({ lastOutgoing, seqStarted });
        const ownerName = lead.owner_id != null ? ownerMap.get(lead.owner_id) || null : null;
        byStatus[status] = (byStatus[status] || 0) + 1;

        await pool.query(
          `INSERT INTO sdr_lead_state (
             pipedrive_lead_id, pipedrive_person_id, person_name, person_email,
             last_outgoing_mail_time, email_messages_count, last_activity_date,
             lowbid_flag, sequence_started, project_stage, trigger_type, lead_title,
             outreach_status, bid_date, start_date, owner_name, synced_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
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
             -- a manual override (set from the interface) wins over stage-derivation
             trigger_type = COALESCE(sdr_lead_state.trigger_override, EXCLUDED.trigger_type),
             lead_title = EXCLUDED.lead_title,
             outreach_status = EXCLUDED.outreach_status,
             bid_date = EXCLUDED.bid_date,
             start_date = EXCLUDED.start_date,
             owner_name = EXCLUDED.owner_name,
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
            bidDate,
            startDate,
            ownerName,
          ],
        );
        upserted++;
      }
      if (!pagination.more_items_in_collection) break;
      start = pagination.next_start;
    }
    return { scanned, upserted, byStatus, personFetchFallbacks };
  } finally {
    running = false;
  }
}
