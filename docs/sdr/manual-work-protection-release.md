# Manual work protection: staged release

This branch is a release candidate, not evidence that live outreach is protected.

## Changed behavior

- Draft edit, refresh, rejection and approval require the revision and context the user saw. A delayed response cannot replace a newer staff revision. Sent draft artifacts are immutable.
- Staff copy and unknown-origin drafts are not silently adopted by automatic retry. Future schedules block immediate enrollment, including generic overrides.
- Project holds have an owner, reason, version and decision history. Application hold and provider-stop status are displayed separately.
- Final enrollment checks the current recipient, company, role, stage, trigger, sender, sequence, cadence and schedule. Role review invalidates old approvals without replacing the draft's copy or recipient.
- Provider contact locks coordinate SDR and permit writers. Durable reservations survive uncertain provider responses. Existing or unexplained memberships cannot be removed and re-added as a collision workaround.
- Existing CRM record updates become review proposals at the shared Pipedrive client boundary. Initial creation and append-only notes remain separate operations.
- Raw CRM events remain separate from later observations. Source ordering prevents older observations replacing newer projected state. Unknown authorship stays unknown.
- Queue acceptance supports a queued note; a completed message receipt is required for a sent claim. Original historical notes are retained.

## Deployment prerequisites

1. Configure and verify `SDR_CRM_COMPANY_ID` for the intended Pipedrive account. Missing company scope blocks protected actions.
2. Apply the additive migrations before routes and workers start. Startup now waits for migrations; a migration failure prevents serving partially protected routes.
3. Populate current accessible lead/person/organization observations with source timestamps and capture sender identity in newly generated/refreshed drafts. Existing unknown sender snapshots require review; do not fill them silently during approval.
4. Update frontend and machine callers together. An old browser tab receives a version conflict and must reload; no implicit approval is inferred.
5. Cover every reachable n8n writer of the protected case's identity, stage, owner, dates, labels, tasks and sequence marker. The locally edited CMD processor alone is insufficient. Weekly tagging, scheduled-task completion, queue dispatch, scoring and import workflows require explicit barriers or proposals.
6. Re-read each correction case and show the exact current values, intended action and provider generation. Never infer a replacement from an organization-ID mismatch alone.
7. Complete the approved observation gate: 48 hours, a full CMD refresh, and representative staff work periods. Record actual checks and timestamps; local tests do not satisfy this gate.

## Staged policy

An explicit versioned company configuration selects observation or enforcement. Missing configuration blocks rollout; it never declares history reviewed. Keep an explicit reviewed lead cohort with an owner, reason and expected context. A changed cohort context remains enforced and blocked for review.

Only the new role/affiliation/cadence-review requirement may run in observation outside that cohort. Technical completeness remains separate from business review. Draft versions, schedules, existing cadence restrictions, scoped holds, current identity/sender checks, contact coordination and uncertain provider-operation protection always apply. Protected existing CRM writes remain proposals in either mode.

Shadow records capture proposed decisions and the actual invariant result, with policy/config versions, action identity and context/source hashes. Writing a shadow record cannot itself create a hold, draft, note or enrollment. The production action path independently enforces the global protections.

Before starting the production observation period, verify both ordinary first-enrollment/manual-draft flows and blocked-path recovery, and quantify the proposed CRM changes that staff will need to review. Do not use an observation flag to bypass a protected pause or resume an unsafe enrollment.

## Recovery and customer communications

An owner/admin can create a replacement review draft from a failed, rejected or cancelled draft after reviewing current context and recording a reason. The old draft and its history remain. Replacement does not clear holds, resume a provider membership or send mail; the new draft requires its own approval. Refresh and replacement preserve existing service and award-only restrictions and invalidate previous review evidence.

Eleven companion n8n workflow candidates have been validated locally; they are not deployed. The Brevo customer audience serves both sales campaigns and customer alerts. Withholding new list entries can therefore affect future alert coverage. Inspect authenticated automation definitions and the required alert audience before releasing those provider changes. Existing memberships are not removed by the candidate.

## Provider limits

Conditional generation-specific removal has not been verified. Unattended project-specific removal therefore remains blocked. An application hold does not stop queued Apollo messages. An explicit current-enrollment operator action and reconciled receipt are still required. Existing contact-wide unsubscribe policy retains its broader scope.

No automatic rollback may re-enroll a contact, resend a message, restore a whole CRM row, or replace later staff edits. Uncertain acceptance remains unresolved until reconciled; the local transaction does not promise exactly-once delivery.

## Verification

Run database tests against an isolated local PostgreSQL database using `SDR_TEST_DATABASE_URL`, then `npm test` and `npm run build`. Tests refuse remote database targets. The full test suite must have no database skips for release validation.

Independent review findings and real case captures belong in the private delivery directory. Public fixtures contain synthetic identities only. This change does not activate LinkedIn or send client updates.
