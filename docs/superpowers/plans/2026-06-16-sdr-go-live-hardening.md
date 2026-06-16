# SDR Go-Live Hardening — Implementation Plan

> **For agentic workers:** Execute task-by-task. Each task: implement → test against LIVE Railway DB/Pipedrive/Apollo (no local Postgres) → commit. Spec: `docs/superpowers/specs/2026-06-16-sdr-go-live-hardening-design.md`.

**Goal:** Make the SDR interface safe to go live: never double-email an already-contacted lead, keep the interface synced with Pipedrive outreach state, and light up engagement.

**Architecture:** Backend cron mirrors Pipedrive→Postgres (`sdr_lead_state`); the interface reads the mirror; approve-and-send does a live dedup re-check with admin override; Apollo engagement webhook feeds the existing ingest pipeline.

**Tech stack:** Express ESM, `pg`, node `fetch`. Deploy: cherry-pick/commit to `main` → Railway. Keys: Pipedrive `3089d0ff…`, Apollo `bl7X4VR2…` (X-Api-Key). Sequence ids: AGC `6a2ac17c71c0fc000cecf469`, LBA `6a2ac17eef87e000180cb54a`, CM `6a2ac18173bec0001018e927`, PB `6a2ac184ac17ea000ce1b28f`.

---

## Phase 1 — Pipedrive lead-state mirror + sync

### Task 1.1: `sdr_lead_state` table
- **Files:** Modify `server.js` `initDB()`.
- Add `CREATE TABLE IF NOT EXISTS sdr_lead_state` with columns from spec §Components.1 (pipedrive_lead_id PK, pipedrive_person_id, person_name, person_email, last_outgoing_mail_time timestamptz, email_messages_count int, last_activity_date date, lowbid_flag bool, sequence_started text, project_stage text, trigger_type text, lead_title text, outreach_status text, synced_at timestamptz).
- Index on `(outreach_status)` and `(pipedrive_person_id)`.
- Test: deploy, hit `/health`, confirm no init errors in Railway logs.

### Task 1.2: `lib/pipedriveSync.js`
- **Files:** Create `lib/pipedriveSync.js`; Modify `server.js` (import + cron + route).
- Export `syncLeadState(pool)`: page Pipedrive `/leads` (limit 100, follow `additional_data.pagination.next_start`), skip E2E test titles, resolve each linked person via `/persons/{id}` (batch/cache by person id), compute:
  - `outreach_status`: `sequenced` if our `Sequence_Started` set; else `contacted_recent` if `last_outgoing_mail_time` within 60 days; else `contacted_stale` if `last_outgoing_mail_time` set; else `clear`.
  - field hashes: LOWBID `2908c43ea1003ced2ab0f15a90e3549c9542807a`, SEQ `48c4bb758e8642d6372c7fff9df3c0ea716170f1`, STAGE `7c1852c27664d1118f75660223a6af9e99d10f2c`, trigger via existing `inferTriggerType`.
  - UPSERT into `sdr_lead_state` (ON CONFLICT pipedrive_lead_id DO UPDATE). Return `{ scanned, upserted, byStatus }`.
- In `server.js`: run on boot (after initDB) + `setInterval(~6h)`; guard against overlap with an in-flight flag.
- Test: add `POST /api/sdr/sync/leads` (admin) → run it → assert returned counts; query `sdr_lead_state` count > 0.

### Task 1.3: `GET /api/sdr/leads`
- **Files:** Modify `server.js`.
- JWT route returning `sdr_lead_state` rows (filterable `?status=`, `?q=`), newest `synced_at` first, capped/paged. Shape mirrors columns + a computed `days_since_outgoing`.
- Test: live GET as derek → 200, array with `outreach_status` present.

---

## Phase 2 — Dedup guard

### Task 2.1: live re-check in approve-and-send
- **Files:** Modify `server.js` approve-and-send handler; `lib/pipedriveClient.js` (or inline) add `getPersonOutreach(personId)`.
- Before the Apollo enroll block: if `!req.body.override`, fetch the lead's person `last_outgoing_mail_time` live. If set → `return res.status(409).json({ code:"already_outreached", lastOutgoing, daysAgo, personName })`.
- If `req.body.override === true` → require admin (`requireAdmin`), proceed, and record the override in the `nurture_audit`/sdr audit trail + the sdr_sends row.
- Test: approve-and-send a contacted real lead (no override) → 409; with `override:true` as derek → enrolls; as sdr with override → 403; clear lead → enrolls. (Use throwaway/own-inbox leads; clean up.)

### Task 2.2: UI outreach badge + override
- **Files:** Modify `src/lib/sdrApi.ts` (types + `leads()` + override param on approveAndSend), `src/components/SdrInterface.tsx`.
- Badge per row: green `clear`, amber `contacted_stale`, red `contacted_recent`/`sequenced`, with the date in a tooltip.
- Approve on a flagged row → confirm dialog naming `lastOutgoing`; admins see "Override & send", non-admins blocked with explanation.
- Test: build (`npm run build`), live smoke via playwright-driver — flagged row shows red badge; override path calls API with `override:true`.

---

## Phase 3 — Sequence env, engagement webhook, Pipedrive backlink

### Task 3.1: Sequence env vars
- Set Railway env `APOLLO_SEQ_AGC/LBA/CM/PB` to the 4 ids; confirm `APOLLO_API_KEY`. (Railway GraphQL `variableCollectionUpsert` or dashboard.)
- Test: generate a draft from a lead WITHOUT passing `apollo_sequence_id` → it resolves from env.

### Task 3.2: Apollo engagement webhook
- **Files:** `lib/apolloClient.js` (add `createWebhook` if API supports), `SDR-MANUAL-STEPS.md`.
- Subscribe Apollo emailer events → `POST {BASE}/api/sdr/events/ingest?callback_secret=…`. If no API, document exact Apollo UI steps.
- Test: trigger/simulate an event → appears in `sdr_engagement_events` + `/api/sdr/engagement/summary`.

### Task 3.3: Pipedrive backlink
- **Files:** Modify `server.js` enroll note builder.
- Append interface deep-link `…/#/sdr?lead=<id>` to the `[Auto]` Pipedrive note on enroll.
- Test: enroll a throwaway lead → fetch its Pipedrive notes → link present.

---

## Final
- Re-run the 30-lead dedup probe through `outreach_status`; assert ≥28 flagged with correct recency split.
- Full E2E once more end-to-end (clear lead) → delivered, engagement event lands.
- Update memory (`project_sdr_automation` / `project_cold_email_infra`) with go-live state.
