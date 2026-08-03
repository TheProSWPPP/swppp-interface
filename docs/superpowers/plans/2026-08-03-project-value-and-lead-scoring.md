# Project Value + Lead Scoring Rebalance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the CMD "Confirmed Value" column into Pipedrive as a new `Project Value` field, tag every imported lead with its source, feed both into the lead score, and let Milo's bid-aggregator sheet go through the same CSV upload without a second button.

**Architecture:** CSV header normalisation happens in `server.js` *before* the file is handed to n8n, as a pure unit-tested module. n8n therefore always receives a CSV in the canonical column shape it already understands, so the only n8n edits are three new key/value lines per PATCH node plus the scoring rules. Scoring stays additive: stage, size and warmth are three independent inputs rather than one substituting for another.

**Tech Stack:** Node ESM + Express (`server.js`, `lib/`), vitest, React + TypeScript + Tailwind (`src/`), n8n cloud (`proswppp.app.n8n.cloud`) edited via `n8nac`, Pipedrive v1 API, PostgreSQL on Railway.

**Background analysis with all measured numbers:** `goal-runs/2026-08-03-lead-value-scoring/PLAN.md`. Read it before Task 6.

## Global Constraints

- **Never write to Pipedrive `deal_value`.** It holds Pro SWPPP quote amounts ($9,988 / $4,997 / $2,497 tiers) on 11 leads. Project size goes in a new field.
- **Blank or unparseable value maps to NULL, never 0.** 3 rows contain the text `na` / `No update` (the 497 apparently-blank rows are empty spacer rows, dropped by the parser). A 0 would collect the sub-$500k penalty.
- **Edit n8n workflows via `n8nac` only** (pull → edit the `.ts` → push). A raw API PUT leaves the tracked file stale and the next push reverts it.
- **Back up any n8n workflow JSON to `~/.claude/backups/<slug>-2026-08-03/` before the first edit to it.**
- **Auto-outreach is ON** (`sdr_settings.auto_outreach_enabled = true`, `auto_min_score = null`) and `lib/autoOutreach.js:104` orders the send queue by `lead_score DESC`. Any scoring change alters who gets emailed on the next pass with no further action. Task 6 captures a baseline first.
- **Bid-invite leads score a flat 50** (Derek, 2026-08-03: "Let's score them at 50 to start and leave it. They are warmer leads as the customer is asking us to specifically bid the swppp scope"). The origin replaces the stage points rather than stacking on them.
- **Derek wants to import tonight.** Tasks 1 to 5 are the critical path for that; Tasks 6 to 8 can follow after.
- Existing test suite is 219 passing across 18 files. `npx vitest run` must stay green after every task.
- Railway auto-deploys `main`. Confirm a deploy landed with `curl -s -u derek:dereksystem https://swppp-interface-production.up.railway.app/api/version`.
- Zero em dashes in any user-facing copy.

---

### Task 1: CSV header normalisation module

Milo's aggregator sheet uses different column names and is missing four columns. Rather than a second upload button, normalise headers server-side so n8n always sees the canonical shape.

**Files:**
- Create: `lib/leadCsvNormalize.js`
- Test: `lib/__tests__/leadCsvNormalize.test.js`

**Model:** `sonnet`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `detectSource(headers) -> "cmd" | "bid-aggregator" | "unknown"`, `parseProjectValue(raw) -> number | null`, `normalizeLeadCsv(csvText) -> { csv: string, source: string, renamed: string[], injected: string[] }`. Task 2 calls `normalizeLeadCsv`. Task 6 mirrors `parseProjectValue`'s tier boundaries.

- [ ] **Step 1: Write the failing test**

