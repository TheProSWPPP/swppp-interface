# ProSWPPP SDR growth roadmap

**October 8 consolidated status:** Start with the [current master plan](</Users/ivanmanfredi/.local/state/proswppp-sdr-delivery/2026-10-08-autonomous-delivery/MASTER-PLAN.md>). It reconciles the shipped releases, completed September import, order-intake findings, remaining growth work and current authorization. This original proposal stays preserved below. Copy/cadence experiments remain frozen; custom follow-ups are draft-only for deliberate staff send. Only existing approved sequence steps continue automatically.

**October 7 status:** This file preserves the original scope and proposed checklist. For delivered work, remaining growth work, latest LinkedIn decisions and active observation/import tasks, read the [current session checkpoint](2026-10-07-session-checkpoint.md), especially its latest dated update. The original unchecked boxes below are not a current release ledger.

> **For agentic workers:** Use superpowers:executing-plans when implementation is requested. Steps use checkbox syntax. The present deliverable is an audit and proposed plan; no live fix has been executed.

**Goal:** Make outreach, replies and sales measurable, repair the gaps that lose eligible opportunities, and build a repeatable growth operating cycle for Derek's paid $2,000/month engagement.

**Architecture:** Extend Derek's existing React/Express/Postgres application with focused reporting and reliability modules. Keep Pipedrive sales state, Apollo message observations and Gmail replies reconciled by real identity and timestamps. Preserve Derek's independent Git repository and deployment while operating from Ivan's current workspace through explicit paths.

**Tech Stack:** React 19, TypeScript, Tailwind, Node ESM/Express 5, PostgreSQL, Apollo, Gmail, Pipedrive and Derek's n8n cloud instance.

**Spec:** `../specs/2026-10-02-sdr-growth-dashboard-design.md`

**Audit:** `../../audits/2026-10-02-sdr-growth-audit.md`

## Global constraints

- $2,000/month; payment user-confirmed October 2. No annual minimum, percentage fee or guaranteed extra sales was agreed.
- Priority order from the call: SDR, LinkedIn, then additional lead sources. Ivan now specifies the interface/KPI revamp as the first product deliverable.
- No new visible Pipedrive custom fields. Preserve historical records and current protections.
- `.co`, `.com`, construction SDR, permit outreach and acquisition campaigns remain separately measurable.
- Use actual messages and event timestamps; draft enrollment is a different metric.
- Backfill reporting has no outreach, forwarding, CRM-note/task or campaign-removal effects.
- Match client `proswppp` to its explicit registry and actual target; never select by the agent's cwd.
- No live build/deploy/automation change is implied by this planning deliverable.

## Review focus

1. Partial CRM/provider reads must produce incomplete coverage, never retire the rest of the book or fake a zero.
2. Shared contacts with different projects must retain their identity and genuine cadence without duplicate sales attribution.
3. Any real reply/unsubscribe must stop relevant automated follow-up even if forwarding or task creation fails.
4. Historical recovery must not create an unexpected blast of old messages, tasks or notes.
5. A successful job or auto-closed CRM activity must not be mistaken for a completed message or a buyer response.

## One workspace, separate client code

Keep the current T3 workspace open. Derek's application remains at `/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system`, Git origin `https://github.com/TheProSWPPP/swppp-interface.git`. Execute commands there with an explicit working directory; open files through absolute paths. The parent directory contains n8n configuration/workflow sources, and the registry's `proswppp-config` repository is a configuration repository rather than the interface repository.

Ivan's workspace holds the call/commercial recap and a navigation page pointing to these canonical plans. No code copy or repository merge is required. For cloud execution, verify the app checkout, branch/commit, scoped credentials, registry and deploy target before using it. The existing shared-cloud connection alone does not establish that Derek's application checkout is available.

## Proposed delivery sequence

Dates below are planning targets, not a client promise made on the call. Start the work cycle in the week of October 5 and use the proposed October 15 check-in if scheduled.

| Cycle | Work | Reviewable result |
|---|---|---|
| First product increment | KPI definitions, compact dashboard, data freshness and safe historical read model | Correct counts, explicit unknowns, sender comparison and a visible attention queue |
| First reliability increment, alongside reporting | CRM retirement/status guard, reply-action retry, poll paging and enrollment refusal visibility | Measured complete runs, recoverable failures and current lead eligibility |
| Following growth increment | Recurring fresh supply, relevant-contact cleanup, open bid/quote follow-up and one controlled copy experiment | More eligible first touches and positive buyer conversations, with next actions |
| LinkedIn pilot | Customer ICP/account confirmed, rep task cadence and cross-channel history | Completed relevant touches, replies and linked opportunities |
| End-of-cycle review | Source-linked quotes/wins, coverage, collections/margin where supplied | Actual results, limitations and next month's priorities |

