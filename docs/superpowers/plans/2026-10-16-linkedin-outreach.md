# ProSWPPP LinkedIn Outreach Implementation Plan

> **October 19 execution update:** Ivan subsequently said “Ok go ahead” to the sales execution recommendation, including building and testing the AGC/LBA LinkedIn pilot. Offline implementation is now authorized and in progress. The earlier documents-only statements below record the original approval boundary. They do not cancel this later approval. Live invitations/DMs, campaign activation, paid sourcing and automatic CRM publications remain unapproved. Current evidence: `/Users/ivanmanfredi/.local/state/proswppp-sdr-delivery/2026-10-19-sales-execution/checkpoint.json`.


> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task after implementation is authorized. All checkboxes below are future work.

**Goal:** Build the complete construction LinkedIn channel and prove its offline behavior before connecting the sender.

**Architecture:** The existing Express/Postgres app owns identity, sequence state, observations, outbound intents and private drafts. An injected Unipile v1 adapter binds the exact sender account. Pipedrive retains staff ownership; native LinkedIn provides human reply sending in the initial release.

**Tech Stack:** Existing Node ES modules, Express 5, Postgres/pg, React/TypeScript and Vitest 4. No new paid vendor or required service.

**Spec:** [Reviewed design](../specs/2026-10-16-linkedin-outreach-design.md)

**Audit:** [Read-only audit](../../audits/2026-10-16-linkedin-outreach-audit.md)

**Baseline:** Audited live/remote main `bddb499b38d86c7d47ed0d75131deacbb583ce62`. Refresh before implementation and use an isolated worktree. Preserve the older working checkout and unrelated changes.

**Status:** Documents finalized only. No implementation, provider connection, production change or live outreach is authorized by the save approval. Independent builder review found no remaining offline-plan blocker.

**October 19 scope update:** Start with selected existing Pipedrive leads from the proposed AGC/LBA sequences after completed unanswered email outreach and fresh context checks. AGC-first priority is a recommendation based on project stage. Ivan's spoken “HCC” is provisionally interpreted as AGC. Keep a small cold test optional and defer signal-based sourcing. The [dated design update](../specs/2026-10-16-linkedin-outreach-design.md#october-19-rollout-focus) takes precedence over the broader initial source mix below. No implementation or launch is authorized by this planning revision.

## Global constraints

- Company is `13105180`; the server binds one verified sender account and LinkedIn Classic product.
- Initial API is existing api38 v1. No v2 migration or new charge is included.
- Default mode is disabled; approved action budgets start at zero. Campaign approval pins source/cohort, sender, copy, waits, territory, owner route, limits and expiry.
- Same-day first DM remains the target. Record actual acceptance when known, observation and send time separately. V1 acceptance events can lag eight hours.
- Proposed review settings: first follow-up three business days after confirmed DM1, final follow-up on business day seven; America/Chicago; weekday 08:00–17:00 for invitations and follow-ups. DM1 is event-driven with a proposed 15-minute processing target after verified observation.
- `lateAcceptancePolicy=hold` is the approved safe default for a known/suspected next-day case. `send_on_verified_observation` is a recommendation requiring explicit campaign approval. A due candidate is not permission to dispatch.
- Any inbound holds prospecting. Existing email human replies retain the 180-day guard; verified LinkedIn-to-email links extend future enrollment suppression.
- Initial LinkedIn eligibility excludes active native Apollo memberships and holds unknown membership evidence. The current stop helper does not establish a native stop.
- Preserve owners, holds, customers, scoring, existing email sequence copy/cadence, staff-edited drafts and independent project associations.
- Unknown required evidence and uncertain provider outcomes hold writes. No automatic POST retry and no replay caused by lease expiry.
- Staff custom replies remain unsent drafts until human action. Pipedrive note publication is a separately enabled CRM write.

## Review focus

1. Same person across projects or identifier namespaces: one person-level sequence, evidence-backed links and no guessed attribution. Tasks 1, 4, 6.
2. Reply, staff outbound, owner or hold change near dispatch: cancel when observed before the local network boundary; report late remote races. Tasks 3, 5, 6.
3. Process death after provider acceptance: preserve uncertainty across restart and never treat empty history as proof of failure. Task 6.
4. Late acceptance, midnight/DST, partial history and account restriction: no fabricated same-day claim or catch-up burst. Tasks 2, 3, 4, 8.
5. Shared sender and several staff users: by-ID owner/author checks, private drafts and no unlinked-conversation leak. Tasks 5, 7.