```javascript
// lib/__tests__/leadCsvNormalize.test.js
import { describe, it, expect } from "vitest";
import { detectSource, parseProjectValue, normalizeLeadCsv } from "../leadCsvNormalize.js";

// Measured 2026-08-03 against the two real sheets.
// MBT JUL 2026.xlsx  -> canonical CMD shape + a new "Confirmed Value" column L
// Multi Bid BC iSQFT CC Tracker.xlsx -> 3 renames, 4 columns absent
const CMD_HEADERS = ["Bid Date","Project Title","City + State","Quick Link","Start","Stage","Winning Bidder","Phone","Email","Name","Notes","Confirmed Value"];
const AGG_HEADERS = ["Manual Sent","Auto Sent","Bid Date","Project Title","Quick Link","Company","Contact Name","Primary Email","Secondary email","Notes"];

describe("detectSource", () => {
  it("recognises the CMD sheet", () => {
    expect(detectSource(CMD_HEADERS)).toBe("cmd");
  });

  it("recognises the aggregator sheet by its renamed columns", () => {
    expect(detectSource(AGG_HEADERS)).toBe("bid-aggregator");
  });

  it("still recognises CMD without the new value column, so June-style files keep working", () => {
    expect(detectSource(CMD_HEADERS.filter((h) => h !== "Confirmed Value"))).toBe("cmd");
  });

  it("tolerates the extra columns each sheet actually carries", () => {
    // June 2026 shipped a "Drafted in Outlook" column; it imported fine.
    expect(detectSource([...CMD_HEADERS, "Drafted in Outlook"])).toBe("cmd");
  });

  it("returns unknown rather than guessing", () => {
    expect(detectSource(["foo", "bar"])).toBe("unknown");
  });
});

describe("parseProjectValue", () => {
  it("parses a plain number", () => {
    expect(parseProjectValue("1171783")).toBe(1171783);
  });

  it("strips currency formatting", () => {
    expect(parseProjectValue("$1,171,783.00")).toBe(1171783);
  });

  it("maps the real junk values to null, NOT zero", () => {
    // 'na' and 'No update' appear in column L. Zero would collect the sub-$500k penalty.
    expect(parseProjectValue("na")).toBeNull();
    expect(parseProjectValue("No update")).toBeNull();
    expect(parseProjectValue("")).toBeNull();
    expect(parseProjectValue(null)).toBeNull();
    expect(parseProjectValue("   ")).toBeNull();
  });

  it("rejects a negative or zero amount rather than storing it", () => {
    expect(parseProjectValue("0")).toBeNull();
    expect(parseProjectValue("-5000")).toBeNull();
  });

  it("keeps the real extremes of the July sheet", () => {
    expect(parseProjectValue("2774")).toBe(2774);
    expect(parseProjectValue("464000000")).toBe(464000000);
  });
});

describe("normalizeLeadCsv", () => {
  it("passes a CMD file through untouched apart from tagging the source", () => {
    const csv = "Bid Date,Project Title,City + State,Quick Link,Start,Stage,Winning Bidder,Phone,Email,Name,Notes,Confirmed Value\n46204,The Junction,\"Wagoner, OK\",http://x,46265,PB,TekTone Builders,(918)-695-9461,d@x.com,Derrick,MB,1171783\n";
    const out = normalizeLeadCsv(csv);
    expect(out.source).toBe("cmd");
    expect(out.renamed).toEqual([]);
    expect(out.csv.split("\n")[0]).toContain("Confirmed Value");
    expect(out.csv.split("\n")[0]).toContain("Lead Origin");
    expect(out.csv.split("\n")[1]).toContain("CMD");
  });

  it("renames the aggregator columns and injects the missing ones", () => {
    const csv = "Manual Sent,Auto Sent,Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Secondary email,Notes\nNo,46144,46145,City Hall Addition,http://bc,Frost Contracting Services LLC,RJ Frost,rj@frost.com,,\n";
    const out = normalizeLeadCsv(csv);
    expect(out.source).toBe("bid-aggregator");
    expect(out.renamed.sort()).toEqual(["Company", "Contact Name", "Primary Email"]);
    const header = out.csv.split("\n")[0];
    for (const h of ["Winning Bidder", "Name", "Email", "Stage", "Phone", "City + State", "Start", "Lead Origin"]) {
      expect(header).toContain(h);
    }
    expect(header).not.toContain("Primary Email");
  });

  it("sets Stage to CM on every aggregator row, because that is the bidding sequence", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,http://bc,Frost,RJ,rj@frost.com,\n46146,Y,http://bc2,Acme,Jo,jo@acme.com,\n";
    const out = normalizeLeadCsv(csv);
    const rows = out.csv.trim().split("\n").slice(1);
    const cols = out.csv.split("\n")[0].split(",");
    const stageIdx = cols.indexOf("Stage");
    expect(rows.every((r) => r.split(",")[stageIdx] === "CM")).toBe(true);
    expect(out.injected).toContain("Stage");
  });

  it("leaves an unknown file completely alone so nothing is silently mangled", () => {
    const csv = "foo,bar\n1,2\n";
    const out = normalizeLeadCsv(csv);
    expect(out.source).toBe("unknown");
    expect(out.csv).toBe(csv);
    expect(out.renamed).toEqual([]);
  });

  it("does not crash on a header-only file", () => {
    const out = normalizeLeadCsv("foo,bar\n");
    expect(out.source).toBe("unknown");
  });

  it("preserves quoted fields containing commas", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,\"Hall, Phase 2\",http://bc,Frost,RJ,rj@frost.com,\n";
    const out = normalizeLeadCsv(csv);
    expect(out.csv).toContain('"Hall, Phase 2"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swppp-system && npx vitest run lib/__tests__/leadCsvNormalize.test.js`
Expected: FAIL, `Failed to resolve import "../leadCsvNormalize.js"`

- [ ] **Step 3: Write the implementation**

