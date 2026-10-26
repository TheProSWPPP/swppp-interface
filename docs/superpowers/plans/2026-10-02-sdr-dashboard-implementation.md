# SDR dashboard implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task when execution is requested. Steps use checkbox syntax. Implementation authorised after payment; Tasks 1–5 are implemented locally. Task 6 local acceptance is complete; its production release gates remain open.

**Goal:** Replace sampled draft statistics with a compact, date-filtered growth dashboard showing real activity, sender performance, reply quality, follow-up, duplication, close rate and trustworthy sales coverage.

**Architecture:** Add focused message/deal reporting facts, read-only aggregate services and one authenticated metrics route. Extract the dashboard view from the large SDR component while preserving existing navigation and permissions. Display unsupported outcomes as unavailable until evidence is ingested and linked.

**Tech Stack:** Existing React/TypeScript/Tailwind UI, Express/Node ESM, PostgreSQL, Vitest and T3 preview.

**Spec:** `../specs/2026-10-02-sdr-growth-dashboard-design.md`

## Global constraints

- No new visible Pipedrive custom fields.
- Default last 30 complete America/Chicago days, inclusive start/exclusive end; current-day windows are provisional.
- Maximum date range 366 days; timezone allow-list initially America/Chicago only.
- No outreach or other sales-side effects from reporting/backfill.
- Preserve team/admin scope for every aggregate and drill-down.
- Actual provider message identity is the message-count unit; actual mailbox is the sender unit.
- A null value with a reason represents unavailable evidence; never silently turn it into zero.
- Historical source links must be explicit or remain unknown.
- Additive migrations are separate from this plan-writing task; establish a live schema baseline and backup before execution.

## Review focus

1. Re-enrolling one lead twice cannot credit the same reply twice: Task 3 fixture.
2. Replies after midnight/DST or to an older contact cohort use the correct event window: Tasks 2–3 fixtures.
3. Missing/stale provider coverage stays visible even when other metrics work: Tasks 3–5 fixtures.
4. A restricted rep cannot infer other senders through totals, query filters or exports: Task 4 fixtures.
5. A person appearing on two projects does not turn an ambiguous win into two sales: Tasks 1–3 fixtures.

## File map

| File | Responsibility |
|---|---|
| `migrations/2026-10-02-sdr-reporting.sql` | Reporting facts, evidence links and job run metadata |
| `lib/sdrReportingIngest.js` | Read-only provider observations to reporting facts, no sales actions |
| `lib/sdrMetricWindow.js` | Validated local date window and SQL timestamp boundaries |
| `lib/sdrMetrics.js` | Aggregate queries, rates, coverage and freshness |
| `lib/sdrMetricsRoutes.js` | Metrics route and permissions |
| `server.js` | Minimal registration and controlled scheduled reporting hook |
| `src/lib/sdrMetricsApi.ts` | Exact response types and fetch helper |
| `src/components/sdr/dashboard/SdrDashboard.tsx` | Dashboard composition and filters |
| `src/components/sdr/dashboard/MetricCard.tsx` | Available/partial/unavailable metric rendering |
| `src/components/sdr/dashboard/SenderTable.tsx` | Real mailbox comparison |
| `src/components/sdr/dashboard/AttentionList.tsx` | Action backlog and drill-down navigation |
| `src/components/sdr/dashboard/metricDisplay.ts` | Pure formatting/zero/null behavior |
| `src/components/SdrInterface.tsx` | Replace inline DashboardView with extracted component |
| `lib/__tests__/sdrReportingIngest.test.js`, `sdrMetricWindow.test.js`, `sdrMetrics.test.js`, `sdrMetricsRoutes.test.js` | Business semantics and failure/scoping tests |
| `src/components/sdr/dashboard/metricDisplay.test.ts` | Frontend display contract |

Do not broadly refactor the remaining 4,000+ line interface or 7,000+ line server.

## Task 1: facts and side-effect-free historical ingestion

**Files:** Create migration, `lib/sdrReportingIngest.js` and its test. Modify the engagement poll only to pass provider observations to the fact writer after the reliability paging repair; do not change its action behavior in this task.

**Interfaces:** Export `observeOutbound(pool, message, { leadLink, observedAt })`; `leadLink` is `{ leadId: string|null, status: 'verified'|'ambiguous'|'unmatched', evidence: string|null, sourceKey?: string }`. Export `observeInbound(pool, message, { mailbox, intent, leadLink })`; the inbound message includes its real received timestamp and unique Gmail/provider ID. Export `syncDealFacts(pool, deals, { quoteStageIds })`; missing quote mapping gives `qualified_quote = NULL`, not false. Each writer returns `{ inserted: number, updated: number }` and calls no sending/CRM-write client.

