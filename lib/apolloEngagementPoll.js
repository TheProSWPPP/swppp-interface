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
// The fix has four parts:
//   1. 15-min cadence (server.js) instead of 2 min.
//   2. Tiered scan: page 1 only on most cycles, full pagination every 3h.
//   3. A rolling 24h call budget with a ceiling below Apollo's cap
//      (lib/apolloMessageSearchBudget.js — SHARED with the outbox route and the permit sync,
//      because Apollo meters the endpoint, not the caller).
//   4. A circuit breaker that honours `retry-after` on a 429 instead of hot-retrying.
//
// STEADY-STATE ARITHMETIC (measured, not modelled — see the phase-2 gate):
//   96 cycles/day; 8 full × 31 pages = 248, 88 shallow × 4 seq = 352  →  600 calls/day.
//   Plus GET /api/sdr/outbox behind a 5-min cache: <=288/day.
//   Per-process worst case = 600 + 288 = 888/day = 44.4% of the 2000 cap.
//   (Ship day only, the one-time backfill sweep adds ~31 → ~631 poll calls / ~919 total.)
//
// Reply detection is NOT the thing at risk here: Gmail is already the primary detector
// (lib/inboxReplyWatch.js, 5-min poll, DIFFERENT endpoint bucket) and caught 23 replies
// in the last 14 days vs Apollo's 10. What a slower Apollo cadence costs is spam_blocked
// detection and step-tracking write-back latency, both of which tolerate 15 min fine.
import * as apollo from "./apolloClient.js";
import * as budget from "./apolloMessageSearchBudget.js";
import { isPermitEngagementSyncEnabled, pollPermitEngagement } from "./permitEngagementSync.js";

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

// ── Pagination + tiering ─────────────────────────────────────────────────────────
// Apollo returns NO `pagination` object on /emailer_messages/search (verified live), which
// is exactly why `page >= (pg.total_pages || 1)` evaluated to `page >= 1` and broke out
// after page 1. Terminate on a SHORT PAGE (fewer rows than per_page = last page) or the
// hard cap, whichever comes first. There is deliberately no since-timestamp cursor: the
// endpoint does not support one — the request body is only {emailer_campaign_ids, page,
// per_page}. Measured real page counts: 14 + 10 + 6 + 1 = 31 pages for the 4 sequences.
const MAX_PAGES_PER_SEQUENCE = 25; // hard stop; measured max is 14
const MESSAGES_PER_PAGE = 100;
// Full pagination every 3h; every other cycle reads page 1 only (Apollo returns newest-first,
// so page 1 carries everything that changed in the last 15 minutes).
//
// This is expressed as an INTERVAL and persisted in sdr_settings, not as "every Nth cycle"
// against an in-memory counter. An in-memory counter reset to 0 on every boot, so
// `cycleNo === 1` forced a 31-call full scan on every single redeploy — and on a busy deploy
// day that is the difference between 600 and several thousand calls. Time-based + persisted
// is restart-proof in both directions: a redeploy neither forces nor skips a sweep.
const FULL_SCAN_EVERY_N_CYCLES = 12;          // kept for documentation of the derivation
const POLL_CADENCE_MS = 15 * 60 * 1000;       // must match server.js's setInterval
const FULL_SCAN_INTERVAL_MS = FULL_SCAN_EVERY_N_CYCLES * POLL_CADENCE_MS; // = 3h

let cycleCount = 0; // in-process only, for logging. NOT used for tiering decisions.

/** Exported for tests/observability — no side effects. */
export function engagementPollBudget() {
  return { ...budget.snapshot(), cycleCount };
}

/** Test-only reset of module-level state (shared budget included). */
export function _resetEngagementPollState() {
  cycleCount = 0;
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
    console.error("[engagement-poll] could not read poll state, assuming backfill pending:", e.message);
    return { backfillDoneAt: null, lastFullScanAt: null, unreadable: true };
  }
}

