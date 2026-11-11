# SDR reliability implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task when execution is requested. Steps use checkbox syntax. No production fix was made in the planning turn.

**Goal:** Make CRM state current, provider polling complete, reply actions recoverable and enrollment refusals visible, then repair the measured CMD failure path without increasing unintended buyer contact.

**Architecture:** Keep the current app and workflows; add durable execution/action state and focused guards. Reconcile complete snapshots conservatively, bind sequence state to campaign/enrollment identity and retry downstream actions independently. Use provider receipts and real data changes to verify work.

**Tech Stack:** Node ESM, PostgreSQL, Apollo/Gmail/Pipedrive, Vitest and n8n-as-code under the full client protocol.

**Spec:** `../specs/2026-10-02-sdr-growth-dashboard-design.md`

## Global constraints

- No new visible Pipedrive custom fields; retain historical rows.
- Existing customer, invalid-address, reply, unsubscribe, active-membership and cooldown protection stays intact.
- Both current `.co` and `.com` lanes remain individually identified; review current rules before changing either.
- Partial sync cannot retire unseen CRM records.
- Reporting/history import has zero sales-side effects; action repair is separately scoped.
- No automatic replay of all historical replies or failed drafts.
- Read the complete canonical n8n protocol before workflow work; target Derek's registered cloud instance.
- Back up before migrations/live changes; verify the next natural scheduled cycle and business side effects.

## Review focus

1. CRM paging failure or missing permission must leave unseen records unknown/current, not falsely archived: Task 2.
2. A genuine reply from an alias with two projects must stop the correct outreach and enter review if ambiguous: Task 4.
3. Forwarding succeeds and CRM fails: retry only CRM, never forward twice: Task 4.
4. Provider page caps/budget/errors cannot stamp a complete full scan: Task 3.
5. Retry of an old draft must recheck changed project/customer/contact state before contacting: Task 5.

## File map

| Existing/new file | Responsibility |
|---|---|
| `lib/sdrJobRuns.js` + `lib/__tests__/sdrJobRuns.test.js` | Durable job starts/completion/partial/error metadata |
| `lib/pipedriveSync.js` + `lib/__tests__/pipedriveSyncRetirement.test.js` | Complete generations and CRM lifecycle status |
| `lib/sdrCrmGuard.js` + test | Live send-time lead eligibility |
| `lib/apolloEngagementPoll.js` + `lib/__tests__/apolloEngagementPagination.test.js` | Complete paged scans and enrollment-scoped step updates |
| `lib/gmailInbox.js` | Paged message/thread result contract and cursor |
| `lib/inboxReplyWatch.js` | Detection, classification and action enqueue |
| `lib/sdrReplyActions.js` + `lib/__tests__/sdrReplyActions.test.js` | Durable independent actions and retries |
| `lib/sdrEnrollmentRetry.js` + `lib/__tests__/sdrEnrollmentRetry.test.js` | Retry category, persisted refusal and eligibility recheck |
| `lib/autoOutreach.js`, `server.js` | Integrate retry/job guards with existing business-hour loops |
| `migrations/2026-10-02-sdr-reliability.sql` | Lifecycle, refusal/action columns/tables |
| n8n workflow ID `QsTHSvl3LvkpznqW` | CMD Per-Lead Processor timeout investigation |
| n8n workflow ID `JIZMs2AQNHrRAsbt` | CMD Smart Refresh - Daily circuit/recovery |
| SDR cleanup workflow, resolve ID from live registry | Activity housekeeping vs provider completion |

## Task 1: app job observability

**Files:** Create job helper/test; use `sdr_job_runs` from the dashboard migration. Modify `server.js` existing sync, auto-outreach, poll and inbox loop wrappers.

**Interfaces:** `withJobRun(pool, { job, scope }, work) -> result`. The work result includes `coverage: 'complete'|'partial'`, counts, cursor and optional next retry. Export `safeErrorCategory(error)`, which never returns a raw header/body/token. Distinguish disabled, outside-hours and truly successful empty work.

