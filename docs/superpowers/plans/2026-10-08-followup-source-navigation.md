# Follow-up Source Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already authorized autonomous execution; no routine approval pause is required. Keep one implementation writer in this worktree and use the independent review gates in the mission.

**Goal:** From an open follow-up or next-step review, staff can open its Pipedrive parent project and an available lead-level inbox conversation, while seeing truthful source and unavailable-state labels.

**Architecture:** Reuse the existing `#/sdr?inboxLead=<leadId>` destination in a new browser tab so the original Follow-ups filters, loaded pages, and scroll position remain intact. First constrain its existing GET lookup to the configured CRM company and connected mailboxes visible to the viewer; its current preferred-sender path lacks that check. The destination already rejects stale lookup responses; add a small visible fallback notice when it cannot open a thread. Centralize safe CRM parent-link validation and the same-origin inbox URL in one pure helper. No new route, CRM write, permission expansion, or source-to-message attribution is introduced.

**Tech Stack:** React 19, TypeScript 5.9, Vitest 4, existing hash navigation and CSS. No added dependency.

**Spec:** [Follow-up workflow corrections](../plans/2026-10-07-followup-workflow-corrections.md), package A of the October 8 autonomous delivery mission (private local run contract).

## Global Constraints

- Freeze sequences, campaigns, enrollment, email/LinkedIn copy, cadence, timing, sending rules, sender identities, suppression/holds, provider stops and runtime sending flags. Do not touch send code or configuration.
- No automatic business writes and no live send/reply/CRM write testing. Original task completion/rescheduling remains in Pipedrive; do not bypass `protectCrmWrite`. Opening an actual Gmail inbox thread currently calls `markThreadRead`; this is an existing deliberate staff read-state side effect, so agent live checks must stop before that GET.
- Preserve original task IDs, dates, owners, evidence identities and list context. A lead-level current-contact inbox search does not establish the originating task email, the most recent staff interaction, or complete mailbox coverage.
- Show project/deal/person/organization links as **parent CRM record** links. Never label them as a specific activity/note permalink.
- Preserve existing company and staff visibility. The existing thread route returns an empty result for an invisible lead; new UI must not infer or reveal a denied mailbox/thread.
- Only one implementation writer. Before release: independent design, code and exact-revision release reviews; full local suite/build; desktop and 390px visual inspection; live version/asset/GET checks. No private customer data in Git fixtures.

## File map and interfaces

| Path | Responsibility |
| --- | --- |
| `src/components/sdr/followupNavigation.ts` (new) | Pure `parentCrmUrl(value: string \| null \| undefined): string \| null` and `leadInboxHref(leadId: string): string`. Restrict CRM host to `proswpppllc.pipedrive.com`, HTTPS and recognized parent paths; encode lead IDs. No fetch or mutation. |
| `src/components/sdr/followupNavigation.test.ts` (new) | URL, label-contract input and denial/ambiguity-safe helper tests. |
| `server.js:2965-3020` | Narrow authorization correction to the existing thread lookup GET only: configured-company lead, then connected viewer-visible mailbox intersection before token/Gmail reads. No other server hunk. |
| `lib/__tests__/sdrLeadThreadAccess.test.js` (new) | Isolated handler test for admin/staff, company boundary, inaccessible preferred sender, no token/Gmail read on denial, and authorized fallback. |
| `src/components/sdr/CrmFollowUps.tsx` | Add a same-origin new-tab conversation action per project and the parent CRM source link with accurate labels; retain current task ID/due/owner and Pipedrive handling guidance. |
| `src/components/sdr/FollowupReview.tsx` | Add one parent source link for every evidence record with a valid URL; retain project source link and preserve evidence identity/order. Add conversation action per project. |
| `src/components/SdrInterface.tsx` | At the existing `inboxLead` hash listener, show an explicit non-sensitive fallback notice for empty lookup versus request failure, only for the latest request. Do not change GET route, mailbox resolution, inbox compose or reply behavior. |
| `src/components/sdr/followups.css` | Only necessary spacing/wrapping/focus styles for navigation at desktop and 390px. |
| `src/components/sdr/CrmViews.test.ts`, `lib/__tests__/priorityInboxNavigation.test.js` | Focused rendered-link and stale/fallback tests. Existing route/visibility tests remain unchanged unless a defect is found. |

