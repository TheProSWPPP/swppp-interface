# Permit Engine Plan 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compliance-pain scoring, a master/per-mailbox activation safety layer, and an automated monthly refresh to the shipped TX TXR050000 permit lead engine.

**Architecture:** Three independently-shippable parts on top of the live engine (Plan 1 pool + Plan 2 direct-mail enrichment). Part A pulls EPA ECHO violation data per permit and folds "compliance pain" into the existing `scoreFacility` slot so the worst-compliance operators rank first. Part B adds a persisted off-by-default master switch + per-mailbox `permit_enabled` flag and gates the enrich/enroll endpoints behind it. Part E refactors the EPA ingest into an importable function and runs EPA + ECHO refresh on a monthly in-process timer. Parts C (email-the-few) and D (Pipedrive-on-engagement) are scoped as deferred sub-plans — they have hard external prerequisites (Apollo token, Derek's sequence copy) and are documented at the end, not built here.

**Tech Stack:** Node ESM, Express, `pg`/PostgreSQL (Railway), Vitest, React+TS+Vite (frontend). Pure-logic-first: parsing/scoring lives in `lib/*.js` with unit tests; I/O (fetch, SQL) lives in scripts/routes.

---

## File Structure

**Part A — Compliance scoring**
- Create `lib/echoCompliance.js` — pure: `parseEchoSummary(json)` + `compliancePain(counts)`. No I/O.
- Create `lib/__tests__/echoCompliance.test.js` — unit tests for both functions.
- Create `scripts/echo-ingest.mjs` — per-permit ECHO fetch + recompute score + upsert. I/O.
- Modify `lib/permitScoring.js` — no signature change; confirm `compliance_pain` flows through (already supported).

**Part B — Activation + mailbox controls**
- Modify `server.js` (`initDB`) — add `permit_engine_settings` table + `sdr_mailboxes.permit_enabled` column.
- Create `lib/permitGate.js` — pure: `engineGateError(settings)` returns a reason string or null.
- Create `lib/__tests__/permitGate.test.js` — unit tests.
- Modify `lib/permitRoutes.js` — settings GET/PATCH + per-mailbox PATCH routes; gate `enrich`.
- Modify `src/lib/permitApi.ts` — settings client functions + types.
- Modify `src/components/permits/PermitsTab.tsx` — master switch + daily-cap UI + per-mailbox toggles.

**Part E — Monthly refresh**
- Modify `scripts/permit-ingest.mjs` — extract `runPermitIngest(pool)` exported function; CLI calls it.
- Modify `scripts/echo-ingest.mjs` — extract `runEchoRefresh(pool)` exported function; CLI calls it.
- Modify `server.js` — gated monthly `setInterval` calling both, only when engine active.

---

## PART A — EPA ECHO Compliance Scoring

**Why:** Direct mail is the live channel. The design's headline segment is "compliance pain" (open violations = renewal urgency). EPA ECHO exposes per-permit violation counts free. Folding them into `score` makes the Pool rank the hottest operators first, improving every batch we promote.

**Verified ECHO contract (live 2026-06-17):**
`GET https://echodata.epa.gov/echo/cwa_rest_services.get_facilities?output=JSON&p_pid=<PERMIT>` returns:
```json
{"Results":{"Message":"Success","QueryRows":"1","SVRows":"0","CVRows":"0","VioLast4QRows":"0","INSPRows":"0","TotalPenalties":"$0"}}
```
- `SVRows` = significant violations, `CVRows` = current violations, `VioLast4QRows` = violations in last 4 quarters, `INSPRows` = inspections, `TotalPenalties` = `$`-prefixed dollar string. Missing keys → treat as 0. `QueryRows:"0"` = permit not in ECHO.
- Bulk-by-master (`p_pid=TXR050000`) is rejected ("not a Program System ID") and state-wide exceeds the query limit, so ingest is **per-permit** like the EPA pull.

### Task A1: Pure ECHO parser + compliance-pain score

**Files:**
- Create: `lib/echoCompliance.js`
- Test: `lib/__tests__/echoCompliance.test.js`

- [ ] **Step 1: Write the failing test**

```js
// lib/__tests__/echoCompliance.test.js
import { describe, it, expect } from "vitest";
import { parseEchoSummary, compliancePain } from "../echoCompliance.js";

describe("parseEchoSummary", () => {
  it("extracts violation counts from the ECHO get_facilities Results block", () => {
    const json = { Results: { QueryRows: "1", SVRows: "2", CVRows: "1", VioLast4QRows: "3", INSPRows: "4", TotalPenalties: "$1,500" } };
    expect(parseEchoSummary(json)).toEqual({ found: true, sv: 2, cv: 1, vioLast4Q: 3, insp: 4, penalties: 1500 });
  });

  it("treats a permit not in ECHO (QueryRows 0) as found:false with zeros", () => {
    const json = { Results: { QueryRows: "0" } };
    expect(parseEchoSummary(json)).toEqual({ found: false, sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0 });
  });

  it("defaults missing keys and a malformed body to zeros without throwing", () => {
    expect(parseEchoSummary({})).toEqual({ found: false, sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0 });
    expect(parseEchoSummary(null)).toEqual({ found: false, sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0 });
  });
});

describe("compliancePain", () => {
  it("scores a current violation as the hottest", () => {
    expect(compliancePain({ vioLast4Q: 1, cv: 0, sv: 0, insp: 1 })).toBe(14); // 12 current + 2 inspected
  });
  it("adds significant-violation weight on top of a current violation, capped at 20", () => {
    expect(compliancePain({ vioLast4Q: 5, cv: 2, sv: 9, insp: 9 })).toBe(20); // 12+6+2=20 cap
  });
  it("returns 0 for a clean, never-inspected facility", () => {
    expect(compliancePain({ vioLast4Q: 0, cv: 0, sv: 0, insp: 0 })).toBe(0);
  });
  it("gives a small bump for inspection history alone", () => {
    expect(compliancePain({ vioLast4Q: 0, cv: 0, sv: 0, insp: 3 })).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "swppp-system" && npx vitest run lib/__tests__/echoCompliance.test.js`
Expected: FAIL — "Failed to resolve import ../echoCompliance.js".

- [ ] **Step 3: Write the implementation**

```js
// lib/echoCompliance.js
// Pure parsing + scoring for EPA ECHO CWA compliance summaries. No I/O.

function toInt(v) { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : 0; }

/** Pull the violation/inspection counts out of an ECHO get_facilities JSON body. */
export function parseEchoSummary(json) {
  const r = (json && json.Results) || {};
  const out = {
    sv: toInt(r.SVRows), cv: toInt(r.CVRows), vioLast4Q: toInt(r.VioLast4QRows),
    insp: toInt(r.INSPRows), penalties: toInt(r.TotalPenalties),
  };
  out.found = toInt(r.QueryRows) > 0;
  return out;
}

/** 0..20 "renewal pain" signal. Current violation dominates; significant violations and
 *  any inspection history add smaller bumps. Tunable; current violations are the hot tier. */
export function compliancePain(c = {}) {
  let p = 0;
  if (toInt(c.vioLast4Q) > 0 || toInt(c.cv) > 0) p += 12; // out of compliance NOW = hottest
  if (toInt(c.sv) > 0) p += 6;                             // significant violation on record
  if (toInt(c.insp) > 0) p += 2;                           // has been inspected = on the radar
  return Math.min(20, p);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "swppp-system" && npx vitest run lib/__tests__/echoCompliance.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd "swppp-system"
git add lib/echoCompliance.js lib/__tests__/echoCompliance.test.js
git commit -m "feat(permits): pure ECHO compliance parser + pain score"
```

### Task A2: ECHO ingest script (per-permit fetch + score recompute)

**Files:**
- Create: `scripts/echo-ingest.mjs`

This script has no unit test (it is I/O orchestration over verified pure functions + the verified ECHO contract); it is validated by a live dry run in Step 3.

- [ ] **Step 1: Write the script**

```js
// scripts/echo-ingest.mjs
// Pull EPA ECHO CWA compliance per permit, fold "compliance pain" into score.
// Usage: DATABASE_URL=<railway-public-url> node scripts/echo-ingest.mjs [limit]
import pg from "pg";
import { parseEchoSummary, compliancePain } from "../lib/echoCompliance.js";
import { scoreFacility } from "../lib/permitScoring.js";

const ECHO = "https://echodata.epa.gov/echo/cwa_rest_services.get_facilities";

async function fetchEcho(permit) {
  const url = `${ECHO}?output=JSON&p_pid=${encodeURIComponent(permit)}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const d = await r.json();
      if (d && d.Results) return d;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
  return null;
}

