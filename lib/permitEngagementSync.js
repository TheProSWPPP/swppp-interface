// Permit (TXR050000 / MSGP) engagement sync — the permit-channel twin of the SDR
// Apollo engagement poll.
//
// WHY THIS EXISTS
// ---------------
// `apolloEngagementPoll.pollEngagement()` enumerates sequences from `sdr_sends` only, so
// the permit MSGP sequence is never polled. Result (live-verified 2026-07-27): 590
// `permit_sends` rows all stuck at 'enrolled' while Apollo held 2 replies, 26 bounces and
// 5 spam-blocks for that same sequence. Two warm replies to a live campaign had no task
// anywhere. This module closes exactly that gap: poll the permit sequence, write
// reply/bounce/spam status back onto `permit_sends`, and raise ONE Pipedrive follow-up
// task per reply so a human actually works it.
//
// BORN DEAD. Nothing here runs unless `PERMIT_ENGAGEMENT_SYNC` is explicitly set to a
// truthy value. With the flag unset, `pollPermitEngagement()` returns `{skipped:'flag_off'}`
// before touching the DB, Apollo or Pipedrive — including before the CREATE TABLE, so the
// schema is not mutated either.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It does NOT call `apolloClient.removeContactsFromSequence()` on reply, unlike the SDR
// path. The permit sequence carries `mark_finished_if_reply: true` AND `num_steps: 1`
// (read live from Apollo), so there is no second step to suppress — an eject call would be
// a live mutation on a campaign running against a hard 2026-08-13 permit deadline, buying
// nothing. If a follow-up step is ever added to that sequence, add the eject here (one
// call, mirroring server.js's reply branch) and re-verify.
//
// PIPEDRIVE ANCHORING — read this before assuming a lead exists
// -------------------------------------------------------------
// Permit operators are NOT Pipedrive-shaped. `lib/permitDrafts.js:2` says so, and it is
// live-true: both replying operators (g.calderon@cityofalpine.com,
// hhughes@zackburkettco.com) return ZERO hits from Pipedrive `/persons/search` on exact
// email. There is no lead, person, org or deal to hang a task on. So:
//   1. We try an exact-email person lookup. If a person happens to exist, the activity is
//      linked to them (best case, gives Derek context in the CRM).
//   2. Otherwise we create a STANDALONE Pipedrive activity (no lead/person/org) assigned
//      to the mailbox owner that sent the email. Pipedrive supports unlinked activities;
//      it lands on that user's task list, which is the thing Derek actually reads.
//   3. We never create a Pipedrive person/lead/org for a permit operator. Inventing CRM
//      records for a cold permit list would pollute the SDR pipeline.
// The durable, always-present record is the DB side: `permit_sends.status`, a
// `permit_outreach` 'replied' row (so the operator drawer's timeline shows it), and the
// `permit_engagement_events` ledger. If Pipedrive is down or rejects the write, the DB
// flag still lands and the ledger row stays `task_status='pending'` for the next run.
import * as apollo from "./apolloClient.js";
import * as budget from "./apolloMessageSearchBudget.js";
import * as pipedrive from "./pipedriveClient.js";

// ── Constants ────────────────────────────────────────────────────────────────
// Sequence discovery is DB-derived (permit_msgp_template + distinct permit_sends). This
// constant is a last-resort fallback only, used when both queries come back empty.
export const PERMIT_SEQUENCE_FALLBACK = "6a32587c8a5c33001c728b9f";
// Hard blast guard: a matcher bug must never dump a task list on Derek. Live population is
// 2 replies ever, so 10 is ~5x headroom and still obviously safe.
export const MAX_TASKS_PER_RUN = 10;
// Apollo /emailer_messages/search returns NO pagination object (verified live 2026-07-27),
// so termination is "a short page ends it", with a hard page ceiling.
const PER_PAGE = 100;
const MAX_PAGES = 40;
// Marker scan depth over the assignee's open activities (100/page).
const MARKER_SCAN_MAX_PAGES = 5;
// Fallback assignee when the sending mailbox has no pipedrive_sender_id (Derek Chinners).
const DEREK_PD_USER_ID = 19499202;
// Dedup marker, mirroring the `[auto] GC award unresolved` pattern at
// n8n-workflows/CMD Per-Lead Processor.workflow.ts:1062 — check for the marker BEFORE
// creating, so a re-poll can never raise a second task for the same reply.
export const TASK_MARKER = "[auto] Permit reply";
const PD_BASE = "https://api.pipedrive.com/v1";

