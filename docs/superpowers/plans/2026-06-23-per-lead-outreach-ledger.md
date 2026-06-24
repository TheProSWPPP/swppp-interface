# Per-Lead Outreach Ledger Implementation Plan

> **For agentic workers:** task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give every lead a truthful per-lead outreach record (latest send, by whom, on which system) so the Leads view stops showing the misleading person-level "Contact emailed (any deal)" date.

**Architecture:** One Postgres ledger `sdr_outreach_log`, one row per (lead, source). Two writers: a Pipedrive **sent-folder sweep** (`GET /mailbox/mailThreads?folder=sent`, every thread carries `lead_id` + sender + sent timestamp; verified 9/9 subject↔title match, 9,393 leads covered) and our own **approve-and-send** path. The Leads API joins the latest row per lead; the UI renders `Last outreach` + `Outreached by = sender · source`.

**Tech Stack:** Express ESM + pg, Pipedrive v1 REST (`lib/pipedriveClient.js`), React 19 + TS + Tailwind v4 (`src/components/SdrInterface.tsx`).

**Verified facts (live, 2026-06-23):**
- Sent mail is lead-linked: 83% of sent threads carry `lead_id`, 0 carry `deal_id`. Sender historically = `dc@proswppp.com` (Derek) for all of it.
- `parties.from[].latest_sent` = the actual sender; `last_message_sent_timestamp` = the send time.
- `/leads/{id}/mailMessages` returns 404 — must sweep the `sent` folder and group by `lead_id`.
- Dallanara "Well Site" lead → `11 May 2026 · Derek` (the correct date the person-level field hid).

---

## File Structure

- Create: `lib/outreachSync.js` — sent-folder sweep + ledger upsert (Pipedrive source)
- Create: `lib/pipedriveClient.js` add `listMailThreads({folder,start,limit})`
- Modify: `server.js` — table DDL in initDB; interface-source upsert in approve-and-send; activity write-back; sweep in sync cron; Leads API LATERAL join; backfill admin endpoint
- Modify: `src/lib/sdrApi.ts` — `SdrLead` gains `outreach` shape
- Modify: `src/components/SdrInterface.tsx` — `Last outreach` column + `Outreached by` (name · source); person-level field to drawer
- Test: live DB checks after each backend task (no unit harness in this repo)

---

## Task 1: Ledger table

**Files:** Modify `server.js` initDB (near the `sdr_sends` block ~line 734)

- [ ] Add DDL:
```sql
CREATE TABLE IF NOT EXISTS sdr_outreach_log (
  pipedrive_lead_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('pipedrive','interface')),
  sent_at TIMESTAMPTZ NOT NULL,
  sender_name TEXT,
  sender_email TEXT,
  subject TEXT,
  external_ref TEXT,           -- pipedrive thread id or sdr_sends id
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pipedrive_lead_id, source)
);
CREATE INDEX IF NOT EXISTS idx_outreach_log_lead ON sdr_outreach_log(pipedrive_lead_id);
```
Plus a 1-row state table for the sweep watermark:
```sql
CREATE TABLE IF NOT EXISTS sdr_outreach_sweep_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_swept_at TIMESTAMPTZ,
  last_thread_ts TIMESTAMPTZ
);
INSERT INTO sdr_outreach_sweep_state (id) VALUES (1) ON CONFLICT DO NOTHING;
```
- [ ] Upsert helper (used by both writers): `INSERT ... ON CONFLICT (pipedrive_lead_id, source) DO UPDATE SET ... WHERE EXCLUDED.sent_at > sdr_outreach_log.sent_at` (keep the later send).

## Task 2: Pipedrive client — list mail threads

**Files:** Modify `lib/pipedriveClient.js`

- [ ] `export async function listMailThreads({ folder = "sent", start = 0, limit = 100 } = {})` → `pdFetch("/mailbox/mailThreads", { query: { folder, start, limit } })`, return `{ data, pagination: additional_data.pagination }`.

## Task 3: Sweep module