```javascript
// lib/leadCsvNormalize.js
// Normalise an uploaded lead CSV into the single column shape the n8n importer understands.
//
// Two sheets feed this system and they disagree on column names:
//
//   MBT <month> <year>.csv  (CMD Insight, monthly)  -> already canonical, plus a new
//     "Confirmed Value" column Derek added 2026-08-03.
//   Multi Bid BC iSQFT CC Tracker  (Milo, by hand)  -> BuildingConnected / iSqFt /
//     ConstructConnect bid invitations. Renames three columns and omits four.
//
// Doing this here rather than in n8n means it is unit-testable, and n8n's parser keeps
// receiving exactly the shape it already handles. The importer stores every column in
// `lead_import_rows.raw_data` and ignores unknown ones (proven by the June 2026 file's
// stray "Drafted in Outlook" column), so injecting extra columns is safe.

/** The column names `CSV Leads -> Pipedrive SUB WF` reads. Exact, case included. */
export const CANONICAL_COLUMNS = [
  "Bid Date", "Project Title", "City + State", "Quick Link", "Start",
  "Stage", "Winning Bidder", "Phone", "Email", "Name", "Notes",
];

/** Aggregator header -> canonical header. */
const AGGREGATOR_RENAMES = {
  "Company": "Winning Bidder",
  "Contact Name": "Name",
  "Primary Email": "Email",
};

/**
 * Columns the aggregator sheet does not have at all, and what to put there.
 *
 * Stage = CM deliberately: the CM template opens "Saw y'all are handling this one...
 * you should have a bid from us on same", which is the right first touch for someone
 * who invited us to bid. AGC and LBA both open with congratulations, which would be
 * wrong for a job nobody has won yet.
 *
 * Phone / City + State / Start are genuinely absent from the source. Empty is honest;
 * an empty Start also means the scorer's proximity term and its 120-day auto-archive
 * both sit out, which is why Lead Origin carries the weight for this source instead.
 */
const AGGREGATOR_CONSTANTS = {
  "Stage": "CM",
  "Phone": "",
  "City + State": "",
  "Start": "",
};

/** Written on every row so the scorer can tell a bid invitation from a CMD scrape. */
export const ORIGIN_COLUMN = "Lead Origin";
export const ORIGIN_BY_SOURCE = { cmd: "CMD", "bid-aggregator": "Bid Invite" };

// --- CSV primitives (RFC4180 subset: quotes, escaped quotes, embedded commas) ---

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v && v.trim()));
}

function encodeCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(encodeCell).join(",")).join("\n") + "\n";
}

// --- Source detection ---

/**
 * Which sheet is this? Returns "cmd", "bid-aggregator", or "unknown".
 *
 * Deliberately keyed on the columns that DIFFER between the two rather than on
 * filename, which Derek changes month to month. "unknown" is a real answer: an
 * unrecognised file is passed through untouched rather than guessed at.
 */
export function detectSource(headers) {
  const set = new Set((headers || []).map((h) => String(h || "").trim()));
  const aggregatorMarkers = ["Company", "Contact Name", "Primary Email"];
  if (aggregatorMarkers.every((h) => set.has(h)) && !set.has("Winning Bidder")) {
    return "bid-aggregator";
  }
  if (set.has("Winning Bidder") && set.has("Project Title") && set.has("Stage")) {
    return "cmd";
  }
  return "unknown";
}

// --- Value parsing ---

/**
 * Column L ("Confirmed Value") -> a positive number, or null.
 *
 * Measured on the real July sheet: 1,496 of 1,499 real data rows filled (99.8%), values from $2,774 to
 * $464,000,000, and three rows carrying the literal text "na" or "No update". Anything
 * not a positive number returns null so the scorer can treat it as "unknown size".
 * Returning 0 would make an unparseable row collect the sub-$500k penalty.
 */
export function parseProjectValue(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// --- The whole job ---

/**
 * @returns {{csv: string, source: string, renamed: string[], injected: string[]}}
 *          `csv` is safe to hand straight to the n8n webhook.
 */
export function normalizeLeadCsv(csvText) {
  const rows = parseCsv(String(csvText || ""));
  if (rows.length < 2) {
    const src = rows.length ? detectSource(rows[0]) : "unknown";
    return { csv: String(csvText || ""), source: src, renamed: [], injected: [] };
  }

  const headers = rows[0].map((h) => String(h).trim());
  const source = detectSource(headers);
  if (source === "unknown") {
    return { csv: String(csvText || ""), source, renamed: [], injected: [] };
  }

  const renamed = [];
  const outHeaders = headers.map((h) => {
    if (source === "bid-aggregator" && AGGREGATOR_RENAMES[h]) {
      renamed.push(h);
      return AGGREGATOR_RENAMES[h];
    }
    return h;
  });

  const injected = [];
  const constants = source === "bid-aggregator" ? AGGREGATOR_CONSTANTS : {};
  for (const col of Object.keys(constants)) {
    if (!outHeaders.includes(col)) { outHeaders.push(col); injected.push(col); }
  }
  if (!outHeaders.includes(ORIGIN_COLUMN)) {
    outHeaders.push(ORIGIN_COLUMN);
    injected.push(ORIGIN_COLUMN);
  }

  const origin = ORIGIN_BY_SOURCE[source] || "";
  const width = headers.length;
  const outRows = [outHeaders];
  for (const r of rows.slice(1)) {
    const cells = outHeaders.map((col, i) => {
      if (i < width) return r[i] ?? "";
      if (col === ORIGIN_COLUMN) return origin;
      return constants[col] ?? "";
    });
    outRows.push(cells);
  }

  return { csv: toCsv(outRows), source, renamed: renamed.sort(), injected };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swppp-system && npx vitest run lib/__tests__/leadCsvNormalize.test.js`
Expected: PASS, 15 tests

- [ ] **Step 5: Run the whole suite for regressions**

Run: `cd swppp-system && npx vitest run`
Expected: PASS, 234 tests across 19 files (was 219 across 18)

- [ ] **Step 6: Commit**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system"
git add lib/leadCsvNormalize.js lib/__tests__/leadCsvNormalize.test.js
git commit -m "feat(leads): normalise upload CSV headers before n8n sees them

