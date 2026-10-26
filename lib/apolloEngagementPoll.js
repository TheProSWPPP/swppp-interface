// Poll Apollo replies/bounces with the existing record-only history guard. This read
// path uses the shared /emailer_messages/search endpoint budget and never assumes a
// request cap proves exhaustion. Durable progress and reporting facts are opt-in.
// Per-pass limits spread larger history sweeps across scheduled runs.
import * as apollo from "./apolloClient.js";
import * as budget from "./apolloMessageSearchBudget.js";
import { isPermitEngagementSyncEnabled, pollPermitEngagement } from "./permitEngagementSync.js";
import { shouldCloseBackfillWindow } from "./engagementSideEffectPolicy.js";
import { observeOutbound } from "./sdrReportingIngest.js";
import { sendAttribution } from "./apolloAttribution.js";
import { rememberSequenceDetail } from "./apolloSequenceDormancy.js";

let running = false;

// Only emit per-step "sent" events for follow-ups completed recently. The poll runs every
// ~15 min so fresh sends are always caught well within this window; the cutoff prevents the
// first poll after deploy from back-filling a Pipedrive activity for every historical
// follow-up (which would blast hundreds of activities onto Derek's leads at once).
const STEP_SENT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// ── Back-blast control: a PERSISTED first-observation watermark ──────────────────
// NOT an age guard. An earlier revision of this file guarded on message age (7 days, keyed
// on `m.completed_at || m.created_at`) and that was WRONG, twice over:
//
//   (a) Wrong field. On this endpoint the reply event and the send event carry the SAME
//       timestamp — measured 15/15 for replies and 2/2 for bounces, `occurred_at`
//       byte-identical. `completed_at` is when WE SENT, not when they answered. Apollo
//       exposes no reply-arrival time here at all.
//   (b) So the guard actually meant "an email we sent more than 7 days ago", which silences
//       real replies. Measured from Gmail, where true arrival times exist: 15 of 44 replies
//       (34%) land more than 7 days after first touch, max 14.98 days, and step 3 alone
//       lands a median 10.08 days after enrollment. 682 of 718 live send rows already have
//       their newest outbound older than 7 days — a genuine reply from any of them today
//       would have been silently dropped.
//
// The actual problem was never age, it was FIRST OBSERVATION. Until this ships the poll has
// only ever seen page 1 of each sequence, so the first correctly-paginated sweep discovers
// the entire history at once (live DB: 866 leads with an Apollo touch, only 132 with a
// recorded reply/bounce → up to 734 leads would take a back-blasted Pipedrive note).
//
// So: one bounded backfill sweep records everything it finds with
// process_status='backfilled' and fires NOTHING — no Pipedrive write, no sdr_sends
// mutation, no Apollo removal. When that sweep completes cleanly the watermark is stamped
// in `sdr_settings.engagement_backfill_done_at`, and every discovery after it behaves
// normally regardless of how old the message is. That kills the back-blast without
// silencing anything genuinely new.
//
// The watermark is a DB ROW, not module state, precisely so a redeploy cannot re-trigger
// the sweep and re-blast the pipeline.
const BACKFILL_SETTINGS_ID = 1;

