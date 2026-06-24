# SDR Outreach Batch — Implementation Plan (2026-06-24)

Execution context for the agent picking this up after compaction.

## Environment / deploy rules (READ FIRST)
- Repo root: `/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system/`. GitHub `TheProSWPPP/swppp-interface`, Railway auto-deploys `main`.
- Build = `npm run build` (tsc -b + vite). Validate server with `node --check server.js`.
- **Local checkout is ~30+ commits BEHIND origin/main** (skip-detection + track-field fixes live ONLY on origin/main, never committed locally). So:
  - server.js: NEVER copy local → worktree. Re-apply each edit in a worktree cut from `origin/main`.
  - Frontend files (SdrInterface.tsx, sdrApi.ts) and lib/*.js: diff `git show origin/main:<f>` vs local; if the only diffs are this session's edits, copying is safe.
- Deploy via detached worktree: `git fetch origin main`; `git worktree add --detach /tmp/wt origin/main`; apply/copy; `node --check` + `npm run build` (symlink node_modules from main checkout); commit; `git push origin HEAD:main`; `git worktree remove --force`.
- After every server.js edit confirm guard intact: `grep -c apollo_skipped server.js` =1, `grep -c 6a3b065762456a00208db22b server.js` =1, `grep -c registerPermitExportRoutes server.js` =2.
- Verify live via API: mint admin JWT with `SDR_JWT_SECRET` (in `/tmp/rwvars.json` = `railway variables --service swppp-interface --json`), sub=`7b7930f3-1439-4c1e-830b-5cf6483d1458`, username=derek, role=admin. Railway CLI keeps flipping to Ivan's personal account; re-fetch rwvars when it works. DB: `postgresql://postgres:EQBDBavxyARYZGeafCVguWQuhUsmMMGb@switchback.proxy.rlwy.net:12018/railway`.
- Last deployed commit at plan time: `62c7e72` (reply/bounce/unsub note-spam gate).

## Current engine state (don't regress)
auto_outreach: enabled, mode=send, auto_min_score=null (no floor), gate = `start_date >= CURRENT_DATE` (future start), rotates dc/jg/mh/th, warmup caps ~5/mbx/day.

---

## Task 1 — Reply → Pipedrive ACTIVITY assigned to the sending rep (supersedes note-only)
**Why:** Ivan wants a real follow-up Activity on reply, owned by whoever sent (dc/jg/mh/th), not just a note.

**Blocker to resolve first:** `sdr_mailboxes.pipedrive_sender_id` is NULL for all 4 mailboxes. Need each rep's Pipedrive USER id.
- Step 1a: `pipedriveClient` already has a users lookup (see lib/pipedriveClient.js ~line 97 "All Pipedrive users"). Call it, list users (id, name, email). Likely only Derek is a real Pipedrive user (single-seat). 
- Step 1b: Map mailbox → pipedrive user by email/name where possible; **fallback to Derek's user_id** for reps with no Pipedrive seat. Persist into `sdr_mailboxes.pipedrive_sender_id` (one-time UPDATE), so the reply handler can read it.

**Code:**
- `lib/pipedriveClient.js addActivity` (signature: `{ leadId, personId, subject, type, dueDate, done, note }`) — ADD `userId` param → `if (userId) body.user_id = userId;`.
- `server.js` events-ingest reply block (now gated on `newlyInserted`, ~line 2501). Inside the gate, after/instead of the note, fetch the send's mailbox → pipedrive_sender_id and:
  ```js
  // sendRow has mailbox_id; join sdr_mailboxes for pipedrive_sender_id + email
  await pipedriveClient.addActivity({
    leadId,
    subject: `Reply received${contactEmail ? ` from ${contactEmail}` : ""} — follow up`,
    type: "task",            // or "call"
    done: false,
    userId: pipedriveSenderId || DEREK_PD_USER_ID,
    note: `Replied to ${mailboxEmail} outreach. Open in interface: ${appBase}/#/sdr?lead=${leadId}`,
  });
  ```
  Keep this idempotent (still inside `if (newlyInserted)`). Decide: keep the one note too, or replace note with activity. Ivan said "instead of just a note" → activity is the primary; a short note with the interface link is fine to keep.
- The reply handler currently has `sendRow` (sdr_sends row) but may not have mailbox_id/email loaded — confirm `sendRow` columns; if missing, add a `SELECT mailbox_id` and join sdr_mailboxes for email + pipedrive_sender_id.

**Verify:** trigger/await a real reply (or simulate an `email_replied` ingest with force) → exactly ONE activity on the lead, assigned to the right user, plus ≤1 note.

---

## Task 2 — Inbox overview misses replies from a DIFFERENT person in the thread
**Why:** We send to Todd; Kyle (kdorsey@carrolldaniel.com) replies on the same thread. Overview matches `last-message From` → Kyle isn't a lead → reply hidden. Real B2B hand-offs.

**Fix:** match a thread by ANY participant, not just the last From.
- `lib/gmailInbox.js listThreads` (now parallelized): currently only uses `last` message's From/To. Change to also collect **all participant emails across all messages** in the thread (each `full.messages[].payload.headers` From + To). Return `participants: string[]` (deduped, lowercased) on each thread object.
- `server.js /api/sdr/inbox/overview`: build the candidate set from `participants` (not just `parseEmailAddr(t.from)`). Match any participant against `sdr_lead_state.person_email` (and permit emails). Keep direction from `lastOutbound`. When matched via a non-last-From participant, it's still a reply thread (inbound) — keep `direction: "in"`.
- Watch: don't let our own mailbox addresses (dc/jg/mh/th@proswppp.co) match anything (they won't be in sdr_lead_state). Permit/SDR matching unchanged otherwise.
- Cost: participants come from the already-fetched thread metadata (no extra Gmail calls). Keep maxResults=12.

**Verify:** the carrolldaniel thread (we sent to tdonaldson, Kyle replied) shows in `/api/sdr/inbox/overview` with the lead title + direction "in".

---

## Task 3 — Enrollment note: include the full sent email (subject + body + signature)
**Why:** the `[Auto] Apollo: enrolled ...` note should show what was actually sent.

**Code (server.js approve-and-send, ~line 3030–3145):**
- The mailbox query in approve-and-send selects `id, email, apollo_mailbox_id, warmup_started_at` — ADD `signature_html`.
- In the Pipedrive write-back `addNote` (the `[Auto] Apollo: enrolled ...` content), append:
  ```
  \n\n--- Email sent ---\nSubject: ${draft.subject}\n${draft.body}\n${mailbox.signature_html || ""}
  ```
  Pipedrive notes accept HTML; convert body `\n`→`<br>` and append `signature_html` (already HTML). Keep the existing "Open in interface" link.
- This is the manual + auto path (both go through approve-and-send).

**Verify:** send a test draft → the enrollment note contains subject + body + signature.

---

## Task 4 — Lead detail drawer: wider + more readable
**Code (SdrInterface.tsx `LeadDetailDrawer`, ~line 1114 + the wrapper ~line 1170):**
- Wrapper is `max-w-[480px]`. Bump to `max-w-[640px]` (or `[720px]`). Check it still slides from the right and the dark overlay onClick-close still works.
- Increase readability: the snapshot `<dl className="grid grid-cols-2 gap-3 text-sm">` → consider `gap-4`, label/value spacing, and the timeline (`Activity timeline`) font/spacing. The "View email" preview block already exists. Keep mobile (max viewport) usable: `w-full max-w-[640px]`.
- No backend. Frontend-only, single file.

**Verify:** open a lead from Leads/Queue/Engaged → drawer is noticeably wider and the email preview reads cleanly.

---

## Task 5 — Outreach/Review button disabled when already outreached
**Why:** prevent re-outreaching a lead we already sent to.

**Definition of "already outreached":** `lead.send_status === "enrolled" || lead.send_status === "sent" || !!lead.outreach_sent_at`. (Covers our interface enrollment + ledger send. Confirm with Ivan whether a Pipedrive-historical `outreach_sent_at` should also block — likely yes per "already an outreach".)

**Code (SdrInterface.tsx):**
- Table row `LeadRow` (~line 1633–1780): the outreach button (~1773) currently disabled unless `hasTrigger`. Add `alreadyOutreached` → set `disabled` + greyed style + title "Already outreached". 
- Drawer button (~1413): `{onOutreach && lead.trigger_type && (...)}` → also hide/disable when `alreadyOutreached`.
- Helper: compute `const alreadyOutreached = lead.send_status === "enrolled" || lead.send_status === "sent" || !!lead.outreach_sent_at;` in both places (or a shared util).

**Verify:** a lead with an interface send shows the outreach button disabled; a fresh lead with a trigger shows it enabled.

---

## Task 6 — Verify inbox overview is fast (post 2b93ea9 parallelization)
- Time `GET /api/sdr/inbox/overview` a few times; expect ~1–3s (was 10–20s). If still slow, the per-thread metadata fetch volume is the cause — consider lowering maxResults further or caching. No code change unless it's still slow.

---

## Suggested order
1 (reply activity) and 2 (thread-participant matching) change behavior Ivan cares about most → do first. Then 3, 5, 4, 6. Batch server.js items (1,2,3) into as few worktree deploys as sensible; frontend items (4,5) can ride together. Re-verify the spam gate (62c7e72) is live and the test-lead/tdonaldson notes stayed clean.