Milo's bid-aggregator sheet renames three columns and omits four. Rather
than a second upload button, map it to the canonical shape server-side so
the existing importer handles both. Also tags every row with Lead Origin.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire normalisation into the upload endpoint

**Files:**
- Modify: `server.js:6366-6400` (the `/api/leads/upload` handler)
- Test: `lib/__tests__/leadCsvNormalize.test.js` (extend)

**Model:** `sonnet`

**Interfaces:**
- Consumes: `normalizeLeadCsv` from Task 1.
- Produces: the upload response gains `source`, `renamed`, `injected`. Task 8's UI reads them.

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/leadCsvNormalize.test.js`:

```javascript
describe("upload contract", () => {
  it("produces a base64 payload n8n can parse back to canonical headers", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,http://bc,Frost,RJ,rj@frost.com,\n";
    const out = normalizeLeadCsv(csv);
    const roundTripped = Buffer.from(Buffer.from(out.csv).toString("base64"), "base64").toString("utf8");
    const headers = parseCsv(roundTripped)[0];
    expect(headers).toContain("Winning Bidder");
    expect(headers).toContain("Stage");
    expect(detectSource(headers)).toBe("cmd"); // now canonical
  });
});
```

Add `parseCsv` to the import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swppp-system && npx vitest run lib/__tests__/leadCsvNormalize.test.js -t "upload contract"`
Expected: FAIL, `parseCsv is not a function` (not yet imported)

- [ ] **Step 3: Fix the import, then modify the endpoint**

In the test file, change the import line to:

```javascript
import { detectSource, parseProjectValue, normalizeLeadCsv, parseCsv } from "../leadCsvNormalize.js";
```

In `server.js`, add near the other `lib/` imports:

```javascript
import { normalizeLeadCsv } from "./lib/leadCsvNormalize.js";
```

Then replace the base64 block in `/api/leads/upload` (currently reading the file and encoding it verbatim) with:

```javascript
  let csvBase64, normalized;
  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    // Map Milo's bid-aggregator headers onto the canonical shape before n8n parses the
    // file, so one upload button serves both sheets. An unrecognised file passes through
    // byte-identical rather than being guessed at.
    normalized = normalizeLeadCsv(fileBuffer.toString("utf8"));
    csvBase64 = Buffer.from(normalized.csv, "utf8").toString("base64");
    if (normalized.source !== "cmd") {
      console.log(
        `[lead-import] job ${jobId}: source=${normalized.source} renamed=[${normalized.renamed}] injected=[${normalized.injected}]`,
      );
    }
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
```

And extend the success response so the UI can show what happened:

```javascript
  res.json({
    job_id: jobId,
    status: "uploaded",
    source: normalized.source,
    renamed: normalized.renamed,
    injected: normalized.injected,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swppp-system && npx vitest run`
Expected: PASS, 235 tests

- [ ] **Step 5: Verify the server still boots**

Run: `cd swppp-system && node --check server.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 6: Commit**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system"
git add server.js lib/__tests__/leadCsvNormalize.test.js
git commit -m "feat(leads): normalise headers at upload, report the mapping back

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Create the Pipedrive `Project Value` field

Pipedrive's native `Value` (`deal_value`) already holds Pro SWPPP quote amounts on 11 leads. Project size needs its own field.

**Files:**
- Create: `scripts/create-project-value-field.mjs`

**Model:** `sonnet`

**Interfaces:**
- Consumes: nothing.
- Produces: a 40-char Pipedrive field key, printed to stdout. Tasks 4, 5, 6 and 7 all need it. **Record it in this plan file under Task 3 Step 4 before continuing.**

- [ ] **Step 1: Write the script**

```javascript
// scripts/create-project-value-field.mjs
// One-shot: create the "Project Value" custom LEAD field in Pipedrive.
//
// Why not the built-in Value field: `deal_value` is already in use for Pro SWPPP's own
// quote amounts ($9,988 / $4,997 / $3,897 / $2,497 / $1,797 on 11 leads as of 2026-08-03).
// Putting a $464M construction budget in the same column would make revenue unreadable.
//
// Idempotent: if a field with this name already exists it prints the existing key.
const TOKEN = process.env.PIPEDRIVE_API_TOKEN || "3089d0ffb03a7f996c5f10156fd4ebfaad9fca28";
const NAME = "Project Value";

const list = await (await fetch(`https://api.pipedrive.com/v1/leadFields?api_token=${TOKEN}`)).json();
const existing = (list.data || []).find((f) => f.name === NAME);
if (existing) {
  console.log(`ALREADY EXISTS  key=${existing.key}  type=${existing.field_type}`);
  process.exit(0);
}

