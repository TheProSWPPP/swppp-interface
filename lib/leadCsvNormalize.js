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

/**
 * Which aggregator a bid invitation came from, read off the Quick Link hostname.
 *
 * Derek asked for this 2026-08-04. Milo's tracker is named "Multi Bid BC iSQFT CC" but as of
 * that date all 1,425 links in it point at BuildingConnected, so the other two are set up
 * ahead of rows existing for them.
 *
 * The platform is appended to Lead Origin ("Bid Invite: BuildingConnected") rather than given
 * its own Pipedrive field, so the scorer keeps matching on the "Bid Invite" PREFIX and Derek
 * reads the source in a field he already has. A link we do not recognise, or a row with no
 * link at all (28 of them), stays plain "Bid Invite" rather than guessing.
 */
const PLATFORM_BY_HOST = [
  [/(^|\.)buildingconnected\.com$/, "BuildingConnected"],
  [/(^|\.)isqft\.com$/, "iSqFt"],
  [/(^|\.)constructconnect\.com$/, "ConstructConnect"],
  [/(^|\.)smartbidnet\.com$/, "SmartBid"],
];

export function detectPlatform(quickLink) {
  const raw = String(quickLink || "").trim();
  if (!raw) return null;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const [re, name] of PLATFORM_BY_HOST) if (re.test(host)) return name;
  return null;
}

/** Derek's raw column, kept verbatim so the review screen shows what he typed. */
export const RAW_VALUE_COLUMN = "Confirmed Value";

/**
 * Machine-readable twin of `Confirmed Value`: a bare number, or empty.
 *
 * The n8n PATCH node writes Pipedrive's `Project Value` from this rather than from the raw
 * column, so the only logic left in an n8n expression is `x ? Number(x) : null`. Keeping the
 * parsing here means it is unit-tested, and an unparseable cell degrades to an empty string
 * instead of throwing inside a JSON template and taking the whole request body with it.
 */
export const CLEAN_VALUE_COLUMN = "Project Value";

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
 * Measured on the real July sheet: 1,499 real data rows (the file also carries 497 empty
 * spacer rows, which parseCsv drops), 1,496 with a value, from $2,774 to $464,000,000.
 * Three rows carry the literal text "na" or "No update". Anything not a positive number
 * returns null so the scorer treats it as "unknown size"; returning 0 would hand those
 * rows the sub-$500k penalty.
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
  // A sheet that already carries Lead Origin keeps its own values; only append when absent.
  if (!outHeaders.includes(ORIGIN_COLUMN)) {
    outHeaders.push(ORIGIN_COLUMN);
    injected.push(ORIGIN_COLUMN);
  }
  if (!outHeaders.includes(CLEAN_VALUE_COLUMN)) {
    outHeaders.push(CLEAN_VALUE_COLUMN);
    injected.push(CLEAN_VALUE_COLUMN);
  }

  const origin = ORIGIN_BY_SOURCE[source] || "";
  const rawValueIdx = headers.indexOf(RAW_VALUE_COLUMN);
  const quickLinkIdx = headers.indexOf("Quick Link");
  const width = headers.length;
  const outRows = [outHeaders];
  for (const r of rows.slice(1)) {
    const parsed = rawValueIdx >= 0 ? parseProjectValue(r[rawValueIdx]) : null;
    const platform = source === "bid-aggregator" && quickLinkIdx >= 0 ? detectPlatform(r[quickLinkIdx]) : null;
    const rowOrigin = platform ? `${origin}: ${platform}` : origin;
    const cells = outHeaders.map((col, i) => {
      if (col === CLEAN_VALUE_COLUMN) return parsed === null ? "" : String(parsed);
      if (i < width) return r[i] ?? "";
      if (col === ORIGIN_COLUMN) return rowOrigin;
      return constants[col] ?? "";
    });
    outRows.push(cells);
  }

  return { csv: toCsv(outRows), source, renamed: renamed.sort(), injected };
}