- [ ] Write fixtures for a zero-item complete run, skipped business hours, partially paged read, API 429, failure and concurrent lock. Verify status/finish time is persisted on every exit.
- [ ] Implement the wrapper:

```js
export async function withJobRun(pool, meta, work) {
  const { rows } = await pool.query(
    'INSERT INTO sdr_job_runs(job, scope, status) VALUES($1,$2,\'running\') RETURNING id',
    [meta.job, meta.scope]);
  const id = rows[0].id;
  try {
    const result = await work();
    const status = result.skipped ? 'skipped' : result.coverage === 'complete' ? 'complete' : 'partial';
    await pool.query('UPDATE sdr_job_runs SET status=$2, finished_at=NOW(), counts=$3, cursor=$4 WHERE id=$1',
      [id, status, JSON.stringify(result.counts || {}), JSON.stringify(result.cursor || {})]);
    return result;
  } catch (error) {
    await pool.query('UPDATE sdr_job_runs SET status=\'failed\', finished_at=NOW(), error_category=$2 WHERE id=$1',
      [id, safeErrorCategory(error)]);
    throw error;
  }
}
```

- [ ] Track expected intervals: CRM six hours, engagement fifteen minutes/full sweep three hours, Gmail five minutes, enrollment hourly during Chicago weekdays 08:00–17:00. Dashboard freshness uses both last attempted and last complete run. A dead process must show a missed heartbeat.
- [ ] Add a DB advisory/single-run lock for overlapping Gmail/job passes, with timeout/lease semantics and a recoverable failed run after process death. Test cleanup on throw and subsequent pass.
- [ ] Run the focused test; commit helper and scoped wrapper changes. Do not add unsolicited external alert channels; expose health in the interface first.

## Task 2: CRM lifecycle and send-time guard

**Files:** Migration; `pipedriveSync.js`; new `sdrCrmGuard.js`; their tests; `server.js` send route and `autoOutreach.js` eligibility query.

**Interfaces:** `syncLeadState` returns `{ scanned, upserted, coverage, generation, retired, missing }`. `checkCrmLead(pdLead) -> { allowed, reason }`. Status values `active|archived|missing|unknown`; a missing API record is distinct from a confirmed archived record.

- [ ] Add `crm_status text NOT NULL DEFAULT 'unknown'`, `crm_sync_generation uuid`, `crm_last_seen_at timestamptz` and `crm_status_checked_at timestamptz` to the mirror. Existing rows start unknown until confirmed; do not delete them.
- [ ] Write tests for three-page complete sync, page-two failure, hard cap reached, persons-page failure and lead archived after the last mirror sync. Only a fully exhausted lead listing can complete the CRM generation.
- [ ] Stamp seen active leads with the generation. On a complete sweep, mark unseen formerly active/unknown rows missing for review, with an observed timestamp; use direct lookup or an authorised archived listing to distinguish archived/deleted/access loss. Do not invent an archive date. A separate read reconciles explicit archive status where available.
- [ ] Implement the guard:

```js
export function checkCrmLead(lead) {
  if (!lead) return { allowed: false, reason: 'crm_missing' };
  if (lead.is_archived) return { allowed: false, reason: 'crm_archived' };
  return { allowed: true, reason: null };
}
```

Call it with a fresh `pd.getLead` result before new enrollment and after old-draft refresh. A temporary API error produces a retryable `crm_unverified` deferral rather than broad history deletion. Automatic eligibility uses confirmed active rows. Apply lifecycle changes to UI totals; expose historic rows separately.
- [ ] Test that a partial sweep preserves unseen rows, an archived record cannot enroll, and a record restored in CRM becomes active next complete sync. Reconcile the 5,137 extras without a destructive bulk operation. Run tests; commit.

## Task 3: complete Apollo polling and identity-correct steps

**Files:** `apolloEngagementPoll.js`, `apolloMessageSearchBudget.js` only if persistence is needed, new pagination test, integration with reporting fact writer.