const res = await fetch(`https://api.pipedrive.com/v1/leadFields?api_token=${TOKEN}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: NAME, field_type: "double" }),
});
const body = await res.json();
if (!res.ok || !body.success) {
  console.error("FAILED", res.status, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}
console.log(`CREATED  key=${body.data.key}  type=${body.data.field_type}`);

// Guard: prove we did not disturb the native Value field.
const after = await (await fetch(`https://api.pipedrive.com/v1/leadFields?api_token=${TOKEN}`)).json();
const dealValue = (after.data || []).find((f) => f.key === "deal_value");
console.log(`deal_value still present: ${!!dealValue}  label="${dealValue?.name}"`);
```

- [ ] **Step 2: Run it**

Run: `cd swppp-system && node scripts/create-project-value-field.mjs`
Expected: `CREATED  key=<40 hex chars>  type=double` then `deal_value still present: true  label="Value"`

- [ ] **Step 3: Verify the quote amounts are untouched**

```bash
cd swppp-system && node -e '
const T="3089d0ffb03a7f996c5f10156fd4ebfaad9fca28";
const r=await (await fetch(`https://api.pipedrive.com/v1/leads?api_token=${T}&limit=500`)).json();
' 2>/dev/null; node --input-type=module -e '
const T="3089d0ffb03a7f996c5f10156fd4ebfaad9fca28";
let s=0,all=[],p=0;
while(p<25){const j=await (await fetch(`https://api.pipedrive.com/v1/leads?api_token=${T}&start=${s}&limit=500`)).json();
 if(!j.data?.length)break; all.push(...j.data); if(!j.additional_data?.pagination?.more_items_in_collection)break;
 s=j.additional_data.pagination.next_start;p++;}
console.log("leads with a quote value:", all.filter(l=>l.value&&l.value.amount).length, "(expected 11)");'
```
Expected: `leads with a quote value: 11 (expected 11)`

- [ ] **Step 4: Record the key in this plan**

Replace every `PROJECT_VALUE_KEY` placeholder in Tasks 4, 5, 6 and 7 with the printed key. Do not proceed until this is done.

- [ ] **Step 5: Commit**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system"
git add scripts/create-project-value-field.mjs
git commit -m "feat(pipedrive): add a Project Value lead field, leaving deal_value alone

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Write Project Value and Lead Origin from the importer

Three PATCH nodes in the sub-workflow set the lead's custom fields, one per branch. All three need the two new keys.

**Files:**
- Modify: `n8n-workflows/CSV Leads -_ Pipedrive SUB WF.workflow.ts` (nodes `Add Extra Lead Fields`, `Add Extra Lead Fields2`, `Add Extra Lead Fields3`)

**Model:** `opus`

**Interfaces:**
- Consumes: `PROJECT_VALUE_KEY` from Task 3; the `Confirmed Value` and `Lead Origin` columns guaranteed by Tasks 1 and 2.
- Produces: leads in Pipedrive carrying both fields. Task 6 reads `PROJECT_VALUE_KEY`, Task 7 reads it from `sdr_lead_state`.

- [ ] **Step 1: Back up the workflow**

```bash
mkdir -p ~/.claude/backups/lead-import-project-value-2026-08-03
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System"
node --input-type=module -e '
import fs from "fs";
const host="https://proswppp.app.n8n.cloud";
const key=process.env.N8N_API_KEY;
for (const id of ["ERjEgsWHru3e0yDK","V24E63aEzWXuVBQz"]) {
  const r=await fetch(`${host}/api/v1/workflows/${id}`,{headers:{"X-N8N-API-KEY":key}});
  const j=await r.json();
  const p=`${process.env.HOME}/.claude/backups/lead-import-project-value-2026-08-03/${id}.json`;
  fs.writeFileSync(p, JSON.stringify(j,null,1));
  console.log("saved", p, fs.statSync(p).size, "bytes, active=", j.active);
}'
```
Expected: two files written, both non-zero.

- [ ] **Step 2: Pull the workflow**

Run: `cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System" && n8nac pull ERjEgsWHru3e0yDK`
Expected: `Pulled workflow ERjEgsWHru3e0yDK.`

- [ ] **Step 3: Edit all three PATCH nodes**

In `n8n-workflows/CSV Leads -_ Pipedrive SUB WF.workflow.ts`, each of `AddExtraLeadFields`, `AddExtraLeadFields2` and `AddExtraLeadFields3` has a `jsonBody` ending with the Project Stage line. Change that closing line in **all three** from:

```
  "7c1852c27664d1118f75660223a6af9e99d10f2c": "{{ $('Start').item.json.Stage }}"
}`,
```

to:

```
  "7c1852c27664d1118f75660223a6af9e99d10f2c": "{{ $('Start').item.json.Stage }}",
  "6abd1d3e43212a7baf864cd4d2a210add6a96f60": "{{ $('Start').item.json['Lead Origin'] || '' }}",
  "PROJECT_VALUE_KEY": {{ (() => { const v = String($('Start').item.json['Confirmed Value'] ?? '').replace(/[$,\s]/g,''); return /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) : 'null'; })() }}
}`,
```

The value expression is unquoted on purpose: Pipedrive wants a JSON number or literal `null` for a `double` field, and quoting `"null"` writes a string. The regex mirrors `parseProjectValue` from Task 1, so `na`, `No update` and blanks land as `null`.

