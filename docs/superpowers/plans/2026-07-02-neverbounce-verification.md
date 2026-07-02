# NeverBounce verification on contacts refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify Pipedrive contact emails via NeverBounce during the 6h refresh (lazy + cached, no double-verify), recover a working contact when the primary is dead (Pipedrive-org → Apollo → flag), cancel in-flight outreach on final failure, and make the send-time gate read the cache.

**Architecture:** A new `lib/emailVerifyRefresh.js` holds the pure decision logic + a dependency-injected cascade orchestrator, keeping `syncLeadState` thin. The refresh calls `runVerificationPass(pool, {cap})` at the end of each sync; it selects eligible+stale leads from `sdr_lead_state`, verifies via the existing `emailVerify.verifyEmail`, and on hard-fail runs the recovery cascade. New thin HTTP wrappers are added to `apolloClient`/`pipedriveClient`. The send gate (server.js) reads the cached verdict before calling the API.

**Tech Stack:** Node ESM, Express, PostgreSQL (pg Pool), Vitest. Existing `lib/emailVerify.js` (NeverBounce active via Railway env — no change).

## Global Constraints

- **Provider:** NeverBounce is already the active provider (`NEVERBOUNCE_API_KEY`, `EMAIL_VERIFY_PROVIDER=neverbounce` in Railway). Do NOT change `lib/emailVerify.js`.
- **Credit ceiling:** NeverBounce ~397 credits. Verify ONLY outreach-eligible leads (`outreach_status='clear'` AND `trigger_type` set), lazily, cached; re-verify only if the email string changed or `email_verified_at` is >90 days old.
- **Apollo cap:** at most **25** Apollo people-searches per refresh cycle. Overflow → flag `email_bad`, retry next cycle.
- **Soft results stay soft:** `catchall`/`unknown` pass through (never block).
- **Fail-open:** verifier/Apollo/Pipedrive errors must never throw out of the sync loop — wrap per-lead, log, continue.
- **Adoption writes to Pipedrive:** when a working alternate is found, set it as the person's primary email AND leave an `[Auto]` note (audit every mutation, like all other SDR notes).
- **Postgres-only state:** verification state lives on `sdr_lead_state`, not new Pipedrive custom fields.
- **House style:** HTTP wrappers use the existing `apolloFetch`/`pdFetch` helpers. Pure logic is unit-tested (Vitest in `lib/__tests__/`); HTTP wrappers + integration are verified with a `scripts/_*.mjs` smoke script (repo convention — no client unit tests exist).
- **Ship from the worktree** `/tmp/swppp-nb-wt` (branch `feat/neverbounce-verification`); deploy via `git push origin HEAD:main`. Verify build with `npm run build` (NOT `tsc --noEmit`).

---

### Task 1: Pure decision helpers

**Files:**
- Create: `lib/emailVerifyRefresh.js`
- Test: `lib/__tests__/emailVerifyRefresh.test.js`

**Interfaces:**
- Produces:
  - `needsVerify({ status, triggerType, email, verifiedValue, verifiedAt, now }) → boolean` — true only when eligible (status `'clear'` + triggerType truthy + email present) AND (no prior verify OR email changed OR verifiedAt older than 90 days).
  - `classifyVerifyResult(v) → 'pass' | 'hard_fail' | 'skip'` — maps the `emailVerify.verifyEmail` return: `v.skipped` → `'skip'`; `v.ok === false` → `'hard_fail'`; else `'pass'`.
  - `emailDomain(email) → string | null` — lowercased domain after `@`, or null.
  - `pickBestCandidate(candidates, titlePriority) → candidate | null` — from `[{email, title}]`, drop entries without a usable email (missing, or matching `/email_not_unlocked/i`), then prefer the earliest match in `titlePriority` (case-insensitive substring), else first remaining.
  - Export `STALE_MS = 90 * 24 * 60 * 60 * 1000` and `DEFAULT_TITLE_PRIORITY = ["owner","president","principal","project manager","estimator","superintendent","manager"]`.

- [ ] **Step 1: Write the failing test**

```js
// lib/__tests__/emailVerifyRefresh.test.js
import { describe, it, expect } from "vitest";
import {
  needsVerify, classifyVerifyResult, emailDomain, pickBestCandidate, STALE_MS,
} from "../emailVerifyRefresh.js";

const NOW = Date.parse("2026-07-02T00:00:00Z");

describe("needsVerify", () => {
  const base = { status: "clear", triggerType: "agc", email: "a@b.com", verifiedValue: null, verifiedAt: null, now: NOW };
  it("verifies an eligible, never-verified lead", () => {
    expect(needsVerify(base)).toBe(true);
  });
  it("skips non-clear leads", () => {
    expect(needsVerify({ ...base, status: "contacted_recent" })).toBe(false);
  });
  it("skips leads with no trigger", () => {
    expect(needsVerify({ ...base, triggerType: null })).toBe(false);
  });
  it("skips leads with no email", () => {
    expect(needsVerify({ ...base, email: null })).toBe(false);
  });
  it("skips when verified recently and email unchanged", () => {
    expect(needsVerify({ ...base, verifiedValue: "a@b.com", verifiedAt: NOW - 1000 })).toBe(false);
  });
  it("re-verifies when the email changed", () => {
    expect(needsVerify({ ...base, verifiedValue: "old@b.com", verifiedAt: NOW - 1000 })).toBe(true);
  });
  it("re-verifies when the cache is older than 90 days", () => {
    expect(needsVerify({ ...base, verifiedValue: "a@b.com", verifiedAt: NOW - STALE_MS - 1000 })).toBe(true);
  });
});

describe("classifyVerifyResult", () => {
  it("maps skipped → skip", () => expect(classifyVerifyResult({ ok: true, skipped: true })).toBe("skip"));
  it("maps ok:false → hard_fail", () => expect(classifyVerifyResult({ ok: false, status: "invalid" })).toBe("hard_fail"));
  it("maps ok pass → pass", () => expect(classifyVerifyResult({ ok: true, status: "valid" })).toBe("pass"));
  it("maps soft (catchall) → pass", () => expect(classifyVerifyResult({ ok: true, status: "catchall", soft: "catchall" })).toBe("pass"));
});

describe("emailDomain", () => {
  it("extracts + lowercases", () => expect(emailDomain("Bob@Acme.COM")).toBe("acme.com"));
  it("returns null on garbage", () => expect(emailDomain("nope")).toBe(null));
});

describe("pickBestCandidate", () => {
  const pri = ["owner", "estimator"];
  it("prefers the higher-priority title", () => {
    const c = pickBestCandidate([{ email: "e@x.com", title: "Estimator" }, { email: "o@x.com", title: "Owner" }], pri);
    expect(c.email).toBe("o@x.com");
  });
  it("drops locked/emailless candidates", () => {
    const c = pickBestCandidate([{ email: "email_not_unlocked@domain.com", title: "Owner" }, { email: "real@x.com", title: "Clerk" }], pri);
    expect(c.email).toBe("real@x.com");
  });
  it("returns null when nothing usable", () => {
    expect(pickBestCandidate([{ email: null, title: "Owner" }], pri)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/swppp-nb-wt && npx vitest run lib/__tests__/emailVerifyRefresh.test.js`
