# Provider operation protection — local implementation, October 7, 2026

The Apollo adapter has no verified generation-conditional removal. The automatic stop executor therefore makes **zero removal calls**. A fresh contact read or local advisory lock does not change that policy. It records the expected local send/generation and a review reason. Provider mail may remain scheduled.

Current-enrollment operator removal remains an explicit review action; this change does not implement an operator removal endpoint. Its contact+campaign scope and the external remove/re-add race must be shown before execution. Established contact-wide unsubscribe is a separate policy and is not represented as project-only cancellation.

## Implemented callers

| Caller | Protection |
|---|---|
| `sdrAutoSwitch.runAutoSwitch` | Context changes produce durable stop review and an unresolved engagement event. No generation, marker clear, replacement enrollment, or provider removal. Cleared identity/trigger fields also invalidate the context. |
| `apolloCollision.campaignsToRelease` | No campaign is released automatically, including finished campaigns. |
| `inboxReplyWatch.createReplyActionClients.stop_sequence` | Shared durable executor, no broad removal, no stopped receipt inferred from absence. Existing reply-message/action foreign keys retained. |
| Legacy inbox reply and bounce | Shared executor; no raw removal; bounce notes report provider-stop review. |
| Reply marker clearing | Existing marker is preserved; no GET/PATCH claim of conditional safety. Already empty marker can be observed. |
| `sdrReplyActions.enqueueReplyActions` | Stop target includes send ID so reused contact/campaign generations remain separate. |
| Email verification cancellation | Preserves pending/approved/edited/rejected drafts and CRM marker; persists a scoped hold before shared stop review. Failed identity promotion remains a proposal. |
| Permit manual and automatic send | Shares global/contact/lead lock and durable reservation before any shared custom fields; obeys recipient holds and SDR/permit historical membership protection. |
| `apolloEngagementPoll` | Continues collecting message progress. Neither message status nor its message-derived enrollment ID establishes generation ownership in the new stop executor. |

## Enrollment integration contract

Match the Apollo contact before acquiring locks. `withProviderContactLock(pool, contactId, leadIds, callback)` takes a shared global-control lock, then locks the provider contact and sorted lead IDs, using the same lead key as existing transaction locks. Hold this scope through shared-field writes and provider enrollment. A rejected second project must never reach shared-field mutation.

Inside that scope, call `reserveEnrollment({pool: client, apollo, context, draftRevision, actionId})` on the autocommit connection **before** provider writes. The reservation must survive any later transaction rollback. Calling reservation with a pool acquires its own locks for the reservation only; callers still need the outer scope for subsequent writes. It enforces scoped controls, complete context, future schedule, provider membership visibility, all prior SDR and permit send history plus completed-message contact cooldown and all outstanding/prior contact operations. Existing or absent historical memberships require review; no replacement/resume shortcut is implemented.

The final caller must also verify the viewed draft revision/context and role policy before changing shared fields. The reservation is not an approval receipt. `recordEnrollmentReceipt` requires an actual provider receipt ID and matching contact/campaign. An uncertain attempt remains reserved/unresolved and cannot be replayed; reconciliation never claims success from current absence or a generic contact presence. Local storage cannot promise exactly-once provider delivery.

Parent-owned integration seams: `server.js` automatic/manual enrollment, engagement handlers and contact-wide unsubscribe. Their coverage must be verified separately before a release claim.

## Verification scope

Synthetic local PostgreSQL fixtures exercise reused generation IDs, changed added-at fallback, same-lead reuse, unexplained pause/absence, durable logical operation identity, uncertainty without repeat mutation, concurrent contact reservations, contact serialization and interoperability with draft lead locks. No production provider/database call or real CRM fixture is used.

Unverified generation-conditional support and absent reviewed resume/operator-removal routes are deliberate fail-closed limits, not completed provider-stop capability. No deployment or production containment is claimed.
