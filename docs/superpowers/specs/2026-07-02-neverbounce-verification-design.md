# NeverBounce verification on the contacts refresh — design

**Date:** 2026-07-02
**Status:** design, awaiting review
**Repo:** swppp-system (origin/main), worktree `feat/neverbounce-verification`

## Problem

Derek wants email verification on the Pipedrive contacts, driven off our daily/refresh
cycle rather than only at send time. Today verification runs **lazily at send** only
([server.js:3639-3664](../../../server.js), `approve-and-send`), with no cached result and
no recovery when an address is dead. We want to: verify proactively, never double-verify,
recover a working contact when the primary email is bad, flag when nothing works, and
cancel any in-flight outreach to a dead address. And consolidate on NeverBounce, retiring
MillionVerifier.

## Grounding facts (verified against origin/main, 2026-07-02)

- `lib/emailVerify.js` already supports NeverBounce (`verifyEmail(email)` →
  `{ok:false,status,suggestion}` hard-fail | `{ok:true,skipped}` fail-open |
  `{ok:true,status,soft}` pass). Provider is env-selected; **NeverBounce is now the active
  provider** (`NEVERBOUNCE_API_KEY` + `EMAIL_VERIFY_PROVIDER=neverbounce` set in Railway).
  Selecting NeverBounce automatically retires MillionVerifier — one provider is active at a
  time. **No provider code change needed.**
- The "daily refresh" is our own backend cron `syncLeadState(pool)`
  ([lib/pipedriveSync.js:109](../../../lib/pipedriveSync.js)), 30s after boot + every 6h.
  **Not n8n.** It already extracts `person_email` and writes `sdr_lead_state`
  (which already has `pipedrive_org_id`).
- `apolloClient.js` has **no** people-search/enrichment — only `matchContactByEmail`
  (find-or-create by email). Alternate-finding via Apollo is genuinely new capability.
- Existing reject/cancel plumbing to reuse: send-gate reject+note+422 pattern
  (server.js:3639), `removeContactsFromSequence` (apolloClient.js), `pruneStaleQueuedDrafts`
  (lib/autoOutreach.js), the bounce handler that clears `Sequence_Started`.
- **Credit constraint:** NeverBounce currently has **397 pay-as-you-go credits**. The book is
  500–2700+ leads. Scope MUST be lazy + cached or it runs dry. Top-up expected before volume.

## Decisions (locked with Ivan)

1. **Placement:** verify in the 6h refresh + cache; keep the send-time gate but have it READ
   the cache (only call the API when the cached result is stale/missing).
2. **Alternate cascade on hard-fail:** free first, paid fallback: (a) other Pipedrive org
   contacts → (b) Apollo people-search by domain → (c) flag. Both fallbacks tried in order.
3. **On finding a working alternate:** write the new contact into Pipedrive **and** leave an
   `[Auto]` note documenting the swap (dead address → new verified address + source), like
   every other note.
4. **Scope:** verify only outreach-eligible leads (`outreach_status='clear'` AND
   `trigger_type` set), first time they qualify; cache; re-verify only if the email string
   changed or the cache is >90d old.
5. **Apollo lookup cap:** at most **25** Apollo people-searches per refresh cycle (spend
   circuit-breaker); overflow leads get flagged `email_bad` and retried next cycle.
6. **Soft results unchanged:** catch-all/unknown pass through as today (blocking them drops
   too many legit B2B addresses).

## Data model — new columns on `sdr_lead_state`

Added via the existing idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern
(server.js ~907):

| Column | Type | Meaning |
|---|---|---|
| `email_verify_status` | TEXT | last NeverBounce result: valid/invalid/disposable/catchall/unknown |
| `email_verified_at` | TIMESTAMPTZ | when we last verified — drives the 90d staleness check |
| `email_verified_value` | TEXT | the exact address checked — re-verify when the email **changes**, not just on age |
| `resolved_email` | TEXT | a discovered alternate that beat a dead primary (also written to Pipedrive) |
| `email_flag` | TEXT | `email_bad` when the cascade found nothing usable; else NULL |