## Files and shared contracts

Create `migrations/2026-10-16-sdr-linkedin-channel.sql` and the focused `lib/sdrLinkedin*.js` modules below. Register only the required feature hooks in `server.js` and `lib/sdrJobRuns.js`; extend `lib/recentReply.js` for verified mapped replies. Keep channel facts separate from email-shaped reporting tables.

- `Identity`: company/account/Classic recipient/profile URL, verified CRM person/org/owner, independently evidenced lead links, verified emails and revision. CRM fields may be empty during staging; sending requires a verified person/org/owner.
- `Observation`: fixed account, kind, optional source event/message IDs, recipient/chat, source time, observation time, direction, source and coverage. Unknown fields do not prove acceptance or inbound classification.
- `Action`: stable company/account/person/step identity, campaign revision, due time, context hash, reservation fence, network boundary state and provider receipt. A copy revision cannot create a second DM1.
- `Decision`: allowed/reasons/due time/context hash/evidence revision. Eligibility checks do not themselves execute.
- `ProviderResult`: confirmed, definite rejection or unknown, with provider IDs, request hash, observation time and documented retry metadata. A successful HTTP submission never implies delivered or read.

Each task follows failing tests, the minimum implementation, passing checks, independent review and a task-only commit. Run tests against a separate test database. Missing database setup must fail critical integration checks rather than silently skip them.

## Task 1: Candidate persistence and exact identity

**Model:** `gpt-6-sol`; independent reviewer `gpt-6-sol`.

**Files:** Create the migration, `lib/sdrLinkedinStore.js`, `lib/sdrLinkedinIdentity.js`, `lib/__tests__/sdrLinkedinStore.test.js` and `lib/__tests__/sdrLinkedinIdentity.test.js`.

**Interfaces:** `stageCandidate(db,{companyId,accountId,sourceRow,actor})`; `resolveIdentity(db,{candidateId,expectedRevision,evidence,actor})`; `readCandidate(db,{companyId,candidateId})`; `withLinkedinPersonLock(pool,identity,work)`.

- [ ] Write failing real-Postgres tests for duplicate import/source row, the same person across projects, conflicting profile/employer, ACw/ACo separation, missing owner, cross-company lookup and concurrent active-campaign uniqueness. Test conditional revisions and additive migration reruns.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedinStore.test.js lib/__tests__/sdrLinkedinIdentity.test.js`; confirm the expected missing-schema/function failure.
- [ ] Implement the seven design tables: accounts, campaigns, candidates, CRM links, events, actions and private drafts. Scope all reads/writes and unique keys by company/account. Stage authorized export fields including exact profile URL, source/date, firm/role, segment and territory. Do not create CRM records or infer identity from names.
- [ ] Re-run the tests; assert unrelated tables and existing hold fixtures are unchanged. Review and commit only these files.

## Task 2: Bound v1 provider adapter and synthetic fixtures

**Model:** `gpt-6-sol`; independent reviewer `gpt-6-sol`.

**Files:** Create `lib/sdrLinkedinClient.js`, `lib/__tests__/sdrLinkedinClient.test.js`, and `lib/__tests__/fixtures/linkedin/` with a contract README.

**Interfaces:** `createLinkedinClient({baseUrl,apiKey,accountId,transport,allowWrites:false})`; reads `getAccount`, `getSelf`, `getProfile`, `listSentInvites`, `listRelations`, `findChats`, `getChat`, `listMessages`; writes `invite`, `sendFirst`, `sendInChat`. The adapter rejects per-call account overrides.

Binding v1 routes: profile `GET /users/{identifier}?account_id=...`; pending invitations `GET /users/invite/sent`; relationships `GET /users/relations`; JSON invitation `POST /users/invite` with account_id/provider_id/message; chat lookup `GET /chat_attendees/{attendee_id}/chats`; multipart first DM `POST /chats` with account_id/text/one attendees_ids; multipart continuation `POST /chats/{chat_id}/messages` with text and explicit account_id. Prefix these paths with the approved DSN `/api/v1`. Validate every returned chat's sender account. Preserve profile/product namespaces.

- [ ] Write failing request-spy tests for exact routes/body/content type, pagination and frozen cursors, disabled writes, foreign accounts/chats, malformed results, auth errors, throttles, timeouts and unknown 5xx results. Assert at most one POST attempt.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedinClient.test.js` and confirm intended failures.
- [ ] Implement injected transport, bounded read retries, safe errors and normalized results. Document v1-specific fields from official sources in the fixture README. Secrets remain server-side.
- [ ] Re-run tests, independently review and commit. Label fixtures synthetic until later bounded account reads validate them.

