# Follow-up workflow corrections — October 7, 2026

Scope: ProSWPPP company13105180. Local work on `feat/followup-recovery-20261007`, based on `7401a56`. This document describes implementation after the expanded Pipedrive/browser review. It is not a production deployment receipt.

## Changes

| Area | Result |
| --- | --- |
| Priority | One current project/recipient instead of repeated draft cards. Engagement must have attributable message evidence and fall within the last 96 hours. Inactive sends, current holds, unresolved provider operations and verified replies prevent misleading hot actions. |
| Inbox | Marking a thread handled uses an inbound-message watermark. Later inbound mail makes it visible again. Mailbox failures and pagination limits are shown. Project links require verified evidence; ambiguous links remain unresolved. |
| Navigation | A new Inbox project link works while the SDR stays mounted. An earlier async lookup cannot override the newer selection. |
| Open tasks | LinkedIn reminders have a separate filter. Default work view excludes them. Original task dates and owners remain visible, with instructions to complete/reschedule the original Pipedrive task. Conflicting project links are excluded rather than choosing a project arbitrarily. |
| Review next steps | A read-only list of active projects with recent CRM notes or completed call notes and no observed open task. Shows up to five recent source records, their timestamps and project owner. Uses a 90-day record-update window. |
| Trust and access | Partial collections remain explicit. Source timestamps show collection checks, not page refreshes. Project visibility applies before pagination; inaccessible/test/ambiguous evidence is excluded. Staff receive no account-wide backlog counts. |

## What the team does

Existing scheduled calls and tasks remain their work list. In Review next steps, they check the original conversation and decide whether to reply, confirm a quote/document, call, wait for a promised date, coordinate with a PM, review the contact, or close the opportunity. They record that decision on the existing Pipedrive project. The view does not infer a missed follow-up or a won sale from a note.

No new tasks, calls, notes, messages or sequence changes are automatically performed by these changes. The LinkedIn filter displays existing CRM reminders only.

## Validation and review

- Full isolated local PostgreSQL suite: initial integrated run passed 1,327 tests across 121 files; final totals recorded below after reviewer fixes.
- TypeScript and production bundle build passed. Existing large-bundle and outdated Browserslist warnings remain.
- Desktop 1280×800 and mobile 390×844 browser inspection used the actual Follow-ups components with synthetic API responses. View switching and LinkedIn filtering worked, mobile width remained 390px without horizontal overflow, and the first review card began around y=555 after explanatory text was collapsed.
- Independent review caught the misleading CRM check timestamp and two Priority attribution edge cases. All three findings were corrected and independently reviewed again; no remaining blockers were found in the reviewed changes.
- Tests cover current-company/staff scoping, pagination, permission failure, ambiguous links, original timing/owner preservation, handled-thread reopening and source attribution. Local tests do not establish live CRM collection completeness or production performance.

## Remaining limits

- Recent-context review is a conservative evidence projection, not an exhaustive opportunity classifier. Known `[Auto]` notes are excluded; other automation-written notes may still appear for human review.
- CRM and mailbox history remain partial. Email activity placeholders do not prove a send. Notes mentioning a quote or contract do not prove delivery or a won sale.
- Inbox overview examines at most 100 threads per mailbox and discloses incomplete coverage. Older task-to-email lookup still searches current-contact conversations; it does not reliably preserve the originating message.
- Priority dismissal remains tied to its current draft. Dismissed cards should be reviewed separately before designing event-aware resurfacing.
- These UI/query changes do not resolve queued Apollo mail or authorize hold release. Existing protection observation and containment work remain separate.

## Release boundary

No database migration, n8n workflow change, CRM/provider mutation, production deployment or external message in this implementation pass. Before a future release, verify current production revision and compatibility with this branch. Preserve staff edits and the separate observation/hold state.

## Final local receipt

Verified 2026-10-07T22:00:49.556257+00:00 (UTC): **1,334 tests passed across 121 files, no skipped tests** with isolated localhost PostgreSQL. Final TypeScript/Vite production build, `node --check server.js` and `git diff --check` passed. New attribution cases failed before correction and pass afterward. Independent final review confirmed rejected-draft handling, current campaign/mailbox/timing attribution, true source-check timestamps and ambiguous task-link rejection. No live release was performed.