Expected: FAIL — "Failed to resolve import ../emailVerifyRefresh.js".

- [ ] **Step 3: Write minimal implementation**

```js
// lib/emailVerifyRefresh.js
// Contacts-refresh email verification: decides WHO to verify (lazy + cached), classifies the
// verifier result, and (Task 5) runs the dead-address recovery cascade. Kept separate from
// syncLeadState so the decision logic is pure + unit-testable.

export const STALE_MS = 90 * 24 * 60 * 60 * 1000; // re-verify addresses older than 90 days
export const DEFAULT_TITLE_PRIORITY = [
  "owner", "president", "principal", "project manager", "estimator", "superintendent", "manager",
];

// Verify only outreach-eligible leads, and only when we have no fresh result for THIS address.
export function needsVerify({ status, triggerType, email, verifiedValue, verifiedAt, now }) {
  if (status !== "clear" || !triggerType || !email) return false;
  if (verifiedValue !== email) return true;              // never verified, or the address changed
  if (!verifiedAt) return true;
  return now - verifiedAt > STALE_MS;                     // stale
}

// Map emailVerify.verifyEmail() output to a coarse action.
export function classifyVerifyResult(v) {
  if (!v || v.skipped) return "skip";                    // fail-open (no key / API error / bad input)
  if (v.ok === false) return "hard_fail";                // confident-bad (invalid/disposable)
  return "pass";                                         // valid, or soft catchall/unknown
}

export function emailDomain(email) {
  const m = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(String(email || "").trim());
  return m ? m[1].toLowerCase() : null;
}

// From [{email, title}], keep those with a usable (unlocked) email, then prefer the best title.
export function pickBestCandidate(candidates, titlePriority = DEFAULT_TITLE_PRIORITY) {
  const usable = (candidates || []).filter(
    (c) => c && c.email && !/email_not_unlocked/i.test(c.email) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email),
  );
  if (!usable.length) return null;
  const rank = (title) => {
    const t = String(title || "").toLowerCase();
    const i = titlePriority.findIndex((p) => t.includes(p));
    return i === -1 ? titlePriority.length : i;
  };
  return usable.slice().sort((a, b) => rank(a.title) - rank(b.title))[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/swppp-nb-wt && npx vitest run lib/__tests__/emailVerifyRefresh.test.js`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
cd /tmp/swppp-nb-wt
git add lib/emailVerifyRefresh.js lib/__tests__/emailVerifyRefresh.test.js
git commit -m "feat(sdr): pure decision helpers for refresh email verification"
```

---

### Task 2: Schema columns + cache read/write helpers

**Files:**
- Modify: `server.js` (the `sdr_lead_state` migration block, after the `pipedrive_org_id` ALTER ~line 916)
- Modify: `lib/emailVerifyRefresh.js` (add DB helpers)
- Test: `lib/__tests__/emailVerifyRefresh.test.js` (add cases with a fake pool)

**Interfaces:**
- Consumes: `needsVerify` (Task 1).
- Produces:
  - `readVerifyCache(pool, leadId) → { email_verify_status, email_verified_at, email_verified_value, resolved_email, email_flag } | null`
  - `writeVerifyCache(pool, leadId, { status, verifiedValue, resolvedEmail?, flag? }) → void` — sets `email_verify_status`, `email_verified_at=NOW()`, `email_verified_value`, and (when provided) `resolved_email` / `email_flag`; clears `email_flag` when `flag` is explicitly `null`.
- New columns on `sdr_lead_state`: `email_verify_status TEXT`, `email_verified_at TIMESTAMPTZ`, `email_verified_value TEXT`, `resolved_email TEXT`, `email_flag TEXT`; index `idx_sdr_lead_state_email_flag`.

- [ ] **Step 1: Add the migration (server.js)**

Immediately after the `pipedrive_org_id` ALTER and before the two `CREATE INDEX` lines (~server.js:916):

```js
    // Email verification state (NeverBounce, added 2026-07-02) — Postgres-only, per the
    // "track SDR state in Postgres" rule. Drives lazy+cached verify in the refresh.
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS email_verify_status TEXT`);
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS email_verified_value TEXT`);
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS resolved_email TEXT`);
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS email_flag TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_lead_state_email_flag ON sdr_lead_state(email_flag)`);
```

- [ ] **Step 2: Write the failing test (fake-pool helpers)**

Append to `lib/__tests__/emailVerifyRefresh.test.js`:

```js
import { readVerifyCache, writeVerifyCache } from "../emailVerifyRefresh.js";

function fakePool(rows = []) {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return { rows }; } };
}