## Task 3: Incoming observations and acceptance recovery

**Model:** `gpt-6-sol`; independent reviewer `gpt-6-sol`.

**Files:** Create `lib/sdrLinkedinSync.js`, `lib/__tests__/sdrLinkedinSync.test.js`; add the webhook subroute to `lib/sdrLinkedinRoutes.js`.

**Interfaces:** `verifyLinkedinWebhook({headers,secret})`; `ingestLinkedinEvent(db,{boundAccountId,payload,receivedAt})`; `processLinkedinEvents({pool,client,companyId,accountId,limit,now})`; `reconcileLinkedinAccount({pool,client,accountId,budget,now})`.

- [ ] Write failing tests for correct/incorrect static secret, foreign account, malformed events, redelivery with no universal event ID, webhook/read overlap, out-of-order acceptance and reply, missing acceptance time, manual outbound, partial pagination and restart after persistence.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedinSync.test.js` and confirm intended failures.
- [ ] Implement constant-time `Unipile-Auth` checking, bounded body parsing and durable ingestion before 200 acknowledgment. V1 has no assumed HMAC/timestamp signature. Deduplicate messages by account/message ID and relation transitions by account/person/evidence. Determine message direction from provider actor fields; hold unknown direction. Apply inbound holds under the person lock before drafting.
- [ ] Implement event-first acceptance, targeted relationship verification and bounded randomly spaced daily recovery reads. An invitation disappearing is not acceptance. Preserve partial coverage and actual/unknown time fields.
- [ ] Re-run tests, review and commit. Observation processing performs no provider message or CRM publication.

## Task 4: Pure campaign and sequence policy

**Model:** `gpt-6-sol`; independent reviewer `gpt-6-sol`.

**Files:** Create `lib/sdrLinkedinPolicy.js` and `lib/__tests__/sdrLinkedinPolicy.test.js`.

**Interfaces:** `validateLinkedinCampaign(config)`; `renderLinkedinStep({campaign,identity,facts,step})`; `planLinkedinNextAction({candidate,campaign,observations,now})`; `checkLinkedinEligibility({identity,campaign,crm,controls,replies,history,account,now})`.

- [ ] Write failing cases for pending invite, already-connected review, verified relation, first-DM priority, no-reply progression, reapproval without duplicate DM1, and every hold condition. Test proposed business-day waits, weekends, both DST changes, midnight and late-policy hold versus approved send-on-observation.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedinPolicy.test.js` and confirm intended failures.
- [ ] Implement immutable campaign approval digests and disabled/zero approved defaults. Require current required evidence within five minutes, exact profile/CRM identity, known healthy account, no active/unknown Apollo membership, and no conflicting staff work. Treat unknown customer-helper results as held.
- [ ] Render only verified company, role-change, project and state/service facts. Use approved local terminology or the agreed SWPPP fallback. Keep the proposed three/seven-day settings and late-acceptance recommendation unapproved.
- [ ] Re-run tests, review and commit.

## Task 5: Person-level reply protection and private staff drafts

**Model:** `gpt-6-sol`; independent reviewer `gpt-6-sol`.

**Files:** Create `lib/sdrLinkedinDrafts.js`, `lib/sdrLinkedinReplyStops.js`, `lib/__tests__/sdrLinkedinDrafts.test.js`, `lib/__tests__/sdrLinkedinReplyStop.integration.test.js`; modify `lib/recentReply.js`. Reference `lib/sdrProviderOperations.js` without weakening its protected-state rules. Preserve the Gmail-shaped coordinator in `sdrReplyActions.js` and `inboxReplyWatch.js`.

