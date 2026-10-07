// Mirrors Pipedrive lead + linked-person outreach state into Postgres (sdr_lead_state)
// so the interface always knows who has already been contacted and can dedup.
// Backend cron (server.js) runs this ~every 6h; also exposed as POST /api/sdr/sync/leads.
import * as pd from "./pipedriveClient.js";
import { inferTriggerType } from "./sdrDraftGenerator.js";
import { runVerificationPass } from "./emailVerifyRefresh.js";
import { randomUUID } from 'node:crypto';
import { crmLifecycleEnabled } from './sdrCrmGuard.js';

// Stable Pipedrive lead custom-field hashes.
export const FIELD_KEYS = {
  LOWBID: "2908c43ea1003ced2ab0f15a90e3549c9542807a", // "Low Bidder Follow Up Email Sent"
  SEQ: "48c4bb758e8642d6372c7fff9df3c0ea716170f1", // "Sequence_Started" (our marker)
  STAGE: "7c1852c27664d1118f75660223a6af9e99d10f2c", // "Project Stage"
  BID: "2fdb3cb21d7c6fddf7c504854af51cbbc6781fb9", // "Bid" (date)
  START: "4255e2f6f4fcd7097f292e9f3ad01c2b6e00c96c", // "Start" (date)
  INTERFACE_LINK: "29bff7b3c877d23aae626adfaedc6b4ca644aa42", // "Interface Link" (deep-link to this lead's twin)
  LEAD_SCORE: "e2b854536230112bff77d6b0ce33bdb49f2916eb", // "Lead Score" (numeric, ~ -50..85, higher = better)
  // "Project Value" (MONETARY, USD) — the construction budget from the CMD sheet's
  // "Confirmed Value" column. NOT `deal_value`, which holds Pro SWPPP's own quote amounts.
  // Monetary rather than double so Pipedrive renders it as currency; the type cannot be
  // changed after creation, so the original double field was migrated and deleted.
  PROJECT_VALUE: "63ad9184b6bc1c3bc60bf0a62b4b963e9ea17369",
};
const F = FIELD_KEYS;
const sourceTimestamp = value => {
  if (!value) return null;
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  return Number.isFinite(+new Date(normalized)) ? new Date(normalized).toISOString() : null;
};
const RECENT_DAYS = 60;
const MAX_PAGES = 150; // safety cap (~15000 leads — covers the full ~8k Pipedrive book)
const PERSON_MAX_PAGES = 100; // bounded 50k-person sweep; the current book exceeds 30k

// Interface "twin" deep-link backfill. Writes a clickable link to each lead's
// interface twin into the Pipedrive "Interface Link" field. Deterministic URL,
// so it's set once and never changes. Scoped to actionable leads (bid date
// null-or-future) and only when the field is empty (idempotent). OFF by default
// and per-cycle capped so it can never blow the Pipedrive daily request budget
// or touch production leads until explicitly enabled.
const INTERFACE_LINK_ENABLED = process.env.INTERFACE_LINK_ENABLED === "true";
const INTERFACE_LINK_CAP = Number(process.env.INTERFACE_LINK_CAP || 30); // max writes per sync cycle
const APP_BASE = process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app";