// Short raw pages prove the end; request/time ceilings yield resumable PARTIAL work.
// Apollo exposes offset pages and no since/snapshot cursor on this endpoint.
//
// Time budget: no new Apollo read (or sequence) STARTS in the last WORK_RESERVE_MS of a
// pass, so the page already read can finish its DB writes and event posts. Event posts
// have their own EMIT_TIMEOUT_MS. They used to get "whatever is left of the pass", which
// near the end was 1 ms: on 2026-10-26 14:58Z five posts failed that way, the page was
// dropped and every later sequence was starved. A page takes ~4 s to store (100 facts,
// step updates, event posts), so 45 s fitted ~8 pages; the pass is now 90 s.
const MAX_REQUESTS_PER_PASS = 50;
const MAX_PASS_MS = 90_000;
const WORK_RESERVE_MS = 15_000;
const EMIT_TIMEOUT_MS = 10_000;
// Sequences with an enrollment in this window are polled.
const ACTIVE_SEQUENCE_DAYS = 45;
const MESSAGES_PER_PAGE = 100;
// Apollo documents a 50,000-record display ceiling. An empty page after the
// ceiling is truncation, not evidence that all retained history was observed.
const MAX_PROVIDER_MESSAGE_PAGE = 500;
// Full pagination every 3h; every other cycle reads page 1 only. Apollo's
// reply flags retain outbound timestamps, so late replies may remain on older
// pages. Shallow observations alone never prove complete reply coverage.
//
// This is expressed as an INTERVAL and persisted in sdr_settings, not as "every Nth cycle"
// against an in-memory counter. An in-memory counter reset to 0 on every boot, so
// `cycleNo === 1` forced a 31-call full scan on every single redeploy — and on a busy deploy
// day that is the difference between 600 and several thousand calls. Time-based + persisted
// preserves verified completion through restarts. A legacy partial-attempt throttle
// is process-local; restarting can retry that still-unverified deep read.
const FULL_SCAN_EVERY_N_CYCLES = 12;          // kept for documentation of the derivation
const POLL_CADENCE_MS = 15 * 60 * 1000;       // must match server.js's setInterval
const FULL_SCAN_INTERVAL_MS = FULL_SCAN_EVERY_N_CYCLES * POLL_CADENCE_MS; // = 3h

let cycleCount = 0; // in-process only, for logging.
// A partial opt-out deep attempt cannot advance the verified DB watermark.
// Throttle its retries locally while preserving 15-minute shallow observations.
// A restart may retry the deep read; it never invents durable completion.
let legacyDeepAttemptAt = null;
let legacySequenceOffset = 0;

/** Exported for tests/observability — no side effects. */
export function engagementPollBudget() {
  return { ...budget.snapshot(), cycleCount };
}

/** Test-only reset of module-level state (shared budget included). */
export function _resetEngagementPollState() {
  cycleCount = 0;
  legacyDeepAttemptAt = null;
  legacySequenceOffset = 0;
  budget._reset();
  running = false;
}

/**
 * Read the persisted poll state. Tolerates the columns not existing yet (a process running
 * older code against a newer DB, or the very first boot before ensureSchema has run).
 */