**Interfaces:** Internal `walkSequence({ sequenceId, cursor, budget, fetchPage }) -> { messages, coverage, nextPage, pages, endObserved }`. `endObserved` requires a short final page. Aggregation key is `(contact_id, sequence_id, enrollment/touch identity)` rather than contact alone; a missing enrollment link is explicitly ambiguous.

- [ ] Write a 34-page LBA fixture with 100 rows on pages 1–33 and three on page 34; assert 3,303 unique rows and end observed. Add fixtures for budget exhaustion at page 26, 429 on page 3, network error, duplicated provider IDs and process restart.
- [ ] Replace fixed whole-history “25 pages then success” with bounded resumable work. Each pass has a request/time budget, persists the next page and marks partial until every sequence reaches its end. Reuse the shared endpoint budget and honour provider retry-after. Measure current page counts/traffic before picking quotas; do not copy old 31-page arithmetic as current sizing.
- [ ] Make completion explicit:

```js
export function fullSweepComplete(results) {
  return results.length > 0 && results.every(r => r.endObserved && r.coverage === 'complete');
}
```

Stamp `engagement_last_full_scan_at` only when this predicate is true and required persistence succeeded. Persist cursor/error state on partial work. Tests must show a page cap, emit failure or no-sequence run cannot falsely close a backfill window.
- [ ] Retain provider touch/enrollment identity when returned by the enrollment receipt; use campaign/contact/time bounds with an explicit ambiguous state when no unique mapping exists. Match step updates to local campaign/contact/enrollment, and prevent a campaign A step count from updating campaign B sends for the same contact. Take total steps from verified sequence configuration, rather than the subset of step IDs present on one page. Preserve completed terminal states and accurate next due time.
- [ ] Separate reporting observation from current sales actions. Existing historical facts may be backfilled, while CRM/task/stop effects remain gated by actual new event/action identity and the preserved historical controls. Add a test asserting historical replay calls no external mutation clients.
- [ ] Investigate September 6's stale full-scan timestamp using runtime job logs, deployment environment and DB write results; do not force a live poll to diagnose. Test, commit and observe a natural full sweep after release.

## Task 4: durable reply actions

**Files:** Migration, `sdrReplyActions.js` and test, `inboxReplyWatch.js`, `gmailInbox.js`, `server.js` action runner.

**Interfaces:** `enqueueReplyActions(pool, { messageId, threadId, mailbox, receivedAt, leadLink, intent })`; `drainReplyActions(pool, { clients, now, limit: 25 })`; pure `runReplyAction(action, { execute, now }) -> updatedAction`, used by the drainer after claiming a due row. Action kinds `stop_sequence|forward|create_task|create_note|match_lead`; status `pending|running|completed|failed|skipped`. The unique key is `(provider_message_id, action_kind, target_key)`.

- [ ] Add action state with attempts, retry_at, safe_error, external_id and receipt time. Store an explicit verified forwarding destination per mailbox and its CRM user mapping. Confirm admin/pm/sr aliases as well as the named reps; same-local-part `.com` derivation alone does not establish the right receiving inbox. Detect/store a message independently of whether its actions succeed. Unknown/ambiguous lead identities get a durable review item, not a claimed-and-forgotten row.
- [ ] Add provider paging to Gmail reads while preserving existing `listThreads` compatibility for the UI. A new `listThreadPage(token, { query, pageToken, maxResults })` returns `{ threads, nextPageToken }`; watcher checkpoints real arrival/message ID, scans a bounded overlap and dedups by stable ID. Token/list failures become scoped failed job runs.
- [ ] Write the critical failure test:

```js
it('retries CRM without forwarding twice', async () => {
  const t0 = new Date('2026-10-05T15:00:00Z');
  const afterRetry = new Date('2026-10-05T15:05:00Z');
  const forward = vi.fn().mockResolvedValue({ id: 'f1' });
  const createTask = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ id: 'a1' });
  let f = { status: 'pending', attempts: 0, retryAt: null, externalId: null };
  let t = { status: 'pending', attempts: 0, retryAt: null, externalId: null };
  f = await runReplyAction(f, { execute: forward, now: t0 });
  t = await runReplyAction(t, { execute: createTask, now: t0 });
  f = await runReplyAction(f, { execute: forward, now: afterRetry });
  t = await runReplyAction(t, { execute: createTask, now: afterRetry });
  expect(f.status).toBe('completed');
  expect(t.status).toBe('completed');
  expect(forward).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledTimes(2);
});
```