/** The born-dead gate. Everything in this module is downstream of this returning true. */
export function isPermitEngagementSyncEnabled() {
  const v = String(process.env.PERMIT_ENGAGEMENT_SYNC || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ── Pipedrive read helpers (GET only) ────────────────────────────────────────
// pipedriveClient.js does not expose person-search or a user-scoped activity list and is
// owned by another workstream this run, so the two read calls live here.
async function pdGet(path, query = {}) {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) throw new Error("PIPEDRIVE_API_TOKEN not set");
  const url = new URL(`${PD_BASE}${path}`);
  url.searchParams.set("api_token", token);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(`Pipedrive GET ${path} → ${res.status}: ${data?.error || "unknown"}`);
  }
  return data;
}

/** Exact-email person lookup. Returns a person id or null. Permit operators usually miss. */
async function findPersonIdByEmail(email) {
  if (!email) return null;
  const data = await pdGet("/persons/search", { term: email, fields: "email", exact_match: true, limit: 5 });
  const items = data?.data?.items || [];
  return items[0]?.item?.id || null;
}

/**
 * Marker check — the dedup gate. Scans the assignee's OPEN activities for a subject
 * containing `[auto] Permit reply · <operator_key>`. Same shape as the CMD processor's
 * note-marker check: read first, only write if the marker is absent.
 */
async function findMarkerActivityId(userId, operatorKey) {
  const needle = `${TASK_MARKER} · ${operatorKey}`;
  for (let page = 0; page < MARKER_SCAN_MAX_PAGES; page++) {
    const data = await pdGet("/activities", { user_id: userId, done: 0, limit: 100, start: page * 100 });
    const rows = data?.data || [];
    for (const r of rows) if ((r.subject || "").includes(needle)) return r.id;
    if (!data?.additional_data?.pagination?.more_items_in_collection) break;
  }
  return null;
}

// ── Schema ───────────────────────────────────────────────────────────────────
/**
 * Ledger of every permit engagement signal we have acted on. `apollo_event_id` UNIQUE is
 * the primary dedup: re-polling the same Apollo message re-derives the same id, the insert
 * no-ops, and every side effect is gated on the insert having actually happened. Mirrors
 * `sdr_engagement_events`, plus a task_status so a Pipedrive failure is retryable rather
 * than silently lost (the SDR path loses those).
 * Only ever called after the flag gate.
 */
export async function ensurePermitEngagementSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS permit_engagement_events (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      apollo_event_id           TEXT NOT NULL UNIQUE,
      event_type                TEXT NOT NULL,
      apollo_sequence_id        TEXT,
      apollo_emailer_message_id TEXT,
      apollo_contact_id         TEXT,
      permit_send_id            UUID,
      operator_key              TEXT,
      contact_email             TEXT,
      mailbox_email             TEXT,
      occurred_at               TIMESTAMPTZ,
      task_status               TEXT NOT NULL DEFAULT 'none'
                                  CHECK (task_status IN ('none','pending','created','skipped_duplicate','failed')),
      pipedrive_activity_id     BIGINT,
      payload                   JSONB,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_permit_eng_events_opkey ON permit_engagement_events(operator_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_permit_eng_events_task ON permit_engagement_events(task_status)`);
}

// ── Sequence discovery ───────────────────────────────────────────────────────
/** DB-derived permit sequences. Constant fallback only if the DB knows nothing. */
export async function permitSequenceIds(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT seq FROM (
        SELECT apollo_sequence_id AS seq FROM permit_msgp_template WHERE apollo_sequence_id IS NOT NULL
        UNION
        SELECT DISTINCT apollo_sequence_id FROM permit_sends
         WHERE apollo_sequence_id IS NOT NULL
           AND status IN ('enrolled','sent','replied')
           AND sent_at > NOW() - INTERVAL '180 days'
     ) t WHERE seq IS NOT NULL AND seq <> ''`,
  );
  const ids = rows.map((r) => r.seq);
  return ids.length ? ids : [PERMIT_SEQUENCE_FALLBACK];
}

// ── Apollo message pull ──────────────────────────────────────────────────────
/**
 * Page every message on a sequence. NOTE: Apollo's /emailer_messages/search response has
 * NO `pagination` key for this endpoint (verified live 2026-07-27) — so we terminate on a
 * short page and de-dup by message id rather than trusting `total_pages`.
 */
