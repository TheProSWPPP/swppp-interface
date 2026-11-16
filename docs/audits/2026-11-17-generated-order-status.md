# Generated order status audit — 17 November 2026

## Finding and intended behavior
Successful automated generation was being stored as Pending Review whenever the router also emitted a package or environmental review warning. The UI grouped solely by that stored status. Environmental refresh could independently reset a generated order to Pending Review. Its button also said Re-trigger Generation even though it only refreshed lookup data.

Generated now means the configured automated outputs for the current run have verified PDF upload receipts. Staff review notes remain visible. Generation Incomplete identifies a run with some verified outputs and missing/failed expected outputs; Generation Failed identifies a run with none, including routing holds. Pending Review remains intake awaiting approval or an explicitly reopened order. Legacy Ready/Complete decisions are preserved. Generated does not assert the full manual SWPPP/NOI/NOT package is complete or that anything was delivered.

## Independent audit and historical evidence
Three audit agents inspected backend transitions, frontend consumers and history. Two implementers handled the UI and summary/refresh consumers in parallel; the root handled the live producer, retained-run replay and reconciliation.

- October 13 PRs #75–76 separated order status/folder links from per-file content and delivery proof. The authenticated manifest callback deliberately leaves lifecycle status unchanged and shipped disabled. Its authentication, context digest, CAS and stale-result guards are unchanged here.
- October 14 environmental refresh introduced a Pending Review reset when the status stayed unchanged during the lookup. Refresh now preserves the lifecycle milestone, while New intake still becomes Pending Review.
- October 26 PR #111 unified queue tile/filter/badge grouping around raw status. The new Generated group and exact failed/incomplete badges update that mapping consistently.
- Both live router completion nodes used warnings.length to choose Pending Review versus Ready after validating receipts. The replacement uses verified current outputs, plus graph-derived expected outputs. Unwired template stubs are excluded; configured explicit skips remain supported. Routing holds become Generation Failed.

Sources: repository history and tests, retained router executions, and the local October 13 producer-integration/final-report archive. Folder existence, a green execution, an older Ready state or a single JO never prove a complete state package.

## Changed surfaces
Queue groups/counts/filtering/badges, detail locking/reopen/retry actions, environmental refresh labels and lifecycle preservation, workspace aggregate counters, and three router Code nodes. The Generate again action uses the existing conflict-aware save path and an explicit approval transition. Status-only corrections do not dispatch generation. Protected-file baseline hashes were refreshed only for the three authorized changed protected files.

The Brevo project-completion consumer reads projects by finish-date window, not by status. No completion messages, delivery actions or new triggers are introduced. Router callbacks retain CAS patch behavior, preserve unrelated fields, and do not use an upsert.

## Verification
- Full serial Vitest run with a disposable local PostgreSQL database: 3,784 passed, one failed. The failing emailVerifyPassCandidates selector test also fails on the unchanged main archive; it is unrelated to document status.
- Production build and TypeScript compilation pass.
- Sixteen producer tests cover both completion branches, review warnings, JO-only runs, partial/zero outputs, missing JO, unexecuted expected CSN/CL, explicit cover skip, malformed receipt hashes, held routing and unchanged graph/other nodes. The old implementation fails the new cases.
- Changed-file lint reports the same existing any declarations and effect-dependency warning in ProjectDetail/data. No new lint finding was introduced. Diff whitespace checks pass.

## Historical correction boundary
Inventory: 645 active orders; 151 Pending Review, of which 58 have folders. Only 34 retained router executions were available. Latest matching retained runs identify 27 correction candidates; one additional candidate is held because its note changed after generation. Source fields, callback notes and current uploaded-file metadata must match before each CAS correction. Older orders without retained evidence stay unchanged. Manual Ready/Complete decisions stay unchanged. No regeneration is needed to repair these labels.

Release and persisted correction receipts are recorded after independent review and deployment.
