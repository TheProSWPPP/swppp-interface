# Conversation collection release

This release collects email metadata into observation tables. It does not enable conversation UI, draft reasoning, reply actions, provider cancellations or historical notifications.

## Operation

- `SDR_CONVERSATION_SYNC_ENABLED=true` starts recent collection every 15 minutes and older history hourly. Startup runs recent collection only.
- `SDR_CONVERSATION_PIPEDRIVE_ACCOUNT` identifies the verified company and API user whose mailbox scope is accessible. It is not proof of company-wide mailbox access.
- Apply `2026-10-03-sdr-conversation-history.sql` if absent, then `2026-10-07-sdr-conversation-sync.sql` before enabling.
- Recent-head, bounded recent catch-up and historical cursors remain independent. PostgreSQL locks prevent duplicate work on the same scope across replicas.
- Default pages contain ten threads. A Pipedrive scope uses at most two GET requests per tick; the six recent scopes use at most twelve, and three historical scopes at most six. Completed unchanged thread fingerprints avoid rereading messages.
- Recent scans stop at their fixed date boundary only after validating timestamp order. Invalid ordering or pagination remains partial. Gmail cursor recovery is bounded and never declares the restart immediately complete.

## Evidence limits

All imported message authorship remains Unknown. Participant addresses do not establish project identity. Explicit Pipedrive links are source observations; conflicting or cleared links preserve original evidence and receive a nonauthoritative conflict marker. No current lead-person relationship is projected backward onto older mail.

The sampled Pipedrive responses omit RFC Message-ID. Collection therefore does not establish exact cross-provider identity or manual authorship. Mailbox bodies are not stored by this worker. Older mailbox coverage remains partial until its own cursor completes; a 15-minute schedule is not a promise that every historical or account-inaccessible message is available.

Job health reports separate recent and historical collection scopes to administrators. Existing staff visibility remains unchanged. Keep `SDR_CONVERSATION_HISTORY_ENABLED=false` during this rollout. Integrating these records into automated decisions requires its own review.

## Verification and rollback

953 tests across 88 files passed against isolated PostgreSQL, including unchanged original outbound-handler hashes. Production build, scoped lint, syntax and independent review passed. Real provider reads into a local disposable schema collected 126 Gmail and four Pipedrive messages across 20 scopes without errors; all origins stayed Unknown.

Disable the collector flag and redeploy to stop new collection. Preserve observation tables and receipts. Do not restore an old database over staff work. No outbound, CRM business-record or workflow setting is part of this release.