- [ ] Inspect current production schema with scoped read access; list the exact existing columns/indexes and preserve the baseline. Create the additive migration with this core fact shape: **Release gate pending:** production schema access/backup; additive migration authored and rehearsed locally.

```sql
CREATE TABLE IF NOT EXISTS sdr_message_facts (
  provider text NOT NULL,
  provider_message_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('out','in')),
  mailbox_email text NOT NULL,
  prospect_email text NOT NULL,
  campaign_id text,
  source_key text NOT NULL DEFAULT 'unknown',
  sequence_step integer,
  occurred_at timestamptz,
  provider_status text,
  human_reply boolean,
  reply_intent text,
  bounce boolean NOT NULL DEFAULT false,
  spam_blocked boolean NOT NULL DEFAULT false,
  pipedrive_lead_id text,
  link_status text NOT NULL CHECK (link_status IN ('verified','ambiguous','unmatched')),
  link_evidence text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_message_id)
);
CREATE INDEX IF NOT EXISTS sdr_message_window_idx
  ON sdr_message_facts (mailbox_email, occurred_at);
CREATE TABLE IF NOT EXISTS sdr_deal_facts (
  pipedrive_deal_id text PRIMARY KEY,
  pipedrive_lead_id text,
  link_status text NOT NULL DEFAULT 'unmatched',
  link_evidence text,
  source text,
  currency text NOT NULL,
  value numeric,
  status text NOT NULL,
  qualified_quote boolean,
  quote_created_at timestamptz,
  won_at timestamptz,
  lost_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sdr_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','complete','partial','failed','skipped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}',
  cursor jsonb NOT NULL DEFAULT '{}',
  error_category text,
  next_retry_at timestamptz
);
```

- [x] Write duplicate-provider-ID and ambiguous-link fixtures before the writer. A fake pool captures SQL calls; assert no note/task/send method can be called:

```js
function recordingPool() {
  return { calls: [], async query(sql, params) {
    this.calls.push({ sql, params });
    return { rows: [], rowCount: 1 };
  } };
}
it('stores an Apollo observation without creating a reply timestamp', async () => {
  const pool = recordingPool();
  await observeOutbound(pool, {
    id: 'm1', from_email: 'dc@proswppp.co', to_email: 'buyer@example.test',
    completed_at: '2026-09-01T15:00:00Z', status: 'completed', replied: true,
    emailer_campaign_id: 'agc', campaign_position: 1
  }, { leadLink: { leadId: null, status: 'ambiguous', evidence: null }, observedAt: new Date() });
  expect(pool.calls[0].params).toContain('out');
  expect(pool.calls[0].params).toContain('ambiguous');
  expect(pool.calls.some(c => /sdr_engagement_events|sdr_sends|activities/.test(c.sql))).toBe(false);
});
```

- [x] Implement parameterised upserts keyed on `(provider, provider_message_id)`. Normalise mailbox/prospect addresses; for Apollo use `completed_at` only for outbound occurrence. Store `replied` solely as an observation if needed; do not invent an inbound fact from it. For inbound use provider ID/internal received time, remove automatic replies and classify human intent separately. Resolve source keys from verified import/invitation/manual provenance and leave historical unknown origins as `unknown`; do not relabel the CRM’s generic API origin as CMD. Retain verified project links when a later observation lacks a link; never overwrite them with an ambiguous email-only guess.
- [x] Add fixtures for same contact/two projects, body-free storage, missing timestamps, status changes, repeated idempotent import, and unknown quote mapping. Run `npm test -- lib/__tests__/sdrReportingIngest.test.js`.
- [x] Rehearsed migration and fact import in isolated local Postgres schemas; no server startup or external sales action. Production schema/backup and real inbound trace remain release gates.
- [x] Commit only the reporting migration, module and tests on the implementation branch.

## Task 2: business date windows

**Files:** Create `lib/sdrMetricWindow.js` and its test.

**Interfaces:** `parseMetricWindow(query, now = new Date()) -> { from, to, timezone, provisional }`. SQL uses local-date boundaries converted by Postgres, which handles Chicago DST.

- [x] Write fixtures for invalid/nonexistent dates, reversed/zero windows, a 367-day range, unsupported timezone, and the Chicago midnight boundary.
- [x] Implement calendar-date validation rather than accepting JavaScript's normalisation of impossible dates:

```js
export function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('invalid_date');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error('invalid_date');
  return parsed;
}
```