async function readPollState(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT engagement_backfill_done_at, engagement_last_full_scan_at
         FROM sdr_settings WHERE id = $1`,
      [BACKFILL_SETTINGS_ID],
    );
    return {
      backfillDoneAt: rows[0]?.engagement_backfill_done_at || null,
      lastFullScanAt: rows[0]?.engagement_last_full_scan_at || null,
    };
  } catch (e) {
    // Fail CLOSED: if we can't prove the backfill already happened, treat it as not done,
    // which suppresses side effects. Never fail open into a back-blast.
    console.error("[engagement-poll] poll state unavailable; assuming backfill pending");
    return { backfillDoneAt: null, lastFullScanAt: null, unreadable: true };
  }
}

// Reads are bounded even when the transport hangs. The client currently has no abort
// parameter; a timed-out read may finish later, but cannot persist or trigger actions.
async function readBeforeDeadline(work, deadline) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('time_budget'), { category: 'time_budget' })), Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

/** Advance only after the page has persisted. Short RAW pages alone prove exhaustion. */
export async function walkSequence({ sequenceId, cursor, budget: quota = budget, fetchPage,
  persistPage, perPage = MESSAGES_PER_PAGE, maxRequests = MAX_REQUESTS_PER_PASS,
  deadline = Date.now() + MAX_PASS_MS }) {
  let nextPage = cursor?.nextPage || 1;
  let pages = 0;
  const messages = [];
  const seen = new Set();
  const partial = (reason, extra = {}) => ({ sequenceId, messages, coverage: 'partial', endObserved: false, nextPage, pages, reason, ...extra });
  while (pages < maxRequests && Date.now() < deadline) {
    if (nextPage > MAX_PROVIDER_MESSAGE_PAGE) return partial('provider_display_limit');
    if (quota.isRateLimited()) return partial('apollo_429');
    if (quota.remaining() <= 0) return partial('budget_ceiling');
    let raw;
    try {
      quota.recordCall();
      const response = await readBeforeDeadline(() => fetchPage({ sequenceId, page: nextPage, perPage }), deadline);
      // Missing/malformed data must not be treated as an empty, successful final page.
      if (!Array.isArray(response?.emailer_messages)
        || response.emailer_messages.some((m) => !m || typeof m.id !== 'string' || !m.id)) return partial('invalid_page');
      raw = response.emailer_messages;
    } catch (error) {
      if (error.category === 'time_budget') return partial('time_budget');
      if (error.status === 429) return partial('apollo_429', { rateLimited: quota.noteRateLimit(error, 'engagement-poll') });
      return partial('provider_error');
    }
    const unique = raw.filter((m) => {
      if (seen.has(String(m.id))) return false;
      seen.add(String(m.id)); return true;
    });
    const endObserved = raw.length < perPage;
    try {
      if (persistPage) await persistPage(unique, { nextPage: endObserved ? null : nextPage + 1, endObserved, coverage: endObserved ? 'complete' : 'partial' }, { page: nextPage });
    } catch { return partial('persistence_failed'); }
    messages.push(...unique);
    pages++;
    if (endObserved) return { sequenceId, messages, coverage: 'complete', endObserved: true, nextPage: null, pages };
    nextPage++;
  }
  return partial(Date.now() >= deadline ? 'time_budget' : 'request_budget');
}

export function fullSweepComplete(results) {
  return results.length > 0 && results.every((r) => r.endObserved && r.coverage === 'complete');
}

// Enrollment receipts win; absent a receipt use the unique campaign/contact/time interval.
// Equal/overlapping enrollment times and missing provider timestamps remain ambiguous.
export function resolveMessageSend(message, sequenceId, sends) {
  const candidates = sends.filter((s) => String(s.apollo_sequence_id) === String(sequenceId)
    && String(s.apollo_contact_id) === String(message.contact_id));
  if (!candidates.length) return { status: 'unmatched' };
  // emailer_touch_id is NOT an enrollment: it is the step's template, shared by every
  // contact on that step (verified live 2026-10-26: 100 messages, 3 touch ids = the 3
  // steps). Treating it as a receipt stamped step 1's id on the send and made every later
  // step ambiguous (879 of 3,612 messages in a real pass). Only an explicit enrollment_id counts.
  const enrollment = message.enrollment_id;
  const receipts = candidates.filter((s) => (message.id && s.apollo_emailer_message_id === message.id)
    || (enrollment && s.apollo_enrollment_id && String(s.apollo_enrollment_id) === String(enrollment)));
  if (receipts.length === 1) return { status: 'verified', send: receipts[0], evidence: `send:${receipts[0].id}:provider_receipt` };
  if (receipts.length > 1) return { status: 'ambiguous' };
  const eventAt = Date.parse(message.created_at || message.completed_at);
  if (!Number.isFinite(eventAt)) return { status: 'ambiguous' };
  const eligible = candidates.filter((s) => Date.parse(s.sent_at) <= eventAt);
  const latest = Math.max(...eligible.map((s) => Date.parse(s.sent_at)));
  const matches = eligible.filter((s) => Date.parse(s.sent_at) === latest);
  if (matches.length !== 1 || (enrollment && matches[0].apollo_enrollment_id
    && String(matches[0].apollo_enrollment_id) !== String(enrollment))) return { status: 'ambiguous' };
  return { status: 'verified', send: matches[0], evidence: `send:${matches[0].id}:campaign_contact_time` };
}

/** Durable (resumable) polling is the default. SDR_APOLLO_RESUMABLE_ENABLED=false opts out. */
export function resumableEnabled(env = process.env) {
  return String(env.SDR_APOLLO_RESUMABLE_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

export async function pollEngagement(pool, options = {}) {
  if (running) return { skipped: 'already_running' };
  if (!process.env.APOLLO_API_KEY) return { skipped: 'no_apollo_key' };
  running = true;
  try {
    // The shared call ledger survives deploys: load it before the first budget decision.
    await budget.hydrate(pool);
    if (budget.isRateLimited()) return { skipped: 'rate_limited', retry_after_sec: budget.rateLimitedForSec(), ...budget.snapshot().lastLimitInfo };
    return await pollPass(pool, options);
  } finally {
    await budget.persist(pool);
    running = false;
  }
}

async function pollPass(pool, { baseUrl, callbackSecret, maxRequests = MAX_REQUESTS_PER_PASS, maxDurationMs = MAX_PASS_MS } = {}) {
  const cycle = ++cycleCount;
  let resumable = resumableEnabled();
  const reporting = process.env.SDR_REPORTING_INGEST_ENABLED === 'true';
  const deadline = Date.now() + maxDurationMs;
  // Nothing new starts after workDeadline; the reserve is for finishing the page in hand.
  const workDeadline = deadline - Math.min(WORK_RESERVE_MS, Math.floor(maxDurationMs / 3));
  const callsBefore = budget.callsInWindow();
  const callsLeft = () => Math.max(0, maxRequests - (budget.callsInWindow() - callsBefore));
  let scanned = 0, emitted = 0, backfilled = 0, emitFailures = 0, stepsUpdated = 0, ambiguous = 0, reportingObserved = 0, reportingFailures = 0, reportingLinked = 0;
  const byType = {};
  const skippedDormant = [];
  let freshnessReads = 0;
  let rateLimited = null;
  {
    const state = await readPollState(pool);
    let backfillMode = !state.backfillDoneAt;
    let historyVerified = !resumable;
    let cursor = { sequences: {} };
    let savedState = null;
    let reconciledSequences = {};
    if (resumable) {
      let pollRow = null;
      try {
        const { rows } = await pool.query("SELECT state,retry_at FROM sdr_apollo_poll_state WHERE scope='engagement'");
        pollRow = rows[0] || null;
      } catch {
        // No cursor table (migration not applied) or DB hiccup: run the legacy pass rather
        // than going blind. It is exactly the behaviour before durable polling existed.
        console.error('[engagement-poll] cursor unavailable; running legacy (non-resumable) pass');
        resumable = false; historyVerified = true;
      }
      if (resumable) {
        if (pollRow?.retry_at && new Date(pollRow.retry_at).getTime() > Date.now()) return { skipped: 'retry_pending', nextRetryAt: new Date(pollRow.retry_at).toISOString() };
        savedState = pollRow?.state || null;
        historyVerified = !!savedState?.historyVerified;
        reconciledSequences = { ...(savedState?.reconciledSequences || {}) };
        if (pollRow?.state && !pollRow.state.completedAt) cursor = pollRow.state;
      }
    }
    // Legacy full timestamps may have been stamped after the old page cap. Reconcile
    // the first opt-in sweep record-only; never let enabling resume replay sales actions.
    backfillMode ||= !historyVerified;
    const { rows: seqRows } = await pool.query(`SELECT DISTINCT apollo_sequence_id FROM sdr_sends
      WHERE apollo_sequence_id IS NOT NULL AND status IN ('enrolled','sent','replied')
        AND sent_at > $1::timestamptz`, [new Date(Date.now() - ACTIVE_SEQUENCE_DAYS * 86_400_000).toISOString()]);
    const wantFullScan = backfillMode || (resumable && seqRows.some((r) => !reconciledSequences[r.apollo_sequence_id])) || !!cursor.startedAt || Date.now() - (state.lastFullScanAt ? new Date(state.lastFullScanAt).getTime() : 0) >= FULL_SCAN_INTERVAL_MS;
    const fullScan = wantFullScan && (resumable || legacyDeepAttemptAt == null || Date.now() - legacyDeepAttemptAt >= FULL_SCAN_INTERVAL_MS);
    if (fullScan && !resumable) legacyDeepAttemptAt = Date.now();
    // The opt-out path retains the production watermark policy: scan depth does
    // not turn already-live reply handling back into permanent record-only mode.
    // Opt-in durable sweeps still reconcile unverified campaign history above.
    const tier = fullScan ? (backfillMode ? 'full(backfill)' : 'full') : 'shallow';
    if (fullScan) {
      cursor.startedAt ||= new Date().toISOString();
      cursor.historyVerified = historyVerified;
      cursor.reconciledSequences = reconciledSequences;
      // Switching an existing install from legacy to durable polling: the legacy pass read
      // page 1 of every polled sequence live every 15 minutes, so page 1 holds nothing a
      // live event could back-blast. Keep page 1 live for those sequences during the first
      // durable sweep; deeper, never-reconciled pages stay record-only.
      if (resumable && !savedState && state.backfillDoneAt) cursor.legacyLiveSequences = seqRows.map((r) => r.apollo_sequence_id);
      for (const row of seqRows) cursor.sequences[row.apollo_sequence_id] ||= { nextPage: 1, endObserved: false, coverage: 'partial' };
      for (const [sequenceId, entry] of Object.entries(cursor.sequences)) {
        if (resumable && !Number.isFinite(Date.parse(entry.firstObservedAt))) {
          const retained = savedState?.sequences?.[sequenceId]?.firstObservedAt;
          entry.firstObservedAt = Number.isFinite(Date.parse(retained)) ? retained : new Date().toISOString();
        }
      }
    }
    const legacyLive = new Set(Array.isArray(cursor.legacyLiveSequences) ? cursor.legacyLiveSequences : []);
    let sequenceIds = (fullScan ? Object.keys(cursor.sequences) : seqRows.map((r) => r.apollo_sequence_id)).sort();
    if (sequenceIds.length) {
      const offset = (resumable ? Number(cursor.sequenceOffset || 0) : legacySequenceOffset++) % sequenceIds.length;
      sequenceIds = [...sequenceIds.slice(offset), ...sequenceIds.slice(0, offset)];
      if (resumable && fullScan) cursor.sequenceOffset = (offset + 1) % sequenceIds.length;
    }
    const { rows: sends } = await pool.query('SELECT * FROM sdr_sends WHERE apollo_sequence_id = ANY($1::text[])', [sequenceIds]);
    const saveCursor = async (retryAt = null, queryPool = pool) => {
      if (resumable && (fullScan || retryAt)) await queryPool.query(`INSERT INTO sdr_apollo_poll_state(scope,state,retry_at)
        VALUES('engagement',$1::jsonb,$2) ON CONFLICT(scope) DO UPDATE
        SET state=EXCLUDED.state,retry_at=EXCLUDED.retry_at,updated_at=NOW()`, [JSON.stringify(fullScan ? cursor : savedState || { sequences: {}, reconciledSequences }), retryAt]);
    };
    // The boundary must exist durably before fresh-vs-historical decisions can
    // emit events. Old cursors without a boundary are upgraded conservatively.
    if (resumable && fullScan) {
      try { await saveCursor(); }
      catch { return { coverage: 'partial', errorCategory: 'cursor_persistence_failed', counts: {}, cursor }; }
    }
    const emit = async (event) => {
      try {
        const response = await fetch(`${baseUrl}/api/sdr/events/ingest?callback_secret=${encodeURIComponent(callbackSecret)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
          // Own timeout: never "whatever is left of the pass" (that reached 1 ms).
          signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
        });
        if (!response.ok) { emitFailures++; return; }
        emitted++; byType[event.type] = (byType[event.type] || 0) + 1;
        try { if ((await response.json())?.side_effect === 'backfill-recorded') backfilled++; } catch { /* optional receipt count */ }
      } catch { emitFailures++; }
    };
    // Events, reporting facts and step write-back for one page of one sequence.
    const processMessages = async (seqId, messages, { page, sequenceBackfillMode, totalSteps }) => {
      const failuresBefore = emitFailures;
      const reportingFailuresBefore = reportingFailures;
      const pageBackfillMode = sequenceBackfillMode && !(page === 1 && legacyLive.has(seqId));
      const aggregates = new Map();
      for (const m of messages) {
        scanned++;
        let mapping = resolveMessageSend(m, seqId, sends);
        const providerEnrollment = m.enrollment_id;
        if (resumable && providerEnrollment && mapping.status === 'verified') {
          const receipt = await pool.query(`UPDATE sdr_sends SET apollo_enrollment_id=$2
            WHERE id=$1 AND apollo_sequence_id=$3 AND apollo_contact_id=$4
              AND (apollo_enrollment_id IS NULL OR apollo_enrollment_id=$2)`,
          [mapping.send.id,String(providerEnrollment),seqId,m.contact_id]);
          if (receipt.rowCount !== 1) mapping = { status: 'ambiguous' };
          else mapping.send.apollo_enrollment_id = String(providerEnrollment);
        }
        if (mapping.status === 'ambiguous') ambiguous++;
        if (reporting && m.completed_at) {
          // A message matched to exactly one of our enrollments carries that project and
          // its source; ambiguous and unmatched messages are stored without a project.
          try {
            const attribution = mapping.status === 'verified'
              ? sendAttribution(mapping.send, mapping.evidence, seqId)
              : { leadLink: { status: mapping.status } };
            await observeOutbound(pool, { ...m, emailer_campaign_id: seqId }, attribution);
            reportingObserved++;
            if (mapping.status === 'verified') reportingLinked++;
          } catch { reportingFailures++; }
        }
        const firstObservedAt = Date.parse(cursor.sequences[seqId]?.firstObservedAt);
        const completedAt = Date.parse(m.completed_at);
        // A verified completed send after the persisted boundary cannot be a
        // replay of pre-existing sent history. This proves send provenance,
        // never reply-arrival time. Old sends/unknown timestamps stay guarded.
        const provenNewSend = resumable && !!state.backfillDoneAt && m.status === 'completed' && Number.isFinite(firstObservedAt)
          && Number.isFinite(completedAt) && completedAt > firstObservedAt && completedAt <= Date.now();
        const base = { sequence_id: seqId, email: m.to_email, emailer_message_id: m.id,
          // Outbound time only. Apollo flags do not establish inbound received time.
          created_at: m.completed_at || m.created_at, backfill: pageBackfillMode && !provenNewSend };
        if (m.replied) await emit({ ...base, type: 'email_replied', id: `poll:${m.id}:replied` });
        if (m.bounce) await emit({ ...base, type: 'email_bounced', id: `poll:${m.id}:bounced` });
        if (m.spam_blocked) await emit({ ...base, type: 'email_bounced', id: `poll:${m.id}:spam` });
        const pos = Number(m.campaign_position) || 0;
        if (m.status === 'completed' && m.completed_at && pos >= 2 && Date.parse(m.completed_at) > Date.now() - STEP_SENT_MAX_AGE_MS) {
          await emit({ ...base, type: 'email_sent', step: pos, id: `poll:${m.id}:sent` });
        }
        if (mapping.status !== 'verified') continue;
        const send = mapping.send;
        let a = aggregates.get(send.id);
        if (!a) { a = { send, doneMax: 0, nextAt: null, nextPos: null, completedAt: null, status: null }; aggregates.set(send.id, a); }
        // A failed/bounced attempt can also carry completed_at. Only Apollo's
        // completed status proves a completed outbound step.
        if (m.status === 'completed' && m.completed_at) {
          a.doneMax = Math.max(a.doneMax, pos);
          if (!a.completedAt || Date.parse(m.completed_at) > Date.parse(a.completedAt)) a.completedAt = m.completed_at;
        }
        if (m.status === 'scheduled' && m.due_at && (!a.nextAt || Date.parse(m.due_at) < Date.parse(a.nextAt))) { a.nextAt = m.due_at; a.nextPos = pos; }
        if (m.replied) a.status = 'replied';
        else if (m.bounce && a.status !== 'replied') a.status = 'bounced';
      }
      if (emitFailures > failuresBefore) throw new Error('emit_failed');
      for (const a of aggregates.values()) {
        if (a.nextPos && a.nextPos <= a.doneMax) a.nextAt = null;
        const status = a.status || (totalSteps && a.doneMax >= totalSteps ? 'completed' : a.doneMax ? 'sent' : a.nextAt ? 'scheduled' : null);
        const updated = await pool.query(`UPDATE sdr_sends SET
          current_step = CASE WHEN $1::int IS NULL THEN current_step ELSE GREATEST(COALESCE(current_step,0),$1) END,
          total_steps=COALESCE($2::int,total_steps),
          next_send_at=CASE WHEN status IN ('replied','bounced','unsubscribed','failed') OR step_status IN ('replied','bounced','unsubscribed','completed') OR $4 IN ('replied','bounced','completed') THEN NULL
            WHEN $3::timestamptz IS NOT NULL THEN CASE
              WHEN step_status='sent' AND current_step >= $10::int THEN next_send_at ELSE $3 END
            WHEN step_status='scheduled' AND $9::int >= current_step THEN NULL
            WHEN next_send_at <= $8::timestamptz THEN NULL ELSE next_send_at END,
          step_status=CASE WHEN status IN ('replied','bounced','unsubscribed','failed') THEN status
            WHEN step_status IN ('replied','bounced','unsubscribed','completed') THEN step_status
            WHEN step_status='sent' AND $4='scheduled' THEN step_status ELSE COALESCE($4,step_status) END,updated_at=NOW()
          WHERE id=$5 AND apollo_sequence_id=$6 AND apollo_contact_id=$7`,
        [a.doneMax || a.nextPos || null,totalSteps,a.nextAt,status,a.send.id,seqId,a.send.apollo_contact_id,a.completedAt,a.doneMax,a.nextPos]);
        stepsUpdated += updated.rowCount;
      }
      // Reporting must not interrupt legacy event/step work. Durable mode
      // retains a failed observation's page for retry after that work.
      if (resumable && reportingFailures > reportingFailuresBefore) throw new Error('reporting_persistence_failed');
    };
    const fetchPage = (seqId) => ({ page, perPage }) => apollo.searchEmailerMessages({ campaignIds: [seqId], page, perPage });
    const results = [];
    for (const [sequenceIndex, seqId] of sequenceIds.entries()) {
      const entry = fullScan ? cursor.sequences[seqId] : null;
      if (Date.now() >= workDeadline) {
        // Too close to the end of the pass to start another sequence. Its cursor is untouched.
        results.push(entry?.endObserved ? entry : { sequenceId: seqId, coverage: 'partial', endObserved: false, reason: 'time_budget' });
        continue;
      }
      const sequenceBackfillMode = backfillMode || (resumable && !reconciledSequences[seqId]);
      let totalSteps = null;
      let dormancy = { dormant: false };
      try {
        const detail = await readBeforeDeadline(() => apollo.getSequenceDetail(seqId), workDeadline);
        const steps = detail?.emailer_steps || detail?.emailer_campaign?.emailer_steps;
        if (Array.isArray(steps) && steps.length > 0 && steps.every((s) => s.id)) totalSteps = new Set(steps.map((s) => s.id)).size;
        dormancy = rememberSequenceDetail(seqId, detail);
      } catch { /* Preserve last verified configuration; never infer from message subsets. */ }
      // Finished/inactive sequences skip the 15-minute checks; full sweeps still read them.
      const skipCheap = dormancy.dormant;
      if (!fullScan && skipCheap) { skippedDormant.push(seqId); results.push({ sequenceId: seqId, coverage: 'partial', endObserved: false, reason: 'dormant' }); continue; }
      // A durable sweep spans several passes and resumes deep pages. Page 1 (newest) is
      // still checked every pass so a fresh reply never waits for the sweep to finish.
      if (fullScan && resumable && (entry.endObserved || entry.nextPage > 1) && !skipCheap && callsLeft() > 0) {
        freshnessReads++;
        const fresh = await walkSequence({ sequenceId: seqId, cursor: null, budget, maxRequests: 1, deadline: workDeadline,
          fetchPage: fetchPage(seqId), persistPage: (messages, progress, { page }) => processMessages(seqId, messages, { page, sequenceBackfillMode, totalSteps }) });
        if (fresh.rateLimited) rateLimited = fresh.rateLimited;
      }
      if (fullScan && entry.endObserved) { results.push(entry); continue; }
      const result = await walkSequence({ sequenceId: seqId,
        cursor: entry, budget,
        // Share the remaining pass budget among unread campaigns. A large early
        // campaign cannot consume every call before later page-1 checks run.
        maxRequests: fullScan ? Math.ceil(callsLeft()
          / Math.max(1, sequenceIds.slice(sequenceIndex).filter((id) => !cursor.sequences[id].endObserved).length))
          : Math.min(1, callsLeft()), deadline: workDeadline,
        fetchPage: fetchPage(seqId),
        persistPage: async (messages, progress, { page }) => {
          await processMessages(seqId, messages, { page, sequenceBackfillMode, totalSteps });
          if (fullScan) {
            const previous = cursor.sequences[seqId];
            const previouslyReconciled = reconciledSequences[seqId];
            if (progress.endObserved) reconciledSequences[seqId] = true;
            cursor.sequences[seqId] = { ...previous, ...progress, pages: (previous.pages || 0) + 1 };
            try { await saveCursor(); } catch (error) { cursor.sequences[seqId] = previous;
              if (!previouslyReconciled) delete reconciledSequences[seqId]; throw error; }
          }
        },
      });
      results.push(result);
      if (fullScan && result.coverage === 'partial') cursor.sequences[seqId] = {
        ...cursor.sequences[seqId], nextPage: result.nextPage, endObserved: false, coverage: 'partial', reason: result.reason,
      };
      if (result.rateLimited) rateLimited = result.rateLimited;
    }
    let persistencePassed = !state.unreadable && emitFailures === 0;
    let errorCategory = null;
    const nextRetryAt = rateLimited?.retry_at || null;
    try { await saveCursor(nextRetryAt); } catch { persistencePassed = false; errorCategory = 'cursor_persistence_failed'; }
    let coverage = fullScan && fullSweepComplete(results) && persistencePassed ? 'complete' : 'partial';
    let watermark = null;
    if (coverage === 'complete') {
      // Watermarks and the completed cursor commit together. Any write failure leaves
      // the prior watermark untouched and the saved end-observed cursor retryable.
      let client;
      try {
        client = resumable ? await pool.connect() : pool;
        if (resumable) await client.query('BEGIN');
        const { rows } = await client.query(`UPDATE sdr_settings SET engagement_last_full_scan_at=NOW(),
          engagement_backfill_done_at=CASE WHEN $2::boolean THEN COALESCE(engagement_backfill_done_at,NOW()) ELSE engagement_backfill_done_at END
          WHERE id=$1 RETURNING engagement_backfill_done_at,engagement_last_full_scan_at`,
        [BACKFILL_SETTINGS_ID,shouldCloseBackfillWindow({ backfillMode,emitFailures })]);
        if (!rows[0]) throw new Error('missing_settings');
        cursor.completedAt = new Date(rows[0].engagement_last_full_scan_at).toISOString();
        cursor.historyVerified = true;
        await saveCursor(null, client);
        if (resumable) await client.query('COMMIT');
        watermark = { backfill_done_at: rows[0].engagement_backfill_done_at, last_full_scan_at: rows[0].engagement_last_full_scan_at };
      } catch {
        if (resumable && client) await client.query('ROLLBACK');
        delete cursor.completedAt;
        cursor.historyVerified = historyVerified;
        cursor.reconciledSequences = reconciledSequences;
        coverage = 'partial'; errorCategory = 'watermark_persistence_failed';
      } finally { if (resumable && client) client.release(); }
    }
    let permit = null;
    if (rateLimited) permit = { skipped: rateLimited.reason };
    else if (isPermitEngagementSyncEnabled()) {
      try { permit = await pollPermitEngagement(pool); } catch { permit = { error: 'provider_error' }; }
    }
    return { cycle,tier,resumable,sequences: sequenceIds.length,scanned,emitted,emitFailures,backfillMode,backfilled,byType,stepsUpdated,
      ambiguous,reportingObserved,reportingLinked,reportingFailures,skippedDormant,freshnessReads,coverage: reportingFailures ? 'partial' : coverage,cursor,nextRetryAt,
      counts: { scanned,emitted,stepsUpdated,ambiguous,reportingObserved,reportingLinked,reportingFailures,skippedDormant: skippedDormant.length,freshnessReads },
      durationMs: Date.now() - (deadline - maxDurationMs),
      apolloCalls: budget.callsInWindow()-callsBefore,apolloCalls24h: budget.callsInWindow(),apolloCeiling: budget.DAILY_CALL_CEILING,
      ...(watermark ? { watermark } : {}),...(rateLimited ? { rateLimited } : {}),...(errorCategory ? { errorCategory } : {}),...(permit ? { permit } : {}) };
  }
}