- [ ] **Step 4: Push and confirm all three changed**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System"
n8nac push ERjEgsWHru3e0yDK
grep -c "PROJECT_VALUE_KEY" "n8n-workflows/CSV Leads -_ Pipedrive SUB WF.workflow.ts"
```
Expected: push succeeds; grep prints `3`.

- [ ] **Step 5: Import a 10-row slice and read it back**

Take the first 10 data rows of `MBT JUL 2026.xlsx` including one row whose column L is `na`, save as `/tmp/mbt-slice.csv`, upload it through the interface, approve it, then:

```bash
cd swppp-system && node --input-type=module -e '
const T="3089d0ffb03a7f996c5f10156fd4ebfaad9fca28", K="PROJECT_VALUE_KEY";
const j=await (await fetch(`https://api.pipedrive.com/v1/leads?api_token=${T}&limit=100&sort=add_time%20DESC`)).json();
for (const l of j.data.slice(0,10)) console.log(String(l[K]).padStart(12), "|", String(l.title).slice(0,44));'
```
Expected: numeric values matching column L, and `null` for the `na` row. **Zero must not appear.**

- [ ] **Step 6: Commit**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System"
git add "n8n-workflows/CSV Leads -_ Pipedrive SUB WF.workflow.ts"
git commit -m "feat(import): write Project Value and Lead Origin on all three branches

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Carry Project Value into `sdr_lead_state`

The interface and the auto-outreach query read `sdr_lead_state`, not Pipedrive directly.

**Files:**
- Modify: `lib/pipedriveSync.js:16` (field map), `:160-210` (extract and upsert)
- Modify: `server.js` (add the column in the schema-init block near `:950`)
- Modify: `server.js:1917` (sortable-field map)

**Model:** `sonnet`

**Interfaces:**
- Consumes: `PROJECT_VALUE_KEY` from Task 3.
- Produces: `sdr_lead_state.project_value DOUBLE PRECISION`. Task 8's UI selects it.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/pipedriveSyncFields.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { FIELD_KEYS } from "../pipedriveSync.js";

describe("pipedriveSync field map", () => {
  it("knows the Project Value key", () => {
    expect(FIELD_KEYS.PROJECT_VALUE).toBe("PROJECT_VALUE_KEY");
  });

  it("still knows the Lead Score key it always did", () => {
    expect(FIELD_KEYS.LEAD_SCORE).toBe("e2b854536230112bff77d6b0ce33bdb49f2916eb");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swppp-system && npx vitest run lib/__tests__/pipedriveSyncFields.test.js`
Expected: FAIL, `FIELD_KEYS` is not exported or `PROJECT_VALUE` is undefined

- [ ] **Step 3: Implement**

In `lib/pipedriveSync.js`, export the existing field-key object (rename the local `F` binding's declaration to `export const FIELD_KEYS = {...}` and add `const F = FIELD_KEYS;` beneath it so existing references keep working), and add:

```javascript
  PROJECT_VALUE: "PROJECT_VALUE_KEY", // "Project Value" (double, construction budget — NOT deal_value)
```

Next to the existing `leadScore` extraction around `:160`, add:

```javascript
        const projectValue =
          lead[F.PROJECT_VALUE] != null && lead[F.PROJECT_VALUE] !== ""
            ? Number(lead[F.PROJECT_VALUE])
            : null;
```

Add `project_value` to the INSERT column list, the `EXCLUDED` update list, and the parameter array in the same positions relative to `lead_score`.

In `server.js`, beside the existing `lead_score` column-add:

```javascript
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS project_value DOUBLE PRECISION`);
```

And in the sortable-field map at `:1917`:

```javascript
  project_value: "s.project_value",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swppp-system && npx vitest run`
Expected: PASS, 237 tests

- [ ] **Step 5: Deploy and confirm the column exists**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system" && git push origin main
# wait for the deploy, then:
node --input-type=module -e '
import pg from "pg";
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
const r=await c.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='"'"'sdr_lead_state'"'"' AND column_name='"'"'project_value'"'"'`);
console.table(r.rows); await c.end();'
```
Expected: one row, `project_value | double precision`

- [ ] **Step 6: Commit**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system"
git add lib/pipedriveSync.js server.js lib/__tests__/pipedriveSyncFields.test.js
git commit -m "feat(sdr): sync Project Value into sdr_lead_state

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Capture the scoring baseline

Rescoring reorders the live send queue. Pipedrive keeps no history on the score field, so this snapshot is the only rollback that will exist.

**Files:**
- Create: `scripts/score-baseline.mjs`
- Create: `goal-runs/2026-08-03-lead-value-scoring/baseline-scores.json` (generated)

**Model:** `sonnet`

**Interfaces:**
- Consumes: nothing.
- Produces: `baseline-scores.json` as `[{id, score, stage}]`. Task 7 diffs against it.

- [ ] **Step 1: Write the script**

```javascript
// scripts/score-baseline.mjs
// Snapshot every lead's current score before the scoring rebalance.
// Pipedrive keeps no field history, so without this a bad rebalance cannot be undone.
import fs from "fs";
const T = process.env.PIPEDRIVE_API_TOKEN || "3089d0ffb03a7f996c5f10156fd4ebfaad9fca28";
const SCORE = "e2b854536230112bff77d6b0ce33bdb49f2916eb";
const STAGE = "7c1852c27664d1118f75660223a6af9e99d10f2c";

