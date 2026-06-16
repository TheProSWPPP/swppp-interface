# Permit Engine — TCEQ Enrichment + Direct-Mail Output (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a promoted permit batch into an actionable **direct-mail list** — fetch each facility's contact name + mailing address + SIC/sector from TCEQ (via Browserless residential proxy), store it, and export a print-ready CSV (name + address + Aug-2026 deadline hook). Direct mail is the primary channel because the email-discovery spike proved Apollo reaches ~0% of these permittees (spec §11).

**Architecture:** Builds on Plan 1's `permit_facilities` (`status='promoted'` rows are the input). A pure TCEQ parser + a Browserless fetch wrapper feed an enrichment runner that writes a new `permit_enrichment` table and advances facility status to `enriched`. A pure CSV builder + a download endpoint produce the direct-mail file. A new "Enrichment" sub-view in the existing Permits tab drives it.

**Tech Stack:** Node ESM + Express + `pg`, React + TypeScript + Tailwind + lucide-react, Vitest (pure logic), Browserless `/content` API with residential proxy (the proven CMD-scraper transport).

**Spec:** `docs/superpowers/specs/2026-06-15-permit-expiry-lead-engine-design.md` (Plan 2 covers spec §2b TCEQ scrape, §3 enrichment chain steps a+b, §4 `permit_enrichment`, §6 Enrichment sub-view direct-mail output).

**Deferred to Plan 3:** Apollo "email the few" path + MSGP sequence, master activation switch + per-mailbox controls, ECHO compliance flags (feeding the scoring slots Plan 1 already built), Pipedrive promotion on response, monthly auto-refresh cron.

**Known facts (verified):**
- Browserless token (CMD scraper): `2TUrlOwcrZ6v9K0c99e5c2543a2b6c4643cb787cfa7adce16`, params `proxy=residential`, `blockConsentModals=true`. Store as env `BROWSERLESS_TOKEN`; do not hardcode in committed files.
- TCEQ detail URL: `https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.validate_permit&permit_number=<PERMIT>` (server-rendered, no JS needed).
- Railway prod DB URL: Railway → `capable-renewal` → Postgres → `DATABASE_PUBLIC_URL` (used for verification; the controller has it).
- App basic-auth defaults locally: `admin:swppp2026`.

**Testing note (codebase-consistent):** Pure logic (TCEQ parser, CSV builder) uses Vitest TDD. Fetch/route/UI verified via real calls + Railway DB + `npm run build` + `curl`, per the repo pattern. Per `feedback_use_railway_db_not_local`, DB verification uses the Railway public URL.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/permitTceqParse.js` (create) | Pure: parse TCEQ `wq_dpa` page text → `{permit, status, site_name, operator_name, customer_number, contact_name, mailing_address, site_address, city, zip, sic_code, sector}`. No I/O. |
| `lib/permitTceqFetch.js` (create) | Fetch one TCEQ detail page via Browserless `/content` (residential proxy); returns HTML/text. Thin I/O wrapper. |
| `lib/permitEnrich.js` (create) | Orchestrates a batch: takes a fetcher + parser (injectable), upserts `permit_enrichment`, updates `permit_facilities`. Core logic testable with a fake fetcher. |
| `lib/permitCsv.js` (create) | Pure: build a direct-mail CSV string from enriched rows (RFC-4180 quoting). No I/O. |
| `lib/__tests__/permitTceqParse.test.js` (create) | Vitest unit tests for the parser (fixture-based). |
| `lib/__tests__/permitCsv.test.js` (create) | Vitest unit tests for the CSV builder. |
| `lib/permitRoutes.js` (modify) | Add `POST /api/permits/enrich`, `GET /api/permits/enriched`, `GET /api/permits/export/direct-mail.csv`. |
| `server.js` (modify) | Add `permit_enrichment` table to `initDB()`. |
| `migrations/2026-06-16-permit-enrichment.sql` (create) | SQL record of the new table. |
| `src/lib/permitApi.ts` (modify) | Add `enrich`, `getEnriched`, and the CSV export URL helper + `PermitEnrichment` type. |
| `src/components/permits/EnrichmentView.tsx` (create) | Sub-view: promoted/enriched counts, "Run enrichment (cap N)", enriched table, "Download direct-mail CSV". |
| `src/components/permits/PermitsTab.tsx` (create) | Small wrapper: Pool | Enrichment sub-tab switcher, rendered by the Permits tab. |
| `src/components/SdrInterface.tsx` (modify) | Render `PermitsTab` instead of `PoolView` directly for the `permits` tab. |

---

## Task 1: Verify the Browserless → TCEQ transport

Confirms the chosen transport actually reaches TCEQ before building on it. This runs from the controller's shell (calls Browserless, which proxies from a US residential IP — so it works even though the dev sandbox can't reach TCEQ directly).

**Files:** none (verification only).

- [ ] **Step 1: Hit one TCEQ permit page through Browserless**

Run (substitute the real token):
```bash
curl -s -m 60 -X POST "https://chrome.browserless.io/content?token=$BROWSERLESS_TOKEN&proxy=residential&blockConsentModals=true" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.validate_permit&permit_number=TXR05DP22"}' \
  | grep -o "Summary of Authorization\|STEPHENVILLE IRON\|MARSHALL DAVIS" | sort -u