**Files:** Create `lib/outreachSync.js`

- [ ] `sweepSentOutreach(pool, { full = false } = {})`: page `listMailThreads` newest-first. For each thread with `lead_id`: pick `from = parties.from.find(latest_sent) ?? parties.from[0]`, `ts = last_message_sent_timestamp ?? last_message_timestamp`. Upsert `(lead_id,'pipedrive',ts,from.name,from.email_address,subject,thread.id)`.
- [ ] Incremental stop: when `!full`, stop paging once a thread's `ts < last_thread_ts - 2h` (overlap guard). On `full`, page to end (cap 400 pages).
- [ ] After sweep, write `last_swept_at = NOW()`, `last_thread_ts = max ts seen`.
- [ ] Return `{ scanned, leadsUpserted, maxTs }`.

## Task 4: Backfill + verify

- [ ] Admin endpoint `POST /api/sdr/outreach/sweep` (body `{full}`) → `sweepSentOutreach`. Reuse SDR admin guard.
- [ ] Run `full` once. Verify against live DB:
  - `SELECT * FROM sdr_outreach_log WHERE pipedrive_lead_id='3353d9e0-4a6d-11f1-9de3-3f7fba6a5600'` → `2026-05-11 · Derek E. Chinners · dc@proswppp.com`.
  - row count ≈ 9k pipedrive rows.

## Task 5: Interface-source writes

**Files:** Modify `server.js` approve-and-send tx (~line 2737) and the activity write-back (~line 2784)

- [ ] In the tx, after the `sdr_sends` insert, upsert `(lead, 'interface', NOW(), sender_name = req.sdrUser?.username, sender_email = mailbox.email, subject = draft.subject, external_ref = send.id)`.
- [ ] Replace/augment the note with a dated Pipedrive **Activity** via `pipedriveClient.addActivity({ leadId, subject: 'Outreach: ${trigger} via ${mailbox.email}', type:'email', done:true })`. Keep `Sequence_Started` field write. (No new custom field — honors the Postgres-not-fields rule.)
- [ ] Same upsert reached automatically by the auto path (it calls this endpoint), so no separate change there.

## Task 6: Sweep in cron

**Files:** Modify `server.js` sync cron (the `syncLeadState` scheduler ~line 1054)

- [ ] After each `syncLeadState`, call `sweepSentOutreach(pool, { full:false })` (non-fatal try/catch).

## Task 7: Leads API

**Files:** Modify `server.js` `GET /api/sdr/leads` LATERAL block (~line 1478-1495)

- [ ] Add LATERAL: latest `sdr_outreach_log` row per lead (ORDER BY sent_at DESC LIMIT 1) → `ol.sent_at, ol.source, ol.sender_name, ol.sender_email`.
- [ ] Return `outreach: { sent_at, source, sender_name, sender_email }` (null when none). Keep existing `outreached_by` from sent drafts as the interface-name fallback; prefer ledger.

## Task 8: UI

**Files:** Modify `src/lib/sdrApi.ts`, `src/components/SdrInterface.tsx`

- [ ] `SdrLead.outreach?: { sent_at, source, sender_name, sender_email }`.
- [ ] Replace the `Contact emailed (any deal)` column with **Last outreach** = `daysAgoLabel(outreach.sent_at)` (else "Not outreached").
- [ ] **Outreached by** cell = `sender · source` → `Derek · Pipedrive` / `jg@proswppp.co · Interface`. Fallback to source-only when sender missing.
- [ ] Move person-level `last_outgoing_mail_time` into the drawer, labeled "Contact's last email (any deal)".

## Task 9: Build + deploy

- [ ] `npm run build` (must pass — `tsc -b && vite build`, NOT `tsc --noEmit -p tsconfig.json`).
- [ ] Deploy via detached worktree; force `railway up --detach --service swppp-interface` if GitHub auto-deploy stalls; verify deployment status via GraphQL.
- [ ] Live check: Dallanara Well Site row reads `Last outreach: 11 May · Derek · Pipedrive`.
