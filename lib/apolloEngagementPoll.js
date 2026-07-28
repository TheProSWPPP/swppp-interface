// Polls Apollo for per-lead REPLIES and BOUNCES on active sequences and feeds them
// into the existing /api/sdr/events/ingest pipeline (which dedups by event id and runs
// the reply→remove-from-sequence + Pipedrive-note side effects). Runs as a backend cron
// every ~15 min — NOT in n8n (would be thousands of executions/day).
//
// NOTE: Apollo's API exposes replies/bounces per message but NOT per-lead opens/clicks
// (those are aggregate-only on Basic, or require the Professional webhook). So this
// covers the high-value signals — replies especially (a reply = a hot lead).
//
// ── RATE-LIMIT DESIGN (measured live 2026-07-27) ──────────────────────────────────
// POST /api/v1/emailer_messages/search is capped PER ENDPOINT at 2000/day (also
// 400/hour, 200/minute). Verified response headers on the live key:
//   x-rate-limit-24-hour: 2000 | x-24-hour-usage: 2000 | x-24-hour-requests-left: 0
//   retry-after: 15733
// The old design (2-min cron × 4 sequences = 2,880 calls/day) was already 144% of the
// cap BEFORE UI traffic, so the bucket emptied ~16.7h into each window and reply polling
// went blind for ~7h/day. Correct pagination on that cadence would have been 31 pages ×
// 720 cycles = 22,320 calls/day (1,116% of cap).
//
// The fix has four parts, all in this file:
//   1. 15-min cadence (server.js) instead of 2 min.
//   2. Tiered scan: page 1 only on most cycles, full pagination every Nth.
//   3. A rolling 24h call budget with a hard ceiling below Apollo's cap.
//   4. A circuit breaker that honours `retry-after` on a 429 instead of hot-retrying.
// Arithmetic: 96 cycles/day; 88 shallow (4 calls each = 352) + 8 full (~31 pages + 4
// short-page terminators = ~48 each = 384) ≈ 736 calls/day = 37% of the 2000 cap.
//
// Reply detection is NOT the thing at risk here: Gmail is already the primary detector
// (lib/inboxReplyWatch.js, 5-min poll, DIFFERENT endpoint bucket) and caught 23 replies
// in the last 14 days vs Apollo's 10. What a slower Apollo cadence costs is spam_blocked
// detection and step-tracking write-back latency, both of which tolerate 15 min fine.
import * as apollo from "./apolloClient.js";
import { isPermitEngagementSyncEnabled, pollPermitEngagement } from "./permitEngagementSync.js";

let running = false;

// Only emit per-step "sent" events for follow-ups completed recently. The poll runs every
// ~15 min so fresh sends are always caught well within this window; the cutoff prevents the
// first poll after deploy from back-filling a Pipedrive activity for every historical
// follow-up (which would blast hundreds of activities onto Derek's leads at once).
const STEP_SENT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// ── Age guard (MUST ship with the pagination fix) ────────────────────────────────
// Same idea as STEP_SENT_MAX_AGE_MS above, extended to reply/bounce/spam. Until now the
// pagination bug hid this: the loop exited after page 1, so the poll only ever saw the
// newest ~100 messages per sequence. Fixing pagination means the FIRST correct pass walks
// the entire message history at once. Live DB, 2026-07-27: 866 leads carry an Apollo touch
// but only 132 have a recorded reply/bounce — so up to 734 leads would take a back-blasted
// "[Auto] REPLY received / BOUNCED" Pipedrive note in one shot. Dedup today is by event id
// only, and the event ids for those messages have never been inserted, so `newlyInserted`
// would be true for every one of them.
//
// So: DB inserts and Apollo sequence removal stay UNCONDITIONAL (both idempotent, both
// safe, and we want the history recorded). Only the Pipedrive addNote/addActivity/updateLead
// side effects are suppressed for events older than this window. Enforced here AND again in
// server.js's /api/sdr/events/ingest so any caller (webhook, manual replay) is protected.
const EVENT_SIDE_EFFECT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Pagination + tiering ─────────────────────────────────────────────────────────
// Apollo returns NO `pagination` object on /emailer_messages/search (verified live), which
// is exactly why `page >= (pg.total_pages || 1)` evaluated to `page >= 1` and broke out
// after page 1. Terminate on a SHORT PAGE (fewer rows than per_page = last page) or the
// hard cap, whichever comes first. There is deliberately no since-timestamp cursor: the
// endpoint does not support one — the request body is only {emailer_campaign_ids, page,
// per_page}. Measured real page counts: 14 + 10 + 6 + 1 = 31 pages for the 4 sequences.
const MAX_PAGES_PER_SEQUENCE = 25; // hard stop; measured max is 14
const MESSAGES_PER_PAGE = 100;
// Full pagination only every Nth cycle; every other cycle reads page 1 only (Apollo returns
// newest-first, so page 1 carries everything that changed in the last 15 minutes).
// N=12 at a 15-min cadence = a full history sweep every 3 hours.
const FULL_SCAN_EVERY_N_CYCLES = 12;