**Interfaces:** `handleLinkedinReply({pool,identity,observation,mode,draftGenerator})`; `inspectLinkedinMatchedEnrollments({pool,apollo,identity,sourceMessageId})`; `readLinkedinDraft(db,{candidateId,viewer})`; `saveLinkedinDraft(db,{draftId,expectedRevision,contextHash,body,viewer})`; `previewLinkedinHandoff(context)`, `publishLinkedinHandoff(context)`, `reconcileLinkedinHandoff(context)`.

- [ ] Write failing cases for reply before DM1/between follow-ups, unknown inbound, mapped email across projects, unmapped person, manual takeover, owner change, repeated source event, staff-edited draft and stale publication preview. Test foreign-owner/by-ID denial.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedinDrafts.test.js lib/__tests__/sdrLinkedinReplyStop.integration.test.js lib/__tests__/recentReply.test.js`; confirm new cases fail and existing email behavior remains covered.
- [ ] Commit the app hold/cancellation first, then create the private draft and inspect any independently verified owned Apollo membership. Release local locks before cross-provider inspection. `stopOwnedEnrollment` records protected/unresolved status; it does not prove removal. Never forge an email observation or call the Gmail coordinator unchanged.
- [ ] Extend future email enrollment suppression through verified LinkedIn-person/email links for the existing 180-day interval. Keep channel drafts independent of email draft rows; preserve staff revisions and private visibility. Observe mode creates no draft; dry-run may create private previews, never provider writes or CRM publications.
- [ ] Keep Pipedrive note publication separately disabled pending explicit enablement and current human preview. Native LinkedIn is the staff send control, gated on a working tested conversation link. Re-run tests, review and commit.

## Task 6: Durable dispatcher and uncertain results

**Model:** `gpt-6-sol`; independent reviewer `gpt-6-sol`.

**Files:** Create `lib/sdrLinkedinOperations.js` and `lib/__tests__/sdrLinkedinOperations.integration.test.js`.

**Interfaces:** `dispatchLinkedinAction({pool,client,actionId,readFreshContext,now,mode})`; `reconcileLinkedinAction({pool,client,actionId,now})`.

- [ ] Write failing real-Postgres races for two workers on one action, one person across projects, different people sharing a budget, owner/approval/hold/customer changes and inbound during final checks. Test process death before network I/O and after provider acceptance.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedinOperations.integration.test.js` and confirm intended failures.
- [ ] Implement stable per-step reservation/fencing. Acquire person lock, reserve the account budget in a short transaction, commit before I/O and never hold the budget row while waiting for a person lock. Prioritize due DM1 capacity. Re-read current context immediately before one POST boundary.
- [ ] Persist network-start state and actual IDs/receipts. Timeout, uncertain 5xx, expired lease and delayed empty history cannot trigger replay. Read-only reconciliation confirms only an unambiguous result; identical staff text remains unresolved. Document the unavoidable remote reply/send race.
- [ ] Assert no provider call in disabled/observe/dry-run modes. Re-run tests, review and commit.

## Task 7: Authorized review, runtime and reporting

**Model:** `gpt-6-sol`; independent reviewer `gpt-6-sol`.

**Files:** Complete `lib/sdrLinkedinRoutes.js`; create `lib/sdrLinkedinRuntime.js`, `lib/sdrLinkedinReporting.js` and corresponding tests; add `src/lib/sdrLinkedinApi.ts`, `src/components/sdr/LinkedinReview.tsx` and component tests. Modify only required registration points in `server.js`, `lib/sdrJobRuns.js` and existing SDR navigation.

**Interfaces:** `registerSdrLinkedinRoutes(app,{pool,companyId,mode,client,visibility})`; `startLinkedinRuntime({pool,client,companyId,mode,scheduler,now})` returning `stop()`; `readLinkedinMetrics(db,{companyId,accountId,cohort,from,to,viewer})`.

