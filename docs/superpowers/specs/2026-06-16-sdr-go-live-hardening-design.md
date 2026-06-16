# SDR Interface Go-Live Hardening — Design

**Date:** 2026-06-16
**Status:** Approved (decisions captured below)

## Problem

The SDR interface drives cold outreach (Pipedrive lead → backend draft → Apollo sequence). An end-to-end test on 2026-06-15 proved the core path works but surfaced gaps that block safe go-live:

1. **No double-outreach protection.** A 30-lead live probe found **28/30 leads already have prior outgoing email in Pipedrive**. Auto-sending from the interface would double-email almost the entire lead set and step on Derek's team's manual flow.
2. **No Pipedrive→interface sync.** The interface has no idea who's already been contacted or any richer lead detail; it only knows its own draft queue.
3. **Apollo engagement not flowing.** The ingest endpoint + UI exist, but Apollo isn't subscribed to push opens/clicks/replies.
4. **Sequence auto-resolution not wired.** `APOLLO_SEQ_*` env vars aren't set, so trigger→sequence only works if the id is passed explicitly.
5. **One-way logging only.** Pipedrive gets `Sequence_Started` written but no link back to the interface.

(Already fixed 2026-06-15, separately: `matchContactByEmail` used Apollo `/people/match` (global person id) instead of an account contact id — every real send would have failed the custom-field write. Now uses `/contacts/search` + create. Deployed to `main` @ 3c79b83.)

## Architecture decisions

- **Trigger model (confirmed):** Pipedrive does NOT trigger sends. The interface is the control surface; Pipedrive is the **logbook/system-of-record**. Reaffirms the deleted v2 webhooks — legacy manual flow untouched.
- **Dedup signal:** `last_outgoing_mail_time` on the linked Pipedrive **person** is the reliable marker (caught 28/28). `Low Bidder Follow Up Email Sent` flag (1/30) and our `Sequence_Started` are secondary corroborators. Note `last_outgoing_mail_time` means "ever emailed via Pipedrive sync" (bids/quotes/replies included), so recency matters.
- **Dedup behavior:** **Warn + admin override, recency-colored.** Blocked by default; RED if last outgoing ≤60 days, amber if older; an admin can override with one click. Plus a **live re-check at approve-and-send** (belt-and-suspenders) regardless of mirror freshness.
- **Sync:** **Backend cron, 3–4×/day**, mirroring Pipedrive into Postgres. Not n8n (keeps legacy flows untouched, lands in the interface's own DB). Interface list views read the mirror; send-time does a live re-check.
- **Engagement:** wire the existing pipeline by subscribing the Apollo webhook to `/api/sdr/events/ingest`.

## Components

### 1. Pipedrive lead-state mirror (`sdr_lead_state`)
New Postgres table, one row per Pipedrive lead the interface cares about:
- `pipedrive_lead_id` (PK), `pipedrive_person_id`, `person_name`, `person_email`
- `last_outgoing_mail_time` (timestamptz), `email_messages_count` (int), `last_activity_date` (date)
- `lowbid_flag` (bool), `sequence_started` (text — our marker), `project_stage` (text)
- `trigger_type` (text — inferred AGC/LBA/CM/PB), `lead_title` (text)
- `outreach_status` (derived enum: `clear` | `contacted_recent` | `contacted_stale` | `sequenced`)
- `synced_at` (timestamptz)

### 2. Sync job (`lib/pipedriveSync.js` + cron in server.js)
- Pulls leads (paged) + linked persons from Pipedrive, computes signals + `outreach_status`, upserts `sdr_lead_state`.
- Runs every ~6h via a backend interval; also exposes `POST /api/sdr/sync/leads` (admin) for on-demand.
- `GET /api/sdr/leads` (JWT) returns the mirror for the interface list, with `outreach_status` + recency.

### 3. Dedup guard
- **Send-time (authoritative):** `approve-and-send` does a LIVE Pipedrive fetch of the person's `last_outgoing_mail_time` before enrolling. If contacted and no `override:true` in the request → `409 { code: "already_outreached", lastOutgoing, daysAgo }`. Admin-only override.
- **UI:** lead/draft rows show an outreach badge (red ≤60d / amber older / green clear). Approve button on a flagged lead opens a confirm naming the date; admins get an "override & send" action, non-admins are blocked.

### 4. Apollo engagement webhook
- Subscribe Apollo to POST engagement events to `/api/sdr/events/ingest?callback_secret=…`.
- Document the exact subscription (Apollo webhook UI/API) in `SDR-MANUAL-STEPS.md`; attempt programmatic creation via Apollo `/webhooks` if supported.

### 5. Sequence env + Pipedrive backlink
- Set Railway env: `APOLLO_SEQ_AGC/LBA/CM/PB` = the 4 sequence ids; confirm `APOLLO_API_KEY`.
- On enroll, also write an interface deep-link (e.g. `https://swppp-interface-production.up.railway.app/#/sdr?lead=<id>`) into the Pipedrive note (and optionally a field) for 2-way navigation.

## Out of scope (separate follow-on)
- User-model polish (ownership "glow" + "Mine" filter + activity feed + blast-radius confirm) — applies to both Cold and Nurture lanes; tracked separately.

## Testing
- Dedup: re-run the 30-lead probe through the new `outreach_status` logic; assert ≥28 flagged, recency split correct.
- Sync: run once, assert `sdr_lead_state` row count + a spot-checked lead's signals match live Pipedrive.
- Guard: attempt approve-and-send on a contacted lead → 409; with admin `override:true` → enrolls; on a clear lead → enrolls.
- Engagement: fire a synthetic event at `/events/ingest`, assert it appears in `engagement/summary`.