- [ ] Classify bounce/automatic/human and positive/negative intent separately. Enqueue a relevant stop for every human reply, including a negative/unsubscribe; forwarding/rep task follows intent and ownership. Allow classifier failures to enter a visible human review state, preserving the existing buyer-protective fallback. Preserve the received timestamp rather than detection time.
- [ ] Implement `runReplyAction` to return completed/skipped actions unchanged, defer not-yet-due actions, record a receipt on success, and return failed status with incremented attempts/retry time on exceptions. Never persist raw error bodies. Retry per action with 1, 5, 30 and 120-minute backoff, then visible manual intervention after five attempts. Permanent bad-recipient/auth cases show the owning mailbox and remediation, not infinite retry. Before retrying a timed-out external task/forward whose receipt is unknown, reconcile via a deterministic external marker/provider receipt where supported. Unknown completion stays in review rather than blindly duplicating it.
- [ ] Remove the 48-hour event-as-task-completed assumption. Record actual task receipt and assignee. Keep `handled`, `read`, `forwarded`, `staff responded` and `won` separate. Dedup action identity across Gmail and Apollo discovery paths.
- [ ] Add fixtures for off-contact alias, two projects, no known lead, negative/OOO, token revocation, 26+ inbox threads, reply during a concurrent send and stop failure followed by retry. Test that local terminal status is not treated as proof provider removal succeeded.
- [ ] Run focused tests, commit and release with one observed natural new reply; inspect task/forward/stop receipts and no repeated action. Historical backlog triage is a separately scoped action set.

## Task 5: enrollment refusals and safe retries

**Files:** Migration, `sdrEnrollmentRetry.js` and test, `autoOutreach.js`, `server.js` `enrollAutoDrafts` and send route.

**Interfaces:** `classifyEnrollmentRefusal({ httpStatus, code, message }) -> { category, retryable, retryAfterMs }`; `recordEnrollmentAttempt(pool, draftId, result)`; `listDueEnrollmentRetries(pool, { now, limit })`. Persist last category, attempt count and next retry. Ordinary pending drafts and auto-switch drafts use the same recovery scheduler but retain their different project-switch rules.

- [ ] Add refusal fields/table and expose reasons/age in the queue. Retain original draft/contact snapshots and action receipts.
- [ ] Pin the policy:

```js
export function classifyEnrollmentRefusal({ httpStatus, code }) {
  if (code === 'daily_cap_reached') return { category: 'capacity', retryable: true, retryAfterMs: 3600000 };
  if (httpStatus === 429) return { category: 'rate_limit', retryable: true, retryAfterMs: 900000 };
  if (httpStatus >= 500) return { category: 'provider_error', retryable: true, retryAfterMs: 300000 };
  if (code === 'crm_unverified') return { category: 'crm_unverified', retryable: true, retryAfterMs: 900000 };
  return { category: code || 'unclassified', retryable: false, retryAfterMs: null };
}
```

Provider retry-after overrides the illustrative fallback. Campaign conflict is deferred for membership review, not blindly retried; a current active/replied/unsubscribed membership stays protected. Expired draft, customer, invalid address and missing lead require revalidation/review, not an automated override.
- [ ] Persist non-2xx refusal categories rather than only logging them. Retry no earlier than business hours/cap reset as appropriate. Enforce bounded attempts and lease/advisory locking.
- [ ] Rebuild stale copy from current project/contact state, then rerun verification, customer, active CRM, reply/stop, cooldown and live membership guards before enrollment. Do not simply resend the September 19 draft or use machine admin override to bypass these protections.
- [ ] Add fixtures for 409 capacity → next-day success, 429 retry-after, customer change, contact replacement, archived project, terminal reply and duplicate worker pickup. Confirm one accepted provider enrollment and no double-touch. Run tests and commit.

