# ProSWPPP LinkedIn outreach design

> **October 19 execution update:** Ivan subsequently said “Ok go ahead” to the sales execution recommendation, including building and testing the AGC/LBA LinkedIn pilot. Offline implementation is now authorized and in progress. The earlier documents-only statements below record the original approval boundary. They do not cancel this later approval. Live invitations/DMs, campaign activation, paid sourcing and automatic CRM publications remain unapproved. Current evidence: `/Users/ivanmanfredi/.local/state/proswppp-sdr-delivery/2026-10-19-sales-execution/checkpoint.json`.


## October 19 rollout focus

Ivan narrowed the initial plan to selected existing Pipedrive leads, with a small cold test kept optional. Signal-based sourcing is deferred. The proposed starting sequences are AGC and LBA; Ivan said “HCC and LBA”, interpreted here as AGC and LBA because the application labels are AGC (Awarded GC) and LBA (Low Bid Apparent). That interpretation remains open to correction.

The recommended starting priority is AGC, followed by LBA, based on the project stage. Comparative LinkedIn conversion has not been measured. Review candidates after their current email sequence finishes without a reply, checking current project relevance, exact person/company, owner, staff activity and provider membership before any LinkedIn action. A fourth touch describes the ordinary three-email sequence case; award-only and other staff-led cases require separate contextual review. Existing connections and pending invitations must be reconciled before a request or message.

Preserve the same-day first-DM target after acceptance, automatic no-reply reminders and human-reviewed response drafts. Exact follow-up spacing, cohort and account limits still require campaign review. This is a planning update; implementation and live outreach remain unstarted. The broader source ideas below remain preserved for later consideration.

## Purpose and authorization

Add construction buyer conversations and bidder-list opportunities through LinkedIn, with evidence linking outreach to quotes and orders. Scope is ProSWPPP company `13105180`. The current request authorizes an audit and detailed plan. This document proposes implementation; it authorizes no live messages, CRM publications, vendor spending or channel activation.

