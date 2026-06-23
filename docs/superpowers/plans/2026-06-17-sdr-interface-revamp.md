# SDR Interface Revamp — Implementation Plan

> **For agentic workers:** Execute task-by-task against the LIVE Railway deploy (no local Postgres). A **concurrent "permit" process runs in the same `swppp-system` working dir** — it switches git branches + reverts files mid-edit. To ship safely: `git worktree add --detach /tmp/sdr-wtN origin/main`, `ln -sfn "<repo>/node_modules" node_modules`, edit there, `npm run build`, then `git push origin HEAD:main`, then `git worktree remove`. Verify UI live with the playwright-driver skill (basic-auth `derek:dereksystem`, then click the passwordless "Derek" picker).

**Goal:** Turn the SDR dashboard from draft-centric into a lead-centric pipeline: see Pipedrive leads in sync, outreach the ready ones in one click (trigger derived from stage), prioritize engaged leads, and make the whole UI clearer/bigger.

**Repo:** `swppp-system/` → swppp-interface on Railway (project capable-renewal `20fc4225-f1b1-447f-909c-cad612ba7860`, service `0bd3e780-2f95-43cb-808e-f06b1c19fd01`, env production `18f8b41e-06f0-48ff-806a-3df1a2bc0352`, workspace theproswppp). Deploy = `git push origin main`. URL `https://swppp-interface-production.up.railway.app`.

## Context — what's ALREADY built & live (do not rebuild)
- **Leads view** (Cold lane default tab) renders `sdr_lead_state` (500 Pipedrive leads, synced 6h) with summary cards (Fresh/Contacted/Sequenced/Total), filters, spacious cards, and an "Outreach →" button. `GET /api/sdr/leads`, `POST /api/sdr/sync/leads` (admin). Built in `SdrInterface.tsx` (LeadsView/LeadCard/StatCard) + `src/lib/sdrApi.ts` (SdrLead, listLeads, syncLeads).
- **Dedup guard** at approve-and-send (409 `already_outreached` unless admin `override:true`). `last_outgoing_mail_time` is the signal.
- **Self-hosted open/click tracking** (per-lead, free): pixel `{{contact.swppp_track}}` in every Apollo template; `swppp_track` CF id `6a32559593e27d000c4ee92f` set = draft id at send; public `GET /api/sdr/track/open/:token` + `/track/click/:token?u=` → `/api/sdr/events/ingest`. `lib/sdrTracking.js`.
- **Replies/bounces poll** `lib/apolloEngagementPoll.js` (cron ~2min). Engagement → `sdr_engagement_events`, surfaced by `GET /api/sdr/engagement/summary` + EngagedView.
- **Sequence editor** (Cold lane → Sequences tab): WYSIWYG (`RichTextEditor`), `GET /api/sdr/sequences` + `PUT /api/sdr/sequences/templates/:id` (admin, double-confirm). All 10 templates styled blue-Georgia (`#1a5276`). Mailbox signatures rebranded to `#1a5276` Georgia (Apollo per-mailbox `signature_html`).
- **Apollo escapes body HTML** → all styling + pixel live in the TEMPLATE, body stays plain text.
- Sequences active: AGC `6a2ac17c71c0fc000cecf469`, LBA `6a2ac17eef87e000180cb54a`, CM `6a2ac18173bec0001018e927`, PB `6a2ac184ac17ea000ce1b28f`. `APOLLO_SEQ_*` env set. Apollo key `bl7X4VR27185B7UrFBBg_Q` (X-Api-Key, base /v1). PD token `3089d0ffb03a7f996c5f10156fd4ebfaad9fca28`.

---

## Phase A — Stage-derived trigger (makes the Leads view actionable)
**Problem:** 493/500 leads have null `trigger_type` (the `Trigger_AGC/LBA/CM/PB` fields are only set by the legacy n8n flow), so the Outreach button is disabled ("Needs a Trigger in Pipedrive"). But every lead has a **Project Stage** (free-text varchar, key `7c1852c27664d1118f75660223a6af9e99d10f2c`). Derive the trigger from the stage.