## Task 6: CMD contact refresh and overdue-activity semantics

**Files:** Current n8n-as-code sources resolved from the initialized Derek workspace for `QsTHSvl3LvkpznqW` and `JIZMs2AQNHrRAsbt`; current cleanup workflow resolved by live name/ID. Audit notes and job health adapters.

- [ ] Read the entire canonical `docs/agent-runtime/n8n-workflow-protocol.md` from Ivan's workspace and any applicable target instructions. Inspect initialized active environment and saved instances; use the canonical CLI initialization/switching flow if needed. Do not hand-write n8n config or assume a directory names the client.
- [ ] List first, pull current remote workflow sources if needed, read their workflow maps and targeted nodes. Back up the current live version. Research exact schemas/examples before editing any node.
- [ ] Inspect retained successful versus timed-out Browserless Contacts executions: login/navigation outcome, company URL class, extraction result, total/page wait latency and provider 408. Read account budget only through authorised account access. The current audit verifies timeouts; it does not distinguish login changes, page load, provider capacity or budget as root cause.
- [ ] Reproduce the extraction as a non-writing diagnostic against one already-known company page with the relevant login/session; cap time and calls. Preserve credentials out of logs. Do not re-run the full daily batch or create CRM test leads.
- [ ] Apply the specific verified cause: navigation/auth selector/session recovery if auth failed; wait-for-selector rather than unbounded network idle if the page never settles; bounded provider retry if the account is temporarily unavailable; budget-aware scheduling if verified exhausted. Record which branch is supported before implementing it.
- [ ] Preserve the circuit breaker, but distinguish a skipped/exhausted run from successful data refresh. Persist processed/updated/failed counts and the next planned recovery. Confirm a real contact data update after the next natural refresh rather than only a green execution.
- [ ] Change completion reporting so the cleanup workflow's overdue auto-closed activities are labelled expired/housekeeping in our reporting, not sent/completed email. If workflow behavior itself is changed, map real provider message receipts before marking an email step completed. Retain CRM housekeeping history.
- [ ] Validate/push/verify under the canonical protocol only when the concrete fix is ready. Any production-trigger test must be safe and explicitly scoped; diagnostic work here is read-only. Observe natural scheduled runs and data effects; document rollback source/version.

## Task 7: cross-channel and release verification

**Files:** Existing `.com` automation sources/current CRM configuration once access is established; reporting facts/adapters; audit follow-up record.

- [ ] Inventory real `.com` automatic/manual senders and current campaign triggers from CRM account configuration. The inactive n8n “Pro SWPPP SDR Automation” alone does not identify every active `.com` sender.
- [ ] Retrieve message-level histories for 20 representative contacts, including a complaint/alias, recent reply, multi-project buyer and customer. Confirm stop-on-reply, archive/customer rules and overlapping contact windows. Record actual message IDs/times rather than latest-ledger row counts.
- [ ] Compare confirmed unintended repeats and legitimate follow-ups. Create review labels and the measurable duplication denominator; never delete repeated company/contact rows automatically.
- [ ] Run the full suite and production build. Baseline: 296 tests/23 files and build pass; new fixtures must cover the five review-focus risks.
- [ ] Roll out in small steps: observability/CRM, provider completion, reply-action reliability, then enrollment recovery. Keep policy flags and migrations additive/reversible; record which flags/configuration were verified live.
- [ ] Observe next natural complete sync/full scan and one safe real action; reconcile provider receipt, local fact, correct CRM owner and dashboard state. No revenue claim until project-linked opportunity/quote/win evidence exists.

## Coverage self-review

Job health → Task 1; stale CRM state → Task 2; page limit/watermark/contact-step defect → Task 3; durable replies/alias/matching → Task 4; pending refusals/campaign protection → Task 5; CMD 408/housekeeping → Task 6; entire SDR duplication and release → Task 7. Broader sales growth is owned by the roadmap's operating packages rather than being represented as an automatic consequence of these repairs.