Dashboard and repair work can overlap, but unsafe or incomplete ingestion cannot become a claimed conversion result. Grow volume only after eligibility, suppression, mailbox evidence and reply ownership are working.

## Work package A: dashboard and KPI revamp

Detailed file/task plan: [dashboard implementation](2026-10-02-sdr-dashboard-implementation.md).

- [ ] Replace latest-200-draft cards with complete aggregate reporting.
- [ ] Separate accepted enrollments, completed messages, contact reach and first-touch/follow-up activity.
- [ ] Show received and positive replies, with real arrival timestamps, denominators and classification coverage.
- [ ] Display real mailbox comparisons, per-source/sequence funnels and step completion.
- [ ] Add duplicate review, sync gaps, job freshness, eligible supply and action backlog.
- [ ] Show all-channel sales separately from verified outreach-linked quotes/wins/value; unsupported close metrics remain unavailable.
- [ ] Validate desktop/mobile readability and role-scoped totals/drill-downs.

Success: Derek can answer what happened, what is stuck, who needs to act and whether opportunities are moving toward orders. A pretty card with the wrong unit does not pass.

## Work package B: reliability and CRM consistency

Detailed file/task plan: [reliability implementation](2026-10-02-sdr-reliability-implementation.md).

- [ ] Instrument the app jobs independently of n8n: expected cadence, complete progress, error categories and oldest pending action.
- [ ] Retain but retire archived/missing CRM records after complete sweeps; check live status at send time.
- [ ] Fix the 25-page ceiling and campaign/project step identity; preserve backfill side-effect controls.
- [ ] Make stop, forward, note and CRM task independently retryable and idempotent per inbound message.
- [ ] Persist retryable enrollment refusal reason, attempts and next retry; recover valid ordinary pending drafts.
- [ ] Inspect current `.com` sender rules, contact aliases, reply stops and overlap with `.co` before changing them.
- [ ] Resolve CMD Browserless timeouts with observed page/auth/latency and budget evidence; verify the daily circuit breaker recovers.
- [ ] Stop using overdue activity auto-closure as evidence of email completion.

Success: selected real leads reconcile across systems; job completion is measurable; failures recover without repeated buyer contact. Do not count all 176 campaign conflicts as recoverable.

## Work package C: increase relevant sends and reply quality

Owned by Ivan for system work; Derek/Milo/Terry supply business validation and source data. No messages to them have been sent by the assistant.

- [ ] Produce an eligibility funnel every business day: available active projects → relevant buyer → valid/soft/unknown email → eligible by date → no current customer/reply/stop/conflicting live sequence → accepted enrollment → completed first touch.
- [ ] Set a recurring fresh-lead intake owner and due date. Prefer a next-batch warning and eligible-supply runway over silently waiting for a monthly file.
- [ ] Review a stratified 30-contact sample: ten recent bounce/spam flags, ten generic/wrong-role contacts and ten normal reached contacts. Record actual role, project stage, address quality, failure and correct owner; do not guess based only on domain.
- [ ] Review 20 recent blocked enrollments against live Apollo memberships and project/customer/reply status. Categorise legitimate protection, temporary deferral and real defect; repair only the latter two through their correct path.
- [ ] Review the 30 inbox attention candidates against `.com`, calls and CRM notes. Keep actionable interest/questions/referrals/later distinct from declines. Give each live opportunity an owner and next action.
- [ ] Review open quotes/invitations with Milo/Terry. Confirm whether each is still live, deadline, contact, last touch, value and next action before importing or contacting.
- [ ] Run one copy experiment at a time within one comparable trigger/source. Use a brief project-specific opener and one clear request for the person responsible for the SWPPP. Compare positive replies per mature unique-contact cohort. Do not mix a volume change and copy change and claim the difference proves copy caused it.
- [ ] Use an initial 50 eligible contacts per copy variant as a smoke test. Check classification/health and buyer feedback before expansion; this is too small to claim a precise statistical conversion lift. Continue only with remaining eligible supply and healthy senders.

Success: eligible new-contact intake and positive-reply opportunities increase without worsening failures, stop compliance or response backlog. The target send volume is derived from real supply and provider limits, not “max everything.”

## Work package D: warmer bids and LinkedIn