**Stage value distribution (live):** AGC 190, LBA 156, PB 137, CD 7, CM 3, Pre-Bid 2, OB 1, "Miscellaneous - *" 4.

### Task A1: derive trigger from stage in the sync
- **File:** `lib/pipedriveSync.js`.
- Add a map: `const STAGE_TRIGGER = { AGC:"AGC", LBA:"LBA", CM:"CM", PB:"PB", OB:"PB", "PRE-BID":"PB" }` (uppercase-keyed; "Miscellaneous - *" and "CD" → null, do not outreach).
- Compute `trigger_type` as: `inferTriggerType(lead)` (Trigger_X fields, authoritative if a human set it) **||** `STAGE_TRIGGER[(project_stage||"").trim().toUpperCase()]` **||** null. Store in `sdr_lead_state.trigger_type`.
- Test: trigger a resync (`POST /api/sdr/sync/leads`), then `GET /api/sdr/leads` and assert `trigger_type` distribution ≈ AGC 190 / LBA 156 / PB ~140 / CM 3, with ~13 null (CD + Misc + Pre-Bid edge).

### Task A2: Leads view reflects it
- The Outreach button already uses `lead.trigger_type`; once the mirror is populated it auto-enables. Verify the "Needs a Trigger" hint now shows only for the ~13 unmappable leads.
- Keep a tiny inline trigger picker (AGC/LBA/CM/PB dropdown) ONLY for leads whose derived trigger is null, so even CD/Misc leads can be outreached manually. Optional but nice.

---

## Phase B — Pipedrive lead deep-link
- **File:** `SdrInterface.tsx` LeadCard.
- Add an "Open in Pipedrive ↗" link per lead: `https://proswpppllc.pipedrive.com/leads/inbox/${pipedrive_lead_id}` (make the base `process.env`/constant `PIPEDRIVE_LEAD_BASE` overridable; domain = `proswpppllc`). Small, secondary, opens new tab.
- Also add the same deep-link on draft rows (Queue) and the Priority view.
- Test: click → opens the correct PD lead.

---

## Phase C — 🔥 Priority view (engagement-ranked)
**Now that self-hosted tracking flows opens/clicks**, make engagement actionable.
- **File:** `SdrInterface.tsx` (enhance EngagedView or add PriorityView). Data: `GET /api/sdr/engagement/summary` (returns leads + by_trigger + by_sender; leads have `opened`/`clicked`/`score`). Verify the score weights **clicks > opens > replies** (check `server.js` engagement/summary scoring; adjust if needed).
- Make it a prominent tab/section: hot leads sorted by score, each showing open/click/reply counts + recency, a **"Call / Follow-up"** CTA, the PD deep-link, and the sender. Empty state explains "engagement appears as leads open/click."
- Test: hit a track URL for a sent draft (`/api/sdr/track/open/<draftId>` + `/track/click/<draftId>?u=...`), confirm that lead rises in Priority.

---

## Phase D — Clarity rollout (apply the Leads visual standard)
The Leads view set the standard: summary-first big-number cards, spacious `p-5 rounded-xl` cards, `text-base`/`text-lg` primary text, color-coded status, generous whitespace. The other Cold-lane tabs (Queue, Engaged, Sequences, Mailboxes, Dashboard) are still dense/small.
- **File:** `SdrInterface.tsx`.
- De-densify Queue (draft rows → spacious cards w/ the OutreachBadge already present), Sequences (the step editor stack is cramped — add per-sequence collapse, more spacing, a summary header), Mailboxes, Dashboard. Add summary headers with counts where it helps.
- Keep all existing functionality + guardrails (admin gates, double-confirm, dedup).
- Test: playwright screenshots at 1440 + 375; confirm no console errors and a visibly cleaner layout.

---

## Final
- Full playwright pass over every Cold-lane tab (screenshots, console-error check).
- Update memory `project_sdr_automation.md`.
- Confirm a real/test send renders blue-Georgia + the open pixel fires (tomorrow's scheduled test or first live send).
