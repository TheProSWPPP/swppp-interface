# Contact identity and sequence-stop safeguards

## Scope

Three production modules change: email verification/recovery, Pipedrive primary-email updates, and automatic sequence switching. No database migration or feature-flag change. Existing document/order routes, CRM synchronization, draft generation, enrollment controls and conversation history remain outside this release.

## Task 1: Preserve identity and confirm stops

- Promote only an alternate address already on the same person's fresh CRM record; preserve every remaining address and label.
- Leave another employee's or an unconfirmed Apollo person's address as a review suggestion. Clear any previously resolved address and retain the bad-email hold.
- After requesting sequence removal, read the exact Apollo contact and verify an explicit membership list without the target sequence. Missing, malformed, wrong-contact, still-present or failed reads remain unresolved.
- Both auto-switch branches must retain local enrollment and avoid replacement enrollment until the removal is confirmed. Email cancellation must not clear the CRM marker while any removal remains unresolved.
- Persist unresolved and subsequently resolved stop evidence in the existing engagement-event schema. Commit local send status and resolved evidence atomically so an evidence-write failure keeps the send retryable.
- A wrong, missing or unreadable fresh CRM identity becomes a review outcome and still applies the known-invalid hold.

Verification: focused behavior tests, full suite with an isolated local Postgres database, production build and changed-file lint. Expected: all pass. Private test evidence is retained outside this public repository.

## Task 2: Review and deploy

Fresh independent review of the whole change, then merge through a PR and verify the exact live commit, HTTP health, unchanged configuration and worker behavior. No customer-facing action is generated for testing. A provider removal is not claimed proven live until a natural operation supplies evidence.

## Review focus

Examine malformed membership objects, missing/wrong identities, asynchronous remove acknowledgements, exceptions after partial external effects, both stop callers, preservation of secondary addresses, and interactions with the existing invalid-address cache. Check that no new CRM context/schema dependency or archived-lead selection behavior has entered this release. Review the narrowed source-preservation assertion explicitly.

## Limitations and rollback

A still-pending removal remains unresolved. Existing invalid-address caching can delay its next verification retry; this release does not introduce a retry scheduler. Alternate staff choices and full manual conversation context require their separate release. CRM address writes use a fresh read but are not an atomic compare-and-swap against concurrent staff edits.

Rollback is an app redeploy to the prior healthy revision. Do not restore an older database over intervening staff activity. Existing evidence records remain compatible.