let start = 0, all = [], p = 0;
while (p < 40) {
  const j = await (await fetch(`https://api.pipedrive.com/v1/leads?api_token=${T}&start=${start}&limit=500`)).json();
  if (!j.data?.length) break;
  all.push(...j.data);
  if (!j.additional_data?.pagination?.more_items_in_collection) break;
  start = j.additional_data.pagination.next_start; p++;
}
const rows = all.map((l) => ({ id: l.id, score: l[SCORE] ?? null, stage: l[STAGE] ?? null }));
const out = "goal-runs/2026-08-03-lead-value-scoring/baseline-scores.json";
fs.writeFileSync(out, JSON.stringify(rows, null, 0));
const nums = rows.map((r) => Number(r.score)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
console.log(`saved ${rows.length} leads to ${out}`);
console.log(`min ${nums[0]}  median ${nums[nums.length >> 1]}  max ${nums[nums.length - 1]}  negative ${nums.filter((n) => n < 0).length}`);
```

- [ ] **Step 2: Run it**

Run: `cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System" && node swppp-system/scripts/score-baseline.mjs`
Expected: ~7,185 leads saved; `min -50  median 20  max 115  negative ~2280`

- [ ] **Step 3: Commit**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System"
git add swppp-system/scripts/score-baseline.mjs goal-runs/2026-08-03-lead-value-scoring/baseline-scores.json
git commit -m "chore(scoring): snapshot every lead score before the rebalance

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Rebalance the lead score

Three changes: pay the stages that currently pay nothing, add value tiers, add a warmth bonus for bid invitations. Kept additive so scores stay comparable across sources.

**Files:**
- Modify: `n8n-workflows/Lead Scoring.workflow.ts:140-250` (the scoring Code node)

**Model:** `fable`

**Interfaces:**
- Consumes: `PROJECT_VALUE_KEY` from Task 3; `baseline-scores.json` from Task 6.
- Produces: no code interface. Changes `sdr_lead_state.lead_score` for all leads on the next sync.

- [ ] **Step 1: Pull the workflow** (backup was taken in Task 4 Step 1)

Run: `cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System" && n8nac pull V24E63aEzWXuVBQz`
Expected: `Pulled workflow V24E63aEzWXuVBQz.`

- [ ] **Step 2: Add the new field reads**

In `n8n-workflows/Lead Scoring.workflow.ts`, after the existing `const currentScore = ...` line, add:

```javascript
  const projectValue = Number(leadData['PROJECT_VALUE_KEY']);
  const leadOrigin = String(leadData['6abd1d3e43212a7baf864cd4d2a210add6a96f60'] || '').trim();
```

- [ ] **Step 3: Replace the bid-stage block**

Replace the whole `if (bidStage === 'AGC') { ... } else { scoreBreakdown.bidStage = 0; }` block with:

```javascript
  // Bid Stage Scoring.
  // CM and PB used to pay 0, which put 2,218 leads (31% of the book) permanently at the
  // bottom of a send queue ordered by score. Both are legitimate outreach moments and both
  // have their own sequence: CM opens "saw y'all are handling this one", PB asks "did y'all
  // win this one?". They now pay proportionally to how close the job is to a decision.
  const STAGE_POINTS = { AGC: 50, LBA: 40, CM: 30, PB: 20 };
  score += STAGE_POINTS[bidStage] || 0;
  scoreBreakdown.bidStage = STAGE_POINTS[bidStage] || 0;

  // Project size. Additive rather than a substitute for bid stage: a $5M pre-bid lead
  // should not tie a $5M awarded one. Weights sit between the stage anchors (50/40) and
  // the customer bonus (25), so size is worth about one stage step and never more.
  // An absent or unparseable value scores 0, never the small-project penalty: 25% of the
  // CMD sheet has no value, and unknown size is not evidence of a small job.
  if (Number.isFinite(projectValue) && projectValue > 0) {
    if (projectValue >= 5000000) { score += 40; scoreBreakdown.projectValue = 40; }
    else if (projectValue >= 1000000) { score += 25; scoreBreakdown.projectValue = 25; }
    else if (projectValue < 500000) { score -= 20; scoreBreakdown.projectValue = -20; }
    else { scoreBreakdown.projectValue = 0; }
  } else {
    scoreBreakdown.projectValue = 0;
  }

  // Warmth. A BuildingConnected / iSqFt / ConstructConnect invitation means the GC asked
  // Pro SWPPP to bid the SWPPP scope specifically. Derek's call, 2026-08-03: "score them at
  // 50 to start and leave it." So the origin REPLACES the stage points rather than stacking
  // on them, which lands a bid invite at exactly 50, level with an awarded job. Those rows
  // carry no start date and no value, so the other terms contribute nothing and 50 is the
  // whole score unless the company is already a customer.
  if (leadOrigin === 'Bid Invite') {
    score = score - (STAGE_POINTS[bidStage] || 0) + 50;
    scoreBreakdown.bidStage = 0;
    scoreBreakdown.bidInvite = 50;
  } else {
    scoreBreakdown.bidInvite = 0;
  }
```

- [ ] **Step 4: Push**

Run: `cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System" && n8nac push V24E63aEzWXuVBQz`
Expected: push succeeds.

- [ ] **Step 5: Let it run, then diff against the baseline**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System" && node --input-type=module -e '
import fs from "fs";
const T="3089d0ffb03a7f996c5f10156fd4ebfaad9fca28";
const SCORE="e2b854536230112bff77d6b0ce33bdb49f2916eb", STAGE="7c1852c27664d1118f75660223a6af9e99d10f2c";
const base=new Map(JSON.parse(fs.readFileSync("goal-runs/2026-08-03-lead-value-scoring/baseline-scores.json")).map(r=>[r.id,r]));
let s=0,all=[],p=0;
while(p<40){const j=await (await fetch(`https://api.pipedrive.com/v1/leads?api_token=${T}&start=${s}&limit=500`)).json();
 if(!j.data?.length)break; all.push(...j.data); if(!j.additional_data?.pagination?.more_items_in_collection)break;
 s=j.additional_data.pagination.next_start;p++;}
const g={};
for(const l of all){const st=l[STAGE]||"(none)"; const b=base.get(l.id); if(!b)continue;
 (g[st]=g[st]||[]).push([Number(b.score), Number(l[SCORE])]);}
console.log("stage        n    avg before   avg after");
Object.entries(g).sort((a,b)=>b[1].length-a[1].length).slice(0,7).forEach(([k,v])=>{
 const bb=v.reduce((a,x)=>a+x[0],0)/v.length, aa=v.reduce((a,x)=>a+x[1],0)/v.length;
 console.log(`${k.padEnd(10)} ${String(v.length).padStart(5)}  ${bb.toFixed(1).padStart(10)}  ${aa.toFixed(1).padStart(10)}`);});'
```
Expected: AGC and LBA averages within ±1 of 27.8 and 20.5 (the rebalance is additive, so untouched stages must not move). PB and CM up by roughly their new stage points.

- [ ] **Step 6: Commit**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System"
git add "n8n-workflows/Lead Scoring.workflow.ts"
git commit -m "feat(scoring): pay CM and PB, add project-value tiers and a bid-invite bonus

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Show Project Value and the detected source in the interface

**Files:**
- Modify: `src/lib/leadUploadApi.ts` (upload response type)
- Modify: `src/components/LeadUpload.tsx` (show the mapping banner)
- Modify: `src/components/sdr/` leads table (add the column)

**Model:** `sonnet`

**Interfaces:**
- Consumes: `source` / `renamed` / `injected` from Task 2; `project_value` from Task 5.
- Produces: no downstream interface.

- [ ] **Step 1: Extend the API type**

In `src/lib/leadUploadApi.ts`, change the `uploadLeadsCsv` return type to:

```typescript
export interface UploadResult {
  job_id: string;
  status: LeadImportStatus;
  source?: "cmd" | "bid-aggregator" | "unknown";
  renamed?: string[];
  injected?: string[];
}

export async function uploadLeadsCsv(file: File): Promise<UploadResult> {
```

- [ ] **Step 2: Show the banner after upload**

In `src/components/LeadUpload.tsx`, hold the upload result in state and render this above the progress list when `source === "bid-aggregator"`:

```tsx
{lastUpload?.source === "bid-aggregator" && (
  <div className="border border-amber-200 bg-amber-50 rounded-xl p-3 text-sm text-amber-900">
    <div className="font-semibold">Read as a bid aggregator sheet</div>
    <div className="mt-1">
      Renamed {lastUpload.renamed?.join(", ")}. Filled in{" "}
      {lastUpload.injected?.join(", ")}. Every row is set to Stage CM, which is the bidding
      sequence rather than a congratulations one. Check the rows below before approving.
    </div>
  </div>
)}
```

- [ ] **Step 3: Add the column to the leads table**

Add a `Project Value` column reading `project_value`, formatted with `new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })`, rendering an em-space ` ` when null so a missing value reads as blank rather than `$0`.

- [ ] **Step 4: Build and check for type errors**

Run: `cd swppp-system && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 5: Screenshot both states**