async function fetchSequenceMessages(seqId, log) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    // Shared endpoint budget: this paginates the SAME /emailer_messages/search route as the
    // SDR engagement poll and GET /api/sdr/outbox, and Apollo meters the route, not the
    // caller. Before this these pages were invisible to the ledger and a 429 raised here
    // left the cron calling happily into an empty bucket.
    if (budget.isRateLimited()) {
      log?.error?.(`[permit-engagement] breaker open (${budget.rateLimitedForSec()}s) — stopping at ${seqId} p${page}`);
      break;
    }
    if (budget.callsInWindow() >= budget.DAILY_CALL_CEILING) {
      log?.error?.(`[permit-engagement] shared budget ceiling ${budget.DAILY_CALL_CEILING} reached — stopping at ${seqId} p${page}`);
      break;
    }
    let res;
    try {
      budget.recordCall();
      res = await apollo.searchEmailerMessages({ campaignIds: [seqId], page, perPage: PER_PAGE });
    } catch (e) {
      if (e.status === 429) budget.noteRateLimit(e, "permit-engagement");
      log?.error?.(`[permit-engagement] message search failed for ${seqId} p${page}: ${e.message}`);
      break;
    }
    const msgs = res.emailer_messages || [];
    for (const m of msgs) {
      if (m?.id && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    if (msgs.length < PER_PAGE) break;
  }
  return out;
}

/** One Apollo message → 0..2 engagement signals, mirroring the SDR poll's event shapes. */
function signalsFor(m) {
  const sigs = [];
  if (m.replied) sigs.push({ kind: "replied", eventType: "email_replied", sendStatus: "replied", suffix: "replied" });
  if (m.bounce) sigs.push({ kind: "bounced", eventType: "email_bounced", sendStatus: "bounced", suffix: "bounced" });
  if (m.spam_blocked) sigs.push({ kind: "spam", eventType: "email_spam_blocked", sendStatus: "bounced", suffix: "spam" });
  return sigs;
}

// ── Main ─────────────────────────────────────────────────────────────────────
/**
 * @param {import('pg').Pool} pool
 * @param {object} opts
 * @param {object} [opts.db]      query-able (pool or a client); the dry-run harness passes a
 *                                client inside a transaction it then ROLLBACKs.
 * @param {boolean} [opts.dryRun] enumerate intended Pipedrive writes instead of performing
 *                                them. DB writes still run against `opts.db`.
 * @param {object} [opts.log]
 */
