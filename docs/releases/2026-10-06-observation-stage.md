# Workspace and CRM observation release

This stage updates the shared interface and company sales reporting, and adds admin-only CRM follow-up/history reads with independently scheduled Pipedrive observations. Existing outbound modules and the original server handlers remain byte-identical to release base `5d8a9b6`; a regression test checks that boundary. The separate contact-recovery, sequence-removal and CRM send-enforcement work remains outside this release. No hold/review controls or blocked-sending claims appear in the observation UI.

## Operation

Apply only `migrations/2026-10-05-sdr-crm-observations.sql`. It creates separate inbox, snapshot, revision, explicit-link, reviewed-exclusion and coverage tables. It does not alter business tables. Enable `SDR_CRM_OBSERVER_ENABLED` with the company ID, source host and dedicated Basic webhook credentials. Register six Pipedrive v2 entity subscriptions; do not change existing webhooks. The event worker polls every 30 seconds; bounded reconciliation runs every five minutes. Historical coverage remains partial until each scope finishes.

`SDR_SALES_HISTORY_ENABLED=true` enables a separate six-hour reporting refresh, including an initial run. It reads current/archived CRM deals and writes reporting facts transactionally. It does not update Pipedrive. A failed read retains previous facts; freshness reflects the last successful collection. Existing test exclusions and reconstructed-date uncertainty remain visible. The known April bulk-date warning withholds affected comparisons.

## Verification before deployment

- Full isolated PostgreSQL suite: 885 tests across 81 files; build passes.
- Focused lint: 55 changed/new files pass; unchanged legacy UI lint debt is documented in the prior review.
- Production backup restored locally. Applying the observer migration preserved every row digest in all existing tables.
- Live read-only source preflight: all eight observer scopes readable; company/admin identity verified; company sales scan exhausted current and archived pages. V1 observer paths use the working canonical `/v1/...` paths; V2 uses `/api/v2/...`.
- Fresh local reporting import reconciled available deals, reconstructed import dates and date-quality warnings. Administrator totals matched the independent source recount; staff company totals remain unavailable.
- Independent review confirmed unchanged document/SDR actions, additive route registration, authentication, read-only UI, and reporting-only writes.

## Rollout and rollback

Deploy from GitHub main through the existing Railway integration, following a reviewed PR. Record exact deployment identity, validate JSON responses and staff access, then verify observer coverage and webhook receipt. Do not test by sending outreach or editing client business records.

On a release regression, return Railway to the previous successful app deployment or revert the release merge. Preserve the additive observation tables and evidence. Do not restore an old database snapshot over new staff activity merely to roll back this app version. The backup is a recovery precaution, not the normal code rollback. Existing sending flags and n8n workflows are not changed by this stage.

References: [Railway deployment actions](https://docs.railway.com/deployments/deployment-actions), [Pipedrive webhook contract](https://developers.pipedrive.com/docs/api/v1/Webhooks). Private backup, source snapshots and production receipts are stored outside this public repository.