The accepted behavior comes from [Ivan's October 9 decisions](/Users/ivanmanfredi/.local/state/proswppp-sdr-delivery/2026-10-09-outreach-map/LINKEDIN-DECISIONS.md): first DM on the day of acceptance, automatic no-reply follow-ups, any reply stops prospecting, and a response draft for staff to review and send. Earlier proposals mentioning a three-day first DM are superseded. The October 13 commercial plan supplies the construction audience and Pipedrive-first operating model.

## Audience and source

Cover medium/large general contractors, design-build firms, developers and sitework contractors. Relevant roles are pre-construction directors/managers, chief estimators, senior project managers and estimators. Keep three source segments separately measurable: selected existing Pipedrive contacts, independently verified recent role/activity contacts, and an ICP-matched cold comparison.

Every staged candidate carries a canonical LinkedIn profile URL, original source and observation date, company/role evidence, proposed territory, segment and exact CRM identity evidence. A role change may be mentioned only when its source and date support it. Name/company similarity alone never approves a profile match. Ivan's personal-brand ICP rubric is outside this construction campaign.

Use available authorized exports and existing records. Do not run a paid sourcing service. New contacts can be staged without creating CRM records. Eligibility for a live touch requires a verified CRM person, organization and current responsible owner. A lead/project association is optional for new contacts and must have independent evidence when supplied. Multiple project links remain separate. Uncertain contact, owner, territory or source is a review state.

## System ownership and file boundaries

Use the existing Express/Postgres service as the only owner of the LinkedIn state machine. No new n8n sender or T3 recurring monitor is planned. Server-side configuration fixes company and allowed sender account; browser input cannot select another tenant or arbitrary provider account.

Proposed modules: `sdrLinkedinClient.js` for provider transport, `sdrLinkedinIdentity.js` for profile/CRM association, `sdrLinkedinStore.js` for transactions and observations, `sdrLinkedinPolicy.js` for eligibility and sequence decisions, `sdrLinkedinOperations.js` for outbound intents and reconciliation, `sdrLinkedinSync.js` for event processing and bounded recovery, `sdrLinkedinDrafts.js` for staff drafts/handoff, `sdrLinkedinReplyStops.js` for mapped reply holds and native-stop inspection, `sdrLinkedinRoutes.js` for authorized reads/reviews and webhook intake, `sdrLinkedinReporting.js` for facts, and `sdrLinkedinRuntime.js` for the bounded scheduler. Tests live beside the existing SDR tests. Candidate/status/reply review can use one small optional app panel; Pipedrive ownership and native LinkedIn sending remain the staff workflow.

Reuse patterns from `sdrJobRuns`, `sdrAccess`, `sdrOutreachControls`, `sdrCrmGuard`, `recentReply`, and `sdrFollowupHandoffs`. Their email-specific contracts require explicit adaptation. In particular, `isCustomerLead` unknown results must block automatic sending; `recipientEmail` cannot stand in for a LinkedIn provider ID.

## Modes and approvals

`SDR_LINKEDIN_MODE` is `disabled` by default. `observe` records events and health but creates no drafts, CRM notes or outbound actions. `dry_run` can produce private draft/action previews against fixtures or authorized observations, with outbound transport disabled. `live` requires an explicitly approved campaign revision plus account and rollout checks. Mode alone never approves an unreviewed campaign.

Store campaign revision, copy versions, source segments, territory list, account timezone, allowed owner mapping, invitation/DM budgets, spacing, stop policy and expiry as a complete immutable approval snapshot. Changing copy, timing, account, cohort or limits invalidates approval. Proposed settings below are the planner's recommendations, with approval unset.

## Persistent records

An additive migration creates:

- `sdr_linkedin_accounts`: company/account/product identity, verified sender identity, status and status observation time, sync cursors/coverage and mode. No API keys or login URLs.
- `sdr_linkedin_campaigns`: versioned campaign configuration, approval status and cohort digest.
- `sdr_linkedin_candidates`: company, account, canonical person identity and segment/source, current owner and lifecycle state. Prevent simultaneous active campaigns for the same company/account/person.
- `sdr_linkedin_links`: evidence-backed CRM person/org/project/verified email associations and conflicts. Do not collapse several projects into one by matching a person.
- `sdr_linkedin_events`: account-scoped provider event/message IDs, relationship/direction/time, source and safe payload, linked or unresolved identity. V1 does not establish a universal webhook event ID. Deduplicate relation transitions by account/person/evidence; deduplicate messages by account/provider message ID. Retain authenticated source receipts and payload hashes for redelivery without inventing event IDs.
- `sdr_linkedin_actions`: immutable candidate/campaign/step/revision context, due time, unique operation key, reservation fence, attempt state, request hash and provider receipt. Record the actual network boundary and reconciliation result.
- `sdr_linkedin_drafts`: account/person/chat/inbound-message scope, owner/author visibility, revision/context hash, editable unsent body and optional handoff receipt. Never overwrite a staff-edited revision on a repeated event.

Use company/account/person keys for channel concurrency. Claim an action transactionally with a fence; commit before provider I/O. The dispatcher and event processor use the same account/person advisory lock for local final checks and state changes. Acquire the person advisory lock first, then reserve account capacity in a short row-locked transaction and commit before network I/O. Never wait for a person lock while holding an account budget row. Release local reply-processing locks after committing the hold before invoking any cross-provider inspection. Test two people sharing one account budget. Do not hold a broad account row lock during network I/O. Never rely on a lease expiry as evidence that a provider action did not occur.

## Provider contract

Use one v1-only adapter against the existing approved api38 DSN capacity. Current credential validity and Derek's account remain unverified. A 400/401 credential failure blocks live integration while local fixtures remain usable. A v2 migration would require separate organization/application/key/account setup and an explicit decision; it is outside this initial build.

Documented v1 capabilities include profile reads, pending invitations and relations, `new_relation` and `message_received` events, Classic first-chat sends, known-chat messages, accounts and hosted authentication. Product IDs remain distinct: Classic ACo, Sales Navigator ACw and Recruiter identifiers must be resolved through supported profile lookups. Restrict this first release to LinkedIn Classic; InMail and group messaging are excluded.

For every read or action, the adapter accepts a bound account ID from server configuration and rejects mismatched payloads or foreign recipients. Keep keys in approved server secret storage. Any future login route uses a short-lived one-time state bound to company and administrator, verifies the returned account via authenticated read, and records the verified sender identity. Generating or distributing a link is a separate operation from this audit.

V1 webhook authentication uses the configured static `Unipile-Auth` header, checked in constant time. No native HMAC or replay timestamp is assumed. Bound body size, validate the fixed account scope, persist authenticated observations before returning 200 within the documented delivery timeout, and deduplicate retries. Compare `account_info.user_id` with `sender.attendee_provider_id` to distinguish incoming and outgoing messages; hold unknown direction. Record malformed or unresolved events without creating outbound actions. [Provider webhook contract](https://developer.unipile.com/docs/webhooks-2).

## Sequence behavior

`staged → reviewed → invite_due → invite_sent → relation_observed → dm1_due → dm1_sent → followup_due → completed_no_reply`. Alternative states include `already_connected_review`, `replied`, `staff_takeover`, `held`, `opted_out`, `archived`, and `uncertain_provider_result`.

An existing connection does not generate a fictitious invitation/acceptance. Review its history and source context before a separate approved DM1 action. An existing pending invitation is adopted only with exact sender/person evidence; do not invite again. Use a known chat for follow-ups and normal staff conversation.

DM1 enters a candidate due state immediately after verified relationship observation. A late-acceptance policy may still hold dispatch. Proposed worker target is within 15 minutes of processing the event, subject to account safety and capacity. Record provider event time, relationship observation time and actual message time independently. The v1 service documents delays up to eight hours for acceptance events; the actual acceptance timestamp may remain unknown. Report same-day-from-observation and known actual acceptance separately. Late or unverified cases receive explicit reasons. Reserve DM capacity for due first messages before new invitations.

Use relationship events as primary detection. Perform bounded pending-invitation reconciliation on recovery and at most one randomly spaced planned sweep per day, within the account request budget. Do not repeatedly scan full connections lists. These checks reduce missed observations but cannot establish real-time detection.

Recommended unapproved configuration: no invitation note for the first cohort; first no-reply follow-up three business days after confirmed DM1; final follow-up seven business days after DM1; then close the sequence. Proposed sender timezone is `America/Chicago`; invitations and follow-ups use weekdays 08:00–17:00 in that timezone. DM1 is event-driven throughout the sender's calendar day. The approved default `lateAcceptancePolicy=hold` prevents a known or suspected next-day acceptance case from dispatching automatically. For campaign review, the recommendation is `send_on_verified_observation`, recording a missed or unknown acceptance-day target. Neither setting changes the agreed same-day target. Unknown customer/history, an unhealthy account or exhausted permitted capacity always holds the action. No unsafe catch-up burst is allowed. Follow-up intervals, final copy and exact account limits remain unset in approved configuration, so live actions remain disabled.

Version the already proposed new-role, cold and project-context messages. Render only verified name/company/project/state facts. Use the approved state term or the previously agreed generic SWPPP fallback; block unsupported service claims. Never generate automatic custom replies from model output.

## Final eligibility and cross-channel protection

The first pilot excludes active native Apollo memberships and holds unknown membership evidence. Immediately before a provider write, check current approval/cohort revision, exact account/person/product, current CRM owner/lifecycle/customer status, holds, existing invite/relation/chat history, pending/confirmed prior actions, all observed inbound and staff outbound, and observation freshness. Proposed maximum age for eligibility reads is five minutes; disconnected, partial or unknown history holds the action. Provider reads that fail or exceed their budget produce a hold with a retry reason.

Any LinkedIn inbound stops queued prospecting for the verified person across campaigns/projects before drafting. Unknown inbound classification also holds prospecting. Existing email human replies retain their current 180-day guard. LinkedIn person-to-email evidence extends that guard for verified addresses only. Unmatched replies hold the known provider person and account scope without guessing a CRM project. Staff outbound unmatched to our own action receipts sets takeover. Owner changes invalidate pending context and route the case to review.

The LinkedIn reply coordinator commits its app hold first. For independently verified owned Apollo memberships, it may call `stopOwnedEnrollment()` to persist inspection/protected status. The current helper does not remove native memberships; native stop remains unresolved. Do not pass LinkedIn events into the Gmail-shaped `enqueueReplyActions()` coordinator or fabricate email records. Preserve email copy/cadence and enrollment behavior, with the additive mapped-person reply guard preventing future app enrollment. Overlapping native activity requires explicit review; external reenrollment remains a limitation. A later native-stop mechanism would need separate provider-contract proof and independent review.

Local locks cannot prevent a remote reply between the final provider read and its send acceptance. Recheck as late as practical and serialize local event/action handling. Record and investigate a late-arriving inbound race; promise neither global exactly-once delivery nor a perfect remote no-race guarantee.

## Uncertain outcomes and account limits

Create one unique intent per company/account/person/sequence step, with content/campaign revisions as immutable context. Reapproval alone cannot create a second DM1. After timeout or uncertain remote failure, retain `uncertain_provider_result` and perform read-only reconciliation. A message with exact returned provider ID can confirm an action. A text/time match without an unambiguous unique source remains unresolved. Delayed absence never authorizes replay. Invitations use pending request and relationship evidence similarly.

Pause on account/product disconnection, restrictions, invalid permissions or provider throttling. Honor documented API retry timing for reads; provider restrictions require review. Derive numeric send/invite limits from the actual account and approved pilot configuration. Default budgets are zero; no universal safe cap is asserted.

## Reply draft and staff handling

After an inbound, create one private source-grounded draft for the verified current owner. Use the exact message and relevant confirmed project/service context. Missing pricing, plan revisions or scope become questions for staff; never invent a price. A generic acknowledgment may be suggested privately. No reply is auto-sent.

A reviewed Pipedrive note can carry conversation context, unsent response and a tested native LinkedIn conversation link. Automatic publication is separately controlled and initially off; note creation is a CRM write. Preserve owner/author access and staff edits. Until a native conversation link is tested on the connected account, mark handoff unavailable; an API chat ID alone does not prove a working browser link. Staff send through native LinkedIn in the first release. API-based human reply sending is a later optional extension.

## Completion and rollout

Offline build is complete only when deterministic fake-provider journeys, real Postgres races, authorization tests and reporting tests pass with all external writes disabled. This is separate from a connected live pilot.

Connected rollout requires verified sender/Classic permissions, pinned real read payloads, webhook verification, current profile source and reviewed cohort, approved copy/timing/account limits, working staff conversation access, and an explicitly authorized controlled send. Read back actual invitation/DM IDs and prove a real inbound cancels future touches. Then expand only from observed account health and buyer outcomes. Disable mode halts new dispatch; preserve all events and uncertain receipts.

Measure reviewed eligible candidates, confirmed invitation submissions, separately verified prospect acceptance/relations, confirmed DMs, inbound conversations, interested replies, bidder-list additions, invitations to bid, quotes and won orders. Keep segment/cohort/time-window denominators and attribution evidence. Exclude synthetic tests and pre-existing company wins. Surface partial collection and unresolved outcomes.

## Review and proposed settings

An independent builder reviewed the corrected v1 contract, local lock order, person-level suppression, protected native Apollo status, late-acceptance hold, private drafts and staged rollout. No remaining blocker to the offline build plan was reported. Proposed settings are planner recommendations for campaign review. Ivan's document-save approval does not approve implementation, timing, a cohort or any live action.
