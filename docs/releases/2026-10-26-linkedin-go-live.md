# LinkedIn channel go-live (Derek's personal profile)

The AGC/LBA LinkedIn channel sends only when all three hold: `SDR_LINKEDIN_MODE=live`, `SDR_LINKEDIN_ALLOW_WRITES=true`, and an approved, unexpired campaign. Every admin step below is audited in `sdr_linkedin_admin_audit`. Replies are never answered automatically; in live mode each one becomes a Pipedrive task for the lead owner with the reply text in the note.

## 1. Database

Both migrations are additive (new tables only). Take a backup, then apply in order:

```
psql "$DATABASE_URL" -f migrations/2026-10-16-sdr-linkedin-channel.sql
psql "$DATABASE_URL" -f migrations/2026-10-26-sdr-linkedin-golive.sql
```

## 2. Environment

| Variable | Value |
| --- | --- |
| `SDR_LINKEDIN_DSN` | `https://api38.unipile.com:16836/api/v1` (exactly; the client refuses anything not ending in `/api/v1`) |
| `SDR_LINKEDIN_API_KEY` | Unipile v1 API key |
| `SDR_LINKEDIN_ACCOUNT_ID` | Derek's Unipile account id |
| `SDR_CRM_COMPANY_ID` | `13105180` (LinkedIn stays off for any other value) |
| `SDR_LINKEDIN_WEBHOOK_SECRET` | long random string, also used in the webhook header below |
| `SDR_LINKEDIN_MODE` | `observe`, then `dry_run`, then `live` |
| `SDR_LINKEDIN_ALLOW_WRITES` | unset until the live step, then `true` |

The runtime reads the account row once at boot and starts only when the row's mode equals `SDR_LINKEDIN_MODE`. After every mode change below, change the env var to match and redeploy.

## 3. Webhooks (Unipile v1)

Register three webhooks against the DSN with header `X-API-KEY: <key>`. Each is `POST https://api38.unipile.com:16836/api/v1/webhooks` with `Content-Type: application/json`:

```json
{"source":"messaging","name":"ProSWPPP LinkedIn messages","request_url":"https://<app>/webhook/sdr-linkedin","format":"json",
 "account_ids":["<ACCOUNT_ID>"],"events":["message_received"],
 "headers":[{"key":"Content-Type","value":"application/json"},{"key":"Unipile-Auth","value":"<SDR_LINKEDIN_WEBHOOK_SECRET>"}]}
```
```json
{"source":"users","name":"ProSWPPP LinkedIn relations","request_url":"https://<app>/webhook/sdr-linkedin","format":"json",
 "account_ids":["<ACCOUNT_ID>"],"events":["new_relation"],
 "headers":[{"key":"Content-Type","value":"application/json"},{"key":"Unipile-Auth","value":"<SDR_LINKEDIN_WEBHOOK_SECRET>"}]}
```
```json
{"source":"account_status","name":"ProSWPPP LinkedIn account status","request_url":"https://<app>/webhook/sdr-linkedin","format":"json",
 "account_ids":["<ACCOUNT_ID>"],"events":["ok","error","credentials","stopped","permissions","deleted","reconnected","sync_success","connecting","creation_fail"],
 "headers":[{"key":"Content-Type","value":"application/json"},{"key":"Unipile-Auth","value":"<SDR_LINKEDIN_WEBHOOK_SECRET>"}]}
```

Each returns `201 {"object":"WebhookCreated","webhook_id":"..."}`. Messages and new connections from people who are not candidates are recorded and closed without changing the account. A message matching more than one candidate holds those candidates only. `ERROR`, `STOPPED`, `CREDENTIALS`, `PERMISSIONS`, `DELETED` or any unknown status marks the account `restricted`, and a later `OK` does not clear it. Re-registering (step 4) does, after verifying the account again.

## 4. Admin routes (admin session only)

1. Register the account. This reads `GET /accounts/{id}` and `GET /users/me` and stores the verified `ACo…` sender. It always lands in `observe`.
   `POST /api/sdr/linkedin/admin/account` `{"readBudget":20,"timezone":"America/Chicago"}`
2. Stage candidates from live data. These are AGC/LBA leads whose Apollo sequence completed every step at least 3 days ago, with no reply, bounce or unsubscribe. Customers, Bid Invite contacts, held leads, existing connections and pending invites are skipped. Each staged person costs one profile read.
   `POST /api/sdr/linkedin/admin/candidates/stage` `{"limit":5}`
3. Create the campaign with the staged candidate ids. Sender, timezone, weekday 08:00–17:00 window, `stopPolicy` and `lateAcceptancePolicy: "send_on_verified_observation"` are filled in. Budgets are capped at 5 a day; leave them at 0 until live.
   `POST /api/sdr/linkedin/admin/campaigns` `{"config":{"copy":{"dm1":"…","followup1":"…","followup2":"…"},"followupDays":[3,7],"budgets":{"invite":0,"dm":0}},"expiresAt":"<≤90 days>","candidateIds":["…"]}`
   Revise with `POST /api/sdr/linkedin/admin/campaigns/<id>` and `expectedRevision`; omitted settings keep their previous values. Any revision returns the campaign to unapproved and holds steps already queued under the old revision, so start a new campaign for each new cohort.
4. Approve. This binds the exact cohort and computes the approval digest the dispatcher re-checks.
   `POST /api/sdr/linkedin/admin/campaigns/<id>/approve` `{"expectedRevision":<n>}`
5. Change mode: `POST /api/sdr/linkedin/admin/account/mode` `{"mode":"dry_run"}`. Then set the env var and redeploy.

## 5. Rollout

- **observe** (a few days): webhooks arrive, the account stays `healthy`, and replies hold candidates. Nothing is sent and no Pipedrive task is created.
- **dry_run** (a few days): `/api/sdr/linkedin/review` and the runtime previews show the queued steps and rendered copy. Nothing is sent.
- **live**: revise the campaign with `POST /api/sdr/linkedin/admin/campaigns/<id>` `{"expectedRevision":<n>,"config":{"budgets":{"invite":2,"dm":2}}}` and approve it again. Set the account mode to `live`, set `SDR_LINKEDIN_MODE=live` and `SDR_LINKEDIN_ALLOW_WRITES=true`, then redeploy. Invites, DM1 and follow-ups go out on weekdays 08:00–17:00 Central only. DM1 goes out within one business day of the observed acceptance; later than that it waits for review. Unaccepted invites stop counting after 21 days, and a candidate completes 7 days after the last unanswered follow-up.

## Stop

Set `SDR_LINKEDIN_MODE=disabled` (or remove `SDR_LINKEDIN_ALLOW_WRITES`) and redeploy. You can also set the account mode to `disabled` through the admin route. Keep all tables; they hold the audit trail and reply holds.
