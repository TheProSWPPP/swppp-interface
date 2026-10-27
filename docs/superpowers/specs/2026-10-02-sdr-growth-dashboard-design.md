# SDR growth dashboard design

Status: implemented locally for the paid engagement; production release gates pending. Prepared October 2 from the call, Ivan's priorities and the fresh audit. This is an architectural change to reporting and job observability. It is split into a dashboard plan, a reliability plan and a growth operating roadmap.

## Intent

Ivan wants Derek to see how the $2,000/month work creates more relevant buyer conversations and orders. Derek wants lead generation and sales, plus consistent attention to his systems. The first product deliverable is a compact SDR KPI interface with reply rate, sends, duplication, close rate, follow-ups and sender comparison. Metrics must distinguish genuine outcomes from draft/enrollment activity.

Proposed assumptions: America/Chicago business time; default last 30 complete days; current day separately labelled provisional; positive replies and qualified quotes tracked separately; historical outcomes remain unknown where source evidence cannot support them. These are implementation defaults, not extra commercial promises.

## Options considered

| Approach | Benefit | Limitation |
|---|---|---|
| Extend the existing app with focused reporting modules and message facts | Uses the current team accounts, project history and deployment; preserves one client system | Requires dependable ingestion and a small schema addition |
| Restyle the current draft tables only | Fast visual improvement | Keeps sampled counts and inflated/ambiguous reply rates |
| Introduce a separate BI/growth platform | Flexible reporting | Another interface and integration surface before the operational gaps are repaired |

Recommendation: extend the existing app. Keep independent Git repositories and scoped deployments. Ivan can remain in the current workspace and agents can operate through Derek's absolute path. No repository merge or shared credentials are needed. Any cloud checkout must be explicitly registered and verified before it is used.

## User experience

Use the existing SDR Dashboard tab, with its reporting content extracted to `src/components/sdr/dashboard/`. Preserve Leads, Queue, Priority, Inbox, Mailboxes and team access.

Top: date range, comparison period, source, real sender mailbox and freshness. Below it, at most four primary cards: actual completed messages, unique reached contacts, human reply rate, and verified won value. A second row switches between pipeline and operational KPIs. An actionable “Needs attention” list shows data failures, awaiting replies, overdue follow-ups, supply shortages and unresolved conflicts, with count and oldest age. Each item opens the relevant filtered list.

Details start collapsed: sender table, source/sequence funnel, follow-up steps, duplication review, CRM reconciliation and metric definitions. Do not place every metric above the fold. Desktop must make the main numbers and next actions readable without horizontal scrolling; sender/details tables can scroll inside their containers on mobile.

Loading, failed data, zero results, stale data and unavailable evidence must look different. Never substitute a zero for an unavailable metric. Every rate shows numerator/denominator and whether its cohort has matured. Opens/clicks are secondary diagnostic signals, labelled as tracking observations; they do not establish buyer intent.

## Exact definitions

| Metric | Unit and denominator |
|---|---|
| Enrollment attempts / accepted enrollments | Draft/send attempts; independent of message count |
| Actual completed messages | Unique provider message IDs with provider status completed, grouped by real completion time and mailbox; delivery/inbox placement remains unknown |
| First touches / follow-ups | Message sequence position 1 / position greater than 1; intended cadence failures separate |
| Unique reached contacts | Distinct normalised recipient addresses with completed messages in the window; this is contact reach, not new project count |
| Human replies received | Unique inbound provider/Gmail message IDs with real received timestamps; exclude bounce and automatic responders; retain sentiment separately |
| Cohort human reply rate | Unique contacted addresses in a first-touch cohort with a linked human reply within 30 days / unique addresses in that cohort; exclude unresolved links from numerator and disclose coverage |
| Positive reply rate | Same denominator; interested/pricing/question/qualified-referral labels, with reviewed classification; later/nurture separate |
| Follow-up completion | Actually completed eligible scheduled steps / eligible steps due; remove steps superseded by reply, unsubscribe, win, archival or deliberate pause |
| Reply response time | Business-time delay from actionable inbound arrival to first verified staff reply or logged call; handled/read/forwarded is insufficient |
| Duplicate candidates | Repeated exact recipient + project + sequence step outside the intended cadence or overlapping conflicting send lanes; review outcome establishes confirmed duplication |
| Duplicate send rate | Confirmed unintended duplicate completed messages / all completed messages; unavailable until project/message evidence exists |
| Quote close rate | Verified won qualified quotes / resolved qualified quotes (won + lost), shown with unresolved count, source and quote-created cohort |
| Contact-to-win rate | Verified won projects / unique eligible contacted projects in a mature cohort; do not divide company wins by email drafts |
| Booked value | Pipedrive won deal value and currency, once per deal; all-channel and source-linked views separate |
| Collected value / margin | Verified accounting data; unavailable until integrated/confirmed |
| Coverage | Linked records / total relevant records, historical source coverage and last successful complete sync |

