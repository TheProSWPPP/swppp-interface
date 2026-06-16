# Permit Engine — Data Foundation (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a populated, deduped, scored, filterable pool of active Texas TXR050000 NOI permittees — ingested free from EPA Envirofacts and visible in a new "Permits" tab in the Cold lane — as the foundation the enrichment + sending layer (Plan 2) builds on.

**Architecture:** A runnable Node ingest script (like the existing `scripts/seed-sdr.mjs`) pulls the active NOI population from EPA Envirofacts using pure, unit-tested parse/dedupe/score modules, and upserts into two new Postgres tables (`permit_facilities`, `permit_operators`). A thin read/promote API (`lib/permitRoutes.js`, mounted like `lib/nurtureRoutes.js`) backs a new React `PoolView` tab. No enrichment, no Apollo, no sending in this plan.

**Tech Stack:** Node ESM + Express + `pg` (backend), React + TypeScript + Tailwind + lucide-react (frontend), Vitest (new — for the pure-logic modules only), EPA Envirofacts REST API (no auth).

**Spec:** `docs/superpowers/specs/2026-06-15-permit-expiry-lead-engine-design.md` (Plan 1 covers spec §2 EPA ingest, §4 `permit_facilities`/`permit_operators`, §5 scoring v1, §6 Pool sub-view. Plan 2 will cover §2b TCEQ, §3 enrichment chain, §6 Enrichment sub-view, §7 sequencing, activation/mailbox controls, multi-channel output.)

**Testing note (codebase-consistent):** This repo has no test runner today; verification has been script/curl/DB-based. This plan adds Vitest **only for pure logic** (EPA parse, dedupe key, scoring) where TDD is cheap and high-value. Route/UI tasks are verified via real EPA calls, `curl`, the Railway DB, and `npm run build` — matching the existing pattern. Per `feedback_use_railway_db_not_local`, DB verification uses the Railway Postgres public URL, never a local Postgres.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/permitIngest.js` (create) | Pure functions: parse EPA rows, filter to active NOI (`EFF` + `TXR05` prefix, exclude `TXRNE`), normalize operator name → dedupe key, shape a facility record. No I/O. |
| `lib/permitScoring.js` (create) | Pure function: `scoreFacility(f)` composite rank (v1: recency + multi-facility size + active). Forward-compatible slots for sector/compliance (Plan 2). No I/O. |
| `lib/permitRoutes.js` (create) | Express routes: `GET /api/permits/pool`, `GET /api/permits/operators`, `POST /api/permits/promote`. `registerPermitRoutes(app, pool)`. |
| `lib/__tests__/permitIngest.test.js` (create) | Vitest unit tests for `permitIngest.js`. |
| `lib/__tests__/permitScoring.test.js` (create) | Vitest unit tests for `permitScoring.js`. |
| `scripts/permit-ingest.mjs` (create) | Runnable: fetch EPA (paginated + retry), filter via `permitIngest.js`, upsert facilities, roll up operators, write scores. Run against Railway DB. |
| `server.js` (modify) | Add `permit_facilities` + `permit_operators` to `initDB()`; import + call `registerPermitRoutes`. |
| `migrations/2026-06-15-permit-engine.sql` (create) | SQL record of the new schema (matches existing `migrations/` convention). |
| `src/lib/permitApi.ts` (create) | Frontend fetch client for the permit endpoints. |
| `src/components/permits/PoolView.tsx` (create) | Pool table: filters (city, multi-facility, recency), sort by score, row select, "Promote batch". |
| `src/components/SdrInterface.tsx` (modify) | Add "Permits" tab button + render `PoolView` in the Cold lane. |
| `vitest.config.ts` (create) | Minimal Vitest config (node env). |
| `package.json` (modify) | Add `vitest` devDep + `"test": "vitest run"` script. |

---

## Task 1: Vitest setup (pure-logic tests only)

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install Vitest**

Run:
```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system" && npm install -D vitest
```
Expected: `vitest` added to devDependencies, no errors.

- [ ] **Step 2: Add the test script**

In `package.json`, add to the `"scripts"` object (after `"lint"`):
```json
    "test": "vitest run",
```

- [ ] **Step 3: Create the Vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.js"],
  },
});
```

- [ ] **Step 4: Verify the runner works (no tests yet = passes trivially)**