`resolved_email` (when present) is the address outreach uses. Index on `email_flag` for the
interface "needs contact" filter.

## Verify flow (inside `syncLeadState`, per eligible lead)

```
if outreach_status == 'clear' AND trigger_type set:
    email = person_email
    stale = (email_verified_value != email) OR (email_verified_at is null OR > 90d)
    if not stale: skip                      # cache hit — no API call, no spend
    else:
        v = verifyEmail(email)
        if v.skipped: leave cache untouched  # fail-open, retry next cycle
        elif v.ok:   cache status + verified_at + verified_value; clear email_flag
        else:        run HARD-FAIL CASCADE   # confident-bad
```

Verification is best-effort and must never throw out of the sync loop (wrap per-lead; a
verifier/Apollo error logs and continues to the next lead).

## Hard-fail cascade

```
1. primary invalid/disposable
2. FREE: other persons on the lead's Pipedrive org (pipedrive_org_id) with an email
     verify each → first that passes → adopt it (see "Adopt an alternate")
3. PAID (only if step 2 found nothing AND cycle Apollo-lookup count < 25):
     Apollo people-search by the org's email domain → best-title candidate
     verify candidate → if passes → adopt it
4. NOTHING (or cap hit): set email_flag='email_bad'; cancel in-flight outreach (below)
```

New apolloClient capability required for step 3: `searchPeopleByDomain(domain, {titles})` →
candidates with emails (Apollo `mixed_people/search`). Capped and counted per cycle.

### Adopt an alternate
- Set `resolved_email` = new address, `email_verify_status='valid'`, clear `email_flag`.
- **Write to Pipedrive**: add the new email to the lead's person (or the newly-found person),
  via `pipedriveClient`.
- **Leave an `[Auto]` note** on the lead: `"[Auto] Primary email <old> failed verification
  (<status>); switched to <new> (source: PD org contact | Apollo). "`.
- Adopting an alternate clears any `email_bad` flag.

## Cancel in-flight outreach on final failure

When a lead ends the cascade at `email_bad` (no usable address):
- Reject any open draft (`status IN ('pending','approved','edited')` → `'rejected'`,
  reason `"auto: email failed verification, no alternate found"`) — reuse the
  `pruneStaleQueuedDrafts` update shape.
- If already enrolled (`sdr_sends.status='enrolled'`): `removeContactsFromSequence` +
  clear `Sequence_Started` on the Pipedrive lead + mark the send row — reuse the existing
  bounce-handler path.
- Leave an `[Auto]` note recording the cancellation.

## Send-time gate change (server.js:3639)

Make the gate cache-aware:
- If `sdr_lead_state` has a fresh (`<90d`, same address) `email_verify_status`, use it — no
  API call. `invalid/disposable` → block as today; else proceed.
- If stale/missing → verify live (current behavior), then write the result back to the cache.
- If `resolved_email` is set, the draft should target it (the primary is known-dead).

## Interface surface

- "Needs contact" filter/badge on the Leads view keyed off `email_flag='email_bad'`.
- Show `email_verify_status` (+ `resolved_email` when set) on the lead drawer.
- (Backend-first; UI can follow in a second slice.)

## Out of scope (v1)

- Blocking catch-all/unknown (stays soft).
- Any n8n changes (refresh is our backend cron).
- Bulk full-book backfill (lazy-only, to respect the 397-credit ceiling).
- Verifying non-eligible leads.

## Risks

- **Credits:** 397 NeverBounce credits < book size. Lazy+cached keeps spend to
  newly-eligible + changed + >90d only. Add a low-credit log/alert; top up before scaling.
- **Apollo spend:** capped at 25 lookups/cycle; only fires when PD org has no alternate.
- **Pipedrive mutation:** we now write a new email + note into Pipedrive on adoption. This is
  a targeted per-lead write (not a bulk mutation) and is always accompanied by an audit note.
- **Concurrent permit process** clobbers the Desktop checkout — all work ships from this
  worktree via `git push origin HEAD:main`.