Use a 30-day reply window and a provisional 60-day sales maturity window, displayed explicitly. Derek's actual sales-cycle review may revise the latter before sales targets are locked. Distinguish event-period totals (“replies received this month”) from first-touch cohort conversion (“September contacts replying within 30 days”). A September reply to an August touch belongs to the September event count and August cohort conversion.

## Data architecture

Postgres remains the operational store; Pipedrive owns current sales records; Apollo owns provider message observations; Gmail supplies received reply timestamps. Reuse existing tables, and add only the reporting facts and durable job/action state needed for gaps.

- `sdr_message_facts`: unique `(provider, provider_message_id)`; message direction, real mailbox, normalised recipient, campaign/step, verified source key or unknown, received/completed timestamp, observed provider status, bounce/spam flags, current linked lead/deal when unambiguous, link status and last observation. Apollo outbound completion is never used as an inbound reply timestamp. Message body is not copied into reporting facts.
- `sdr_deal_facts`: unique Pipedrive deal ID; lead/project link evidence, source and link evidence, currency, value, status, quote-created/won/lost times and last sync. Ambiguous joins remain unlinked. Existing company sales remain available separately.
- `sdr_job_runs`: job/scope, started/finished times, complete/partial/failed/skipped, counts, cursor progress, error category, next retry. Never store tokens, raw request headers or sensitive error bodies.
- CRM status on `sdr_lead_state`: active/archived/missing/unknown, current sync generation and last confirmed presence. Retain historical rows.
- `sdr_reply_actions`: per received message/action, pending/running/completed/failed/skipped, target, external receipt, attempts, retry time and last error category. Independent idempotency for forward, task, note and sequence stop.

Unknown project linkage is a first-class state. A person with multiple projects cannot be attributed by email alone or the first row returned. Resolve by provider thread/message, enrollment contact + campaign + time interval and specific CRM lead/deal IDs. Preserve evidence and review ambiguities.

Historical backfill writes reporting facts only. It must not forward old replies, create CRM tasks/notes, resend mail or remove campaign members. Current-action repair is separate and explicitly scoped. Do not broaden the current send policy through a reporting migration.

## API contract

`GET /api/sdr/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&timezone=America/Chicago&mailbox=<optional>&source=<optional>` uses inclusive start/exclusive end local dates. `to` is a boundary date, not an inclusive date. Support a maximum 366-day range. Validate dates, timezone allow-list and sender visibility before queries. Current-day views are provisional.

Response:

```ts
type Metric = {
  value: number | null;
  numerator?: number;
  denominator?: number;
  state: 'available' | 'partial' | 'unavailable';
  reason?: string;
};
type MetricsResponse = {
  window: { from: string; to: string; timezone: 'America/Chicago'; provisional: boolean };
  freshness: { last_complete_at: string | null; state: 'fresh' | 'stale' | 'unknown' };
  coverage: { provider_messages: Metric; project_links: Metric; deal_links: Metric };
  metrics: Record<string, Metric>;
  senders: Array<{ mailbox: string; display_name: string; metrics: Record<string, Metric> }>;
  attention: Array<{ kind: string; count: number; oldest_at: string | null; target: string }>;
};
```

The service performs bounded aggregate queries rather than downloading full draft inventories into the browser. Sender rows group actual mailbox, with staff label added separately. Existing `ownerScope`/mailbox visibility still applies to all queries, totals and drill-downs. Admin sees the team; reps see authorised records. Errors expose a safe category and retryable state without buyer data or secrets.

## Constraints and acceptance

- Preserve existing sending rules and human overrides; reporting must not send mail.
- No new visible Pipedrive custom fields.
- No destructive deletion of historical lead or message records.
- Both `.co` and `.com` lanes remain individually identified; verify current ownership and rules before changing either.
- Preserve customer, invalid-address, reply, unsubscribe, active-sequence and cooldown protections.
- Complete sync evidence is required before retiring absent CRM records.
- Historical import has zero sales-side effects.
- Dashboard rates use one documented unit/window and show coverage.
- Production workflow work follows the complete registered n8n protocol and correct client instance.
- Cloud use requires a verified checkout, client scope and deploy target; none is established by this design document.

Acceptance fixtures cover repeat draft enrollments, a negative/automatic reply, a late reply, two projects per contact, partial provider paging, DST boundaries, restricted reps, missing attribution, failure retries and archived CRM records. Reconcile a sampled message → reply → quote → win trace with real records before publishing attributed ROI. Production release also needs a backup/rollback and a verified next natural polling cycle.

## October 3 implementation safeguard

Preserve existing company sales and average calculations. New USD average won deal value is total known USD won value / unique USD won deals with known value, with missing-value coverage shown. July–September audit baseline: 77 wins, $186,508, $2,422.18 average. Filters and repeated enrollment must not change that definition. Production migration/deployment and natural-run acceptance remain separate release gates.

## Local acceptance, October 3

Implemented locally on `feat/sdr-growth-dashboard`; see `../../audits/2026-10-03-dashboard-acceptance.md`. Weighted-average baseline reconciles exactly. Local SQL, UI state and responsive checks completed. Production collection, migration, permissions acceptance and release remain pending; this status is not a claim of live deployment.