Use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now)` to form today's local date without depending on display ordering. Set provisional when the window extends beyond today's local midnight. Defaults are generated from that date.
- [x] Use this predicate consistently in queries:

```sql
occurred_at >= ($1::date::timestamp AT TIME ZONE $3)
AND occurred_at < ($2::date::timestamp AT TIME ZONE $3)
```

- [x] Add a DST fixture for November 1–2, 2026: the day spans 25 elapsed hours in Chicago. Assert inclusive start/exclusive end and no double count across adjacent windows. Run the focused test; commit the module and test.

## Task 3: correct aggregates, cohorts and coverage

**Files:** Create `lib/sdrMetrics.js` and `lib/__tests__/sdrMetrics.test.js`.

**Interfaces:** `buildMetrics(pool, { window, visibleMailboxes, source, now }) -> MetricsResponse`. `visibleMailboxes` is an explicit array of allowed real addresses, never null meaning “everyone.” Metric keys: `messages_completed`, `contacts_reached`, `first_touches`, `followups_completed`, `human_reply_rate`, `positive_reply_rate`, `followup_completion_rate`, `duplicate_rate`, `quote_close_rate`, `contact_to_win_rate`, `won_booked_value`, `collected_value`, `eligible_supply`, `bounce_rate`.

- [x] Pin zero versus unknown behavior first:

```js
export function rate(numerator, denominator, coverageComplete) {
  if (!coverageComplete) return { value: null, state: 'unavailable', reason: 'incomplete_coverage' };
  if (!denominator) return { value: null, numerator, denominator, state: 'available', reason: 'no_denominator' };
  return { value: numerator / denominator, numerator, denominator, state: 'available' };
}
```

Test that one contact, two enrollments and one human reply yield one replied contact; negative replies count as human but not positive; bounce/OOO count as neither. Test that an unlinked win cannot increase verified SDR sales.
- [x] Implement message aggregation with explicit mailbox scoping and real occurrence:

```sql
SELECT mailbox_email,
  COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed') AS messages_completed,
  COUNT(DISTINCT prospect_email) FILTER
    (WHERE direction='out' AND provider_status='completed') AS contacts_reached,
  COUNT(*) FILTER
    (WHERE direction='out' AND provider_status='completed' AND sequence_step=1) AS first_touches,
  COUNT(*) FILTER
    (WHERE direction='out' AND provider_status='completed' AND sequence_step>1) AS followups_completed
FROM sdr_message_facts
WHERE occurred_at >= ($1::date::timestamp AT TIME ZONE $3)
  AND occurred_at < ($2::date::timestamp AT TIME ZONE $3)
  AND mailbox_email = ANY($4::text[])
