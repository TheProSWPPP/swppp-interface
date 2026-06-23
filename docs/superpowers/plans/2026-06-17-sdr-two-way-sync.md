# SDR ↔ Pipedrive Two-Way Sync + Lead Detail Drawer — Implementation Plan

> **For agentic workers:** Execute against the LIVE Railway deploy (no local Postgres). A concurrent "permit" process shares `swppp-system/` and switches branches/reverts files. Ship via an isolated worktree: `git worktree add --detach /tmp/sdr-wtX origin/main`, `ln -sfn "<repo>/node_modules" node_modules`, edit, `npm run build`, `git fetch origin && git rebase origin/main`, `git push origin HEAD:main`, `git worktree remove`. Verify UI with playwright-driver (basic-auth `derek:dereksystem` → top-nav "SDR" → "Derek" picker). DB URL: Railway GraphQL `variables(projectId 20fc4225-f1b1-447f-909c-cad612ba7860, envId 18f8b41e-06f0-48ff-806a-3df1a2bc0352, serviceId cca26bd2-f54a-4ccc-a8e8-f74f1abb7c64)` → DATABASE_PUBLIC_URL, `ssl:false`.

**Goal:** Make the SDR console a true coexistence layer over Pipedrive — a per-lead detail drawer that surfaces everything and lets reps write back (stage/trigger, notes, calls/activities), with precise Apollo sequence-step tracking and automated reply/bounce push-back to Pipedrive.

**Already shipped (rounds 1-3, commit 32de5c0):** branded sortable leads TABLE (server pagination/filter/sort), stage-derived trigger, dedup pre-confirm, Bid/Start cols, "Contact last emailed" relabel, sequence-stage chip (enrolled/sent), per-row Pipedrive **note** write-back (`POST /api/sdr/leads/:id/note`), Pro SWPPP brand band + pill tabs.

**Key IDs:** PD fields — Stage `7c1852c27664d1118f75660223a6af9e99d10f2c`, triggerAgc `4e555902fff229d66c1a631ea2135e3676d710c4`, triggerLba `310a6cfbcf364587467a42835b369cd4bf1766fa`, triggerCm `5fd5cb8c79f7be331ae9af9b03285d9fe1756699`, triggerPb `61435d2e87311ced7c75007334828fa2de9e9628`. Apollo seqs AGC `6a2ac17c71c0fc000cecf469` / LBA `6a2ac17eef87e000180cb54a` / CM `6a2ac18173bec0001018e927` / PB `6a2ac184ac17ea000ce1b28f`; key `bl7X4VR27185B7UrFBBg_Q`. PD token `3089d0ffb03a7f996c5f10156fd4ebfaad9fca28`.

---

## Phase 1 — Lead detail drawer (foundation, read-only)
**Backend:** `GET /api/sdr/leads/:leadId/detail` → aggregate: `sdr_lead_state` row + live `pipedriveClient.getLead` + `getPerson` + all `sdr_drafts` + all `sdr_sends` + `sdr_engagement_events` for the lead. Return `{ lead, person, drafts[], sends[], events[] }`.
**Frontend:** `LeadDetailDrawer` — right slide-out (`fixed inset-y-0 right-0 w-[480px]`), opened by clicking a table row (add `onClick` to `LeadRow`, keep action buttons `stopPropagation`). Sections: header (title + PD deep-link + stage/trigger), Contact, Timeline (drafts/sends/events merged, newest first), Actions footer (placeholder buttons for later phases). Loading/empty/error states.
**Test:** click row → drawer opens with data; 0 console errors.

## Phase 2 — Stage / Trigger write-back
**Backend:** `PATCH /api/sdr/leads/:leadId` body `{ project_stage?, trigger_type? }` → `pipedriveClient.updateLead(leadId, { [STAGE]: stage })` and for trigger set the matching `triggerX` field (map AGC→triggerAgc etc., value "1"/set per `isTriggerSet`); also UPDATE `sdr_lead_state` (project_stage, trigger_type). Return updated row.
**Frontend:** in drawer, Stage = editable `<select>` (from `/leads/filters` stages) + Trigger `<select>` (AGC/LBA/CM/PB/none); "Save to Pipedrive" with confirm. Optimistic refresh.
**Test:** change stage → confirm PD lead updated (re-GET) + row reflects it.

## Phase 3 — Log call / activity to Pipedrive
**Backend:** add `pipedriveClient.addActivity({ leadId, personId, subject, type, due_date, done, note })` → POST `/activities` (`lead_id`, `subject`, `type` in call|task|meeting, `due_date`, `done` 0/1). Route `POST /api/sdr/leads/:leadId/activity`.
**Frontend:** drawer "Log activity" → mini-form (type call/task, subject, optional due date, done toggle). Tag note "via SDR console".
**Test:** log a call → appears in PD lead activities.

## Phase 4 — Precise Apollo step tracking
**Backend:** new poller `lib/apolloStepPoll.js` (or extend `apolloEngagementPoll.js`): for each `sdr_sends` row with status not terminal, `GET /emailer_messages/search` by contact → derive current step position from `emailer_step_id` → campaign step positions, plus next send time. Store on `sdr_sends`: add cols `current_step INT`, `total_steps INT`, `next_send_at TIMESTAMPTZ`, `step_status TEXT` (ALTER IF NOT EXISTS). Surface in leads query (extend the `snd` lateral) + detail.
**Frontend:** sequence-stage chip → "AGC · Step 2 of 3 · next in 2d"; drawer Timeline shows each step's sent/scheduled state.
**Test:** an enrolled lead shows real step number matching Apollo UI.

## Phase 5 — Reply / bounce auto push-back to Pipedrive
**Backend:** extend `lib/apolloEngagementPoll.js`: when a send transitions to `replied` or `bounced` (first detection only — guard with a `pushed_to_pd_at` col on `sdr_sends` so it fires once), call `pipedriveClient.addNote({ leadId, content })` ("📨 Reply received via Apollo …" / "⚠️ Bounced …") and optionally set a PD flag. Event-driven, low-volume, idempotent — NOT a bulk blast.
**Frontend:** none required (shows via existing note timeline); optionally badge in drawer.
**Test:** simulate a replied send → exactly one PD note created, `pushed_to_pd_at` set; re-poll creates no duplicate.

---

## Final
- Full playwright pass (drawer open, edit stage, log activity, screenshots 1440+375), 0 console errors.
- Update memory `project_sdr_interface_revamp.md`.
- Guardrails preserved: no bulk mutations from transcript content; all writes user-initiated except the idempotent reply/bounce push (Ivan-approved).
