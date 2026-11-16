# Generated order status implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make generated orders distinguishable from intake awaiting approval.
**Architecture:** Explicit generation milestone statuses, independent review notes, unchanged authenticated receipt/context guards. Live n8n classifies only verified upload outcomes.
**Tech Stack:** React/TypeScript, Express, Vitest, n8n-as-code.
**Spec:** docs/superpowers/specs/2026-11-17-generated-order-status.md

## Global constraints
Preserve Ready/Complete, numeric/template routing fixes, PDF/upload receipt validation, CAS updates and tenant scope. No messages or delivery/completion triggers.

## Review focus
Partial failed output, missing templates explicitly skipped, legacy or stale evidence, concurrent staff edits, generated status surviving lookup refresh.

### Task 1: Frontend status contract
**Model:** gpt-6-sol, high
Own src/data.ts, src/documentQueue.ts and tests, src/components/ProjectList.tsx and tests, src/components/ProjectDetail.tsx and tests.
- [x] Add failing tests for Generated, Generation Incomplete, Generation Failed group/count/filter/badge/action behavior and preserved file-evidence warnings.
- [x] Implement explicit labels, separate review warnings, generated locking/reopen/regenerate behavior; preserve legacy status semantics.
- [x] Run affected frontend tests and report.

### Task 2: Refresh/backend status consumers
**Model:** gpt-6-sol, high
Own src/projectRetrigger.ts and tests, lib/workspaceOverviewRoutes.js and tests, lib/__tests__/projectGenerationStorage.test.js.
- [x] Add failing tests for generated refresh preserving milestone, status transitions not sending/regenerating, and new aggregate groups.
- [x] Preserve post-generation statuses through environmental refresh and classify aggregate statuses explicitly without breaking existing fields.
- [x] Run affected tests and report.

### Task 3: Producer transitions and historical reconciliation
**Model:** gpt-6-sol, high
Root owns live router status nodes and scoped scripts/evidence.
- [x] Test both live status-code branches on complete automatic output, review warnings, partial/failed output, JO-only, skipped template and invalid receipt fixtures.
- [x] Patch only completion status choice and held-routing status; preserve notes, callbacks and CAS payload.
- [x] Replay retained executions and draft reviewable current-row corrections.

### Task 4: Integration and release
- [ ] Full suite and build; independent cross-family review; fix confirmed findings.
- [ ] Commit scoped changes, PR, link PR, merge after checks and verify app deploy.
- [ ] Publish live workflow change only after UI/backend supports statuses; read back exact code and graph.
- [ ] CAS-reconcile eligible orders, reread persisted records and confirm no re-generation or send side effects.