GROUP BY mailbox_email;
```

- [x] Add first-touch cohort queries grouped by normalised prospect and verified project when available. Link inbound facts via message/thread/enrollment evidence. Include replies only after touch and within the 30-day observation window. A late September reply to an August touch belongs to August's cohort. Return partial maturity and coverage for cohorts that have not completed the window; do not label them final conversion.
- [x] Read quote-created cohorts only from verified qualified-quote facts. The proposed resolved-quote rate is `won/(won+lost)`; show unresolved/age separately. Keep company won value and verified source-linked value distinct. Display collected value as unavailable without accounting evidence. Duplicate rate remains unavailable until review-labelled duplication facts exist.
- [x] Read job coverage and actual action backlog for attention items. Use the reliability plan's CRM status/complete generations and reply-action receipts. Missing tables on an older schema return explicit unsupported metrics instead of an unhandled 500 or a zero.
- [x] Add fixtures for 30/60-day immature cohorts, currency separation, orphan CRM records, repeated facts, incomplete pagination, stale scan and mixed senders. Run focused tests and commit.

## Task 4: permission-scoped API

**Files:** Create `lib/sdrMetricsRoutes.js` and its test; modify `server.js` near SDR route registration.

**Interfaces:** `registerSdrMetricsRoutes(app, { pool, resolveVisibleMailboxes, metrics = buildMetrics })`. It registers exactly `GET /api/sdr/metrics`. Reuse the existing JWT middleware. Resolve mailbox scope from authenticated identity, then intersect an optional sender filter; never trust the filter as permission.

- [x] Write a fake Express request/response test for admin, rep, forged mailbox filter, no visible mailboxes and invalid date. Assert aggregate totals and attention lists remain scoped.
- [x] Implement this route contract:

```js
app.get('/api/sdr/metrics', async (req, res) => {
  try {
    const window = parseMetricWindow(req.query);
    const allowed = await resolveVisibleMailboxes(req.sdrUser);
    const requested = req.query.mailbox ? String(req.query.mailbox).toLowerCase() : null;
    if (requested && !allowed.includes(requested)) return res.status(403).json({ error: 'mailbox_not_visible' });
    const visibleMailboxes = requested ? [requested] : allowed;
    res.json(await metrics(pool, { window, visibleMailboxes, source: req.query.source || null, now: new Date() }));
  } catch (e) {
    const invalid = ['invalid_date','invalid_range','unsupported_timezone'].includes(e.message);
    res.status(invalid ? 400 : 503).json({ error: invalid ? e.message : 'metrics_unavailable' });
  }
});
```

The `resolveVisibleMailboxes` adapter maps the existing `visibleMailboxes` records to lowercased address strings. Parameterise source values or validate against persisted source IDs; they cannot become SQL fragments.
- [x] Add explicit freshness/coverage response examples to the API doc. Run route/scoping tests and commit. Do not alter authentication or seed team users.

## Task 5: readable dashboard and real sender table

**Files:** Create the frontend files in the map; modify only the Dashboard tab render/import in `SdrInterface.tsx` and add `sdrMetricsApi.ts`.

**Interfaces:** `getMetrics(query: MetricsQuery): Promise<MetricsResponse>` uses existing `sdrFetch`. `SdrDashboard` accepts the current user and an `onNavigate(target: string)` callback. `MetricCard` receives label, `Metric`, format and detail; all sender rows use real mailbox identity. Drill-down callbacks open existing leads/queue/inbox views with the intended filter rather than sending or auto-handling anything.

- [x] Add exact TypeScript types from the spec and the metric-key union in Task 3. Write display tests:

```ts
expect(metricText({ value: 0, state: 'available' }, 'count')).toBe('0');
expect(metricText({ value: null, state: 'unavailable', reason: 'not_linked' }, 'rate')).toBe('Unavailable');
expect(metricText({ value: .05, numerator: 5, denominator: 100, state: 'available' }, 'rate')).toBe('5.0%');
```

- [x] Implement `metricText` with explicit null/state handling before number formatting. Add accessible labelled cards, explanatory numerator/denominator text and a data-state badge. Avoid clickable-looking cards without a real drill-down.
- [x] Build the view with date/sender/source filters, freshness, four primary cards, compact attention queue and collapsed detail groups. Keep the existing sidebar/tab controls and client visual style. Use `AbortController` or a request generation guard so a slow older filter response cannot overwrite a newer one.
- [x] Expose a retry control on fetch failure, retain previously loaded values as visibly stale, show a true empty window separately, and show missing attribution with a path to the review queue. Do not silently suppress engagement errors as the old view does.
- [x] Add sender totals with actual completed messages, first touches, human/positive replies, bounce flags, due/completed follow-ups and coverage. Detailed row denominators appear on expansion; mailbox and staff name both remain visible.
- [x] Lazy-load the extracted dashboard through React `lazy`/`Suspense` to avoid adding more initial JavaScript to the existing large bundle. Remove only the superseded inline dashboard component/rates table after checking its remaining references.
- [x] Run `npm test -- src/components/sdr/dashboard/metricDisplay.test.ts` and `npm run build`; commit the UI increment.

## Task 6: rollout and measured acceptance

**Files:** Update the spec acceptance record and `docs/audits/2026-10-02-sdr-growth-audit.md` with subsequent verified release evidence, preserving the original snapshot.

- [x] Use read-only fixture APIs in an isolated preview; do not boot client production jobs on a local server. Test 1440×900, 1280×800 and 390×844 through T3 preview. Verify collapsed details, keyboard controls, visible unknowns, no main horizontal overflow and drill-down navigation.
- [x] Run 23+ test files and `npm run build`. Inspect changed-file diff and no unexpected policy/dependency changes.
- [ ] Reconcile real sampled source messages and a known reply against API totals; demonstrate repeated enrollment does not inflate replies. Confirm role scopes using an existing rep identity with authorised access.
- [ ] Deploy only through Derek's established repository/deployment after reviewing the concrete change. Back up additive schema/data; rollback UI/API code if needed without dropping historical facts.
- [ ] Observe the next natural collection/sync runs and verify completion counts, last complete timestamps and no unintended external actions. Report which historical metrics remain unavailable.

## Coverage self-review

Sends/senders → Tasks 1, 3, 5. Reply/positive rates → Tasks 1–3, 5. Follow-ups → Task 3 plus reliability polling. Duplication → honest unavailable/review state in Tasks 3/5 until whole-lane evidence. Close rate/value → Tasks 1/3/5 with explicit quote/source mapping. Date/freshness → Tasks 2–5. Permissions → Task 4. UI readability → Tasks 5/6. Reliability actions are owned by the separate plan, and both plans use the same facts/job contracts.

## October 3 implementation safeguard

Preserve existing company sales and average calculations. New USD average won deal value is total known USD won value / unique USD won deals with known value, with missing-value coverage shown. July–September audit baseline: 77 wins, $186,508, $2,422.18 average. Filters and repeated enrollment must not change that definition. Production migration/deployment and natural-run acceptance remain separate release gates.