Run: `npm run test`
Expected: Vitest runs and reports "No test files found" or exits 0. (It will find tests once Task 2 adds them.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest for pure-logic unit tests"
```

---

## Task 2: EPA ingest pure logic (`lib/permitIngest.js`)

**What EPA returns:** records from `ICIS_PERMIT` filtered by `MASTER_EXTERNAL_PERMIT_NMBR=TXR050000`. Each record has at least: `external_permit_nmbr`, `permit_name` (operator), `permit_status_code` (`EFF`=active), `permit_type_code` (`GPC`), `effective_date`, `expiration_date`, `original_issue_date`. NOI vs NEC is the **prefix of `external_permit_nmbr`**: `TXR05…` = NOI (keep), `TXRNE…` = NEC (drop).

**Files:**
- Create: `lib/permitIngest.js`
- Test: `lib/__tests__/permitIngest.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/permitIngest.test.js`:
```js
import { describe, it, expect } from "vitest";
import { isActiveNoi, operatorKey, shapeFacility } from "../permitIngest.js";

describe("isActiveNoi", () => {
  it("keeps active TXR05 NOI records", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXR05DP22", permit_status_code: "EFF" })).toBe(true);
  });
  it("drops NEC (TXRNE prefix) even if active", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXRNEU482", permit_status_code: "EFF" })).toBe(false);
  });
  it("drops expired/terminated records", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXR05BB10", permit_status_code: "EXP" })).toBe(false);
    expect(isActiveNoi({ external_permit_nmbr: "TXR05BB10", permit_status_code: "TRM" })).toBe(false);
  });
  it("is case-insensitive on status and tolerant of missing fields", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXR05BB10", permit_status_code: "eff" })).toBe(true);
    expect(isActiveNoi({})).toBe(false);
  });
});

describe("operatorKey", () => {
  it("normalizes case, punctuation, and legal suffixes so dupes collapse", () => {
    expect(operatorKey("Uvalde Concrete, LLC")).toBe(operatorKey("UVALDE CONCRETE LLC"));
    expect(operatorKey("K.A.T. Excavation & Construction Inc.")).toBe(
      operatorKey("KAT EXCAVATION & CONSTRUCTION INC")
    );
  });
  it("returns empty string for missing names", () => {
    expect(operatorKey(null)).toBe("");
    expect(operatorKey("")).toBe("");
  });
});

