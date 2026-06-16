# SDR Go-Live — Manual Steps (need dashboard access)

Everything else (lead-state sync, dedup guard, badges, Pipedrive backlink, the
Apollo contact-id bug fix) is shipped to production. These three need a human with
the right dashboard logins.

## 1. Railway env vars — auto-resolve trigger → Apollo sequence
Railway → project **capable-renewal** (workspace `theproswppp`) → service **swppp-interface** → **Variables** → add:

```
APOLLO_SEQ_AGC = 6a2ac17c71c0fc000cecf469
APOLLO_SEQ_LBA = 6a2ac17eef87e000180cb54a
APOLLO_SEQ_CM  = 6a2ac18173bec0001018e927
APOLLO_SEQ_PB  = 6a2ac184ac17ea000ce1b28f
```
(My CLI token — ivan@intelligents.agency — isn't authorized on this workspace, so I couldn't set them programmatically.)
Without these, drafts still work but an admin must pick the sequence per draft. With them, generated drafts come out send-ready.

## 2. Apollo engagement webhook — light up the opens/clicks UI
Apollo → **Settings → Integrations → Webhooks** (the API has no webhook endpoint on this plan, so it's UI-only).
- **Webhook URL:**
  `https://swppp-interface-production.up.railway.app/api/sdr/events/ingest?callback_secret=swppp-lead-import-2026-r9k4hz3qwm8nbv`
- **Events:** email sent, email opened, email clicked, email replied, email bounced, email unsubscribed
- The backend ingest + `sdr_engagement_events` table + the Engagement view already exist; they stay empty until this is connected.

## 3. Activate the remaining sequences (when ready)
Only **SWPPP - AGC** is currently active (activated during the 2026-06-15 E2E test).
**LBA / CM / PB are inactive** — activate each in Apollo when you want those triggers live.

## Test cleanup (low priority)
- One E2E test email is queued to ivan.manfredi2001@gmail.com (left to deliver on purpose).
- A couple `E2E ...TEST` throwaway leads exist in Pipedrive + one `Ivan E2ETest` Apollo contact — the lead-state sync filters `E2E` titles, so they don't pollute the interface.