// ── Budget + circuit breaker ─────────────────────────────────────────────────────
// Ceiling deliberately below Apollo's 2000/day so UI traffic (/api/sdr/outbox, sequence
// editor) still has headroom. In-memory only: a process restart resets the ledger, which is
// safe in the conservative direction only if restarts are rare — the breaker below is the
// real backstop, since it reads Apollo's own retry-after.
const APOLLO_DAILY_CALL_CEILING = 1500;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

let cycleCount = 0;            // increments once per pollEngagement() invocation
let callLedger = [];           // ms timestamps of /emailer_messages/search calls
let rateLimitedUntilMs = 0;    // circuit breaker: set from `retry-after` on a 429

function recordCall() {
  const now = Date.now();
  callLedger.push(now);
  if (callLedger.length > 4000) callLedger = callLedger.filter((t) => now - t < ROLLING_WINDOW_MS);
}

function callsInWindow() {
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  callLedger = callLedger.filter((t) => t >= cutoff);
  return callLedger.length;
}

/** Exported for tests/observability — no side effects. */
export function engagementPollBudget() {
  return {
    callsLast24h: callsInWindow(),
    ceiling: APOLLO_DAILY_CALL_CEILING,
    cycleCount,
    rateLimitedUntil: rateLimitedUntilMs ? new Date(rateLimitedUntilMs).toISOString() : null,
    rateLimitedForSec: rateLimitedUntilMs > Date.now() ? Math.ceil((rateLimitedUntilMs - Date.now()) / 1000) : 0,
  };
}

/** Test-only reset of the module-level budget/breaker state. */
export function _resetEngagementPollState() {
  cycleCount = 0;
  callLedger = [];
  rateLimitedUntilMs = 0;
  running = false;
}

