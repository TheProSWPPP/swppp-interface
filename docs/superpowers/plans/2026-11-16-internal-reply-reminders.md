# Internal Reply Reminders Implementation Plan

**Goal:** Notify staff about unresolved existing reply tasks inside their email/Pipedrive workflow.
**Architecture:** A scheduled worker reads current records, plans reminders and records durable send intents before internal Gmail delivery. No CRM writes or interface changes.
**Spec:** ../specs/2026-11-16-internal-reply-reminders-design.md

## Constraints and verification
Preserve CMD copy, warm-invite and LinkedIn launch holds. No buyer sends. Test weekends/DST, delayed requests, deadline windows, current-owner routing, completion/snoozing, later project-specific replies, incomplete reads, concurrent workers, same-day duplication and uncertain delivery.

- [ ] Add failing scheduling/content tests, implement pure scheduling and copy.
- [ ] Add migration and database tests for bounded selection, durable unique claims, uncertainty and repeated runs.
- [ ] Add read-only CRM/conversation adapter and tests for fresh ownership, identity and handled evidence.
- [ ] Wire default-off cron, safe internal sender and migration.
- [ ] Run focused tests and full suite; independent review; fix concrete findings.
- [ ] Dry-run four actual tasks, review recipients/date/body, deploy, verify source and config, enable only approved scope.

## Independent review and corrections
Claude Opus 5.5 reviewed the implementation through the agency account. Last verdict: changes needed. All seven findings were verified and corrected locally: postponed-date escalation, next-year dates, UTC CRM timestamps, explicit deferrals across intents, self-escalation, rejected-send recovery and reconciliation fairness, and isolated boot configuration failure. The first account failed before reviewing anything. No second review was requested for these small corrections.

The regression suite first reproduced ten failures, then passed all 42 focused tests. HTTP 408 and server errors remain uncertain, and a successful provider acknowledgement followed by a local ledger failure never becomes retryable. Long deferrals remain within the explicit seed/new-task launch scope beyond 30 days. Production rollout remains a separate verification step.