The reusable `leadInboxHref` returns a relative hash, `#/sdr?inboxLead=${encodeURIComponent(leadId)}`. Render it as `<a target="_blank" rel="noopener noreferrer">` so navigation is a direct user gesture and the current list stays open. The destination's lookup remains a *candidate conversation* for the lead's current contact. A project with several conversations stays ambiguous even when this GET returns one thread; use a standing caution in the link label/help text. If no thread is found, the destination opens the existing lead drawer and displays “No available inbox thread was found for this project. Check Pipedrive and other conversations.” If the lookup throws, display “Inbox search is unavailable. Check the project in Pipedrive.” Never display the contact email or mailbox ID in these notices. The staff handoff must state: opening the inbox thread marks it read in Gmail; it does not send a message or complete the CRM task.

## Review Focus

1. An activity linked ambiguously to two projects must remain absent from the server list; no helper may guess the destination. Task 3 uses only the server-provided `leadId`, and the existing `sdrFollowupRecovery.test.js` exclusion remains a required regression test.
2. An activity source URL on a different Pipedrive tenant or a script URL must render as text/no link. Task 1 tests exact host and scheme.
3. An older thread lookup finishing after a newer hash must not show an old thread or old failure notice. Task 4 extends the existing race test.
4. A missing or denied thread must not turn into a claimed exact-email source or expose mailbox metadata. Task 4 tests generic fallback wording.
5. A review project with five evidence records and repeated parent URLs must show each original ID and its own valid parent link in order, without merging identities. Task 3 tests this.
6. An admin requesting a lead from another CRM company must cause zero Gmail token/search calls. An SDR whose preferred sender mailbox is inaccessible must cause zero token/search calls to that mailbox; a connected viewer-visible fallback remains allowed. Task 2 tests both at the GET boundary.

---

### Task 1: Pure source navigation contract

**Files:** Create `src/components/sdr/followupNavigation.ts`; create `src/components/sdr/followupNavigation.test.ts`.

**Interfaces:** Produces `parentCrmUrl(value: string | null | undefined): string | null` and `leadInboxHref(leadId: string): string`; Task 3 consumes them. The helper never calls a provider.

- [ ] **Step 1: Write failing tests** for `parentCrmUrl('https://proswpppllc.pipedrive.com/leads/inbox/123')` returning the URL; permitted `/deal/`, `/person/`, `/organization/` parent paths; `null`, `javascript:`, `http:`, and `https://other.pipedrive.com/leads/inbox/123` returning `null`; and `leadInboxHref('lead A/B') === '#/sdr?inboxLead=lead%20A%2FB'`.
- [ ] **Step 2: Run** `npx vitest run src/components/sdr/followupNavigation.test.ts`. Expect import failure.
- [ ] **Step 3: Implement** with `new URL(value)` in a try/catch, `url.protocol === 'https:'`, `url.hostname === 'proswpppllc.pipedrive.com'`, no username/password, and pathname matching `^/(?:leads/inbox|deal|person|organization)/[^/]+/?$`; return `url.toString()` or `null`. For `leadInboxHref`, use `encodeURIComponent(leadId)`; callers only pass an observed server `leadId`, never a user-entered search term.
- [ ] **Step 4: Run** `npx vitest run src/components/sdr/followupNavigation.test.ts`. Expect pass. Commit only after the scoped task review gate permits it, with `git add` restricted to these two paths.

### Task 2: Authorize the existing thread lookup before adding links

**Files:** Modify only `server.js:2965-3020`; create `lib/__tests__/sdrLeadThreadAccess.test.js`.

**Interfaces:** Consumes existing `visibleMailboxes(req.sdrUser)` and `leadVisibleTo(pool, req.sdrUser, leadId)`; produces the unchanged GET response `{mailbox:string|null,threadId:string|null}`. Returns the same empty shape for inaccessible/missing lead and missing authorized mailbox. Do not add a new route or use a provider write.