export async function pollEngagement(pool, { baseUrl, callbackSecret, force = false } = {}) {
  if (running && !force) return { skipped: "already_running" };
  if (!process.env.APOLLO_API_KEY) return { skipped: "no_apollo_key" };
  // Circuit breaker: Apollo told us exactly when the bucket refills. Retrying before then
  // just burns a 429 and (on some plans) extends the penalty. `force` does NOT override —
  // an admin clicking "poll now" cannot un-exhaust the bucket. Shared with the outbox route
  // and the permit sync, so a 429 raised by ANY of the three stops all three.
  if (budget.isRateLimited()) {
    return { skipped: "rate_limited", retry_after_sec: budget.rateLimitedForSec(), ...budget.snapshot().lastLimitInfo };
  }
  running = true;
  const cycleNo = ++cycleCount;
  let scanned = 0;
  let emitted = 0;
  let backfilled = 0;
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
          // Ingest reports whether it recorded the event as backfill-only. Counting them
          // here makes the one-time sweep observable in the cron log instead of silent.
          try {
            const body = await r.json();
            if (body?.side_effect === "backfill-recorded") backfilled++;
          } catch { /* body parse is best-effort */ }
        }
      } catch {
        /* individual emit failure is non-fatal — next poll retries (idempotent) */
      }
    };

    // Per-contact step aggregates (Apollo `campaign_position` = step number).
    // contactId → { steps:Set, doneMax, nextAt, nextPos, status }
    const stepAgg = new Map();
    const seqStepCount = new Map(); // seqId → Set of distinct step ids (total steps)

    // ── Tier decision ──
    // A full walk happens when (a) the one-time backfill sweep still owes us a pass, or
    // (b) FULL_SCAN_INTERVAL_MS has elapsed since the last one. Both facts are read from
    // sdr_settings, so this survives a redeploy: no `cycleNo === 1` clause, and therefore no
    // forced 31-call sweep on every boot. Refuse a full walk if the shared budget can't
    // absorb its worst case — degrade to shallow rather than blow the cap.
    const state = await readPollState(pool);
    const backfillPending = !state.backfillDoneAt;
    const lastFullMs = state.lastFullScanAt ? new Date(state.lastFullScanAt).getTime() : 0;
    const fullScanDue = Date.now() - lastFullMs >= FULL_SCAN_INTERVAL_MS;

    const used24h = budget.callsInWindow();
    const wantFullScan = backfillPending || fullScanDue;
    const fullScanWorstCase = seqRows.length * MAX_PAGES_PER_SEQUENCE;
    const budgetOk = used24h + fullScanWorstCase <= budget.DAILY_CALL_CEILING;
    const fullScan = wantFullScan && budgetOk;
    const tier = fullScan ? (backfillPending ? "full(backfill)" : "full") : wantFullScan ? "shallow(budget)" : "shallow";
    const maxPages = fullScan ? MAX_PAGES_PER_SEQUENCE : 1;

    // While the watermark is unset EVERY discovery is recorded-only, including on a shallow
    // cycle — otherwise a budget-degraded cycle would fire side effects for history the
    // sweep hasn't reconciled yet.
    const backfillMode = backfillPending;

    for (const { apollo_sequence_id: seqId } of seqRows) {
      if (rateLimited) break; // circuit breaker tripped mid-cycle — stop, don't hammer
      if (!seqStepCount.has(seqId)) seqStepCount.set(seqId, new Set());
      for (let page = 1; page <= maxPages; page++) {
        // Per-call budget backstop (covers shallow cycles and a mid-cycle overrun).
        if (budget.callsInWindow() >= budget.DAILY_CALL_CEILING) {
          console.warn(`[engagement-poll] rolling 24h budget ceiling ${budget.DAILY_CALL_CEILING} reached — stopping cycle`);
          rateLimited = { reason: "budget_ceiling" };
          break;
        }
        let res;
        try {
          budget.recordCall();
          callsThisCycle++;
          res = await apollo.searchEmailerMessages({ campaignIds: [seqId], page, perPage: MESSAGES_PER_PAGE });
        } catch (e) {
          if (e.status === 429) {
            // Apollo's own retry-after is authoritative. Open the SHARED breaker and abandon
            // the cycle — the previous behaviour (fall through, retry in 120s) is what kept
            // the daily bucket pinned at zero for ~7h a day.
            rateLimited = budget.noteRateLimit(e, "engagement-poll");
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
            // NOTE: this is the SEND time, not the reply time. Apollo does not expose a
            // reply-arrival timestamp on this endpoint — the reply and the send carry the
            // same value (measured 15/15). Nothing may branch on its age; it is stored for
            // the record only.
            created_at: m.completed_at || m.created_at,
          };
          // Stable synthetic ids → re-polling is idempotent (ingest does ON CONFLICT DO NOTHING).
          // `backfill` tells ingest to RECORD ONLY: no Pipedrive write, no sdr_sends
          // mutation, no Apollo removal. Ingest re-derives it from the watermark too, so a
          // caller that omits the flag is still protected.
          if (m.replied) await emit({ ...base, backfill: backfillMode, type: "email_replied", id: `poll:${m.id}:replied` });
          if (m.bounce) await emit({ ...base, backfill: backfillMode, type: "email_bounced", id: `poll:${m.id}:bounced` });
          if (m.spam_blocked) await emit({ ...base, backfill: backfillMode, type: "email_bounced", id: `poll:${m.id}:spam` });

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

    // ── Watermark ──
    // Stamp ONLY after a full walk that completed cleanly: not rate-limited, not budget-
    // truncated, and it actually paginated. A partial sweep must not close the window, or the
    // pages it never reached would fire side effects as "new" on the next cycle — exactly the
    // back-blast this exists to prevent. `engagement_last_full_scan_at` drives the 3h tier,
    // `engagement_backfill_done_at` is set once and never cleared.
    let watermark = null;
    if (fullScan && !rateLimited) {
      try {
        const { rows: wm } = await pool.query(
          `UPDATE sdr_settings
              SET engagement_last_full_scan_at = NOW(),
                  engagement_backfill_done_at  = COALESCE(engagement_backfill_done_at, NOW())
            WHERE id = $1
        RETURNING engagement_backfill_done_at, engagement_last_full_scan_at`,
          [BACKFILL_SETTINGS_ID],
        );
        watermark = {
          backfill_done_at: wm[0]?.engagement_backfill_done_at || null,
          last_full_scan_at: wm[0]?.engagement_last_full_scan_at || null,
          ...(backfillMode ? { backfill_just_closed: true } : {}),
        };
        if (backfillMode) {
          console.log(
            `[engagement-poll] backfill sweep complete — ${backfilled} historical events recorded with ZERO side effects; watermark stamped, normal processing resumes next cycle`,
          );
        }
      } catch (e) {
        // Do NOT swallow into success: an unstamped watermark means the next cycle repeats
        // the sweep in backfill mode, which is the safe direction.
        console.error("[engagement-poll] watermark stamp failed (sweep will repeat):", e.message);
        watermark = { error: e.message };
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
      backfillMode,
      backfilled,
      ...(watermark ? { watermark } : {}),
      byType,
      stepsUpdated,
      apolloCalls: callsThisCycle,
      apolloCalls24h: budget.callsInWindow(),
      apolloCeiling: budget.DAILY_CALL_CEILING,
      ...(rateLimited ? { rateLimited } : {}),
      ...(permit ? { permit } : {}),
    };
  } finally {
    running = false;
  }
}