describe("shapeFacility", () => {
  it("maps an EPA row to our facility record shape", () => {
    const f = shapeFacility({
      external_permit_nmbr: "TXR05DP22",
      permit_name: "Stephenville Iron And Metal, LLC",
      permit_status_code: "EFF",
      effective_date: "2021-12-01 00:00:00",
      expiration_date: "2026-08-13 00:00:00",
      original_issue_date: "2017-03-31 00:00:00",
    });
    expect(f).toMatchObject({
      external_permit_nmbr: "TXR05DP22",
      master_permit: "TXR050000",
      state: "TX",
      operator_name: "Stephenville Iron And Metal, LLC",
      coverage_type: "NOI",
      status: "pool",
    });
    expect(f.operator_key).toBe(operatorKey("Stephenville Iron And Metal, LLC"));
    expect(f.expiration_date).toBe("2026-08-13");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test`
Expected: FAIL — `permitIngest.js` does not export `isActiveNoi`/`operatorKey`/`shapeFacility`.

- [ ] **Step 3: Implement `lib/permitIngest.js`**

Create `lib/permitIngest.js`:
```js
// Pure logic for EPA Envirofacts TXR050000 ingest. No I/O.

const LEGAL_SUFFIXES = /\b(l\.?l\.?c|l\.?p|inc|incorporated|co|corp|corporation|ltd|company|limited|lllp|llp|pllc)\b/g;

/** Active Multi-Sector NOI? TXR05 prefix = NOI, TXRNE = NEC (excluded). EFF = active. */
export function isActiveNoi(row) {
  const epn = (row?.external_permit_nmbr || "").toUpperCase();
  const status = (row?.permit_status_code || "").toUpperCase();
  if (!epn.startsWith("TXR05")) return false; // excludes TXRNE (NEC) and anything else
  return status === "EFF";
}

/** Normalize an operator name to a dedupe key: lowercase, strip punctuation + legal suffixes. */
export function operatorKey(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,/#!$%^*;:{}=\-_`~()'"]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim an EPA timestamp ("2026-08-13 00:00:00") to a date string, or null. */
function toDate(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

/** Map a raw EPA row to our permit_facilities record shape. */
export function shapeFacility(row) {
  const operator = row?.permit_name || null;
  return {
    external_permit_nmbr: row?.external_permit_nmbr || null,
    master_permit: "TXR050000",
    state: "TX",
    operator_name: operator,
    operator_key: operatorKey(operator),
    coverage_type: "NOI",
    effective_date: toDate(row?.effective_date),
    expiration_date: toDate(row?.expiration_date),
    original_issue_date: toDate(row?.original_issue_date),
    status: "pool",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test`
Expected: PASS — all `permitIngest` tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/permitIngest.js lib/__tests__/permitIngest.test.js
git commit -m "feat(permits): EPA ingest pure logic (NOI filter, dedupe key, shape)"
```

---

## Task 3: Scoring pure logic (`lib/permitScoring.js`)

**Scoring v1:** EPA alone gives dates + multi-facility count. Score = recency of original issue (newer filers may lack a consultant) + multi-facility size (bigger account). Sector and compliance weights are accepted but default to 0 until Plan 2 enrichment fills them — so the function is forward-compatible and the call site never changes.

**Files:**
- Create: `lib/permitScoring.js`
- Test: `lib/__tests__/permitScoring.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/permitScoring.test.js`:
```js
import { describe, it, expect } from "vitest";
import { scoreFacility } from "../permitScoring.js";

describe("scoreFacility", () => {
  it("scores a recent multi-facility operator higher than an old single-site one", () => {
    const recent = scoreFacility({ original_issue_date: "2024-01-01", facility_count: 5 }, { now: "2026-06-15" });
    const old = scoreFacility({ original_issue_date: "2010-01-01", facility_count: 1 }, { now: "2026-06-15" });
    expect(recent).toBeGreaterThan(old);
  });
  it("returns a finite number even with missing fields", () => {
    const s = scoreFacility({}, { now: "2026-06-15" });
    expect(Number.isFinite(s)).toBe(true);
  });
  it("applies sector and compliance boosts when present (Plan 2 forward-compat)", () => {
    const base = scoreFacility({ original_issue_date: "2015-01-01", facility_count: 1 }, { now: "2026-06-15" });
    const boosted = scoreFacility(
      { original_issue_date: "2015-01-01", facility_count: 1, sector_weight: 10, compliance_pain: 20 },
      { now: "2026-06-15" }
    );
    expect(boosted).toBeGreaterThan(base);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test`
Expected: FAIL — `permitScoring.js` does not export `scoreFacility`.

- [ ] **Step 3: Implement `lib/permitScoring.js`**

Create `lib/permitScoring.js`:
```js
// Pure scoring for the permit pool. No I/O. `now` is injected for deterministic tests.

/** Years between an ISO date string and `now` (default huge if missing → oldest). */
function yearsAgo(dateStr, now) {
  if (!dateStr) return 99;
  const then = new Date(dateStr + "T00:00:00Z").getTime();
  const ref = new Date(now + "T00:00:00Z").getTime();
  if (Number.isNaN(then) || Number.isNaN(ref)) return 99;
  return (ref - then) / (365.25 * 24 * 3600 * 1000);
}

/**
 * Composite rank. Higher = warmer/bigger.
 * v1 inputs (EPA): original_issue_date, facility_count.
 * Plan-2 inputs (enrichment, default 0): sector_weight, compliance_pain.
 */
export function scoreFacility(f, opts = {}) {
  const now = opts.now || "2026-06-15";
  const recency = Math.max(0, 10 - yearsAgo(f.original_issue_date, now)); // 0..10, newer = higher
  const size = Math.min(15, (Number(f.facility_count) || 1) * 3);          // multi-site account, capped
  const sector = Number(f.sector_weight) || 0;                            // Plan 2
  const compliance = Number(f.compliance_pain) || 0;                      // Plan 2 (highest weight)
  return Math.round((recency + size + sector + compliance) * 100) / 100;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test`
Expected: PASS — all `permitScoring` tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/permitScoring.js lib/__tests__/permitScoring.test.js
git commit -m "feat(permits): scoring v1 (recency + multi-facility, enrichment-ready)"
```

---

## Task 4: Database schema (`permit_facilities`, `permit_operators`)

Follows the exact `initDB()` `CREATE TABLE IF NOT EXISTS` + index idiom used for `sdr_*` tables in `server.js`.

**Files:**
- Modify: `server.js` (inside `async function initDB()`, after the last `sdr_*`/`nurture_audit` table block)
- Create: `migrations/2026-06-15-permit-engine.sql`

- [ ] **Step 1: Add the tables to `initDB()`**

In `server.js`, locate the end of the `initDB()` table-creation block (after the `nurture_audit` table, before `initDB()` closes). Insert:
```js
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_facilities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_permit_nmbr TEXT UNIQUE NOT NULL,
        master_permit TEXT NOT NULL DEFAULT 'TXR050000',
        state TEXT NOT NULL DEFAULT 'TX',
        operator_name TEXT,
        operator_key TEXT NOT NULL DEFAULT '',
        coverage_type TEXT NOT NULL DEFAULT 'NOI' CHECK (coverage_type IN ('NOI','NEC')),
        site_address TEXT,
        city TEXT,
        zip TEXT,
        sector_code TEXT,
        ownership_type TEXT,
        compliance_flags JSONB NOT NULL DEFAULT '{}',
        effective_date DATE,
        expiration_date DATE,
        original_issue_date DATE,
        score NUMERIC(8,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pool'
          CHECK (status IN ('pool','promoted','scraped','enriched','enrolled','exported','engaged','dead')),
        last_pulled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_master ON permit_facilities(master_permit)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_status ON permit_facilities(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_opkey ON permit_facilities(operator_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_score ON permit_facilities(score DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_operators (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        operator_key TEXT UNIQUE NOT NULL,
        operator_name TEXT,
        customer_number TEXT,
        state TEXT NOT NULL DEFAULT 'TX',
        facility_count INT NOT NULL DEFAULT 0,
        best_score NUMERIC(8,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pool',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_operators_score ON permit_operators(best_score DESC)`);
```

- [ ] **Step 2: Create the migration record**

Create `migrations/2026-06-15-permit-engine.sql` with the same two `CREATE TABLE` + index statements as above (verbatim, minus the JS `pool.query` wrapper) so the schema is recorded alongside the existing migration files.

- [ ] **Step 3: Apply schema to the Railway DB by booting the server once**

`initDB()` runs on server start. Apply with the Railway public DB URL (from `tokens.txt`; never local Postgres):
```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system" && DATABASE_URL="<RAILWAY_DATABASE_PUBLIC_URL>" node -e "import('./server.js')" 2>&1 | head -20
# Once you see the server listening / initDB complete, Ctrl-C.
```
Expected: no SQL errors during init.

- [ ] **Step 4: Verify the tables exist**

```bash
psql "<RAILWAY_DATABASE_PUBLIC_URL>" -c "\d permit_facilities" -c "\d permit_operators"
```
Expected: both tables print their columns; `permit_facilities.external_permit_nmbr` is UNIQUE NOT NULL.

- [ ] **Step 5: Commit**

```bash
git add server.js migrations/2026-06-15-permit-engine.sql
git commit -m "feat(permits): permit_facilities + permit_operators schema"
```

---

## Task 5: EPA ingest script (`scripts/permit-ingest.mjs`)

Pulls the full TXR050000 record set from EPA (single-filter, paginated, with retry because the two-filter query is flaky — see spec §2/§11), filters to active NOI in-process via `permitIngest.js`, upserts facilities, rolls up operators, writes scores. Runnable like `scripts/seed-sdr.mjs`.

**Files:**
- Create: `scripts/permit-ingest.mjs`

- [ ] **Step 1: Implement the script**

Create `scripts/permit-ingest.mjs`:
```js
// Ingest active TXR050000 NOI permittees from EPA Envirofacts into Postgres.
// Usage: DATABASE_URL=<railway-public-url> node scripts/permit-ingest.mjs
import pg from "pg";
import { isActiveNoi, shapeFacility, operatorKey } from "../lib/permitIngest.js";
import { scoreFacility } from "../lib/permitScoring.js";

const BASE = "https://data.epa.gov/efservice/ICIS_PERMIT/MASTER_EXTERNAL_PERMIT_NMBR/TXR050000";
const CHUNK = 1000;

async function fetchChunk(start) {
  const url = `${BASE}/rows/${start}:${start + CHUNK - 1}/JSON`;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
      const d = await r.json();
      if (Array.isArray(d)) return d;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`EPA fetch failed after retries at start=${start}`);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set (use Railway public URL)");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  let start = 0, rawTotal = 0;
  const facilities = [];
  for (;;) {
    const chunk = await fetchChunk(start);
    rawTotal += chunk.length;
    for (const row of chunk) if (isActiveNoi(row)) facilities.push(shapeFacility(row));
    process.stdout.write(`  fetched ${rawTotal} raw, kept ${facilities.length} active NOI\r`);
    if (chunk.length < CHUNK) break;
    start += CHUNK;
  }
  console.log(`\nEPA: ${rawTotal} raw records, ${facilities.length} active NOI to upsert.`);

  // operator facility counts (for score + rollup)
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
    if (++n % 500 === 0) process.stdout.write(`  upserted ${n}/${facilities.length}\r`);
  }
  console.log(`\nUpserted ${n} facilities.`);

  // roll up operators
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
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS facilities, COUNT(DISTINCT operator_key) AS operators FROM permit_facilities`
  );
  console.log(`Done. facilities=${rows[0].facilities}, operators=${rows[0].operators}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the ingest against the Railway DB**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system" && DATABASE_URL="<RAILWAY_DATABASE_PUBLIC_URL>" node scripts/permit-ingest.mjs
```
Expected: prints raw count (~29k), kept active NOI (a few thousand), upserts, and a final `facilities=<N>, operators=<M>` line with M < N (dedupe working).

- [ ] **Step 3: Verify in the DB**

```bash
psql "<RAILWAY_DATABASE_PUBLIC_URL>" -c "SELECT coverage_type, COUNT(*) FROM permit_facilities GROUP BY 1;" \
  -c "SELECT operator_name, facility_count FROM permit_operators ORDER BY facility_count DESC LIMIT 5;"
```
Expected: only `NOI` rows (no `NEC`); top operators show `facility_count > 1` (e.g. Uvalde Concrete, KAT Excavation), confirming dedupe.

- [ ] **Step 4: Commit**

```bash
git add scripts/permit-ingest.mjs
git commit -m "feat(permits): EPA ingest script (paginated, retry, dedupe rollup, scoring)"
```

---

## Task 6: Read + promote API (`lib/permitRoutes.js`)

Mounted via `registerPermitRoutes(app, pool)` exactly like `registerNurtureRoutes` is in `server.js`. Routes sit behind the app's existing basic-auth wall; they reuse the shared `pool`.

**Files:**
- Create: `lib/permitRoutes.js`
- Modify: `server.js` (import + call, next to `registerNurtureRoutes`)

- [ ] **Step 1: Implement the routes**

Create `lib/permitRoutes.js`:
```js
// Permit Engine read + promote API. registerPermitRoutes(app, pool).
export function registerPermitRoutes(app, pool) {
  // GET /api/permits/pool?status=&city=&multi=1&search=&page=1&pageSize=50&sort=score
  app.get("/api/permits/pool", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
      const params = [];
      const where = [];
      const status = req.query.status;
      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      if (req.query.city) { params.push(req.query.city); where.push(`city ILIKE '%' || $${params.length} || '%'`); }
      if (req.query.search) { params.push(req.query.search); where.push(`operator_name ILIKE '%' || $${params.length} || '%'`); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const totalQ = await pool.query(`SELECT COUNT(*) AS n FROM permit_facilities ${clause}`, params);
      params.push(pageSize); params.push((page - 1) * pageSize);
      const rowsQ = await pool.query(
        `SELECT * FROM permit_facilities ${clause}
         ORDER BY score DESC, operator_name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.json({ rows: rowsQ.rows, total: Number(totalQ.rows[0].n), page, pageSize });
    } catch (err) {
      console.error("GET /api/permits/pool error:", err);
      res.status(500).json({ error: "Failed to list pool" });
    }
  });

  // GET /api/permits/operators?limit=50 — deduped rollup, ranked
  app.get("/api/permits/operators", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
      const { rows } = await pool.query(
        `SELECT * FROM permit_operators ORDER BY best_score DESC LIMIT $1`, [limit]
      );
      res.json({ operators: rows });
    } catch (err) {
      console.error("GET /api/permits/operators error:", err);
      res.status(500).json({ error: "Failed to list operators" });
    }
  });

  // POST /api/permits/promote { ids: [external_permit_nmbr,...] }  OR  { topN: 100 }
  app.post("/api/permits/promote", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const { ids, topN } = req.body || {};
      let result;
      if (Array.isArray(ids) && ids.length) {
        result = await pool.query(
          `UPDATE permit_facilities SET status='promoted', updated_at=NOW()
           WHERE external_permit_nmbr = ANY($1) AND status='pool' RETURNING external_permit_nmbr`,
          [ids]
        );
      } else if (Number.isInteger(topN) && topN > 0) {
        result = await pool.query(
          `UPDATE permit_facilities SET status='promoted', updated_at=NOW()
           WHERE external_permit_nmbr IN (
             SELECT external_permit_nmbr FROM permit_facilities WHERE status='pool'
             ORDER BY score DESC LIMIT $1
           ) RETURNING external_permit_nmbr`,
          [topN]
        );
      } else {
        return res.status(400).json({ error: "Provide ids[] or topN" });
      }
      res.json({ promoted: result.rowCount });
    } catch (err) {
      console.error("POST /api/permits/promote error:", err);
      res.status(500).json({ error: "Failed to promote" });
    }
  });
}
```

- [ ] **Step 2: Mount in `server.js`**

Add the import next to the other `lib/*Routes` import (`server.js:21`):
```js
import { registerPermitRoutes } from "./lib/permitRoutes.js";
```
Find where `registerNurtureRoutes(app, pool)` is called and add directly after it:
```js
registerPermitRoutes(app, pool);
```

- [ ] **Step 3: Verify endpoints against the Railway DB**

Boot locally pointed at Railway, then curl:
```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system" && DATABASE_URL="<RAILWAY_DATABASE_PUBLIC_URL>" PORT=8787 node server.js &
sleep 4
curl -s "http://localhost:8787/api/permits/pool?page=1&pageSize=3" | head -c 400; echo
curl -s "http://localhost:8787/api/permits/operators?limit=3" | head -c 400; echo
kill %1
```
Expected: `pool` returns `{rows:[...3], total:<N>, page:1}` ordered by score; `operators` returns 3 ranked operators.

- [ ] **Step 4: Verify promote flips status**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system" && DATABASE_URL="<RAILWAY_DATABASE_PUBLIC_URL>" PORT=8787 node server.js &
sleep 4
curl -s -X POST "http://localhost:8787/api/permits/promote" -H "Content-Type: application/json" -d '{"topN":5}'; echo
psql "<RAILWAY_DATABASE_PUBLIC_URL>" -c "SELECT status, COUNT(*) FROM permit_facilities GROUP BY 1;"
kill %1
```
Expected: `{"promoted":5}` and a `promoted` row count of 5 in the DB.

- [ ] **Step 5: Commit**

```bash
git add lib/permitRoutes.js server.js
git commit -m "feat(permits): pool/operators/promote API"
```

---

## Task 7: Frontend API client (`src/lib/permitApi.ts`)

Mirrors the existing `src/lib/sdrApi.ts` fetch-wrapper style (same-origin `fetch`, JSON, throw on non-2xx).

**Files:**
- Create: `src/lib/permitApi.ts`

- [ ] **Step 1: Implement the client**

Create `src/lib/permitApi.ts`:
```ts
export type PermitFacility = {
  id: string;
  external_permit_nmbr: string;
  operator_name: string | null;
  operator_key: string;
  city: string | null;
  sector_code: string | null;
  expiration_date: string | null;
  original_issue_date: string | null;
  score: number;
  status: string;
};

export type PoolResponse = { rows: PermitFacility[]; total: number; page: number; pageSize: number };

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export const permitApi = {
  getPool: (params: { page?: number; pageSize?: number; city?: string; search?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") q.set(k, String(v)); });
    return j<PoolResponse>(`/api/permits/pool?${q.toString()}`);
  },
  promote: (body: { ids?: string[]; topN?: number }) =>
    j<{ promoted: number }>(`/api/permits/promote`, { method: "POST", body: JSON.stringify(body) }),
};
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run build`
Expected: `tsc -b` passes (no type errors from the new file).

- [ ] **Step 3: Commit**

```bash
git add src/lib/permitApi.ts
git commit -m "feat(permits): frontend api client"
```

---

## Task 8: Pool view component (`src/components/permits/PoolView.tsx`)

A table of the ranked pool with a search box, a city filter, paging, row selection, and a "Promote top N" / "Promote selected" action. Matches the Tailwind + lucide-react style of the existing `nurture/` views.

**Files:**
- Create: `src/components/permits/PoolView.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/permits/PoolView.tsx`:
```tsx
import { useEffect, useState, useCallback } from "react";
import { Flame, Search, CheckSquare, Square, ArrowUpRight } from "lucide-react";
import { permitApi, type PermitFacility } from "../../lib/permitApi";

export default function PoolView({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [rows, setRows] = useState<PermitFacility[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [city, setCity] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const pageSize = 50;

  const load = useCallback(() => {
    setLoading(true);
    permitApi
      .getPool({ page, pageSize, search, city, status: "pool" })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch((e) => pushToast?.(`Load failed: ${e.message}`, "error"))
      .finally(() => setLoading(false));
  }, [page, search, city, pushToast]);

  useEffect(() => { load(); }, [load]);

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function promoteSelected() {
    if (!selected.size) return;
    try {
      const { promoted } = await permitApi.promote({ ids: [...selected] });
      pushToast?.(`Promoted ${promoted} to enrichment`, "success");
      setSelected(new Set()); load();
    } catch (e) { pushToast?.(`Promote failed: ${(e as Error).message}`, "error"); }
  }

  async function promoteTopN(n: number) {
    try {
      const { promoted } = await permitApi.promote({ topN: n });
      pushToast?.(`Promoted top ${promoted}`, "success"); load();
    } catch (e) { pushToast?.(`Promote failed: ${(e as Error).message}`, "error"); }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
          <input className="pl-8 pr-3 py-2 rounded-xl border border-slate-200 text-sm"
            placeholder="Search operator" value={search}
            onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
        </div>
        <input className="px-3 py-2 rounded-xl border border-slate-200 text-sm" placeholder="City"
          value={city} onChange={(e) => { setPage(1); setCity(e.target.value); }} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-slate-500">{total.toLocaleString()} in pool</span>
          <button onClick={() => promoteTopN(100)}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
            <Flame className="h-4 w-4" /> Promote top 100
          </button>
          <button onClick={promoteSelected} disabled={!selected.size}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl border border-slate-200 disabled:opacity-40">
            <ArrowUpRight className="h-4 w-4" /> Promote selected ({selected.size})
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="w-10 p-2"></th>
              <th className="text-left p-2">Operator</th>
              <th className="text-left p-2">Permit #</th>
              <th className="text-left p-2">City</th>
              <th className="text-right p-2">Expires</th>
              <th className="text-right p-2">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.external_permit_nmbr} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-2 text-center cursor-pointer" onClick={() => toggle(r.external_permit_nmbr)}>
                  {selected.has(r.external_permit_nmbr)
                    ? <CheckSquare className="h-4 w-4 text-indigo-600" />
                    : <Square className="h-4 w-4 text-slate-300" />}
                </td>
                <td className="p-2 font-medium text-slate-800">{r.operator_name || "—"}</td>
                <td className="p-2 text-slate-500">{r.external_permit_nmbr}</td>
                <td className="p-2 text-slate-500">{r.city || "—"}</td>
                <td className="p-2 text-right text-slate-500">{r.expiration_date || "—"}</td>
                <td className="p-2 text-right font-semibold text-slate-700">{r.score}</td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">No facilities in pool. Run the ingest script.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>Page {page} / {pages}</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Prev</button>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks/builds**

Run: `npm run build`
Expected: build passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/permits/PoolView.tsx
git commit -m "feat(permits): Pool view (filter, rank, select, promote)"
```

---

## Task 9: Wire the "Permits" tab into the Cold lane

Add a `permits` tab to the Cold-lane tab set in `SdrInterface.tsx` (the lane already exists: `Cold · Apollo` | `Nurture · Brevo`). The tab renders `PoolView`.

**Files:**
- Modify: `src/components/SdrInterface.tsx`

- [ ] **Step 1: Extend the Cold-lane tab type and import the view**

In `src/components/SdrInterface.tsx`, find:
```ts
type SdrTab = "queue" | "engaged" | "dashboard" | "mailboxes" | "templates";
```
Change to:
```ts
type SdrTab = "queue" | "engaged" | "dashboard" | "mailboxes" | "templates" | "permits";
```
Add the import with the other component imports near the top:
```ts
import PoolView from "./permits/PoolView";
```
Add `FileSearch` to the existing `lucide-react` import in this file (alongside `Inbox`, `Flame`, etc.).

- [ ] **Step 2: Add the tab button and panel**

In the Cold-lane render block, after the `templates` `TabButton` (around the `Templates` button), add:
```tsx
            <TabButton current={tab} value="permits" onClick={setTab} icon={<FileSearch className="h-4 w-4" />}>Permits</TabButton>
```
After the `{tab === "templates" && <TemplatesView />}` line, add:
```tsx
          {tab === "permits" && <PoolView pushToast={push} />}
```

- [ ] **Step 3: Build and verify the bundle compiles**

Run: `npm run build`
Expected: build passes with the new tab wired.

- [ ] **Step 4: Visual smoke test against the Railway DB**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system" && DATABASE_URL="<RAILWAY_DATABASE_PUBLIC_URL>" PORT=8787 node server.js &
sleep 4
# In a browser: http://localhost:8787  → log in → SDR → Cold · Apollo → Permits tab.
# Confirm: pool count shows, rows ranked by score, search/city filter works, "Promote top 100" flips rows out of the pool view.
kill %1
```
Expected: Permits tab lists the ingested pool, filters work, promote actions succeed with a toast.

- [ ] **Step 5: Commit**

```bash
git add src/components/SdrInterface.tsx
git commit -m "feat(permits): Permits tab in Cold lane"
```

---

## Task 10: End-to-end verification + handoff note

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-permit-expiry-lead-engine-design.md` (tick off Plan-1 scope, note Plan 2 entry point)

- [ ] **Step 1: Run the full vitest suite**

Run: `npm run test`
Expected: all `permitIngest` + `permitScoring` tests pass.

- [ ] **Step 2: Confirm the data path end-to-end**

```bash
psql "<RAILWAY_DATABASE_PUBLIC_URL>" -c "SELECT status, COUNT(*) FROM permit_facilities GROUP BY 1 ORDER BY 1;"
```
Expected: rows in `pool` (and `promoted` if you promoted during testing); zero `NEC` coverage rows anywhere.

- [ ] **Step 3: Record Plan-2 entry point in the spec**

Append a short note under spec §10 Open Questions:
```markdown
- **Plan 1 (foundation) shipped 2026-06-15:** EPA ingest + pool + scoring v1 + Pool tab live. Plan 2 starts at build-task-1 (TCEQ transport IP test from n8n/Railway), then TCEQ scrape → enrichment table → email discovery → activation/mailbox controls → MSGP sequence → multi-channel output, consuming `permit_facilities.status='promoted'` rows.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-15-permit-expiry-lead-engine-design.md
git commit -m "docs(permits): mark Plan 1 foundation complete, note Plan 2 entry"
```

---

## Plan 1 → Plan 2 boundary

**Plan 1 delivers (working software):** the full active-NOI population, free from EPA, deduped by operator, scored, and browsable/filterable in the Permits tab, with a promote action that stages a batch (`status='promoted'`).

**Plan 2 (separate plan, after TCEQ transport is confirmed) adds:** TCEQ per-permit scrape (contact name + address + SIC/sector) on promoted batches via plain HTTP from n8n/Railway (Browserless+residential fallback), `permit_enrichment` table, email discovery (Apollo person-match / pattern), compliance flags from ECHO (feeds the scoring slots already built in Task 3), master activation switch + per-mailbox enable/disable, the MSGP Renewal Apollo sequence, enroll + reuse of `sdr_sends`/engagement, Pipedrive promotion on engagement, and the no-email call/mail CSV export.