- [ ] **Step 1: Write failing route-handler tests** using a local synthetic Postgres fixture or a dependency-injected `new Function` handler extraction as in `sdrInboxOverview.test.js`. Include: (a) admin requests a lead whose `crm_company_id` differs from `SDR_CRM_COMPANY_ID`: empty shape, no `accessTokenForMailbox`/`listThreads`; (b) staff lead passes visibility but its recent `sdr_sends` sender is not in `visibleMailboxes`: never query that sender's Gmail, use only a connected viewer-visible mailbox if available; (c) visible sender is disconnected: empty shape/no token; (d) authorized company/lead and connected visible sender: existing thread shape; (e) no configured company ID: fail closed with 503 and no provider call. Use synthetic addresses and no production token.
- [ ] **Step 2: Run** `npx vitest run lib/__tests__/sdrLeadThreadAccess.test.js`. Expect the denial tests to fail against the old route.
- [ ] **Step 3: In the existing GET handler**, require `process.env.SDR_CRM_COMPANY_ID`; query `sdr_lead_state` with both `pipedrive_lead_id=$1` and `crm_company_id=$2`; return the empty shape before touching Gmail if absent. Keep `leadVisibleTo` and verify its result, but do not rely on its admin bypass for company scope. Call `visibleMailboxes` once, take only connected addresses, and intersect preferred `sdr_sends` mailboxes against those addresses case-insensitively. Preserve preferred order; if no *authorized preferred* mailbox remains, consider only the viewer's connected mailboxes. Never call `accessTokenForMailbox` on an unlisted sender. Keep the response shape and bounded five-thread search; avoid changing the route's search or mutating inbox read state.
- [ ] **Step 4: Run** `npx vitest run lib/__tests__/sdrLeadThreadAccess.test.js lib/__tests__/sdrInboxOverview.test.js` and `node --check server.js`. Expect pass. Obtain separate hunk review of this server change before proceeding; if the company/mailbox authorization cannot be established, omit the inbox anchor from Tasks 3–4 and ship parent CRM source links only. Commit only `server.js` and its test after review.

### Task 3: Source and conversation links in both follow-up lists

**Files:** Modify `src/components/sdr/CrmFollowUps.tsx`, `src/components/sdr/FollowupReview.tsx`, and if required `src/components/sdr/followups.css`; modify `src/components/sdr/CrmViews.test.ts`.

**Interfaces:** Consumes Task 1 helpers and the verified Task 2 GET authorization. `CrmFollowUps` and `FollowupReview` keep existing `onOpenLead(leadId)` for same-tab project drawer; the new anchor uses `leadInboxHref(leadId)` in a new tab. No props or API response types change.

- [ ] **Step 1: Add failing tests** for the rendered navigation using the existing static markup test or a small extracted presentational card if hook-driven data cannot be injected cleanly. Fixtures: one task (`id:'task-1'`, `leadId:'lead-1'`, parent `sourceUrl`, original due date and owner); two review evidence rows with distinct IDs and valid parent URLs; one invalid evidence URL. Assert a `target="_blank"` same-origin inbox link, `rel="noopener noreferrer"`, “Find a conversation for this project” wording, per-evidence “Open parent CRM record” links, task ID/date/owner preserved, and no “task email”/“note permalink” claim. Use synthetic `example.invalid` contact fields only.
- [ ] **Step 2: Run** `npx vitest run src/components/sdr/CrmViews.test.ts`. Expect new assertions to fail.
- [ ] **Step 3: Replace** each component's local permissive `sourceLink`/`safeSource` with `parentCrmUrl`. Add the new inbox anchor at the project heading/context, with a visible helper sentence: “Searches conversations for this project's current contact. Other threads may exist; check the task and project history.” In `FollowupReview`, put each evidence's valid parent URL inside its own `<li>` and label it “Open parent CRM record for [note/activity] [id]”; keep the separate project link labeled “Open project in Pipedrive.” Keep the existing `onOpenLead` button and task guidance. Do not move records, fabricate a thread ID, or invoke `findLeadThread` from the list.
- [ ] **Step 4: Run** `npx vitest run src/components/sdr/CrmViews.test.ts src/components/sdr/followupNavigation.test.ts src/components/sdr/followupView.test.ts` and `npm run build`. Expect pass. Inspect diff for JSX nesting, focus order, rel/target, and 390px wrapping. Commit only owned paths after scoped review.

### Task 4: Honest destination fallback and stale lookup protection

**Files:** Modify only the existing `inboxLead` hash effect and its notice rendering in `src/components/SdrInterface.tsx`; extend `lib/__tests__/priorityInboxNavigation.test.js`.

**Interfaces:** Consumes unchanged `sdrApi.findLeadThread(leadId): Promise<{mailbox:string|null;threadId:string|null}>`. The effect continues to call `goInbox({threadId,mailbox})` on success and `setDeepLeadId(leadId)` on fallback. Produces a local UI notice string for empty versus rejected lookup; no event/API format changes.

