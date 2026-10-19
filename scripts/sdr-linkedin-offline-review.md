# Private LinkedIn offline review

This command operates only on a local `SDR_TEST_DATABASE_URL` (`localhost` or `127.0.0.1`) with the additive LinkedIn migration already applied. It fixes company scope to `13105180`. It never calls the provider, queues actions, approves a campaign, or sends outreach. Keep input packets and the exclusive `0600` output file in private storage.

Set `SDR_LINKEDIN_OFFLINE_REVIEW=1`, `SDR_LINKEDIN_OFFLINE_ACCOUNT_ID`, `SDR_LINKEDIN_OFFLINE_REVIEWER`, and `SDR_TEST_DATABASE_URL`. For an isolated test schema, set `PGOPTIONS='-c search_path=<schema>'`. Then run:

```sh
node scripts/sdr-linkedin-offline-review.mjs intake candidate.json candidate-receipt.json
node scripts/sdr-linkedin-offline-review.mjs campaign campaign.json campaign-receipt.json
node scripts/sdr-linkedin-offline-review.mjs assign assignment.json assignment-receipt.json
node scripts/sdr-linkedin-offline-review.mjs preview preview.json preview-receipt.json
```

The command refuses an existing output path before changing the database. The intake packet must contain only `source`, `identity`, `links`, and `email`:

- `source`: `source` (`pipedrive`, `authorized_export`, or `cold_review`), stable `sourceId`, dated `observedAt`, independently traceable `evidenceRef`, canonical `profileUrl`, `segment` (`AGC`, `LBA`, or `cold`), `territory`, `firm`, and `role`.
- `identity`: exact `personId`, `organizationId`, `ownerId`, `pipedriveOwnerId`, Classic `providerId`, `product:"classic"`, matching `profileUrl`, plus separate dated `personEvidence` (`source:"pipedrive_person_export"`, `sourceRef`, matching person and organization) and `profileEvidence` (`source:"linkedin_profile_review"`, `sourceRef`, matching profile and provider ID). The current mailbox owner mapping must agree.
- `links`: one or more independently evidenced project links with `leadId`, `verifiedEmail`, `apolloContactId`, and `evidence` containing `source:"pipedrive_project_export"`, unique `sourceRef`, dated `observedAt`, matching `personId` and `leadId`. Each project stays separate.
- `email`: `source:"apollo_sequence_export"`, distinct `sourceRef`, matching `personId`, `sequenceId`, dated `completedAt`, `expectedStepCount`, and a complete ordered `steps` array. Each step needs its number, provider `messageId`, `status:"completed"`, and `completedAt`; the final step time must equal sequence completion. Include a separate `replyReview` with `source:"mailbox_reply_review"`, distinct `sourceRef`, `from`, `through`, `coverage:"complete"`, a `contactEmail` matching a reviewed link, and `messages:[]`. The review window must cover every completed step. A listed reply or partial coverage rejects intake.

The evidence references identify the reviewed export or record. The packet is a dated human review, not a fresh connected CRM or provider read. Do not use browser assertions as these fields. The CLI preserves the references and reviewer on the candidate and leaves live eligibility unavailable. Re-review of an existing staged or reviewed candidate advances evidence only when source and reply coverage dates are monotonic, retains prior review references in `reviewHistory`, and preserves holds, opt-outs, replies, and staff takeover.

A campaign packet contains `config` and future `expiresAt`. Include sender provider ID, timezone, late-acceptance policy, two increasing business-day follow-up intervals, copy for `dm1`/`followup1`/`followup2`, source IDs, segments, territories, owner IDs, stop policy, and the weekday 08:00–17:00 `sendWindow`. Omitted budgets default to `{ "invite": 0, "dm": 0 }`; explicit proposed budgets remain unapproved. The receipt includes the current revision and `status:"unapproved"` with no approval digest. To revise, include `campaignId` and `expectedRevision` in a new campaign packet.

An assignment packet is `{ "candidateId": "...", "campaignId": "...", "expectedRevision": 2 }`. A preview packet is `{ "campaignId": "..." }`. A synthetic test may add `providerSnapshot:{"kind":"synthetic_fixture","byPerson":{...}}`; the result marks synthetic input. Each decision includes a rendered preview for all three message steps or `copy_facts_unverified` when a placeholder lacks dated source proof. The reviewed firm can supply `{company}`; `{firstName}` stays unavailable without a separately corroborated person export. Every decision stays held for approval and fresh connected evidence, and the action table remains untouched.

For later reviewed commercial attribution, `attribution` accepts `candidateId`, `dealId`, `leadId`, `occurredAt`, an independent CRM `evidenceRef`, and the exact `channelActionId` of a previously confirmed LinkedIn action. The lead must be an independently reviewed link. This records a review observation only; a quote or order is counted later only when a non-test CRM deal fact and its own event date corroborate it.