```bash
PW_INSPECT_CONFIG='{"url":"https://derek:dereksystem@swppp-interface-production.up.railway.app/","viewports":[1440],"waitFor":"body"}' \
  node ~/.claude/skills/playwright-driver/templates/inspect.js | tail -n 1 | jq '.console_errors'
```
Expected: `[]`

- [ ] **Step 6: Commit and deploy**

```bash
cd "/Users/ivanmanfredi/Desktop/SWPPP Doc System/swppp-system"
git add src/
git commit -m "feat(ui): surface Project Value and the detected import source

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Deferred, deliberately

- **Start-decay curve.** Reaching -50 makes it the dominant term and it drives the negative third of the book. With three new inputs it is probably too steep, but changing it has its own blast radius and belongs in its own decision.
- **The importer's hardcoded owner.** All three PATCH nodes send `"owner_id": 19499202`, so every imported lead is forced onto Derek, overriding the `SDR_ASSIGN_OWNER` work shipped 2026-08-03. Worth fixing, unrelated to this plan.
- **Phone enrichment.** Apollo already sits in this sub-workflow doing email verification and could return a phone from name + company. Costs credits, so it is Ivan's call.
- **City + State backfill.** 237 of 425 aggregator companies already exist in Pipedrive but only 105 carry an address, so this would fill a quarter of them. Not worth building.
- **Backfilling Project Value onto the 7,185 existing leads.** They predate the column. Only new imports carry it until someone decides otherwise.