describe("readVerifyCache", () => {
  it("returns the row", async () => {
    const pool = fakePool([{ email_verify_status: "valid", email_flag: null }]);
    const r = await readVerifyCache(pool, "123");
    expect(r.email_verify_status).toBe("valid");
    expect(pool.calls[0].params).toEqual(["123"]);
  });
  it("returns null when absent", async () => {
    expect(await readVerifyCache(fakePool([]), "x")).toBe(null);
  });
});

describe("writeVerifyCache", () => {
  it("writes status + value and clears flag when flag:null", async () => {
    const pool = fakePool();
    await writeVerifyCache(pool, "123", { status: "valid", verifiedValue: "a@b.com", flag: null });
    const { text, params } = pool.calls[0];
    expect(text).toMatch(/UPDATE sdr_lead_state/);
    expect(params).toContain("valid");
    expect(params).toContain("a@b.com");
    expect(params).toContain("123");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /tmp/swppp-nb-wt && npx vitest run lib/__tests__/emailVerifyRefresh.test.js`
Expected: FAIL — "readVerifyCache is not a function".

- [ ] **Step 4: Implement the helpers**

Append to `lib/emailVerifyRefresh.js`:

```js
export async function readVerifyCache(pool, leadId) {
  const { rows } = await pool.query(
    `SELECT email_verify_status, email_verified_at, email_verified_value, resolved_email, email_flag
       FROM sdr_lead_state WHERE pipedrive_lead_id = $1`,
    [String(leadId)],
  );
  return rows[0] || null;
}

// Upsert-style write of the verification result. flag === null explicitly clears email_flag;
// flag === undefined leaves it untouched. resolvedEmail === undefined leaves resolved_email untouched.
export async function writeVerifyCache(pool, leadId, { status, verifiedValue, resolvedEmail, flag }) {
  await pool.query(
    `UPDATE sdr_lead_state
        SET email_verify_status = $2,
            email_verified_at = NOW(),
            email_verified_value = $3,
            resolved_email = CASE WHEN $4::bool THEN $5 ELSE resolved_email END,
            email_flag = CASE WHEN $6::bool THEN $7 ELSE email_flag END
      WHERE pipedrive_lead_id = $1`,
    [
      String(leadId), status ?? null, verifiedValue ?? null,
      resolvedEmail !== undefined, resolvedEmail ?? null,
      flag !== undefined, flag ?? null,
    ],
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /tmp/swppp-nb-wt && npx vitest run lib/__tests__/emailVerifyRefresh.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /tmp/swppp-nb-wt
git add server.js lib/emailVerifyRefresh.js lib/__tests__/emailVerifyRefresh.test.js
git commit -m "feat(sdr): add email-verify columns + cache read/write helpers"
```

---

### Task 3: Pipedrive client — list org persons + set primary email

**Files:**
- Modify: `lib/pipedriveClient.js`
- Create: `scripts/_verify_pd_smoke.mjs` (smoke)

**Interfaces:**
- Produces:
  - `listOrgPersons(orgId) → Array<person>` — Pipedrive persons for an org (empty array on none/error-null).
  - `setPrimaryEmail(personId, newEmail, { keepOld }) → person` — makes `newEmail` the primary email; when `keepOld` is the old address string, retains it as a non-primary entry.

- [ ] **Step 1: Add the wrappers**

After `getOrganization` in `lib/pipedriveClient.js`:

```js
// All persons attached to an organization (for the dead-email recovery cascade).
export async function listOrgPersons(orgId) {
  if (orgId == null) return [];
  const { data } = await pdFetch(`/organizations/${orgId}/persons`, { query: { limit: 100 } });
  return Array.isArray(data) ? data : [];
}

// Promote newEmail to primary on a person. If keepOld is provided, retain it as a secondary
// (non-primary) entry so we don't lose the record of the dead address.
export async function setPrimaryEmail(personId, newEmail, { keepOld } = {}) {
  const email = [{ value: newEmail, primary: true, label: "work" }];
  if (keepOld && keepOld !== newEmail) email.push({ value: keepOld, primary: false, label: "old" });
  const { data } = await pdFetch(`/persons/${personId}`, { method: "PUT", body: { email } });
  return data;
}
```

- [ ] **Step 2: Write the smoke script**

```js
// scripts/_verify_pd_smoke.mjs — read-only-ish check of the new Pipedrive wrappers.
// Usage: PIPEDRIVE_API_TOKEN=... node scripts/_verify_pd_smoke.mjs <orgId>
import * as pd from "../lib/pipedriveClient.js";
const orgId = process.argv[2];
const persons = await pd.listOrgPersons(orgId);
console.log(`org ${orgId}: ${persons.length} persons`);
for (const p of persons.slice(0, 5)) {
  const primary = (p.email || []).find((e) => e.primary)?.value || (p.email?.[0]?.value ?? "—");
  console.log(`  #${p.id} ${p.name} <${primary}>`);
}
```

- [ ] **Step 3: Run the smoke script**

Run: `cd /tmp/swppp-nb-wt && PIPEDRIVE_API_TOKEN=$(cat /tmp/pd_token.txt 2>/dev/null) node scripts/_verify_pd_smoke.mjs <a-real-org-id>`
Expected: prints the org's person count + up to 5 `#id name <email>` lines. (Do NOT call `setPrimaryEmail` in the smoke — it mutates; it's exercised end-to-end in Task 5's cascade test with a fake client, and live in Task 6's guarded run.)

- [ ] **Step 4: Commit**

```bash
cd /tmp/swppp-nb-wt
git add lib/pipedriveClient.js scripts/_verify_pd_smoke.mjs
git commit -m "feat(sdr): Pipedrive listOrgPersons + setPrimaryEmail wrappers"
```

---

### Task 4: Apollo client — people search by domain

**Files:**
- Modify: `lib/apolloClient.js`
- Create: `scripts/_verify_apollo_smoke.mjs` (smoke)

**Interfaces:**
- Produces:
  - `searchPeopleByDomain(domain, { titles, perPage }) → Array<{ id, name, title, email }>` — POST `/mixed_people/search` with `q_organization_domains`; normalizes each person to `{id,name,title,email}` (email may be Apollo's `email_not_unlocked@domain.com` sentinel — the caller filters via `pickBestCandidate`). NO paid reveal in v1.

- [ ] **Step 1: Add the wrapper**

After `matchContactByEmail` in `lib/apolloClient.js`:

```js
/**
 * Find people at a company by email domain. Used by the dead-address recovery cascade.
 * v1 does NO paid reveal — Apollo may return a masked "email_not_unlocked@domain" sentinel;
 * the caller keeps only candidates whose email is actually usable.
 */
export async function searchPeopleByDomain(domain, { titles, perPage = 10 } = {}) {
  const body = { q_organization_domains: domain, page: 1, per_page: perPage };
  if (titles?.length) body.person_titles = titles;
  const data = await apolloFetch("/mixed_people/search", { method: "POST", body });
  const people = data?.people || data?.contacts || [];
  return people.map((p) => ({
    id: p.id,
    name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || null,
    title: p.title || null,
    email: p.email || null,
  }));
}
```

- [ ] **Step 2: Write the smoke script**

```js
// scripts/_verify_apollo_smoke.mjs — costs ~1 Apollo credit per run (a people search).
// Usage: APOLLO_API_KEY=... node scripts/_verify_apollo_smoke.mjs <domain>
import * as apollo from "../lib/apolloClient.js";
const domain = process.argv[2] || "apollo.io";
const people = await apollo.searchPeopleByDomain(domain, { perPage: 5 });
console.log(`${domain}: ${people.length} people`);
for (const p of people) console.log(`  ${p.name} | ${p.title} | ${p.email}`);
```

- [ ] **Step 3: Run the smoke script (spends ~1 Apollo credit)**

Run: `cd /tmp/swppp-nb-wt && APOLLO_API_KEY=$(grep -o 'APOLLO_API_KEY=[^ ]*' /tmp/sdr_env.txt 2>/dev/null | cut -d= -f2) node scripts/_verify_apollo_smoke.mjs apollo.io`
Expected: prints up to 5 people; note how many have a real email vs `email_not_unlocked@...` (confirms the masking reality this branch is designed around).

- [ ] **Step 4: Commit**

```bash
cd /tmp/swppp-nb-wt
git add lib/apolloClient.js scripts/_verify_apollo_smoke.mjs
git commit -m "feat(sdr): Apollo searchPeopleByDomain for dead-address recovery"
```

---

### Task 5: Recovery cascade + in-flight cancel (dependency-injected)

**Files:**
- Modify: `lib/emailVerifyRefresh.js`
- Test: `lib/__tests__/emailVerifyRefresh.test.js`

**Interfaces:**
- Consumes: `classifyVerifyResult`, `emailDomain`, `pickBestCandidate` (Task 1); `writeVerifyCache` (Task 2); wrappers from Tasks 3–4; existing `emailVerify.verifyEmail`, `pipedriveClient.addNote`, `apolloClient.removeContactsFromSequence`.
- Produces:
  - `resolveContact(lead, deps) → { outcome, email?, source? }` where `outcome ∈ 'ok' | 'recovered' | 'flagged'`. `deps = { verify, listOrgPersons, searchPeopleByDomain, setPrimaryEmail, addNote, canUseApollo }`. Pure control flow over injected async fns — no direct imports, so it is fully unit-testable.
  - `cancelInFlightOutreach(pool, lead, deps) → { cancelledDrafts, removedEnrollments }` — rejects open drafts + removes any active Apollo enrollment + clears `Sequence_Started`, mirroring `inboxReplyWatch.js:246-310`.

`resolveContact` control flow:
1. `v = await deps.verify(lead.email)`; `cls = classifyVerifyResult(v)`.
   - `'skip'` → `{outcome:'ok', email:lead.email}` (fail-open; caller leaves cache untouched).
   - `'pass'` → `{outcome:'ok', email:lead.email}`.
   - `'hard_fail'` → continue.
2. Org contacts: `persons = await deps.listOrgPersons(lead.orgId)`; flatten to `{email,title}` (primary email each), drop the dead `lead.email`; for each (best-title first via `pickBestCandidate`) verify; first pass → adopt (see below), `source:'pd_org'`.
3. Apollo (only if `deps.canUseApollo()` returns true — the per-cycle cap): `cands = await deps.searchPeopleByDomain(emailDomain(lead.email), {titles})`; `best = pickBestCandidate(cands)`; if best, verify; pass → adopt, `source:'apollo'`.
4. Nothing → `{outcome:'flagged'}`.

Adopt(newEmail, source): `await deps.setPrimaryEmail(lead.personId, newEmail, {keepOld:lead.email})`; `await deps.addNote({leadId:lead.leadId, content:'[Auto] Primary email '+lead.email+' failed verification; switched to '+newEmail+' (source: '+source+').'})`; return `{outcome:'recovered', email:newEmail, source}`.

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/emailVerifyRefresh.test.js`:

```js
import { resolveContact } from "../emailVerifyRefresh.js";

const lead = { leadId: "1", personId: "9", orgId: "5", email: "dead@acme.com" };
const pass = { ok: true, status: "valid" };
const fail = { ok: false, status: "invalid" };
function deps(over = {}) {
  return {
    verify: async () => pass,
    listOrgPersons: async () => [],
    searchPeopleByDomain: async () => [],
    setPrimaryEmail: async () => ({}),
    addNote: async () => ({}),
    canUseApollo: () => true,
    ...over,
  };
}

describe("resolveContact", () => {
  it("passes a good primary through untouched", async () => {
    const r = await resolveContact(lead, deps());
    expect(r).toEqual({ outcome: "ok", email: "dead@acme.com" });
  });
  it("recovers from a Pipedrive org contact (free branch, no Apollo call)", async () => {
    let apolloCalled = false;
    const r = await resolveContact(lead, deps({
      verify: async (e) => (e === "dead@acme.com" ? fail : pass),
      listOrgPersons: async () => [{ email: [{ value: "owner@acme.com", primary: true }], name: "O", title: "Owner" }],
      searchPeopleByDomain: async () => { apolloCalled = true; return []; },
    }));
    expect(r.outcome).toBe("recovered");
    expect(r.email).toBe("owner@acme.com");
    expect(r.source).toBe("pd_org");
    expect(apolloCalled).toBe(false);
  });
  it("falls back to Apollo when the org has nothing usable", async () => {
    const r = await resolveContact(lead, deps({
      verify: async (e) => (e === "found@acme.com" ? pass : fail),
      searchPeopleByDomain: async () => [{ email: "found@acme.com", title: "Estimator" }],
    }));
    expect(r.outcome).toBe("recovered");
    expect(r.source).toBe("apollo");
  });
  it("does NOT call Apollo when the cap is exhausted", async () => {
    let apolloCalled = false;
    const r = await resolveContact(lead, deps({
      verify: async () => fail,
      canUseApollo: () => false,
      searchPeopleByDomain: async () => { apolloCalled = true; return []; },
    }));
    expect(r.outcome).toBe("flagged");
    expect(apolloCalled).toBe(false);
  });
  it("flags when every avenue fails", async () => {
    const r = await resolveContact(lead, deps({
      verify: async () => fail,
      listOrgPersons: async () => [{ email: [{ value: "x@acme.com", primary: true }], title: "Clerk" }],
      searchPeopleByDomain: async () => [{ email: "y@acme.com", title: "Clerk" }],
    }));
    expect(r.outcome).toBe("flagged");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/swppp-nb-wt && npx vitest run lib/__tests__/emailVerifyRefresh.test.js`
Expected: FAIL — "resolveContact is not a function".

- [ ] **Step 3: Implement `resolveContact` + `cancelInFlightOutreach`**

Append to `lib/emailVerifyRefresh.js`:

```js
import * as pipedriveClient from "./pipedriveClient.js";
import * as apolloClient from "./apolloClient.js";

const primaryEmailOf = (p) => (p?.email || []).find((e) => e.primary)?.value || p?.email?.[0]?.value || null;

// Dependency-injected so the cascade is unit-testable without network. Returns the address to
// use + how we got it.
export async function resolveContact(lead, deps) {
  const v = await deps.verify(lead.email);
  const cls = classifyVerifyResult(v);
  if (cls !== "hard_fail") return { outcome: "ok", email: lead.email };

  const adopt = async (newEmail, source) => {
    await deps.setPrimaryEmail(lead.personId, newEmail, { keepOld: lead.email });
    await deps.addNote({
      leadId: lead.leadId,
      content: `[Auto] Primary email ${lead.email} failed verification; switched to ${newEmail} (source: ${source}).`,
    });
    return { outcome: "recovered", email: newEmail, source };
  };

  // 1. FREE: other persons on the same Pipedrive org.
  const orgPersons = await deps.listOrgPersons(lead.orgId);
  const orgCands = (orgPersons || [])
    .map((p) => ({ email: primaryEmailOf(p), title: p.title }))
    .filter((c) => c.email && c.email.toLowerCase() !== String(lead.email).toLowerCase());
  let best = pickBestCandidate(orgCands);
  // pickBestCandidate returns the single best; verify candidates best-first until one passes.
  for (const c of orgCands.sort((a, b) => (best && a.email === best.email ? -1 : 0))) {
    if (classifyVerifyResult(await deps.verify(c.email)) === "pass") return adopt(c.email, "pd_org");
  }

  // 2. PAID (capped): Apollo people-search by domain.
  if (deps.canUseApollo()) {
    const domain = emailDomain(lead.email);
    if (domain) {
      const cands = await deps.searchPeopleByDomain(domain, { titles: DEFAULT_TITLE_PRIORITY });
      const pick = pickBestCandidate(cands);
      if (pick && classifyVerifyResult(await deps.verify(pick.email)) === "pass") return adopt(pick.email, "apollo");
    }
  }

  return { outcome: "flagged" };
}

// Stop outreach to a confirmed-dead address: reject open drafts, pull any live Apollo enrollment,
// clear Sequence_Started. Mirrors inboxReplyWatch.js:246-310.
export async function cancelInFlightOutreach(pool, lead, deps = {}) {
  const removeFromSeq = deps.removeContactsFromSequence || apolloClient.removeContactsFromSequence;
  const updateLead = deps.updateLead || pipedriveClient.updateLead;
  const SEQ_FIELD = "48c4bb758e8642d6372c7fff9df3c0ea716170f1"; // PD Sequence_Started

  const { rowCount: cancelledDrafts } = await pool.query(
    `UPDATE sdr_drafts SET status = 'rejected',
        reject_reason = 'auto: email failed verification, no alternate found'
      WHERE pipedrive_lead_id = $1 AND status IN ('pending','approved','edited')`,
    [String(lead.leadId)],
  );

  const { rows: sends } = await pool.query(
    `SELECT id, apollo_sequence_id, apollo_contact_id FROM sdr_sends
      WHERE pipedrive_lead_id = $1 AND status = 'enrolled'`,
    [String(lead.leadId)],
  );
  let removedEnrollments = 0;
  for (const s of sends) {
    try {
      if (s.apollo_sequence_id && s.apollo_contact_id) {
        await removeFromSeq(s.apollo_sequence_id, [s.apollo_contact_id], "remove");
      }
      await pool.query(`UPDATE sdr_sends SET status = 'failed' WHERE id = $1`, [s.id]);
      removedEnrollments++;
    } catch (e) {
      console.error("cancelInFlightOutreach: Apollo remove failed", e.message);
    }
  }
  if (removedEnrollments && lead.leadId) {
    try { await updateLead(lead.leadId, { [SEQ_FIELD]: "" }); } catch (e) { console.error(e.message); }
  }
  return { cancelledDrafts, removedEnrollments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/swppp-nb-wt && npx vitest run lib/__tests__/emailVerifyRefresh.test.js`
Expected: PASS (all `resolveContact` cases green).

- [ ] **Step 5: Commit**

```bash
cd /tmp/swppp-nb-wt
git add lib/emailVerifyRefresh.js lib/__tests__/emailVerifyRefresh.test.js
git commit -m "feat(sdr): dead-address recovery cascade + in-flight outreach cancel"
```

---

### Task 6: Verification pass + sync integration + manual endpoint

**Files:**
- Modify: `lib/emailVerifyRefresh.js` (add `runVerificationPass`)
- Modify: `lib/pipedriveSync.js` (call the pass at the end of `syncLeadState`)
- Modify: `server.js` (add `POST /api/sdr/verify/run` admin endpoint)
- Create: `scripts/_verify_pass_smoke.mjs`

**Interfaces:**
- Consumes: `needsVerify`, `resolveContact`, `cancelInFlightOutreach`, `writeVerifyCache`; `emailVerify.verifyEmail`; `pipedriveClient.listOrgPersons/setPrimaryEmail/addNote`; `apolloClient.searchPeopleByDomain/removeContactsFromSequence`.
- Produces: `runVerificationPass(pool, { cap = 25, now = Date.now(), limit = 500 }) → { checked, verified, recovered, flagged, apolloUsed }`.

`runVerificationPass` behavior:
1. `SELECT pipedrive_lead_id, pipedrive_person_id, pipedrive_org_id, person_email, outreach_status, trigger_type, email_verify_status, email_verified_at, email_verified_value FROM sdr_lead_state WHERE outreach_status='clear' AND trigger_type IS NOT NULL AND person_email IS NOT NULL ORDER BY email_verified_at NULLS FIRST LIMIT $1` (limit bounds NeverBounce spend per pass).
2. For each row where `needsVerify({...})` is true (converting `email_verified_at` to ms), wrap in try/catch:
   - Build `lead = { leadId, personId, orgId, email }`.
   - `apolloUsed` counter; `canUseApollo = () => apolloUsed < cap` and increment inside the injected `searchPeopleByDomain` wrapper.
   - `r = await resolveContact(lead, deps)`.
   - `'ok'` → `writeVerifyCache(pool, leadId, {status:v-status,'valid'|soft, verifiedValue:email, flag:null})` (status from the pass verify — re-verify once here; acceptable, 1 credit). recovered++/verified++ counters.
   - `'recovered'` → `writeVerifyCache(pool, leadId, {status:'valid', verifiedValue:email, resolvedEmail:r.email, flag:null})`.
   - `'flagged'` → `writeVerifyCache(pool, leadId, {status:'invalid', verifiedValue:email, flag:'email_bad'})` then `cancelInFlightOutreach(pool, lead)`.
3. Return counters.

> Note: to avoid double-charging NeverBounce, `resolveContact`'s injected `verify` is a memoizing wrapper around `emailVerify.verifyEmail` (cache by address within the pass). Implement inline in `runVerificationPass`.

- [ ] **Step 1: Implement `runVerificationPass`**

Append to `lib/emailVerifyRefresh.js`:

```js
import * as emailVerify from "./emailVerify.js";

export async function runVerificationPass(pool, { cap = 25, now = Date.now(), limit = 500 } = {}) {
  const stats = { checked: 0, verified: 0, recovered: 0, flagged: 0, apolloUsed: 0 };
  if (!emailVerify.verifyEnabled()) return stats;

  const { rows } = await pool.query(
    `SELECT pipedrive_lead_id, pipedrive_person_id, pipedrive_org_id, person_email,
            outreach_status, trigger_type, email_verified_at, email_verified_value
       FROM sdr_lead_state
      WHERE outreach_status = 'clear' AND trigger_type IS NOT NULL AND person_email IS NOT NULL
      ORDER BY email_verified_at NULLS FIRST
      LIMIT $1`,
    [limit],
  );

  const memo = new Map();
  const verify = async (email) => {
    if (memo.has(email)) return memo.get(email);
    const v = await emailVerify.verifyEmail(email);
    memo.set(email, v);
    return v;
  };
  const searchWithCap = async (domain, opts) => {
    stats.apolloUsed++;
    return apolloClient.searchPeopleByDomain(domain, opts);
  };

  for (const row of rows) {
    const email = row.person_email;
    const verifiedAt = row.email_verified_at ? new Date(row.email_verified_at).getTime() : null;
    if (!needsVerify({
      status: row.outreach_status, triggerType: row.trigger_type, email,
      verifiedValue: row.email_verified_value, verifiedAt, now,
    })) continue;

    stats.checked++;
    const lead = { leadId: row.pipedrive_lead_id, personId: row.pipedrive_person_id, orgId: row.pipedrive_org_id, email };
    try {
      const r = await resolveContact(lead, {
        verify,
        listOrgPersons: pipedriveClient.listOrgPersons,
        searchPeopleByDomain: searchWithCap,
        setPrimaryEmail: pipedriveClient.setPrimaryEmail,
        addNote: pipedriveClient.addNote,
        canUseApollo: () => stats.apolloUsed < cap,
      });
      if (r.outcome === "ok") {
        const v = await verify(email);
        await writeVerifyCache(pool, lead.leadId, { status: v.status || "valid", verifiedValue: email, flag: null });
        stats.verified++;
      } else if (r.outcome === "recovered") {
        await writeVerifyCache(pool, lead.leadId, { status: "valid", verifiedValue: email, resolvedEmail: r.email, flag: null });
        stats.recovered++;
      } else {
        await writeVerifyCache(pool, lead.leadId, { status: "invalid", verifiedValue: email, flag: "email_bad" });
        await cancelInFlightOutreach(pool, lead);
        stats.flagged++;
      }
    } catch (e) {
      console.error(`runVerificationPass: lead ${lead.leadId} failed`, e.message);
    }
  }
  console.log(`[verify-pass] ${JSON.stringify(stats)}`);
  return stats;
}
```

- [ ] **Step 2: Wire into the 6h sync**

In `lib/pipedriveSync.js`, import at top: `import { runVerificationPass } from "./emailVerifyRefresh.js";`
At the very end of `syncLeadState`, after the byStatus summary is built and before `return`, inside the `try` (so a failure can't break the sync — it's already try/wrapped, but also guard):

```js
    // Contacts-refresh email verification (lazy + cached; eligible leads only). Best-effort.
    try {
      const cap = Number(process.env.APOLLO_LOOKUP_CAP || 25);
      await runVerificationPass(pool, { cap });
    } catch (e) {
      console.error("syncLeadState: verification pass failed", e.message);
    }
```

- [ ] **Step 3: Add the manual admin endpoint (server.js)**

Near the other `/api/sdr/sync/*` admin routes, add (reuse the existing admin-auth middleware used by `POST /api/sdr/sync/leads`):

```js
// Manually trigger a verification pass (careful rollout / testing). Admin only.
app.post("/api/sdr/verify/run", requireSdrAdmin, async (req, res) => {
  const cap = Number(req.body?.cap ?? process.env.APOLLO_LOOKUP_CAP ?? 25);
  const limit = Number(req.body?.limit ?? 50); // default small for a careful, credit-aware run
  res.status(202).json({ started: true, cap, limit });
  try {
    const { runVerificationPass } = await import("./lib/emailVerifyRefresh.js");
    await runVerificationPass(pool, { cap, limit });
  } catch (e) {
    console.error("/api/sdr/verify/run failed", e.message);
  }
});
```

> Use the SAME admin guard identifier the neighboring `/api/sdr/sync/leads` route uses (check its handler — it may be `requireSdrAdmin` or an inline role check). Match it exactly.

- [ ] **Step 4: Smoke — run a tiny pass against the real DB (spends a few credits)**

```js
// scripts/_verify_pass_smoke.mjs
// DATABASE_URL=... NEVERBOUNCE_API_KEY=... EMAIL_VERIFY_PROVIDER=neverbounce \
// PIPEDRIVE_API_TOKEN=... APOLLO_API_KEY=... node scripts/_verify_pass_smoke.mjs
import pg from "pg";
import { runVerificationPass } from "../lib/emailVerifyRefresh.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const stats = await runVerificationPass(pool, { cap: 3, limit: 5 }); // tiny: ≤5 leads, ≤3 Apollo lookups
console.log("RESULT", stats);
await pool.end();
```

Run: `cd /tmp/swppp-nb-wt && DATABASE_URL=$(cat /tmp/dburl.txt) node scripts/_verify_pass_smoke.mjs`
Expected: prints `[verify-pass] {...}` + `RESULT {checked,verified,recovered,flagged,apolloUsed}` with `checked ≤ 5`, `apolloUsed ≤ 3`. Verify in DB: `SELECT pipedrive_lead_id,email_verify_status,email_flag,resolved_email FROM sdr_lead_state WHERE email_verified_at IS NOT NULL LIMIT 5;`

- [ ] **Step 5: Full unit run + build**

Run: `cd /tmp/swppp-nb-wt && npx vitest run && npm run build`
Expected: all tests pass; build succeeds (catches TS6133/unused-import before deploy).

- [ ] **Step 6: Commit**

```bash
cd /tmp/swppp-nb-wt
git add lib/emailVerifyRefresh.js lib/pipedriveSync.js server.js scripts/_verify_pass_smoke.mjs
git commit -m "feat(sdr): verification pass wired into 6h refresh + manual endpoint"
```

---

### Task 7: Cache-aware send-time gate

**Files:**
- Modify: `server.js` (the verification block at ~3639-3665 in `approve-and-send`)

**Interfaces:**
- Consumes: `readVerifyCache`, `writeVerifyCache`, `STALE_MS` from `lib/emailVerifyRefresh.js`; existing `emailVerify`.
- Behavior: before calling the API, read the cache for this lead+address. Fresh `valid`/soft → proceed with NO API call. Fresh `invalid`/`disposable` → block (existing reject+note+422). Stale/missing → verify live (current path), then write the result to the cache. If `resolved_email` is set, target it.

- [ ] **Step 1: Add the import**

At the top of `server.js` with the other imports:

```js
import { readVerifyCache, writeVerifyCache, STALE_MS } from "./lib/emailVerifyRefresh.js";
```

- [ ] **Step 2: Replace the verification block**

Replace the block at server.js ~3639 (`if (emailVerify.verifyEnabled() && req.body?.skip_verify !== true) { ... }`) with a cache-aware version:

```js
    if (emailVerify.verifyEnabled() && req.body?.skip_verify !== true) {
      const adminForcing = req.body?.override === true && req.sdrUser?.role === "admin";
      const targetEmail = draft.contact_email_snapshot;

      // Prefer a fresh cached verdict for this exact address (set by the refresh pass) — no API spend.
      const cache = draft.pipedrive_lead_id ? await readVerifyCache(pool, draft.pipedrive_lead_id) : null;
      const cacheFresh =
        cache && cache.email_verified_value === targetEmail && cache.email_verified_at &&
        Date.now() - new Date(cache.email_verified_at).getTime() < STALE_MS;

      let blocked = null; // { status, sub_status, suggestion }
      if (cacheFresh) {
        if (["invalid", "disposable"].includes(cache.email_verify_status)) {
          blocked = { status: cache.email_verify_status, sub_status: null, suggestion: null };
        }
      } else {
        const v = await emailVerify.verifyEmail(targetEmail);
        if (v && !v.skipped && draft.pipedrive_lead_id) {
          await writeVerifyCache(pool, draft.pipedrive_lead_id, {
            status: v.status || (v.ok ? "valid" : "invalid"), verifiedValue: targetEmail,
          }).catch((e) => console.error("send-gate cache write failed:", e.message));
        }
        if (!v.ok) blocked = { status: v.status, sub_status: v.sub_status, suggestion: v.suggestion };
      }

      if (blocked && !adminForcing) {
        await pool.query(`UPDATE sdr_drafts SET status = 'rejected' WHERE id = $1`, [draft.id]);
        if (draft.pipedrive_lead_id && process.env.PIPEDRIVE_API_TOKEN) {
          try {
            await pipedriveClient.addNote({
              leadId: draft.pipedrive_lead_id,
              content:
                `[Auto] Skipped enroll — email failed verification (${blocked.status}${blocked.sub_status ? "/" + blocked.sub_status : ""}). ` +
                `Address: ${targetEmail}.` + (blocked.suggestion ? ` Did you mean ${blocked.suggestion}?` : ""),
            });
          } catch (e) { console.error("Pipedrive note on verify-fail failed:", e.message); }
        }
        return res.status(422).json({
          code: "email_unverified", status: blocked.status, sub_status: blocked.sub_status, suggestion: blocked.suggestion,
          message: `Email ${targetEmail} failed verification (${blocked.status}) — not enrolled.${blocked.suggestion ? ` Suggested: ${blocked.suggestion}` : ""}`,
        });
      }
    }
```

- [ ] **Step 3: Build + regression check**

Run: `cd /tmp/swppp-nb-wt && npm run build`
Expected: build succeeds (no unused-import / type errors).

- [ ] **Step 4: Manual gate check (no live send)**

Confirm the block compiles and the fresh-cache path avoids an API call: temporarily add a `console.log("verify: cacheFresh=", cacheFresh)` (remove before commit), or reason through it. The behavioral guarantee: a lead the refresh already marked `invalid` gets a 422 at approve-and-send with zero NeverBounce calls.

- [ ] **Step 5: Commit**

```bash
cd /tmp/swppp-nb-wt
git add server.js
git commit -m "feat(sdr): send-time gate reads the verification cache (no double-spend)"
```

---

### Task 8: Interface slice — "needs contact" flag + drawer status (deferrable)

**Files:**
- Modify: `server.js` (`GET /api/sdr/leads` + `/detail` to expose the new fields)
- Modify: `src/components/SdrInterface.tsx` (badge/filter + drawer display)
- Modify: `src/lib/sdrApi.ts` (types)

**Interfaces:**
- Consumes: the `sdr_lead_state` columns from Task 2.
- Produces: leads API returns `email_verify_status`, `email_flag`, `resolved_email`; a "Needs contact" filter chip keyed off `email_flag='email_bad'`; drawer shows verify status + resolved email.

> This slice is independently shippable and can be deferred — the backend (Tasks 1–7) fully functions without it (flags live in Postgres; the interface just doesn't surface them yet). Do it in a second session if you want backend proven first under the credit ceiling.

- [ ] **Step 1: Expose fields in the leads query**

In the `GET /api/sdr/leads` handler, add `email_verify_status, email_flag, resolved_email` to the `SELECT` from `sdr_lead_state`. Do the same for the `/detail` handler.

- [ ] **Step 2: Add types (src/lib/sdrApi.ts)**

Add to the lead row type:

```ts
  email_verify_status?: string | null;
  email_flag?: string | null;
  resolved_email?: string | null;
```

- [ ] **Step 3: Add the filter chip + drawer display (SdrInterface.tsx)**

Add a "Needs contact" filter that shows only rows where `email_flag === 'email_bad'`, and in the lead drawer render a line: `Email: {resolved_email || person_email} · {email_verify_status || 'unverified'}` with a red pill when `email_flag === 'email_bad'`. Follow the existing badge/filter patterns in the file (e.g. the outreach-status badges).

- [ ] **Step 4: Build**

Run: `cd /tmp/swppp-nb-wt && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /tmp/swppp-nb-wt
git add server.js src/components/SdrInterface.tsx src/lib/sdrApi.ts
git commit -m "feat(sdr): surface email-verify flag + resolved email in the interface"
```

---

## Deploy (after tasks complete + approved)

```bash
cd /tmp/swppp-nb-wt
npm run build            # MUST pass — Railway build fails on TS errors that tsc --noEmit misses
git push origin HEAD:main
```

Then set `APOLLO_LOOKUP_CAP` (optional; default 25) in Railway. Watch the first `[verify-pass] {...}` log line after the next sync, and NeverBounce credits (`GET /v4/account/info`). Start the manual endpoint with a small `limit` to stay under the 397-credit ceiling until a top-up.

## Self-review notes

- **Spec coverage:** provider swap (env, done pre-plan) ✓; verify-in-refresh + lazy/cached (Tasks 1,2,6) ✓; no double-verify (`needsVerify` + `email_verified_value`/90d) ✓; cache-reading send gate (Task 7) ✓; cascade PD-org→Apollo→flag (Task 5) ✓; write alternate to Pipedrive + `[Auto]` note (Task 5 adopt) ✓; cancel in-flight outreach (Task 5 `cancelInFlightOutreach`, called in Task 6) ✓; Apollo cap (Task 6 `canUseApollo`/`stats.apolloUsed`) ✓; soft-pass unchanged (`classifyVerifyResult`) ✓; interface flag (Task 8) ✓; retire MillionVerifier (automatic on provider swap) ✓.
- **Known v1 limitation (from spec):** Apollo branch adopts only unlocked emails (no paid reveal); memory says coverage is ~0% for these small operators, so the PD-org branch + flag carry the load. Documented, intentional.
- **Type consistency:** `resolveContact` outcomes `ok|recovered|flagged` used identically in Tasks 5 & 6; `writeVerifyCache` signature `{status,verifiedValue,resolvedEmail?,flag?}` consistent across Tasks 2, 6, 7.
```