```
Expected: prints `Summary of Authorization` (and ideally the operator / contact strings) — proving Browserless+residential renders the TCEQ page.

- [ ] **Step 2: Decide transport**

If Step 1 returns the expected strings → Browserless transport confirmed; proceed. If it fails or rate-limits, try the plain-HTTP fallback from a US host (Railway one-off) before continuing; record which transport works in the commit message of Task 3. No code commit in this task.

---

## Task 2: TCEQ page parser (`lib/permitTceqParse.js`)

The TCEQ `wq_dpa` detail page (rendered to text/markdown) contains labelled lines. Example shape:
```
Summary of Authorization TXR05DP22
Permit Number:TXR05DP22
Authorization Status:ACTIVE
Site Name on Permit:STEPHENVILLE IRON AND METAL
Primary SIC Code: 5093
sector : N
Operator: CN605404029 - Stephenville Iron And Metal, LLC
Address: PO BOX 1250 STEPHENVILLE TX 76401 0012
Annual Fee Billing Address: MARSHALL DAVIS PO BOX 1250 STEPHENVILLE TX 76401 0012
Site Location: 3229 N US HIGHWAY 377 STEPHENVILLE TX 76401 1514
County: ERATH
```
The contact name is the first line of "Annual Fee Billing Address" (a person), followed by the mailing address. The parser must handle missing fields gracefully (some permits have no billing contact).

**Files:**
- Create: `lib/permitTceqParse.js`
- Test: `lib/__tests__/permitTceqParse.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/permitTceqParse.test.js`:
```js
import { describe, it, expect } from "vitest";
import { parseTceqDetail } from "../permitTceqParse.js";

const FIXTURE = `Water Quality General Permits Search
Summary of Authorization TXR05DP22
Permit Number:TXR05DP22
Authorization Status:ACTIVE
Date Coverage Began:08/03/2017
Site Name on Permit:STEPHENVILLE IRON AND METAL
Authorization Type:INDUSTRIAL
Primary SIC Code:
5093
sector :
N
Operator:
CN605404029 - Stephenville Iron And Metal, LLC
Address:
PO BOX 1250 STEPHENVILLE TX 76401 0012
Annual Fee Billing Address:
MARSHALL DAVIS
PO BOX 1250 STEPHENVILLE TX 76401 0012
Permitted Site Information
RN:RN109885749
Site Location:
3229 N US HIGHWAY 377 STEPHENVILLE TX 76401 1514
County:ERATH`;