- [ ] Write failing tests for human session/owner scope, machine or foreign-tenant denial, guessed IDs, strict inputs, missing credentials/schema/account, hosted-link state/name reuse, callback account mismatch and persistence failure. A hosted-link route must bind/verify the v1 notify callback, never trust an account ID from browser input.
- [ ] Test disabled startup, duplicate runtime exclusion, bounded work, stop(), account restriction and private shared-account health visibility. No T3 recurring monitor is created.
- [ ] Test metrics distinguishing staged candidates, confirmed invitation submissions, prospect acceptance/relations, confirmed DMs, inbound/interested replies, quotes and orders. Keep source/cohort/time denominators, test exclusions, partial coverage and uncertain outcomes. Use independent CRM evidence for attribution.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedinRoutes.test.js lib/__tests__/sdrLinkedinRuntime.test.js lib/__tests__/sdrLinkedinReporting.test.js` and the component tests; confirm expected failures, then implement the minimal optional review panel and runtime registrations. Pipedrive remains the staff workspace. No arbitrary browser account/recipient/message send endpoint.
- [ ] Re-run tests, `npm run build`, changed-file lint and review; commit only these files.

## Task 8: Complete offline proof and separate connected pilot

**Model:** `gpt-6-sol`; independent whole-channel architecture reviewer `gpt-6-astra`.

**Files:** Create `lib/__tests__/sdrLinkedinJourney.integration.test.js` and `docs/sdr/linkedin-rollout.md`; example configuration stays secret-free and disabled.

- [ ] Build fake-provider/real-Postgres journeys for invitation, delayed acceptance, DM1 and both no-reply follow-ups. Repeat as separate test cases with replies/takeover at each boundary, already-connected review, unknown-send restart, identity conflict and account restriction. Reject non-fixture network destinations.
- [ ] Run `npx vitest run lib/__tests__/sdrLinkedin*.test.js lib/__tests__/sdrLinkedin*.integration.test.js`, relevant existing SDR regressions, `npm test`, `npm run build` and changed-file lint. Assert critical database tests actually ran. Document independently reproducible pre-existing failures without weakening the new gate.
- [ ] Produce an offline acceptance receipt with commit/schema version, commands/results, disabled runtime, demonstrated invariants, review findings and remaining live dependencies. No claim of connected behavior follows from fixtures.
- [ ] Later, after separate authorization, restore/verify credential and sender/Classic identity, capture bounded real read payloads, verify webhook delivery/account scope, account-derived limits and native conversation link. Resolve the earlier account-check approval gate through its proper route.
- [ ] Stage a dated real cohort and obtain complete campaign approval covering copy, waits, late-acceptance policy, source/territory, budgets, owner handoff and authorized actions. No fixed cohort size or account cap is invented here.
- [ ] Execute only authorized live test actions, read back actual IDs, demonstrate inbound cancellation and staff conversation access, then decide expansion from measured health and buyer outcomes. Disabling mode halts new dispatch and preserves history/unknown receipts.

## Completion definitions

**Offline ready:** complete software paths and synthetic provider/real-DB failure tests pass with external writes disabled.

**Connected ready:** exact sender, credentials, actual read contracts, authenticated observations and staff source links are verified.

**Pilot ready:** a reviewed real cohort, approved settings and numeric limits, working handoff and explicit live-action authorization exist.

**Operating:** actual provider receipts and demonstrated reply cancellation exist; outcome reporting retains coverage and attribution limits.

## Review and source trail

The independent builder checked the corrected v1 contract, lock order, relation/message deduplication, current Apollo protected-state limitation, late-policy gate, privacy and eight task dependencies. No remaining offline-plan blocker was reported. Proposed campaign settings remain unapproved.

Detailed code/provider evidence and the initial builder review are preserved under `/Users/ivanmanfredi/.local/state/proswppp-sdr-delivery/2026-10-16-linkedin-audit/`. Final corrected-plan review is recorded in this thread. Official contract sources: [v1 accepted invitations](https://developer.unipile.com/docs/detecting-accepted-invitations), [v1 webhook authentication](https://developer.unipile.com/docs/webhooks-2), [v1 messaging](https://developer.unipile.com/docs/send-messages). The audit/design hold the complete evidence and authorization boundary.