// True when the lead is still actionable: no bid date yet, or a bid date today/future.
function bidIsOpen(bidDate) {
  if (!bidDate) return true;
  const t = new Date(`${bidDate}`.replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return true; // unparseable → don't exclude
  return t >= Date.now() - 86400000; // today or later (1-day grace)
}

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
async function loadPersonMap(maxPages) {
  const map = new Map();
  let start = 0;
  let pages = 0;
  let errorCategory = null;
  for (let page = 0; page < maxPages; page++) {
    let res;
    try {
      res = await pd.listPersons({ start, limit: 500 });
    } catch {
      errorCategory = 'crm_person_read_failed';
      break; // individual fallbacks do not establish full-sweep coverage
    }
    pages++;
    if (!Array.isArray(res.data)) { errorCategory = 'crm_person_page_invalid'; break; }
    for (const p of res.data) map.set(p.id, p);
    if (res.pagination?.more_items_in_collection === false) return { map, pages, endObserved: true, nextStart: null, errorCategory };
    if (res.pagination?.more_items_in_collection !== true || !Number.isInteger(res.pagination.next_start) || res.pagination.next_start <= start) {
      errorCategory = 'crm_person_cursor_invalid';
      break;
    }
    start = res.pagination.next_start;
  }
  return { map, pages, endObserved: false, nextStart: start, errorCategory: errorCategory || 'crm_person_page_cap' };
}

let running = false;

export async function syncLeadState(pool, { companyId = null, lifecycleEnabled = crmLifecycleEnabled(), maxLeadPages = MAX_PAGES, maxPersonPages = PERSON_MAX_PAGES } = {}) {
  if (running) return { skipped: "already_running" };
  running = true;
  const generation = randomUUID();
  const startedAt = new Date();
  const personCache = new Map();
  let scanned = 0;
  let upserted = 0;
  let personFetchFallbacks = 0;
  let linkWrites = 0;
  const byStatus = {};
  const byCrmStatus = {};
  let leadPages = 0;
  let leadEndObserved = false;
  let personFallbackFailed = false;
  let leadStatusInvalid = false;
  let leadErrorCategory = null;
  try {
    // Bulk-load persons up front (cheap); only fall back to getPerson for misses.
    const persons = await loadPersonMap(maxPersonPages);
    const personMap = persons.map;
    // Map owner_id → name (one cheap /users call) so we can show who owns each lead.
    const ownerMap = new Map();
    try {
      for (const u of await pd.listUsers()) ownerMap.set(u.id, u.name || u.email || null);
    } catch {
      /* non-fatal — fall back to no owner name */
    }
    let start = 0;
    for (let page = 0; page < maxLeadPages; page++) {
      let res;
      try { res = await pd.listLeads({ start, limit: 100 }); }
      catch { leadErrorCategory = 'crm_lead_read_failed'; break; }
      leadPages++;
      const { data: leads, pagination } = res;
      if (!Array.isArray(leads)) { leadErrorCategory = 'crm_lead_page_invalid'; break; }
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
        if (personId != null && !person) {
          // Do not clear prior-contact evidence after an unresolved person read.
          personFallbackFailed = true;
          continue;
        }
        const lastOutgoing = person?.last_outgoing_mail_time || null;
        const seqStarted = lead[F.SEQ] || null;
        const stage = lead[F.STAGE] || null;
        const orgId = lead.organization_id != null ? String(lead.organization_id) : null;
        const bidDate = lead[F.BID] || null;
        const startDate = lead[F.START] || null;
        const leadScore = lead[F.LEAD_SCORE] != null && lead[F.LEAD_SCORE] !== "" ? Number(lead[F.LEAD_SCORE]) : null;
        const projectValue =
          lead[F.PROJECT_VALUE] != null && lead[F.PROJECT_VALUE] !== "" ? Number(lead[F.PROJECT_VALUE]) : null;
        const triggerType = resolveTriggerType(lead, stage);
        const status = deriveStatus({ lastOutgoing, seqStarted });
        const ownerName = lead.owner_id != null ? ownerMap.get(lead.owner_id) || null : null;
        byStatus[status] = (byStatus[status] || 0) + 1;
        // /leads is an authorised not-archived listing. An omitted flag can
        // use that endpoint evidence; a malformed explicit flag cannot.
        const crmStatus = lead.is_archived === true ? 'archived'
          : lead.is_archived === false || lead.is_archived === undefined ? 'active' : 'unknown';
        if (crmStatus === 'unknown') leadStatusInvalid = true;
        byCrmStatus[crmStatus] = (byCrmStatus[crmStatus] || 0) + 1;

        const applied = await pool.query(
          `INSERT INTO sdr_lead_state (
             pipedrive_lead_id, pipedrive_person_id, person_name, person_email,
             last_outgoing_mail_time, email_messages_count, last_activity_date,
             lowbid_flag, sequence_started, project_stage, trigger_type, lead_title,
             outreach_status, bid_date, start_date, owner_name, lead_score, project_value,
             pipedrive_org_id, synced_at, crm_source_updated_at, crm_source_read_started_at, crm_person_source_updated_at, crm_person_source_read_started_at, crm_company_id${lifecycleEnabled ? ', crm_status, crm_sync_generation, crm_last_seen_at, crm_status_checked_at' : ''}
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),$20,$21,$22,$21,$23${lifecycleEnabled ? ', $24, $25, NOW(), NOW()' : ''})
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
             lead_score = EXCLUDED.lead_score,
             project_value = EXCLUDED.project_value,
             pipedrive_org_id = EXCLUDED.pipedrive_org_id,
             crm_company_id=COALESCE(sdr_lead_state.crm_company_id,EXCLUDED.crm_company_id),
             crm_source_updated_at=EXCLUDED.crm_source_updated_at,
             crm_source_read_started_at=EXCLUDED.crm_source_read_started_at,
             crm_person_source_updated_at=EXCLUDED.crm_person_source_updated_at,
             crm_person_source_read_started_at=EXCLUDED.crm_person_source_read_started_at,
             synced_at = NOW()${lifecycleEnabled ? ', crm_status=EXCLUDED.crm_status, crm_sync_generation=EXCLUDED.crm_sync_generation, crm_last_seen_at=NOW(), crm_status_checked_at=NOW()' : ''}
           WHERE (sdr_lead_state.crm_company_id IS NULL OR sdr_lead_state.crm_company_id=EXCLUDED.crm_company_id)
             AND (sdr_lead_state.crm_source_read_started_at IS NULL OR EXCLUDED.crm_source_read_started_at >= sdr_lead_state.crm_source_read_started_at)
             AND (sdr_lead_state.crm_source_updated_at IS NULL OR EXCLUDED.crm_source_updated_at >= sdr_lead_state.crm_source_updated_at)
             AND (sdr_lead_state.crm_person_source_read_started_at IS NULL OR EXCLUDED.crm_person_source_read_started_at >= sdr_lead_state.crm_person_source_read_started_at)
             AND (sdr_lead_state.pipedrive_person_id IS DISTINCT FROM EXCLUDED.pipedrive_person_id OR sdr_lead_state.crm_person_source_updated_at IS NULL OR EXCLUDED.crm_person_source_updated_at >= sdr_lead_state.crm_person_source_updated_at)`,
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
            leadScore,
            projectValue,
            orgId,
            sourceTimestamp(lead.update_time), startedAt, sourceTimestamp(person?.update_time), companyId == null ? null : String(companyId),
            ...(lifecycleEnabled ? [crmStatus, generation] : []),
          ],
        );
        if (applied.rowCount) upserted++;

        // Backfill the lead's interface "twin" deep-link (once, when actionable).
        // Gated, capped, and idempotent — see constants above. Non-fatal on error.
        if (
          INTERFACE_LINK_ENABLED &&
          crmStatus === 'active' &&
          linkWrites < INTERFACE_LINK_CAP &&
          !lead[F.INTERFACE_LINK] &&
          bidIsOpen(bidDate)
        ) {
          try {
            await pd.updateLead(lead.id, {
              [F.INTERFACE_LINK]: `${APP_BASE}/#/sdr?lead=${lead.id}`,
            });
            linkWrites++;
          } catch (e) {
            console.warn(`[interface-link] failed for lead ${lead.id}: ${e.message}`);
          }
        }
      }
      if (pagination?.more_items_in_collection === false) { leadEndObserved = true; break; }
      if (pagination?.more_items_in_collection !== true || !Number.isInteger(pagination.next_start) || pagination.next_start <= start) {
        leadErrorCategory = 'crm_lead_cursor_invalid';
        break;
      }
      start = pagination.next_start;
    }
    const coverage = leadEndObserved && persons.endObserved && !personFallbackFailed && !leadStatusInvalid ? 'complete' : 'partial';
    let missing = 0;
    if (lifecycleEnabled && coverage === 'complete') {
      const result = await pool.query(
        `UPDATE sdr_lead_state SET crm_status='missing', crm_status_checked_at=NOW()
         WHERE crm_status IN ('active','unknown')
           AND crm_sync_generation IS DISTINCT FROM $1::uuid
           AND (crm_status_checked_at IS NULL OR crm_status_checked_at <= $2)
           AND (crm_source_read_started_at IS NULL OR crm_source_read_started_at <= $2)
           AND (crm_person_source_read_started_at IS NULL OR crm_person_source_read_started_at <= $2)
           AND (crm_company_id IS NULL OR crm_company_id=$3)`, [generation, startedAt, companyId == null ? null : String(companyId)]);
      missing = result.rowCount || 0;
    }
    // Contacts-refresh email verification (lazy + cached; eligible leads only). Best-effort.
    try {
      const cap = Number(process.env.APOLLO_LOOKUP_CAP || 25);
      const limit = Number(process.env.VERIFY_PASS_LIMIT || 100);
      await runVerificationPass(pool, { cap, limit });
    } catch (e) {
      console.error("syncLeadState: verification pass failed", e.message);
    }
    const errorCategory = leadErrorCategory || (!leadEndObserved ? 'crm_lead_page_cap' : null) || persons.errorCategory || (personFallbackFailed ? 'crm_person_lookup_failed' : null) || (leadStatusInvalid ? 'crm_lead_status_invalid' : null);
    return {
      scanned, upserted, byStatus, byCrmStatus, personFetchFallbacks, linkWrites,
      coverage, generation, retired: missing, missing,
      endObserved: { leads: leadEndObserved, persons: persons.endObserved },
      pages: { leads: leadPages, persons: persons.pages },
      cursor: { leads: leadEndObserved ? null : start, persons: persons.nextStart },
      errorCategory,
      counts: { scanned, upserted, retired: missing, missing, personFetchFallbacks, linkWrites },
    };
  } finally {
    running = false;
  }
}