export async function pollEngagement(pool, { baseUrl, callbackSecret, force = false } = {}) {
  if (running && !force) return { skipped: "already_running" };
  if (!process.env.APOLLO_API_KEY) return { skipped: "no_apollo_key" };
  // Circuit breaker: Apollo told us exactly when the bucket refills. Retrying before then
  // just burns a 429 and (on some plans) extends the penalty. `force` does NOT override —
  // an admin clicking "poll now" cannot un-exhaust the bucket.
  if (Date.now() < rateLimitedUntilMs) {
    return {
      skipped: "rate_limited",
      retry_after_sec: Math.ceil((rateLimitedUntilMs - Date.now()) / 1000),
      retry_at: new Date(rateLimitedUntilMs).toISOString(),
    };
  }
  running = true;
  const cycleNo = ++cycleCount;
  let scanned = 0;
  let emitted = 0;
  let staleSkipped = 0;
  let callsThisCycle = 0;
  let rateLimited = null;
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
          // Ingest tells us whether it suppressed the Pipedrive side effects for age.
          // Counting them here makes the first correct-pagination run observable in the
          // cron log instead of silent.
          try {
            const body = await r.json();
            if (body?.side_effect === "stale-skipped") staleSkipped++;
          } catch { /* body parse is best-effort */ }
        }
      } catch {
        /* individual emit failure is non-fatal — next poll retries (idempotent) */
      }
    };

    // Age guard, applied to the reply / bounce / spam branches only. Keyed on the message's
    // own timestamp, not on when we happened to scan it. The flag rides along on the event;
    // ingest re-derives it independently from occurred_at so a caller that omits it is
    // still protected.
    const isStale = (m) => {
      const ts = Date.parse(m.completed_at || m.created_at || "");
      if (!Number.isFinite(ts)) return true; // no usable timestamp → treat as historical
      return ts < Date.now() - EVENT_SIDE_EFFECT_MAX_AGE_MS;
    };

    // Per-contact step aggregates (Apollo `campaign_position` = step number).
    // contactId → { steps:Set, doneMax, nextAt, nextPos, status }
    const stepAgg = new Map();
    const seqStepCount = new Map(); // seqId → Set of distinct step ids (total steps)

    // ── Tier decision ──
    // Cycle 1 (first run after boot) and every FULL_SCAN_EVERY_N_CYCLES-th cycle do the
    // full walk; the rest read page 1 only. Refuse a full walk if the rolling budget can't
    // absorb its worst case — degrade to a shallow cycle rather than blowing the cap.
    const used24h = callsInWindow();
    const wantFullScan = cycleNo === 1 || cycleNo % FULL_SCAN_EVERY_N_CYCLES === 0;
    const fullScanWorstCase = seqRows.length * MAX_PAGES_PER_SEQUENCE;
    const budgetOk = used24h + fullScanWorstCase <= APOLLO_DAILY_CALL_CEILING;
    const fullScan = wantFullScan && budgetOk;
    const tier = fullScan ? "full" : wantFullScan ? "shallow(budget)" : "shallow";
    const maxPages = fullScan ? MAX_PAGES_PER_SEQUENCE : 1;

    for (const { apollo_sequence_id: seqId } of seqRows) {
      if (rateLimited) break; // circuit breaker tripped mid-cycle — stop, don't hammer
      if (!seqStepCount.has(seqId)) seqStepCount.set(seqId, new Set());
      for (let page = 1; page <= maxPages; page++) {
        // Per-call budget backstop (covers shallow cycles and a mid-cycle overrun).
        if (callsInWindow() >= APOLLO_DAILY_CALL_CEILING) {
          console.warn(`[engagement-poll] rolling 24h budget ceiling ${APOLLO_DAILY_CALL_CEILING} reached — stopping cycle`);
          rateLimited = { reason: "budget_ceiling" };
          break;
        }
        let res;
        try {
          recordCall();
          callsThisCycle++;
          res = await apollo.searchEmailerMessages({ campaignIds: [seqId], page, perPage: MESSAGES_PER_PAGE });
        } catch (e) {
          if (e.status === 429) {
            // Apollo's own retry-after is authoritative. Open the breaker and abandon the
            // cycle — the previous behaviour (fall through, retry in 120s) is what kept the
            // daily bucket pinned at zero for ~7h a day.
            const waitSec = e.retryAfterSec || 15 * 60;
            rateLimitedUntilMs = Date.now() + waitSec * 1000;
            rateLimited = {
              reason: "apollo_429",
              retry_after_sec: waitSec,
              retry_at: new Date(rateLimitedUntilMs).toISOString(),
              ...(e.rateLimit || {}),
            };
            console.error(
              `[engagement-poll] Apollo 429 on /emailer_messages/search — breaker open for ${waitSec}s (until ${rateLimited.retry_at})`,
            );
            break;
          }
          console.error(`[engagement-poll] message search failed for ${seqId} p${page}:`, e.message);
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
          // `stale` carries the age verdict to ingest: it still inserts the row and still
          // pulls the contact out of the Apollo sequence, it just doesn't write to Pipedrive.
          const stale = isStale(m);
          if (m.replied) await emit({ ...base, stale, type: "email_replied", id: `poll:${m.id}:replied` });
          if (m.bounce) await emit({ ...base, stale, type: "email_bounced", id: `poll:${m.id}:bounced` });
          if (m.spam_blocked) await emit({ ...base, stale, type: "email_bounced", id: `poll:${m.id}:spam` });

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
        // Apollo sends no `pagination` block on this endpoint — the old
        // `page >= (pg.total_pages || 1)` was always `page >= 1`, so every sequence stopped
        // at page 1. A page shorter than per_page is the last page.
        if (msgs.length < MESSAGES_PER_PAGE) break;
      }
    }

    // Persist step tracking onto sdr_sends (matched by apollo_contact_id).
    let stepsUpdated = 0;
    for (const [cid, a] of stepAgg) {
      // total_steps is only trustworthy from a FULL walk — a page-1-only cycle sees a subset
      // of the distinct step ids and would otherwise shrink an already-correct value every
      // 15 min. COALESCE keeps the last full-scan figure on shallow cycles.
      const total = fullScan ? (seqStepCount.get(a.seqId)?.size || null) : null;
      // current step = highest completed position, or the next scheduled position if nothing sent yet.
      const current = a.doneMax || a.nextPos || null;
      try {
        const r = await pool.query(
          `UPDATE sdr_sends SET current_step = $1, total_steps = COALESCE($2, total_steps), next_send_at = $3, step_status = $4, updated_at = NOW()
           WHERE apollo_contact_id = $5`,
          [current, total, a.nextAt, a.lastStatus, cid],
        );
        stepsUpdated += r.rowCount;
      } catch (e) {
        console.error("[engagement-poll] step update failed:", e.message);
      }
    }

    // ── Permit channel (BORN DEAD: env flag PERMIT_ENGAGEMENT_SYNC, default OFF) ──
    // The query above enumerates sequences from `sdr_sends` ONLY, so the permit MSGP
    // sequence has never been polled — 590 permit_sends rows sat at 'enrolled' while Apollo
    // held 2 replies / 26 bounces / 5 spam-blocks for that sequence. This runs the permit
    // channel as a SEPARATE pass rather than adding the sequence to `seqRows` above, because
    // the loop above emits into /api/sdr/events/ingest and persists step tracking onto
    // `sdr_sends` by contact id — both of which are wrong shapes for a permit operator (no
    // Pipedrive lead, no sdr_sends row) and could cross-write an SDR row for a shared email.
    // With the flag unset this is a single string comparison and an immediate return.
    // Skipped when the breaker is open or the budget ceiling is hit: this pass paginates the
    // SAME /emailer_messages/search endpoint and would share (and re-blow) the same bucket.
    let permit = null;
    if (rateLimited) {
      permit = { skipped: rateLimited.reason };
    } else if (isPermitEngagementSyncEnabled()) {
      try {
        // No appBase passed on purpose: `baseUrl` here is the loopback the ingest callback
        // uses (http://127.0.0.1:<port>), which is useless in a Pipedrive task link. The
        // module falls back to PUBLIC_BASE_URL.
        permit = await pollPermitEngagement(pool);
      } catch (e) {
        console.error("[engagement-poll] permit sync failed:", e.message);
        permit = { error: e.message };
      }
    }

    return {
      cycle: cycleNo,
      tier,
      sequences: seqRows.length,
      scanned,
      emitted,
      staleSkipped,
      byType,
      stepsUpdated,
      apolloCalls: callsThisCycle,
      apolloCalls24h: callsInWindow(),
      apolloCeiling: APOLLO_DAILY_CALL_CEILING,
      ...(rateLimited ? { rateLimited } : {}),
      ...(permit ? { permit } : {}),
    };
  } finally {
    running = false;
  }
}