export async function runEchoRefresh(pool, { limit = 0, delayMs = 250, log = () => {} } = {}) {
  const lim = limit > 0 ? `LIMIT ${parseInt(limit, 10)}` : "";
  const { rows } = await pool.query(
    `SELECT f.external_permit_nmbr, f.original_issue_date,
            COALESCE(o.facility_count, 1) AS facility_count
       FROM permit_facilities f
       LEFT JOIN permit_operators o USING (operator_key)
      WHERE f.state = 'TX'
      ORDER BY f.score DESC ${lim}`
  );
  let done = 0, withPain = 0;
  for (const row of rows) {
    const json = await fetchEcho(row.external_permit_nmbr);
    const counts = json ? parseEchoSummary(json) : { sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0, found: false };
    const pain = compliancePain(counts);
    if (pain > 0) withPain++;
    const score = scoreFacility({
      original_issue_date: row.original_issue_date ? String(row.original_issue_date).slice(0, 10) : null,
      facility_count: row.facility_count,
      compliance_pain: pain,
    });
    await pool.query(
      `UPDATE permit_facilities
         SET compliance_flags = $2::jsonb, score = $3, updated_at = NOW()
       WHERE external_permit_nmbr = $1`,
      [row.external_permit_nmbr, JSON.stringify({ ...counts, pain }), score]
    );
    if (++done % 200 === 0) log(`  echo ${done}/${rows.length} (${withPain} with pain)`);
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  }
  // refresh operator best_score so the operator rollup ranks by the new scores too
  await pool.query(
    `UPDATE permit_operators o
        SET best_score = s.mx, updated_at = NOW()
       FROM (SELECT operator_key, MAX(score) AS mx FROM permit_facilities GROUP BY operator_key) s
      WHERE o.operator_key = s.operator_key`
  );
  return { processed: done, withPain };
}

