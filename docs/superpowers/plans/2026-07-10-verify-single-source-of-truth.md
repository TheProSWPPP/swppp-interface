# Verification Single Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NeverBounce the single verification source of truth over the shared Pipedrive lead book, consumed by BOTH the `.co` (interface/Apollo) and `.com` (Pipedrive-triggered) send channels, and retire the redundant, weaker Apollo email-verification in n8n.

**Architecture:** The interface's existing NeverBounce pass already verifies the whole eligible book with a live SMTP check and writes results to Postgres `sdr_lead_state` (`email_verify_status`, `email_flag`, `resolved_email`). It stays the single verifier. We (1) expose a per-lead verify-on-demand endpoint for freshly-triggered leads, (2) gate the `.com` send workflow (`Pro SWPPP SDR Automation`) on the shared Postgres result, and (3) disconnect the weaker Apollo email-verification in the n8n CMD chain. No verifier is duplicated; both channels read one source.

**Tech Stack:** Node ESM + Express (interface, Railway `swppp-interface`), PostgreSQL (Railway, shared), n8n (proswppp.app.n8n.cloud, workflows edited via `n8nac` CLI), NeverBounce (`lib/emailVerify.js`).

## Architecture decision (why this shape, not "rebuild verify in n8n")

Ivan's ask was "make the n8n daily refresh the source of truth, using NeverBounce, since Apollo verify isn't good enough." Investigation on 2026-07-10 found two facts that redirect the *mechanism* while keeping the *intent*:

1. **The n8n daily refresh is NOT a full-book verifier.** `CMD Smart Refresh - Daily` (`JIZMs2AQNHrRAsbt`) is a construction-market-data scraper: `Build Candidates` selects tier-A/B leads gated on `!!cmd_url` + a 36h freshness window, cap 1000/day. Apollo verify is a side-effect of that subset enrichment. Rebuilding NeverBounce there would verify FEWER leads than today.
2. **The interface NeverBounce pass already is the ideal source of truth** — whole eligible book, live SMTP, results in Postgres. Proven live (2,576/2,688 clear leads carry a status, fresh timestamps daily).

So the best alternative is to keep the good verifier where it is and finally have `.com` consume it, rather than duplicate a weaker/partial verifier in n8n. The **result** in Postgres is the shared source of truth both channels read — which is the actual goal. If Ivan specifically wants the verifier operationally owned inside n8n (Option B: a new dedicated n8n workflow paging ALL leads → NeverBounce → Postgres, retiring the interface pass), that is a larger, duplicative build; flag before executing.

## Global Constraints