- [ ] **Step 1: Extend the existing race harness** with deferred first lookup then successful second lookup, and deferred first rejection then empty second lookup. Assert first result/rejection never changes the newest thread/notice. Add empty-result test asserting lead drawer fallback and generic no-thread notice; thrown-result test asserting generic unavailable notice; successful-result test asserting notice clears. Keep the role/tenant route behavior in `lib/__tests__/sdrFollowupRecovery.test.js` as a required regression check.
- [ ] **Step 2: Run** `npx vitest run lib/__tests__/priorityInboxNavigation.test.js`. Expect the new fallback assertions to fail.
- [ ] **Step 3: In the hash effect**, set notice to `null` at each new request, assign `null` on success, assign the no-thread or unavailable wording only inside `if (request === generation)`, then call `setDeepLeadId(inboxLead)` for the latest fallback. Clear notice when drawer closes or a later lead navigation starts. Render the notice near the existing signed-in tab/drawer area with `role="status"` or `role="alert"` and a dismiss control; never include mailbox/thread IDs. Preserve the current request-generation and cleanup logic exactly. If changing the legacy source-slice harness becomes brittle, extract just the hash-listener setup to a named helper and test it directly, without changing route behavior.
- [ ] **Step 4: Run** `npx vitest run lib/__tests__/priorityInboxNavigation.test.js lib/__tests__/sdrFollowupRecovery.test.js` and `npm run build`. Expect pass. Review the `SdrInterface.tsx` diff at the hunk level to exclude compose, reply, send, queue, template and sequence code. Commit only the owned component/test paths after scoped review.

### Task 5: Synthetic visual and release gates

**Files:** No production code by default; store sanitized test/preview receipts outside Git in the run's private delivery folder. Any CSS fix is limited to `followups.css` and reruns Task 3 checks.

**Interfaces:** Consumes Tasks 1–4. Produces exact revision/test/visual/release receipts for independent reviewers.

- [ ] **Step 1: Build a synthetic UI fixture** in a local mocked GET environment with: two open tasks (dated/undated), one held project, one current-contact conversation candidate, one missing inbox thread, one rejected inbox GET, and a Review card containing five evidence rows including an invalid parent URL. Stub every POST/PATCH/DELETE to fail the fixture and log any attempt; never use production CRM/mailbox credentials. Stub the full-thread GET too because the real endpoint marks Gmail read.
- [ ] **Step 2: Inspect** Follow-ups and Review at 1280×800 and 390×844. Check link labels, keyboard focus, horizontal overflow, evidence readability, destination new tab, fallback notice, and original list state after returning. Save sanitized screenshots and observations outside Git. If CSS changes, rerun the targeted tests/build and inspect both sizes again.
- [ ] **Step 3: Run** `npm test`, `npm run build`, `npm run lint`, `git diff --check`, and `git diff --name-only 507c9ea...HEAD`. Record test count/skips, warnings, exact commit, changed paths, and a zero-diff check for send/campaign/config/provider-operation files. Resolve failures in owned scope; do not weaken tests.
- [ ] **Step 4: Obtain independent scope/design review before code, code/test review after implementation, and exact-final-revision release review.** The release reviewer checks current `origin/main`, deployed SHA, approved allowlist, baseline holds/settings, restart job behavior and rollback target. A material unresolved issue blocks this package's deployment.
- [ ] **Step 5: After gates pass,** use the existing GitHub PR and Railway application release path. Verify the live SHA, served asset, JSON content type for existing GET routes, and staff/admin/anonymous access behavior using safe synthetic or missing IDs. Stop before opening any real customer Gmail thread: `GET /api/sdr/inbox/threads/:id` marks it read. Compare baseline holds/sending flags/provider operations before and after restart. Record the release receipt and staff handoff text disclosing the existing read-state effect; do not use a real send/reply/CRM write as a smoke test. Roll back only this app revision if it regresses, after checking for later deployments.

## Self-review result

This plan covers project and conversation navigation, per-evidence parent links, missing/failed lookup notices, async race behavior, list preservation, company/mailbox access boundaries and freeze checks. It leaves original-task mutation and outcome writes to the later design package because the current CRM guard intentionally blocks existing-activity edits. The narrow existing-GET authorization repair is a prerequisite for inbox links; if it cannot pass review, release only parent CRM navigation. The main unprovable behavior remains source-thread identity: the existing GET searches by current contact and selects one candidate, so every UI label and the release receipt must say that explicitly. Opening the selected full Gmail thread is a current staff read-state mutation (marks read), so agent live tests must not do that.