export async function pollPermitEngagement(pool, { db = pool, dryRun = false, log = console, appBase } = {}) {
  // ── BORN-DEAD GATE. Nothing below runs with the flag unset. ──
  if (!isPermitEngagementSyncEnabled()) return { skipped: "flag_off" };
  if (!process.env.APOLLO_API_KEY) return { skipped: "no_apollo_key" };

  const base = appBase || process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app";
  await ensurePermitEngagementSchema(db);

  const seqIds = await permitSequenceIds(db);
  const stats = {
    dryRun,
    sequences: seqIds,
    scanned: 0,
    signals: 0,
    ledgerInserted: 0,
    ledgerDuplicate: 0,
    unmatched: 0,
    sendStatusUpdated: 0,
    outreachInserted: 0,
    tasksCreated: 0,
    tasksSkippedDuplicate: 0,
    tasksFailed: 0,
    capHit: false,
    intents: [],
    errors: [],
  };

  // 1. Pull every message on every permit sequence.
  const messages = [];
  for (const seqId of seqIds) {
    const msgs = await fetchSequenceMessages(seqId, log);
    for (const m of msgs) messages.push({ ...m, _seqId: seqId });
  }
  stats.scanned = messages.length;

  const flagged = messages.filter((m) => m.replied || m.bounce || m.spam_blocked);
  if (!flagged.length) return stats;

  // 2. Match Apollo contacts → permit_sends. Primary key is apollo_contact_id (the same
  //    column sendPermitToOperator writes at permitDrafts.js:568). Email fallback goes
  //    through permit_operator_email because permit_sends carries no email column.
  const contactIds = [...new Set(flagged.map((m) => m.contact_id).filter(Boolean))];
  const emails = [...new Set(flagged.map((m) => (m.to_email || "").toLowerCase()).filter(Boolean))];

  const { rows: byCidRows } = await db.query(
    `SELECT id, operator_key, apollo_contact_id, apollo_sequence_id, mailbox_id, status, sent_at
       FROM permit_sends WHERE apollo_contact_id = ANY($1::text[])`,
    [contactIds],
  );
  const byCid = new Map();
  for (const r of byCidRows) {
    const prev = byCid.get(r.apollo_contact_id);
    if (!prev || new Date(r.sent_at) > new Date(prev.sent_at)) byCid.set(r.apollo_contact_id, r);
  }

  const { rows: byEmailRows } = await db.query(
    `SELECT ps.id, ps.operator_key, ps.apollo_contact_id, ps.apollo_sequence_id, ps.mailbox_id,
            ps.status, ps.sent_at, lower(e.email) AS email
       FROM permit_operator_email e
       JOIN permit_sends ps ON ps.operator_key = e.operator_key
      WHERE lower(e.email) = ANY($1::text[])`,
    [emails],
  );
  const byEmail = new Map();
  for (const r of byEmailRows) {
    const prev = byEmail.get(r.email);
    if (!prev || new Date(r.sent_at) > new Date(prev.sent_at)) byEmail.set(r.email, r);
  }

  const { rows: mbRows } = await db.query(
    `SELECT id, email, pipedrive_sender_id, apollo_mailbox_id FROM sdr_mailboxes`,
  );
  const mbById = new Map(mbRows.map((r) => [r.id, r]));
  const mbByApollo = new Map(mbRows.filter((r) => r.apollo_mailbox_id).map((r) => [r.apollo_mailbox_id, r]));

  const opKeys = [...new Set([...byCid.values(), ...byEmail.values()].map((r) => r.operator_key).filter(Boolean))];
  const { rows: opRows } = await db.query(
    `SELECT operator_key, max(operator_name) AS operator_name, max(contact_name) AS contact_name
       FROM permit_operator_email WHERE operator_key = ANY($1::text[]) GROUP BY operator_key`,
    [opKeys],
  );
  const opByKey = new Map(opRows.map((r) => [r.operator_key, r]));

  // 3. Process each signal. Order matters: reply-shaped signals first so the task budget is
  //    never eaten by a bounce backlog.
  const work = [];
  for (const m of flagged) {
    for (const sig of signalsFor(m)) work.push({ m, sig });
  }
  const rank = (w) => (w.sig.kind === "replied" ? 0 : 1);
  work.sort((a, b) => rank(a) - rank(b));
  stats.signals = work.length;

  for (const { m, sig } of work) {
    const send = byCid.get(m.contact_id) || byEmail.get((m.to_email || "").toLowerCase()) || null;
    if (!send) {
      stats.unmatched++;
      stats.intents.push({ action: "unmatched", kind: sig.kind, contact_id: m.contact_id, email: m.to_email });
      continue;
    }
    const mailbox = (send.mailbox_id && mbById.get(send.mailbox_id)) || mbByApollo.get(m.email_account_id) || null;
    const op = opByKey.get(send.operator_key) || {};
    const eventId = `permit-poll:${m.id}:${sig.suffix}`;
    const occurredAt = m.completed_at || m.created_at || new Date().toISOString();
    const wantsTask = sig.kind === "replied";

    // 3a. Ledger insert — the dedup of record.
    let ledgerId = null;
    let newlyInserted = false;
    try {
      const ins = await db.query(
        `INSERT INTO permit_engagement_events (
           apollo_event_id, event_type, apollo_sequence_id, apollo_emailer_message_id,
           apollo_contact_id, permit_send_id, operator_key, contact_email, mailbox_email,
           occurred_at, task_status, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (apollo_event_id) DO NOTHING
         RETURNING id`,
        [
          eventId, sig.eventType, m._seqId, m.id, m.contact_id, send.id, send.operator_key,
          m.to_email || null, mailbox?.email || null, occurredAt,
          wantsTask ? "pending" : "none",
          JSON.stringify({ reply_class: m.reply_class ?? null, status: m.status ?? null, campaign_position: m.campaign_position ?? null }),
        ],
      );
      newlyInserted = ins.rows.length > 0;
      ledgerId = ins.rows[0]?.id || null;
    } catch (e) {
      stats.errors.push({ eventId, step: "ledger", msg: e.message });
      continue;
    }

    if (!newlyInserted) {
      stats.ledgerDuplicate++;
      // Retry ONLY a task whose creation previously failed mid-flight. Everything else is a
      // genuine no-op, which is what makes a re-poll safe.
      if (!wantsTask) continue;
      const { rows: prior } = await db.query(
        `SELECT id, task_status FROM permit_engagement_events WHERE apollo_event_id = $1`,
        [eventId],
      );
      if (prior[0]?.task_status !== "pending") continue;
      ledgerId = prior[0].id;
    } else {
      stats.ledgerInserted++;

      // 3b. Status write-back onto permit_sends. Terminal states are never downgraded.
      const upd = await db.query(
        `UPDATE permit_sends SET status = $2
          WHERE id = $1 AND status IN ('enrolled','sent') AND status <> $2`,
        [send.id, sig.sendStatus],
      );
      stats.sendStatusUpdated += upd.rowCount;
      if (upd.rowCount) {
        stats.intents.push({ action: "permit_sends.status", kind: sig.kind, operator_key: send.operator_key, send_id: send.id, to: sig.sendStatus });
      }

      // 3c. Reply → a permit_outreach 'replied' row so the operator drawer timeline shows
      //     it. Guarded so repeated replies from one operator log once.
      if (wantsTask) {
        const outr = await db.query(
          `INSERT INTO permit_outreach (operator_key, channel, status, note)
           SELECT $1, 'email', 'replied', $2
            WHERE NOT EXISTS (SELECT 1 FROM permit_outreach WHERE operator_key = $1 AND status = 'replied')
           RETURNING id`,
          [send.operator_key, `auto: reply from ${m.to_email || "operator"}${mailbox?.email ? ` to ${mailbox.email}` : ""}`],
        );
        stats.outreachInserted += outr.rowCount;
        if (outr.rowCount) {
          stats.intents.push({ action: "permit_outreach.replied", operator_key: send.operator_key });
        }
      }
    }

    if (!wantsTask) continue;

    // 3d. Pipedrive follow-up task, marker-deduped.
    if (stats.tasksCreated + stats.tasksSkippedDuplicate >= MAX_TASKS_PER_RUN) {
      stats.capHit = true;
      continue;
    }
    const userId = mailbox?.pipedrive_sender_id || DEREK_PD_USER_ID;
    const operatorName = op.operator_name || send.operator_key;
    const subject = `${TASK_MARKER} · ${send.operator_key} — follow up (${operatorName})`;
    const note =
      `Permit (MSGP/TXR050000) operator replied to outreach.\n` +
      `Operator: ${operatorName}\nContact: ${op.contact_name || "—"} <${m.to_email || "?"}>\n` +
      `Replied to: ${mailbox?.email || "permit mailbox"}${m.reply_class ? `\nApollo reply class: ${m.reply_class}` : ""}\n` +
      `Open the Permits tab: ${base}/#/sdr  (operator key: ${send.operator_key})`;

    try {
      if (!process.env.PIPEDRIVE_API_TOKEN) throw new Error("PIPEDRIVE_API_TOKEN not set");
      // Marker check BEFORE create — mirrors `[auto] GC award unresolved`
      // (n8n-workflows/CMD Per-Lead Processor.workflow.ts:1062).
      const existing = await findMarkerActivityId(userId, send.operator_key);
      if (existing) {
        stats.tasksSkippedDuplicate++;
        stats.intents.push({ action: "task_skipped_marker", operator_key: send.operator_key, existing_activity_id: existing });
        await db.query(
          `UPDATE permit_engagement_events SET task_status='skipped_duplicate', pipedrive_activity_id=$2, updated_at=NOW() WHERE id=$1`,
          [ledgerId, existing],
        );
        continue;
      }
      // Permit operators are not Pipedrive-shaped; a person hit is the exception, not the rule.
      const personId = await findPersonIdByEmail(m.to_email).catch(() => null);

      if (dryRun) {
        stats.tasksCreated++;
        stats.intents.push({
          action: "WOULD_CREATE_pipedrive_activity", operator_key: send.operator_key,
          anchor: personId ? `person:${personId}` : "standalone (no Pipedrive object exists for this operator)",
          user_id: userId, subject, note,
        });
        await db.query(
          `UPDATE permit_engagement_events SET task_status='created', updated_at=NOW() WHERE id=$1`,
          [ledgerId],
        );
        continue;
      }

      const act = await pipedrive.addActivity({
        personId: personId || undefined,
        subject,
        type: "task",
        done: false,
        userId,
        note,
      });
      stats.tasksCreated++;
      stats.intents.push({ action: "created_pipedrive_activity", operator_key: send.operator_key, activity_id: act?.id, anchor: personId ? `person:${personId}` : "standalone" });
      await db.query(
        `UPDATE permit_engagement_events SET task_status='created', pipedrive_activity_id=$2, updated_at=NOW() WHERE id=$1`,
        [ledgerId, act?.id || null],
      );
    } catch (e) {
      stats.tasksFailed++;
      stats.errors.push({ eventId, step: "pipedrive_task", msg: e.message });
      // Stays 'pending' → the next poll retries this one task and nothing else.
      await db.query(
        `UPDATE permit_engagement_events SET task_status='pending', updated_at=NOW() WHERE id=$1`,
        [ledgerId],
      );
    }
  }

  return stats;
}