- **Single verifier:** NeverBounce via `lib/emailVerify.js` (`EMAIL_VERIFY_PROVIDER=neverbounce`). Do NOT re-add Apollo email verification anywhere.
- **Shared store = Postgres `sdr_lead_state`** (per Ivan's "track SDR state in Postgres, not visible Pipedrive fields" rule). Columns already exist: `email_verify_status`, `email_verified_at`, `email_verified_value`, `resolved_email`, `email_flag`.
- **Fail-open everywhere:** a verifier/DB/API error must never block a send or break the sync (both channels). Out-of-credits already skips (interface) — preserve.
- **Both `.co` and `.com` are intentional live channels.** Do not disable either.
- **No coverage gap during migration:** `.co` keeps its send-gate throughout; `.com` gains the gate; interface pass keeps populating. Retire Apollo verify LAST.
- **Only `invalid`/`disposable` block; `catchall`/`unknown` soft-pass** (unchanged NeverBounce semantics).
- **n8n callback secret (hardcoded):** `swppp-lead-import-2026-r9k4hz3qwm8nbv` (used as `?callback_secret=` on interface endpoints called by n8n).
- **n8n Postgres cred:** `Railway SWPPP Postgres` (id `UignBb6N6lsezq9P`) — reuse for the gate node (same cred `Reserve Send Slot` uses in `pcUKAkMkvoKQ4kPY`).
- **`.com` send workflow:** `Pro SWPPP SDR Automation` (`pcUKAkMkvoKQ4kPY`, ACTIVE). It sets the Pipedrive trigger field and Pipedrive fires the email; gating = route to the existing `Skip` branch so the trigger is never set.
- **Ship interface from a worktree** (`/tmp/swppp-verify-wt`, branch `feat/verify-single-source`) via `git push origin HEAD:main`; verify with `npm run build` (NOT `tsc --noEmit`). Edit n8n via `n8nac` (pull → edit `.workflow.ts` → push), never hand-edit live in the UI mid-migration.

---

### Task 1: Per-lead verify-on-demand endpoint (interface)

Freshly-triggered `.com` leads may not yet be covered by the 6h pass. Give the `.com` workflow a synchronous "verify this one lead now" call that reuses the existing cascade and writes the shared result.

**Files:**
- Modify: `server.js` (add route near `POST /api/sdr/verify/run`)
- Modify: `lib/emailVerifyRefresh.js` (extract a single-lead helper `verifyOneLead`)
- Test: `lib/__tests__/emailVerifyRefresh.test.js`

**Interfaces:**
- Produces:
  - `verifyOneLead(pool, { leadId, personId, orgId, email }, { cap }) → { outcome, status, email_flag, resolved_email }` — runs the same `resolveContact` cascade + `writeVerifyCache` + `cancelInFlightOutreach` used by `runVerificationPass`, for ONE lead. Reuses the memoized-verify + adopt/flag logic. Returns the resulting cached row shape.
  - `POST /api/sdr/verify/lead?callback_secret=…` body `{ pipedrive_lead_id }` → looks up the lead in `sdr_lead_state` (person_email/person_id/org_id), calls `verifyOneLead`, returns `{ email_verify_status, email_flag, resolved_email }` (200). Fail-open: on any error returns 200 `{ skipped: true }` so the caller never blocks.

- [ ] **Step 1: Write the failing test** for `verifyOneLead` using injected fakes (mirror the `resolveContact` DI test): a lead whose primary hard-fails and has no alternate returns `{ outcome:'flagged', email_flag:'email_bad' }` and writes cache; a valid lead returns `{ outcome:'ok', status:'valid', email_flag:null }`.

```js
import { verifyOneLead } from "../emailVerifyRefresh.js";
// fake pool records writes; stub emailVerify via the same injection seam resolveContact uses.
// assert cache write params + returned shape for valid / flagged / recovered.
```

- [ ] **Step 2: Run test to verify it fails** — `cd /tmp/swppp-verify-wt && npx vitest run lib/__tests__/emailVerifyRefresh.test.js` → FAIL "verifyOneLead is not a function".

- [ ] **Step 3: Implement `verifyOneLead`** by factoring the per-lead body of `runVerificationPass` (the `resolveContact` → outcome switch → `writeVerifyCache`/`cancelInFlightOutreach`) into an exported function, and have `runVerificationPass` call it in its loop (DRY — the loop becomes `for (row of rows) await verifyOneLead(pool, leadFromRow, {cap, verify, canUseApollo})`). Keep the memoized `verify` + `apolloUsed` cap owned by the caller and passed in.

- [ ] **Step 4: Run test to verify it passes.**

- [ ] **Step 5: Add the route** `POST /api/sdr/verify/lead` (callback_secret-guarded like `/drafts/generate`): read the lead row, build `{leadId,personId,orgId,email}`, `await verifyOneLead(...)`, return the cached row; wrap in try/catch → 200 `{skipped:true}` on error.

- [ ] **Step 6: Build + full test** — `npm run build && npx vitest run` (both green).

- [ ] **Step 7: Commit** — `feat(sdr): per-lead verify-on-demand endpoint for the .com gate`.

---

### Task 2: Gate the `.com` send workflow on the shared verification result (n8n)

**Files:**
- n8n workflow `Pro SWPPP SDR Automation` (`pcUKAkMkvoKQ4kPY`) via `n8nac pull pcUKAkMkvoKQ4kPY` → edit `.workflow.ts` → `n8nac push`.

**Change:** after `Get Person Email` and before the lead-update path, insert:
1. **Postgres node "Verify Lookup"** (cred `UignBb6N6lsezq9P`): `SELECT email_verify_status, email_flag, resolved_email, email_verified_value FROM sdr_lead_state WHERE pipedrive_lead_id = '{{lead_id}}'`.
2. **HTTP node "Verify On-Demand" (conditional)**: if the lookup returns no row OR `email_verified_value` != the person's current email, `POST {interfaceBase}/api/sdr/verify/lead?callback_secret=swppp-lead-import-2026-r9k4hz3qwm8nbv` `{pipedrive_lead_id}` and use its response. `interfaceBase = https://swppp-interface-production.up.railway.app`. `continueOnFail: true` (fail-open).
3. **IF node "Email Bad?"**: `email_flag === 'email_bad'` OR `email_verify_status ∈ {invalid,disposable}` → route to the existing **`Skip`** node (no trigger set → Pipedrive sends nothing). Else continue to `Should Process?` as today.
4. If `resolved_email` is present, the `.com` path should send to it: the person's Pipedrive email is already updated to the resolved address by the cascade's `setPrimaryEmail`, so `Get Person Email` will already return it on the next run — no extra change needed. Add a sticky note documenting this.

- [ ] **Step 1:** `n8nac pull pcUKAkMkvoKQ4kPY` into the n8n-authoring workspace.
- [ ] **Step 2:** Add the `Verify Lookup` Postgres node wired from `Get Person Email`.
- [ ] **Step 3:** Add the `Verify On-Demand` HTTP node (conditional, continueOnFail) for the no-row/stale case.
- [ ] **Step 4:** Add the `Email Bad?` IF node → `Skip` on bad, else `Should Process?`.
- [ ] **Step 5:** `n8nac push` (workflow stays active).
- [ ] **Step 6: Verify with a controlled execution** — pick a KNOWN `email_flag='email_bad'` lead id (query Postgres for one), POST it to the workflow's `sdr-trigger` webhook, and confirm via `n8n_execs.py exec <id> --include-data` that it routed to `Skip` and set no trigger field. Then pick a known-`valid` lead and confirm it proceeds. Record both execution ids.
- [ ] **Step 7:** Document the change in the plan's companion note + a sticky note in the workflow.

---

### Task 3: Retire the Apollo email-verification in the n8n CMD chain

The interface NeverBounce pass + cascade now own validity AND alternate-finding (org persons + Apollo people-search already live in `resolveContact`). The n8n Apollo verify is redundant and weaker.

**Files:**
- n8n `CMD Per-Lead Processor` (`QsTHSvl3LvkpznqW`) via `n8nac`.

**Change:** disconnect `Call Apollo Verify v2` (`executeWorkflow` → `1p8GG5KWLIT5dEw9`) from the CMD per-lead flow so the daily scraper no longer performs email verification / alternate-finding. Leave the CMD data-scraping intact. Do NOT delete the `Apollo Verify v2` / `Apollo Email Verification` workflows (keep as archived/inactive for reference), just stop calling them from the active daily path.

- [ ] **Step 1:** Confirm no OTHER active workflow depends on `Call Apollo Verify v2`'s output for CMD data (only the verify/alternate branch). Trace the connections in the pulled `QsTHSvl3LvkpznqW.workflow.ts`.
- [ ] **Step 2:** Remove the `Call Apollo Verify v2` node (and its now-orphaned downstream verify-only nodes) from the CMD per-lead flow; reconnect the CMD-data path around it.
- [ ] **Step 3:** `n8nac push`.
- [ ] **Step 4: Verify** — trigger `CMD Smart Refresh - Daily` (or wait for the 5 AM/8 PM run) and confirm via `n8n_execs.py wf JIZMs2AQNHrRAsbt` that a run completes green and no Apollo verify sub-execution fires. Confirm CMD data still updates on a sample lead.

---

### Task 4: Confirm no double-verification + interface unchanged for `.co`

**Files:** none (verification task).

- [ ] **Step 1:** Confirm the interface `runVerificationPass` (6h) + send-gate remain ON and are now the ONLY NeverBounce caller. `.co` approve-and-send still reads the cache (unchanged). `sequence_unverified_email:true` stays (NeverBounce authoritative for `.co`).
- [ ] **Step 2:** After Task 3, watch NeverBounce credits (`GET /v4/account/info`) and Apollo credit usage for 48h — Apollo email-verify spend should drop to ~0; NeverBounce steady (only the interface pass + the new per-lead on-demand calls). Log the before/after in the companion note.
- [ ] **Step 3:** Spot-check three flagged (`email_bad`) leads end-to-end: confirm `.co` send-gate blocks them (existing behavior) AND the `.com` workflow now routes them to `Skip` (Task 2). Record lead ids + outcomes.

---

## Migration order (no coverage gap)

1. Task 1 (verify-on-demand endpoint) — additive, ships first.
2. Task 2 (`.com` gate) — `.com` starts consuming the shared result; fail-open so it can't block sends if the DB/endpoint hiccups.
3. Task 4 step-1 sanity — confirm both channels gated.
4. Task 3 (retire Apollo verify) — LAST, only after `.com` is confirmed consuming the shared store, so validity coverage never drops.

## Self-review notes

- **Coverage:** single verifier (NeverBounce interface pass) ✓; `.co` consumes (existing send-gate) ✓; `.com` consumes (Task 2 gate + Task 1 on-demand for fresh leads) ✓; Apollo verify retired (Task 3) ✓; Postgres shared store ✓; fail-open preserved ✓; migration order avoids gaps ✓.
- **Open item flagged for Ivan:** this keeps the verifier interface-side (Option A). If he wants the verifier rebuilt inside n8n over the full book (Option B), that is a separate, larger plan.
- **Risk:** freshly-imported leads racing a `.com` stage-change before any verification — mitigated by Task 1's on-demand call from Task 2's gate (fail-open if it errors).