- [ ] Obtain Derek's earlier LinkedIn proposal and actual platform list. Confirm account access, sales ICP, sender, staff owner and acceptable cadence.
- [ ] Choose one invitation source with usable authorised exports or invitation emails. BuildingConnected is a candidate from the call; do not assume a provider API or universal extraction capability.
- [ ] Pilot ten confirmed open invited bids. Import/stage with source, project identity, buyer, deadline, quote status, owner and next action. Dedup against existing CRM leads/deals. Missing construction Start date is supported by a separate invitation policy, not a broad removal of cold-project date guards.
- [ ] Create LinkedIn follow-up tasks for an initial 20 suitable customer contacts with matched profiles and relevant project context. No arbitrary profile or account-wide automated sends.
- [ ] Use Derek's preferred style: a short introduction, recognisable personality and a spaced follow-up. His “about a week” comment is a proposed timing input, not an agreed complete cadence.
- [ ] Record connect requested/accepted, message/task completed, replies, stop reason, opportunity and staff owner. Manual task completion is separate from an actual sent message receipt.
- [ ] Coordinate LinkedIn/email/call history; stop pending prospecting on buyer reply, unsubscribe, win, archive or staff takeover as appropriate.
- [ ] Keep business-acquisition targets separate from customer project outreach and sales ROI.

Success: the team works warmer existing demand consistently and can trace whether added LinkedIn touches lead to relevant replies, quotes and orders. No fixed DM volume or revenue guarantee.

## Operating cadence and scorecard

Daily during rollout: inspect job coverage, refusals, sender failures, new eligible supply and actionable replies. Weekly: compare comparable source cohorts, review open quotes, select the next highest-value repair/experiment and show work delivered. Twice-monthly client calls follow the call's agreement; the 15th is proposed but unbooked in these artifacts.

Baseline: September 21 wins / $51,665 all-channel booked value; 2,416 completed-status SWPPP messages, 1,331 recorded first-step activities, 1,101 first-seen recipients. These units are separate. Historical positive reply and source-linked close rates are not yet dependable.

First-month business target for discussion: four additional average-sized wins, approximately $9,689 booked value. Define the comparison, project source and sales lag before calling them incremental. Report leading indicators weekly even when sales lag exceeds the month. Obtain margin and cash collection to assess economic return.

## Dependencies

| Input | Work it unlocks | Owner |
|---|---|---|
| Scoped Railway runtime/DB read access | Job/root-cause visibility, schema baseline and safe migration rehearsal | Derek account access with Ivan |
| `.com` sending configuration/history | Whole-system duplication and stop audit | Derek/CRM owner |
| Earlier LinkedIn proposal and account choice | ICP/cadence pilot | Derek |
| Exact platform list/export/invitation examples | Warm-source integration | Milo/Terry |
| Open bid/quote inventory and response ownership | Opportunity recovery | Estimators/sales team |
| Deal/project links, collections, margin and sales-cycle timing | Close rate and measured ROI | Derek/accounting |
| Meeting date/time | Twice-monthly cadence | Ivan/Derek |

These inputs do not prevent dashboard/data-contract planning or the already completed read audit. They determine the supported implementation and which results can be claimed.

## Later backlog from the call

Inspections portal/Claude coaching, remaining state document templates, SEO/state coverage, urgent-intent ads, quiz/nurture, customer reactivation, VSL and automation referrals. Scope each after the current sales work shows reliable progress. Portal coaching versus a full build and vendor cost/site requirements remain open. No revenue-share growth-partner agreement was made.

## Verification and release sequence

- [ ] Read the current spec, audit, repository instructions and full canonical n8n protocol before the relevant work.
- [ ] Use an isolated feature branch/worktree at implementation time; preserve unrelated edits.
- [ ] Establish DB/runtime access and back up before additive migrations; rehearse read-only history ingestion first.
- [ ] Use failure-injection tests for paging, retries, scopes, alias/project identity and side-effect-free history.
- [ ] Run the full suite and production build. Baseline today: 296 tests passed; build passed.
- [ ] Review the UI with T3 preview, role-scoped fixtures and real sampled records.
- [ ] Release through the existing client deployment with a rollback; never push Ivan's repository as Derek's application.
- [ ] Verify the next natural sync/poll cycle and business data-side effects. A green HTTP status or n8n execution alone is insufficient.
- [ ] Report changes delivered, opportunities created, verified outcomes and remaining coverage limits at the next client check-in.

## Planning addition: call-based LinkedIn content

Saved October 7 at Ivan's request: [Derek call-content pilot](2026-10-07-derek-call-content-pilot.md). Bounded automation with Derek reviewing ideas and finished posts; validate with existing call samples first. Separate from managed content delivery and LinkedIn outreach approval. Status: planning only.

## Planning addition: public website

October 7 read-only [website review](../../audits/2026-10-07-public-website-review.md) records mobile content/layout defects, estimate-route improvements, inconsistent rating data and preliminary performance observations. No live website changes authorized or applied by this audit.

Detailed website continuation: [conversion plan](2026-10-07-public-website-conversion-plan.md), [design](../specs/2026-10-07-public-website-conversion-design.md), and [new-chat handoff](2026-10-07-website-chat-handoff.md). Planning saved; website work continues separately.