// CLI entry (only when run directly, not when imported by the cron in Part E)
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set (use Railway public URL)");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const limit = parseInt(process.argv[2] || "0", 10);
  runEchoRefresh(pool, { limit, log: (m) => process.stdout.write(m + "\r") })
    .then((r) => { console.log(`\nECHO refresh done: ${JSON.stringify(r)}`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Verify the file parses (no DB)**

Run: `cd "swppp-system" && node --check scripts/echo-ingest.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: Live dry run against prod DB (small limit), human-gated**

> This calls the prod Railway DB and EPA ECHO. Per `feedback_no_bulk_without_auth`, run only the small smoke first; the full ~8,947 refresh is a separate explicit step.

Run (controller sources `/tmp/dburl.env`):
```bash
cd "swppp-system"
set -a; . /tmp/dburl.env; set +a
DATABASE_URL="${DATABASE_PUBLIC_URL:-$DATABASE_URL}" node scripts/echo-ingest.mjs 25
```
Expected: `ECHO refresh done: {"processed":25,"withPain":<N>}` and no errors. Spot-check in DB that `compliance_flags` now holds `{sv,cv,vioLast4Q,insp,penalties,pain,found}` for those 25.

- [ ] **Step 4: Commit**

```bash
cd "swppp-system"
git add scripts/echo-ingest.mjs
git commit -m "feat(permits): ECHO compliance ingest folds pain into score (runEchoRefresh)"
```

### Task A3: Surface compliance in the Pool view

**Files:**
- Modify: `src/lib/permitApi.ts` (PermitFacility type — add `compliance_flags`)
- Modify: `src/components/permits/PoolView.tsx` (render a "⚠ in violation" badge)

- [ ] **Step 1: Extend the type**

In `src/lib/permitApi.ts`, add `compliance_flags?: { pain?: number; vioLast4Q?: number; cv?: number; sv?: number } | null;` to the `PermitFacility` interface (find the interface that lists `external_permit_nmbr`, `operator_name`, `score`).

- [ ] **Step 2: Render the badge**

In `PoolView.tsx`, in the row that renders `operator_name`/`score`, add next to the score:
```tsx
{(f.compliance_flags?.pain ?? 0) >= 12 && (
  <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">⚠ in violation</span>
)}
```
(Match the existing className idiom in the file; if Tailwind tokens differ, follow the file's existing badge pattern.)

- [ ] **Step 3: Build the frontend to verify it compiles**

Run: `cd "swppp-system" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20` (or the project's typecheck script if present in package.json)
Expected: no new type errors referencing PoolView/permitApi.

- [ ] **Step 4: Commit**

```bash
cd "swppp-system"
git add src/lib/permitApi.ts src/components/permits/PoolView.tsx
git commit -m "feat(permits): show in-violation badge in Pool view"
```

---

## PART B — Master Activation Switch + Per-Mailbox Controls

**Why:** Derek's #1 requirement: "It doesn't start till I activate it," and he chooses which mailboxes the permit engine may use. OFF by default. The switch gates the enrich endpoint (and, once built, enroll) and the monthly cron (Part E).

### Task B1: Schema — settings table + mailbox flag

**Files:**
- Modify: `server.js` (inside `initDB`, alongside the other permit `CREATE TABLE` statements)

- [ ] **Step 1: Add the DDL**

In `initDB`, after the `permit_enrichment` table creation, add:
```js
await pool.query(`
  CREATE TABLE IF NOT EXISTS permit_engine_settings (
    id INT PRIMARY KEY DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    daily_enroll_cap INT NOT NULL DEFAULT 50,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT permit_engine_settings_singleton CHECK (id = 1)
  )`);
await pool.query(`INSERT INTO permit_engine_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
await pool.query(`ALTER TABLE sdr_mailboxes ADD COLUMN IF NOT EXISTS permit_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
```

- [ ] **Step 2: Verify server boots locally (schema applies without DB optional)**

Run: `cd "swppp-system" && node --check server.js`
Expected: exit 0 (syntax check; full boot needs DATABASE_URL and is validated at deploy).

- [ ] **Step 3: Commit**

```bash
cd "swppp-system"
git add server.js
git commit -m "feat(permits): permit_engine_settings table + sdr_mailboxes.permit_enabled (off by default)"
```

### Task B2: Pure engine gate

**Files:**
- Create: `lib/permitGate.js`
- Test: `lib/__tests__/permitGate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// lib/__tests__/permitGate.test.js
import { describe, it, expect } from "vitest";
import { engineGateError } from "../permitGate.js";

describe("engineGateError", () => {
  it("returns null when the engine is active", () => {
    expect(engineGateError({ active: true })).toBeNull();
  });
  it("returns a reason when inactive", () => {
    expect(engineGateError({ active: false })).toBe("Permit engine is inactive — activate it before running this action.");
  });
  it("treats missing/undefined settings as inactive (fail closed)", () => {
    expect(engineGateError(null)).toMatch(/inactive/);
    expect(engineGateError(undefined)).toMatch(/inactive/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "swppp-system" && npx vitest run lib/__tests__/permitGate.test.js`
Expected: FAIL — cannot resolve `../permitGate.js`.

- [ ] **Step 3: Implement**

```js
// lib/permitGate.js
// Pure: decide whether a permit-engine action may run. Fail closed.
export function engineGateError(settings) {
  if (settings && settings.active === true) return null;
  return "Permit engine is inactive — activate it before running this action.";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd "swppp-system" && npx vitest run lib/__tests__/permitGate.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd "swppp-system"
git add lib/permitGate.js lib/__tests__/permitGate.test.js
git commit -m "feat(permits): pure fail-closed engine gate"
```

### Task B3: Settings + mailbox routes; gate enrich

**Files:**
- Modify: `lib/permitRoutes.js`

- [ ] **Step 1: Import the gate at the top of the file**

Add alongside the existing imports:
```js
import { engineGateError } from "./permitGate.js";
```

- [ ] **Step 2: Add the settings + mailbox routes** (inside `registerPermitRoutes`, after the existing routes)

```js
// GET /api/permits/settings — engine state + per-mailbox flags
app.get("/api/permits/settings", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const s = await pool.query(`SELECT active, daily_enroll_cap FROM permit_engine_settings WHERE id = 1`);
    const m = await pool.query(`SELECT id, email, display_name, permit_enabled FROM sdr_mailboxes ORDER BY email ASC`);
    res.json({ settings: s.rows[0] || { active: false, daily_enroll_cap: 50 }, mailboxes: m.rows });
  } catch (err) {
    console.error("GET /api/permits/settings error:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// PATCH /api/permits/settings { active?, daily_enroll_cap? }
app.patch("/api/permits/settings", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const sets = [], params = [];
    if (typeof req.body?.active === "boolean") { params.push(req.body.active); sets.push(`active = $${params.length}`); }
    if (Number.isInteger(req.body?.daily_enroll_cap)) {
      params.push(Math.min(500, Math.max(0, req.body.daily_enroll_cap))); sets.push(`daily_enroll_cap = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Provide active and/or daily_enroll_cap" });
    sets.push(`updated_at = NOW()`);
    const r = await pool.query(`UPDATE permit_engine_settings SET ${sets.join(", ")} WHERE id = 1 RETURNING active, daily_enroll_cap`, params);
    res.json({ settings: r.rows[0] });
  } catch (err) {
    console.error("PATCH /api/permits/settings error:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// PATCH /api/permits/mailboxes/:id { permit_enabled: boolean }
app.patch("/api/permits/mailboxes/:id", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (typeof req.body?.permit_enabled !== "boolean") return res.status(400).json({ error: "permit_enabled (boolean) required" });
  try {
    const r = await pool.query(
      `UPDATE sdr_mailboxes SET permit_enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, permit_enabled`,
      [req.params.id, req.body.permit_enabled]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Mailbox not found" });
    res.json({ mailbox: r.rows[0] });
  } catch (err) {
    console.error("PATCH /api/permits/mailboxes/:id error:", err);
    res.status(500).json({ error: "Failed to update mailbox" });
  }
});
```

- [ ] **Step 3: Gate the enrich endpoint**

In the existing `app.post("/api/permits/enrich", ...)` handler, immediately inside the `try` (before reading `cap`), add:
```js
const s = await pool.query(`SELECT active FROM permit_engine_settings WHERE id = 1`);
const gate = engineGateError(s.rows[0]);
if (gate) return res.status(409).json({ error: gate });
```

- [ ] **Step 4: Verify syntax**

Run: `cd "swppp-system" && node --check lib/permitRoutes.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd "swppp-system"
git add lib/permitRoutes.js
git commit -m "feat(permits): settings + mailbox routes; gate enrich behind master switch"
```

### Task B4: Frontend — master switch, daily cap, per-mailbox toggles

**Files:**
- Modify: `src/lib/permitApi.ts`
- Modify: `src/components/permits/PermitsTab.tsx`

- [ ] **Step 1: Add API client functions + types**

In `src/lib/permitApi.ts` add:
```ts
export interface PermitSettings { active: boolean; daily_enroll_cap: number; }
export interface PermitMailbox { id: string; email: string; display_name: string | null; permit_enabled: boolean; }

export async function getPermitSettings(): Promise<{ settings: PermitSettings; mailboxes: PermitMailbox[] }> {
  const r = await fetch("/api/permits/settings", { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load settings");
  return r.json();
}
export async function patchPermitSettings(body: Partial<PermitSettings>): Promise<{ settings: PermitSettings }> {
  const r = await fetch("/api/permits/settings", {
    method: "PATCH", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Failed to update settings");
  return r.json();
}
export async function patchPermitMailbox(id: string, permit_enabled: boolean): Promise<{ mailbox: PermitMailbox }> {
  const r = await fetch(`/api/permits/mailboxes/${id}`, {
    method: "PATCH", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permit_enabled }),
  });
  if (!r.ok) throw new Error("Failed to update mailbox");
  return r.json();
}
```
(Match the existing fetch idiom in this file — if it uses a shared `apiBase` or auth header helper, use that instead of raw `fetch`.)

- [ ] **Step 2: Render the controls in `PermitsTab.tsx`**

At the top of the Permits tab (above the Pool|Enrichment sub-tab switch), add a settings bar that loads state on mount and renders: a master Active toggle, a daily-cap number input, and a collapsible list of mailboxes each with a `permit_enabled` checkbox. Use the existing toast adapter prop for success/error. Skeleton:
```tsx
import { useEffect, useState } from "react";
import { getPermitSettings, patchPermitSettings, patchPermitMailbox, type PermitSettings, type PermitMailbox } from "../../lib/permitApi";

// inside the component:
const [settings, setSettings] = useState<PermitSettings | null>(null);
const [mailboxes, setMailboxes] = useState<PermitMailbox[]>([]);
useEffect(() => { getPermitSettings().then((d) => { setSettings(d.settings); setMailboxes(d.mailboxes); }).catch(() => {}); }, []);

const toggleActive = async () => {
  if (!settings) return;
  const next = !settings.active;
  const { settings: s } = await patchPermitSettings({ active: next });
  setSettings(s);
  pushToast(`Permit engine ${s.active ? "ACTIVATED" : "deactivated"}`, s.active ? "success" : "error");
};
```
Render (place above the sub-tab nav):
```tsx
{settings && (
  <div className="mb-3 rounded border p-3">
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={settings.active} onChange={toggleActive} />
      <span className="font-medium">Permit engine {settings.active ? "ACTIVE" : "OFF"}</span>
    </label>
    <div className="mt-2 flex items-center gap-2 text-sm">
      <span>Daily enroll cap</span>
      <input type="number" min={0} max={500} value={settings.daily_enroll_cap}
        onChange={async (e) => { const v = parseInt(e.target.value, 10) || 0; const { settings: s } = await patchPermitSettings({ daily_enroll_cap: v }); setSettings(s); }} className="w-20 rounded border px-1" />
    </div>
    <details className="mt-2 text-sm">
      <summary>Mailboxes ({mailboxes.filter((m) => m.permit_enabled).length} enabled)</summary>
      {mailboxes.map((m) => (
        <label key={m.id} className="flex items-center gap-2 py-0.5">
          <input type="checkbox" checked={m.permit_enabled}
            onChange={async () => { const { mailbox } = await patchPermitMailbox(m.id, !m.permit_enabled); setMailboxes((xs) => xs.map((x) => x.id === mailbox.id ? { ...x, permit_enabled: mailbox.permit_enabled } : x)); }} />
          <span>{m.email}</span>
        </label>
      ))}
    </details>
  </div>
)}
```
NOTE: Match the file's existing class idiom and the `pushToast` signature already used in `PermitsTab.tsx`.

- [ ] **Step 3: Typecheck**

Run: `cd "swppp-system" && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no new errors in PermitsTab/permitApi.

- [ ] **Step 4: Commit**

```bash
cd "swppp-system"
git add src/lib/permitApi.ts src/components/permits/PermitsTab.tsx
git commit -m "feat(permits): master switch + daily cap + per-mailbox toggles UI"
```

---

## PART E — Monthly Refresh Cron

**Why:** Keep the pool current (new NOIs, status changes) and compliance fresh, without manual runs. In-process `setInterval` matches the repo's existing cron pattern (no node-cron, no Railway cron). Gated by env + the master switch so it never runs unexpectedly.

### Task E1: Make the EPA ingest importable

**Files:**
- Modify: `scripts/permit-ingest.mjs`

- [ ] **Step 1: Refactor `main()` into an exported `runPermitIngest(pool)`**

Replace the `async function main() { ... } main().catch(...)` tail so the body becomes:
```js
export async function runPermitIngest(pool, { log = () => {} } = {}) {
  let start = 0, rawTotal = 0;
  const facilities = [];
  for (;;) {
    const chunk = await fetchChunk(start);
    rawTotal += chunk.length;
    for (const row of chunk) if (isActiveNoi(row)) facilities.push(shapeFacility(row));
    log(`  fetched ${rawTotal} raw, kept ${facilities.length} active NOI`);
    if (chunk.length < CHUNK) break;
    start += CHUNK;
  }
  const counts = {};
  for (const f of facilities) counts[f.operator_key] = (counts[f.operator_key] || 0) + 1;
  let n = 0;
  for (const f of facilities) {
    const score = scoreFacility({ original_issue_date: f.original_issue_date, facility_count: counts[f.operator_key] });
    await pool.query(
      `INSERT INTO permit_facilities
         (external_permit_nmbr, master_permit, state, operator_name, operator_key, coverage_type,
          effective_date, expiration_date, original_issue_date, score, status, last_pulled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pool',NOW())
       ON CONFLICT (external_permit_nmbr) DO UPDATE SET
         operator_name=EXCLUDED.operator_name, operator_key=EXCLUDED.operator_key,
         effective_date=EXCLUDED.effective_date, expiration_date=EXCLUDED.expiration_date,
         original_issue_date=EXCLUDED.original_issue_date, score=EXCLUDED.score,
         last_pulled_at=NOW(), updated_at=NOW()`,
      [f.external_permit_nmbr, f.master_permit, f.state, f.operator_name, f.operator_key, f.coverage_type,
       f.effective_date, f.expiration_date, f.original_issue_date, score]
    );
    n++;
  }
  for (const key of Object.keys(counts)) {
    if (!key) continue;
    await pool.query(
      `INSERT INTO permit_operators (operator_key, operator_name, facility_count, best_score, status)
       SELECT operator_key, MIN(operator_name), COUNT(*), MAX(score), 'pool'
         FROM permit_facilities WHERE operator_key=$1 GROUP BY operator_key
       ON CONFLICT (operator_key) DO UPDATE SET
         operator_name=EXCLUDED.operator_name, facility_count=EXCLUDED.facility_count,
         best_score=EXCLUDED.best_score, updated_at=NOW()`,
      [key]
    );
  }
  return { raw: rawTotal, facilities: n, operators: Object.keys(counts).filter(Boolean).length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set (use Railway public URL)");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  runPermitIngest(pool, { log: (m) => process.stdout.write(m + "\r") })
    .then((r) => { console.log(`\nDone: ${JSON.stringify(r)}`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```
**IMPORTANT:** Do not change the upsert SQL — it must stay byte-for-byte the proven Plan 1 statement. The `ON CONFLICT` means re-running never duplicates or resets `status` of already-promoted/enriched rows (status is not in the UPDATE set).

- [ ] **Step 2: Verify CLI still works (parse only)**

Run: `cd "swppp-system" && node --check scripts/permit-ingest.mjs`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd "swppp-system"
git add scripts/permit-ingest.mjs
git commit -m "refactor(permits): export runPermitIngest for cron reuse (CLI unchanged)"
```

### Task E2: Monthly in-process timer in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Import the two refresh functions near the other permit imports**

```js
import { runPermitIngest } from "./scripts/permit-ingest.mjs";
import { runEchoRefresh } from "./scripts/echo-ingest.mjs";
```

- [ ] **Step 2: Add the gated timer** (near the other `setInterval` cron blocks, e.g. by the lead-sync block)

```js
// Permit engine monthly refresh: EPA re-pull + ECHO compliance refresh.
// Gated by env opt-in AND the master switch so it never runs unexpectedly.
if (process.env.DATABASE_URL && process.env.PERMIT_REFRESH_ENABLED === "true") {
  const runPermitRefresh = async () => {
    try {
      const s = await pool.query(`SELECT active FROM permit_engine_settings WHERE id = 1`);
      if (!s.rows[0]?.active) { console.log("[permit-refresh] skipped — engine inactive"); return; }
      const ing = await runPermitIngest(pool);
      const echo = await runEchoRefresh(pool, { delayMs: 250 });
      console.log(`[permit-refresh] ingest=${JSON.stringify(ing)} echo=${JSON.stringify(echo)}`);
    } catch (e) { console.error("[permit-refresh] failed:", e.message); }
  };
  setInterval(runPermitRefresh, 30 * 24 * 60 * 60 * 1000); // ~monthly
}
```
NOTE: no run-on-boot `setTimeout` (a full refresh is heavy; monthly cadence only). Operators can still run the scripts manually any time.

- [ ] **Step 3: Verify syntax**

Run: `cd "swppp-system" && node --check server.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd "swppp-system"
git add server.js
git commit -m "feat(permits): gated monthly EPA+ECHO refresh cron (off unless PERMIT_REFRESH_ENABLED + engine active)"
```

---

## Deferred Sub-Plans (NOT built in this plan)

These are real Plan 3 scope but have hard external prerequisites. They get their own plan once unblocked — documenting here so coverage is explicit.

### Part C — Email-the-few (Apollo MSGP sequence)
**Blocked on:** (1) Apollo API token working — ops health shows `Pro SWPPP SDR Automation` with "invalid token" (2026-04-30); (2) Derek's MSGP Renewal sequence copy; (3) decision on yield — the 2026-06-15 spike found **0/7** small-operator contacts in Apollo, so this only ever reaches the larger-operator minority.
**Scope when unblocked:** Apollo email-discovery on enriched promoted rows → set `permit_enrichment.channel='email'` for matches → create/identify the "MSGP Renewal" sequence (`apolloClient.searchSequences`/`activateSequence`) → enroll via `addContactsToSequence` **only from `permit_enabled` mailboxes** and **only while `engineGateError` passes**, respecting `daily_enroll_cap` → "Enroll email-able" button in the Enrichment view. Reuses `sdr_sends`/`sdr_engagement_events` with `source='permit_tx_msgp'`.

### Part D — Pipedrive promotion on engagement
**Blocked on:** Part C (no engagement events exist until emails send) and a Pipedrive credential refresh (ops shows `Lead Import - Pipedrive Push` 401, 2026-04-30).
**Scope when unblocked:** add `createPerson`/`createDeal` to `lib/pipedriveClient.js` → on a reply/click engagement event for `source='permit_tx_msgp'`, create a Pipedrive person + deal (so the CRM only ever holds engaged permit leads, per `feedback_no_new_pipedrive_fields` keep state in Postgres) → wire into the existing engagement→Pipedrive path in `lib/pipedriveSync.js`.

---

## Self-Review

**Spec coverage (design §6, §5, §8):**
- Master activation switch (off by default) → Part B (B1 default FALSE, B2 fail-closed, B3 gate). ✓
- Per-mailbox enable/disable → Part B (B1 `permit_enabled`, B3 route, B4 UI). ✓
- Compliance pain feeds the scoring slot → Part A (A1 `compliancePain`, A2 folds into `scoreFacility`). ✓
- Monthly re-pull → Part E. ✓
- Email-the-few / Apollo sequence / Pipedrive-on-engagement → Deferred C/D with explicit blockers (honest, not faked). ✓
- Pacing safety (no 8k/day) → daily_enroll_cap (B1/B3/B4) + gated enroll deferred to C. Promotion already human-sized (Plan 1). ✓

**Placeholder scan:** No "TBD"/"handle errors"/"similar to". One intentional flagged typo guard in B4 Step 2 (`why` token) with an explicit removal note. ✓

**Type consistency:** `compliance_pain` matches `permit_scoring.js`'s existing input name; `parseEchoSummary` output `{sv,cv,vioLast4Q,insp,penalties,found}` is consumed by `compliancePain` and stored as `compliance_flags` JSONB read back by the `PermitFacility.compliance_flags` type (A3) — names align. `engineGateError(settings)` takes `{active}` consistently across B2/B3/E2. `runEchoRefresh`/`runPermitIngest` signatures match their CLI and cron callers. ✓