describe("parseTceqDetail", () => {
  it("extracts the core fields", () => {
    const r = parseTceqDetail(FIXTURE, "TXR05DP22");
    expect(r.permit).toBe("TXR05DP22");
    expect(r.status).toBe("ACTIVE");
    expect(r.site_name).toBe("STEPHENVILLE IRON AND METAL");
    expect(r.operator_name).toBe("Stephenville Iron And Metal, LLC");
    expect(r.customer_number).toBe("CN605404029");
    expect(r.contact_name).toBe("MARSHALL DAVIS");
    expect(r.sic_code).toBe("5093");
    expect(r.mailing_address).toContain("PO BOX 1250");
    expect(r.mailing_address).toContain("STEPHENVILLE TX 76401");
    expect(r.city).toBe("STEPHENVILLE");
    expect(r.zip).toBe("76401");
  });

  it("returns nulls (not throws) when the billing contact is absent", () => {
    const r = parseTceqDetail("Summary of Authorization TXR05XX99\nPermit Number:TXR05XX99\nAuthorization Status:ACTIVE\nSite Name on Permit:SOME PIT", "TXR05XX99");
    expect(r.permit).toBe("TXR05XX99");
    expect(r.contact_name).toBeNull();
    expect(r.mailing_address).toBeNull();
  });

  it("returns a found=false marker when the page isn't a valid authorization", () => {
    const r = parseTceqDetail("No authorization found", "TXR05NONE");
    expect(r.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test`
Expected: FAIL — `permitTceqParse.js` does not export `parseTceqDetail`.

- [ ] **Step 3: Implement `lib/permitTceqParse.js`**

Create `lib/permitTceqParse.js`:
```js
// Pure parser for TCEQ wq_dpa "Summary of Authorization" detail pages. No I/O.

/** Grab the text immediately following a label (same line or next non-empty line). */
function after(text, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s*([^\\n]*)", "i");
  const m = text.match(re);
  if (!m) return null;
  let val = (m[1] || "").trim();
  if (val) return val;
  // value is on the following non-empty line(s)
  const idx = m.index + m[0].length;
  const rest = text.slice(idx).split("\n").map((s) => s.trim()).filter(Boolean);
  return rest.length ? rest[0] : null;
}

/** Operator line looks like "CN605404029 - Stephenville Iron And Metal, LLC". */
function splitOperator(raw) {
  if (!raw) return { customer_number: null, operator_name: null };
  const m = raw.match(/(CN\d+)\s*-\s*(.+)/i);
  if (m) return { customer_number: m[1].toUpperCase(), operator_name: m[2].trim() };
  return { customer_number: null, operator_name: raw.trim() };
}

/** "CITY TX 76401 0012" -> { city, zip }. */
function cityZip(addr) {
  if (!addr) return { city: null, zip: null };
  const m = addr.match(/([A-Za-z][A-Za-z .]+?)\s+TX\s+(\d{5})/);
  return m ? { city: m[1].trim().toUpperCase(), zip: m[2] } : { city: null, zip: null };
}

/**
 * Parse the billing block: the line after "Annual Fee Billing Address:" is the
 * contact person; the remaining line(s) up to the next label are the mailing address.
 */
function billing(text) {
  const m = text.match(/Annual Fee Billing Address\s*:?\s*\n?([\s\S]*?)(?:\n\s*(?:Permitted Site Information|Site Location|RN:|Regulated Entity|Permittee))/i);
  if (!m) return { contact_name: null, mailing_address: null };
  const lines = m[1].split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { contact_name: null, mailing_address: null };
  // First line with no digits = a person name; address lines contain numbers/PO BOX.
  const contact = /\d/.test(lines[0]) ? null : lines[0];
  const addrLines = contact ? lines.slice(1) : lines;
  return {
    contact_name: contact,
    mailing_address: addrLines.length ? addrLines.join(", ") : null,
  };
}

export function parseTceqDetail(text, permit) {
  const t = String(text || "");
  const found = /Summary of Authorization/i.test(t);
  if (!found) return { permit, found: false };
  const op = splitOperator(after(t, "Operator"));
  const { contact_name, mailing_address } = billing(t);
  const { city, zip } = cityZip(mailing_address || after(t, "Address"));
  return {
    permit,
    found: true,
    status: after(t, "Authorization Status"),
    site_name: after(t, "Site Name on Permit"),
    operator_name: op.operator_name,
    customer_number: op.customer_number,
    contact_name: contact_name || null,
    mailing_address: mailing_address || null,
    site_address: after(t, "Site Location"),
    city: city || null,
    zip: zip || null,
    sic_code: after(t, "Primary SIC Code"),
    sector: after(t, "sector"),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test`
Expected: PASS. If a field assertion fails, adjust the parser minimally (the regexes above are the intended behavior) and re-run.

- [ ] **Step 5: Commit**

```bash
git add lib/permitTceqParse.js lib/__tests__/permitTceqParse.test.js
git commit -m "feat(permits): TCEQ wq_dpa detail parser (contact + address + SIC)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: TCEQ fetch wrapper (`lib/permitTceqFetch.js`)

**Files:**
- Create: `lib/permitTceqFetch.js`

- [ ] **Step 1: Implement the fetcher**

Create `lib/permitTceqFetch.js`:
```js
// Fetch a single TCEQ wq_dpa detail page via Browserless (residential proxy).
// Returns the rendered HTML/text, or null on failure. Thin I/O wrapper.

const TCEQ_URL = (permit) =>
  `https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.validate_permit&permit_number=${encodeURIComponent(permit)}`;

export async function fetchTceqDetail(permit, { token = process.env.BROWSERLESS_TOKEN } = {}) {
  if (!token) throw new Error("BROWSERLESS_TOKEN not set");
  const endpoint = `https://chrome.browserless.io/content?token=${token}&proxy=residential&blockConsentModals=true`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: TCEQ_URL(permit) }),
        signal: AbortSignal.timeout(60000),
      });
      if (r.ok) {
        const html = await r.text();
        if (html && /Summary of Authorization|Water Quality General Permits/i.test(html)) return html;
      }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
  return null;
}
```

- [ ] **Step 2: Verify it parses (syntax) and the real path works**

Run: `node --check lib/permitTceqFetch.js` (expect exit 0).
Then a live smoke test (controller, with `BROWSERLESS_TOKEN` set):
```bash
node -e 'import("./lib/permitTceqFetch.js").then(async m=>{const h=await m.fetchTceqDetail("TXR05DP22");console.log("len",h&&h.length, /MARSHALL DAVIS/i.test(h||"")?"contact-found":"no-contact")})'
```
Expected: a non-zero length and `contact-found`.

- [ ] **Step 3: Commit** (note the working transport from Task 1 in the message)

```bash
git add lib/permitTceqFetch.js
git commit -m "feat(permits): TCEQ fetch via Browserless residential proxy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `permit_enrichment` schema

**Files:**
- Modify: `server.js` (`initDB()`, after the `permit_operators` block)
- Create: `migrations/2026-06-16-permit-enrichment.sql`

- [ ] **Step 1: Add the table to `initDB()`**

Insert after the `permit_operators` index in `initDB()`:
```js
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_enrichment (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_permit_nmbr TEXT UNIQUE NOT NULL
          REFERENCES permit_facilities(external_permit_nmbr) ON DELETE CASCADE,
        operator_key TEXT,
        customer_number TEXT,
        contact_name TEXT,
        mailing_address TEXT,
        site_address TEXT,
        sic_code TEXT,
        sector TEXT,
        channel TEXT NOT NULL DEFAULT 'mail' CHECK (channel IN ('mail','email','phone','none')),
        tceq_status TEXT,
        source TEXT NOT NULL DEFAULT 'tceq',
        enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_enrichment_channel ON permit_enrichment(channel)`);
```

- [ ] **Step 2: Create the migration record**

Create `migrations/2026-06-16-permit-enrichment.sql` with the same `CREATE TABLE` + index as raw SQL.

- [ ] **Step 3: Apply to prod (controller)**

```bash
export DATABASE_URL="<RAILWAY_DATABASE_PUBLIC_URL>"
node -e 'import("pg").then(async({default:pg})=>{const fs=await import("fs");const p=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await p.query(fs.readFileSync("migrations/2026-06-16-permit-enrichment.sql","utf8"));const t=await p.query("SELECT to_regclass(\x27public.permit_enrichment\x27) t");console.log("permit_enrichment:",t.rows[0].t);await p.end();})'
```
Expected: `permit_enrichment: permit_enrichment`.

- [ ] **Step 4: Commit**

```bash
git add server.js migrations/2026-06-16-permit-enrichment.sql
git commit -m "feat(permits): permit_enrichment schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Enrichment runner (`lib/permitEnrich.js`)

Processes up to `cap` promoted facilities: fetch TCEQ → parse → upsert `permit_enrichment` → advance `permit_facilities.status` to `enriched` and backfill `city`/`sector_code`/`site_address`. The fetcher + parser are injected so the core is testable without network.

**Files:**
- Create: `lib/permitEnrich.js`
- Test: `lib/__tests__/permitEnrich.test.js`

- [ ] **Step 1: Write the failing test (with a fake fetcher + fake pool)**

Create `lib/__tests__/permitEnrich.test.js`:
```js
import { describe, it, expect } from "vitest";
import { enrichOne } from "../permitEnrich.js";

// minimal fake pg pool capturing queries
function fakePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; },
  };
}

const FIXTURE = `Summary of Authorization TXR05DP22
Authorization Status:ACTIVE
Site Name on Permit:STEPHENVILLE IRON AND METAL
Operator:
CN605404029 - Stephenville Iron And Metal, LLC
Annual Fee Billing Address:
MARSHALL DAVIS
PO BOX 1250 STEPHENVILLE TX 76401 0012
Permitted Site Information
Primary SIC Code:
5093`;

describe("enrichOne", () => {
  it("fetches, parses, and writes enrichment + facility update", async () => {
    const pool = fakePool();
    const fetcher = async () => FIXTURE;
    const res = await enrichOne(pool, "TXR05DP22", { fetcher });
    expect(res.ok).toBe(true);
    expect(res.contact_name).toBe("MARSHALL DAVIS");
    // wrote to permit_enrichment and updated permit_facilities
    const sqls = pool.calls.map((c) => c.sql).join(" ");
    expect(sqls).toMatch(/INSERT INTO permit_enrichment/i);
    expect(sqls).toMatch(/UPDATE permit_facilities/i);
  });

  it("marks not-found without throwing when TCEQ has no record", async () => {
    const pool = fakePool();
    const fetcher = async () => "No authorization found";
    const res = await enrichOne(pool, "TXR05NONE", { fetcher });
    expect(res.ok).toBe(false);
  });

  it("returns ok:false when the fetch returns null", async () => {
    const pool = fakePool();
    const fetcher = async () => null;
    const res = await enrichOne(pool, "TXR05X", { fetcher });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test` → FAIL (no `enrichOne`).

- [ ] **Step 3: Implement `lib/permitEnrich.js`**

Create `lib/permitEnrich.js`:
```js
import { parseTceqDetail } from "./permitTceqParse.js";
import { fetchTceqDetail } from "./permitTceqFetch.js";

/** Enrich a single promoted facility. fetcher injectable for tests. */
export async function enrichOne(pool, permit, { fetcher = fetchTceqDetail } = {}) {
  const html = await fetcher(permit);
  if (!html) return { ok: false, permit, reason: "fetch_failed" };
  const d = parseTceqDetail(html, permit);
  if (!d.found) return { ok: false, permit, reason: "not_found" };

  await pool.query(
    `INSERT INTO permit_enrichment
       (external_permit_nmbr, customer_number, contact_name, mailing_address, site_address,
        sic_code, sector, channel, tceq_status, source, enriched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'mail',$8,'tceq',NOW())
     ON CONFLICT (external_permit_nmbr) DO UPDATE SET
       customer_number=EXCLUDED.customer_number, contact_name=EXCLUDED.contact_name,
       mailing_address=EXCLUDED.mailing_address, site_address=EXCLUDED.site_address,
       sic_code=EXCLUDED.sic_code, sector=EXCLUDED.sector, tceq_status=EXCLUDED.tceq_status,
       enriched_at=NOW(), updated_at=NOW()`,
    [permit, d.customer_number, d.contact_name, d.mailing_address, d.site_address, d.sic_code, d.sector, d.status]
  );
  await pool.query(
    `UPDATE permit_facilities
       SET status='enriched', city=COALESCE($2, city), sector_code=COALESCE($3, sector_code),
           site_address=COALESCE($4, site_address), updated_at=NOW()
     WHERE external_permit_nmbr=$1`,
    [permit, d.city, d.sic_code, d.site_address]
  );
  return { ok: true, permit, contact_name: d.contact_name, channel: "mail" };
}

/** Enrich up to `cap` promoted facilities. Sequential to be gentle on Browserless + TCEQ. */
export async function enrichBatch(pool, { cap = 50, fetcher = fetchTceqDetail } = {}) {
  const { rows } = await pool.query(
    `SELECT external_permit_nmbr FROM permit_facilities WHERE status='promoted' ORDER BY score DESC LIMIT $1`,
    [cap]
  );
  let ok = 0, fail = 0;
  for (const r of rows) {
    const res = await enrichOne(pool, r.external_permit_nmbr, { fetcher });
    res.ok ? ok++ : fail++;
  }
  return { processed: rows.length, ok, fail };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test` → PASS (parser + csv + enrich + Plan-1 suites all green).

- [ ] **Step 5: Commit**

```bash
git add lib/permitEnrich.js lib/__tests__/permitEnrich.test.js
git commit -m "feat(permits): enrichment runner (TCEQ -> permit_enrichment, status advance)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Direct-mail CSV builder (`lib/permitCsv.js`)

**Files:**
- Create: `lib/permitCsv.js`
- Test: `lib/__tests__/permitCsv.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/permitCsv.test.js`:
```js
import { describe, it, expect } from "vitest";
import { buildDirectMailCsv } from "../permitCsv.js";

describe("buildDirectMailCsv", () => {
  it("produces a header + one row per record with the deadline column", () => {
    const csv = buildDirectMailCsv([
      { contact_name: "MARSHALL DAVIS", operator_name: "Stephenville Iron And Metal, LLC",
        mailing_address: "PO BOX 1250, STEPHENVILLE TX 76401", city: "STEPHENVILLE",
        external_permit_nmbr: "TXR05DP22", expiration_date: "2026-08-13" },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("contact_name,operator_name,mailing_address,city,permit_number,permit_expires,deadline_hook");
    expect(lines[1]).toContain("MARSHALL DAVIS");
    expect(lines[1]).toContain("TXR05DP22");
    expect(lines[1]).toContain("2026-08-13");
  });

  it("quotes fields containing commas or quotes (RFC-4180)", () => {
    const csv = buildDirectMailCsv([
      { contact_name: 'JANE "JJ" DOE', operator_name: "Acme, Inc.", mailing_address: "1 Main St, Austin TX 78701",
        city: "AUSTIN", external_permit_nmbr: "TXR05AA01", expiration_date: "2026-08-13" },
    ]);
    expect(csv).toContain('"Acme, Inc."');
    expect(csv).toContain('"JANE ""JJ"" DOE"');
  });

  it("returns just the header for an empty list", () => {
    expect(buildDirectMailCsv([]).trim()).toBe("contact_name,operator_name,mailing_address,city,permit_number,permit_expires,deadline_hook");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** → `npm run test` FAIL (no `buildDirectMailCsv`).

- [ ] **Step 3: Implement `lib/permitCsv.js`**

Create `lib/permitCsv.js`:
```js
// Pure direct-mail CSV builder (RFC-4180). No I/O.
const HEADERS = ["contact_name","operator_name","mailing_address","city","permit_number","permit_expires","deadline_hook"];

function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function buildDirectMailCsv(rows) {
  const out = [HEADERS.join(",")];
  for (const r of rows || []) {
    const exp = r.expiration_date ? String(r.expiration_date).slice(0, 10) : "";
    const hook = exp ? `Your TXR050000 stormwater permit expires ${exp} — is your SWPPP updated?` : "";
    out.push([
      cell(r.contact_name), cell(r.operator_name), cell(r.mailing_address),
      cell(r.city), cell(r.external_permit_nmbr), cell(exp), cell(hook),
    ].join(","));
  }
  return out.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests to verify they pass** → `npm run test` PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/permitCsv.js lib/__tests__/permitCsv.test.js
git commit -m "feat(permits): direct-mail CSV builder (RFC-4180, deadline hook)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Enrichment + export API (`lib/permitRoutes.js`)

**Files:**
- Modify: `lib/permitRoutes.js` (add three handlers inside `registerPermitRoutes`)

- [ ] **Step 1: Add the imports + routes**

At the top of `lib/permitRoutes.js`, add:
```js
import { enrichBatch } from "./permitEnrich.js";
import { buildDirectMailCsv } from "./permitCsv.js";
```
Inside `registerPermitRoutes(app, pool)`, add:
```js
  // POST /api/permits/enrich { cap?: number }  — enrich promoted batch from TCEQ
  app.post("/api/permits/enrich", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!process.env.BROWSERLESS_TOKEN) return res.status(503).json({ error: "BROWSERLESS_TOKEN not configured" });
    try {
      const cap = Math.min(200, Math.max(1, parseInt(req.body?.cap) || 50));
      const result = await enrichBatch(pool, { cap });
      res.json(result);
    } catch (err) {
      console.error("POST /api/permits/enrich error:", err);
      res.status(500).json({ error: "Enrichment failed" });
    }
  });

  // GET /api/permits/enriched?page=&pageSize= — enriched facilities joined with contact
  app.get("/api/permits/enriched", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
      const totalQ = await pool.query(`SELECT COUNT(*) AS n FROM permit_enrichment`);
      const rowsQ = await pool.query(
        `SELECT f.external_permit_nmbr, f.operator_name, f.city, f.expiration_date, f.score,
                e.contact_name, e.mailing_address, e.sic_code, e.channel
           FROM permit_enrichment e
           JOIN permit_facilities f ON f.external_permit_nmbr = e.external_permit_nmbr
          ORDER BY f.score DESC LIMIT $1 OFFSET $2`,
        [pageSize, (page - 1) * pageSize]
      );
      res.json({ rows: rowsQ.rows, total: Number(totalQ.rows[0].n), page, pageSize });
    } catch (err) {
      console.error("GET /api/permits/enriched error:", err);
      res.status(500).json({ error: "Failed to list enriched" });
    }
  });

  // GET /api/permits/export/direct-mail.csv — download the direct-mail list (channel='mail')
  app.get("/api/permits/export/direct-mail.csv", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const { rows } = await pool.query(
        `SELECT f.external_permit_nmbr, f.operator_name, f.expiration_date,
                e.contact_name, e.mailing_address, f.city
           FROM permit_enrichment e
           JOIN permit_facilities f ON f.external_permit_nmbr = e.external_permit_nmbr
          WHERE e.channel = 'mail' AND e.mailing_address IS NOT NULL
          ORDER BY f.score DESC`
      );
      const csv = buildDirectMailCsv(rows);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="permit-direct-mail.csv"');
      res.send(csv);
    } catch (err) {
      console.error("GET /api/permits/export/direct-mail.csv error:", err);
      res.status(500).json({ error: "Export failed" });
    }
  });
```

- [ ] **Step 2: Verify syntax** → `node --check lib/permitRoutes.js` (exit 0).

- [ ] **Step 3: Live verification (controller, server booted against prod DB with BROWSERLESS_TOKEN set)**

```bash
# promote a tiny batch first (Plan-1 endpoint), then enrich 5
curl -s -u admin:swppp2026 -X POST localhost:8787/api/permits/promote -H "Content-Type: application/json" -d '{"topN":5}'
curl -s -m 180 -u admin:swppp2026 -X POST localhost:8787/api/permits/enrich -H "Content-Type: application/json" -d '{"cap":5}'
curl -s -u admin:swppp2026 "localhost:8787/api/permits/enriched?pageSize=5"
curl -s -u admin:swppp2026 "localhost:8787/api/permits/export/direct-mail.csv" | head -3
```
Expected: enrich returns `{processed:5, ok:N, fail:M}`; enriched lists rows with `contact_name`/`mailing_address`; CSV head shows the header + real mail rows.

- [ ] **Step 4: Commit**

```bash
git add lib/permitRoutes.js
git commit -m "feat(permits): enrich + enriched + direct-mail CSV export endpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Frontend API additions (`src/lib/permitApi.ts`)

**Files:**
- Modify: `src/lib/permitApi.ts`

- [ ] **Step 1: Add types + methods**

Append to `src/lib/permitApi.ts` (keep existing exports):
```ts
export type PermitEnrichment = {
  external_permit_nmbr: string;
  operator_name: string | null;
  city: string | null;
  expiration_date: string | null;
  score: number;
  contact_name: string | null;
  mailing_address: string | null;
  sic_code: string | null;
  channel: string;
};

export type EnrichedResponse = { rows: PermitEnrichment[]; total: number; page: number; pageSize: number };
```
And add to the `permitApi` object (before the closing `};`):
```ts
  enrich: (cap = 50) =>
    j<{ processed: number; ok: number; fail: number }>(`/api/permits/enrich`, { method: "POST", body: JSON.stringify({ cap }) }),
  getEnriched: (params: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") q.set(k, String(v)); });
    return j<EnrichedResponse>(`/api/permits/enriched?${q.toString()}`);
  },
  directMailCsvUrl: () => `/api/permits/export/direct-mail.csv`,
```

- [ ] **Step 2: Verify build** → `npm run build` (tsc clean).

- [ ] **Step 3: Commit**

```bash
git add src/lib/permitApi.ts
git commit -m "feat(permits): frontend api for enrich/enriched/csv export

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Enrichment sub-view (`src/components/permits/EnrichmentView.tsx`)

**Files:**
- Create: `src/components/permits/EnrichmentView.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/permits/EnrichmentView.tsx`:
```tsx
import { useEffect, useState, useCallback } from "react";
import { Sparkles, Download, RefreshCw } from "lucide-react";
import { permitApi, type PermitEnrichment } from "../../lib/permitApi";

export default function EnrichmentView({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [rows, setRows] = useState<PermitEnrichment[]>([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    permitApi.getEnriched({ pageSize: 100 })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch((e) => pushToast?.(`Load failed: ${e.message}`, "error"))
      .finally(() => setLoading(false));
  }, [pushToast]);

  useEffect(() => { load(); }, [load]);

  async function runEnrich() {
    setRunning(true);
    try {
      const r = await permitApi.enrich(50);
      pushToast?.(`Enriched ${r.ok}/${r.processed} (${r.fail} failed)`, "success");
      load();
    } catch (e) { pushToast?.(`Enrich failed: ${(e as Error).message}`, "error"); }
    finally { setRunning(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-500">{total.toLocaleString()} enriched</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={runEnrich} disabled={running}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            <Sparkles className="h-4 w-4" /> {running ? "Enriching…" : "Run enrichment (50)"}
          </button>
          <a href={permitApi.directMailCsvUrl()}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50">
            <Download className="h-4 w-4" /> Download direct-mail CSV
          </a>
          <button onClick={load} className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50" aria-label="Refresh">
            <RefreshCw className="h-4 w-4 text-slate-500" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left p-2">Contact</th>
              <th className="text-left p-2">Operator</th>
              <th className="text-left p-2">Mailing address</th>
              <th className="text-left p-2">City</th>
              <th className="text-left p-2">Channel</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.external_permit_nmbr} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-2 font-medium text-slate-800">{r.contact_name || "—"}</td>
                <td className="p-2 text-slate-600">{r.operator_name || "—"}</td>
                <td className="p-2 text-slate-500">{r.mailing_address || "—"}</td>
                <td className="p-2 text-slate-500">{r.city || "—"}</td>
                <td className="p-2"><span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-semibold">{r.channel}</span></td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={5} className="p-6 text-center text-slate-400">Nothing enriched yet. Promote a batch in the Pool tab, then Run enrichment.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build** → `npm run build`.

- [ ] **Step 3: Commit**

```bash
git add src/components/permits/EnrichmentView.tsx
git commit -m "feat(permits): Enrichment sub-view (run enrichment + direct-mail CSV)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: Pool | Enrichment sub-tabs (`PermitsTab.tsx` + wire-in)

**Files:**
- Create: `src/components/permits/PermitsTab.tsx`
- Modify: `src/components/SdrInterface.tsx`

- [ ] **Step 1: Create the sub-tab wrapper**

Create `src/components/permits/PermitsTab.tsx`:
```tsx
import { useState } from "react";
import { FileSearch, Sparkles } from "lucide-react";
import PoolView from "./PoolView";
import EnrichmentView from "./EnrichmentView";

export default function PermitsTab({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [sub, setSub] = useState<"pool" | "enrichment">("pool");
  const btn = (v: "pool" | "enrichment", label: string, icon: React.ReactNode) => (
    <button onClick={() => setSub(v)}
      className={"flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-lg " +
        (sub === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
      {icon}{label}
    </button>
  );
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {btn("pool", "Pool", <FileSearch className="h-4 w-4" />)}
        {btn("enrichment", "Enrichment", <Sparkles className="h-4 w-4" />)}
      </div>
      {sub === "pool" ? <PoolView pushToast={pushToast} /> : <EnrichmentView pushToast={pushToast} />}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `SdrInterface.tsx`**

In `src/components/SdrInterface.tsx`:
- Replace the import `import PoolView from "./permits/PoolView";` with `import PermitsTab from "./permits/PermitsTab";`
- Replace the panel line `{tab === "permits" && <PoolView pushToast={(m, k) => push(k ?? "success", m)} />}` with `{tab === "permits" && <PermitsTab pushToast={(m, k) => push(k ?? "success", m)} />}`

(If the existing `pushToast` adapter differs, preserve whatever adapter is already there — just swap `PoolView` → `PermitsTab`.)

- [ ] **Step 3: Verify build** → `npm run build`.

- [ ] **Step 4: Visual smoke test (controller, server vs prod DB + BROWSERLESS_TOKEN)**

Open the app → SDR → Cold · Apollo → Permits → Pool tab still works; Enrichment sub-tab shows enriched rows + the two action buttons; "Download direct-mail CSV" downloads a file with real names/addresses.

- [ ] **Step 5: Commit**

```bash
git add src/components/permits/PermitsTab.tsx src/components/SdrInterface.tsx
git commit -m "feat(permits): Pool | Enrichment sub-tabs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: End-to-end verification + spec note

- [ ] **Step 1: Full vitest** → `npm run test` (Plan-1 + parser + enrich + csv suites all green).
- [ ] **Step 2: Real batch E2E (controller):** promote 10 → enrich 10 → confirm `permit_enrichment` rows + `permit_facilities.status='enriched'` in the DB → download CSV and eyeball ~10 rows with names + addresses + the Aug-2026 hook.
```bash
psql "<RAILWAY_DATABASE_PUBLIC_URL>" -c "SELECT status, COUNT(*) FROM permit_facilities GROUP BY 1 ORDER BY 1;" -c "SELECT COUNT(*), COUNT(contact_name) FROM permit_enrichment;"
```
Expected: some `enriched` facilities; `permit_enrichment` count > 0 with most `contact_name` populated.
- [ ] **Step 3: Note Plan-2 completion in the spec** (append under §10):
```markdown
- **Plan 2 (enrichment + direct-mail) shipped <date>:** TCEQ scrape via Browserless → permit_enrichment → direct-mail CSV export + Enrichment sub-tab. Plan 3 = email-the-few (Apollo + MSGP sequence), activation/mailbox controls, ECHO compliance scoring, Pipedrive promotion on response, monthly refresh cron.
```
- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/specs/2026-06-15-permit-expiry-lead-engine-design.md
git commit -m "docs(permits): mark Plan 2 complete, note Plan 3 scope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Plan 2 → Plan 3 boundary

**Plan 2 delivers (working software):** promote a batch → one click enriches it from TCEQ (contact name + mailing address + SIC) → download a print-ready direct-mail CSV with the Aug-2026 deadline hook. The primary channel, end-to-end.

**Plan 3 (separate):** the "email the few" path (Apollo company-match on enriched batch → MSGP Apollo sequence enroll, reusing `sdr_sends`/engagement), master activation switch + per-mailbox enable/disable, ECHO compliance flags feeding the scoring slots, Pipedrive promotion when a lead responds (mail/email), and the monthly EPA re-pull + re-enrichment cron. Phone enrichment for the hot tier is an option here too.
