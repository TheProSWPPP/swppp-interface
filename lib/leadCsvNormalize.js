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

/**
 * Header aliases for a bid-invite sheet, keyed by the canonical column the SUB WF reads.
 * Each header is lowercased and stripped of non-alphanumerics before matching, and the list
 * order is the priority when a sheet carries more than one match ("Primary Email" beats "Email").
 */
const ALIASES = {
  "Winning Bidder": ["company", "companyname", "gc", "generalcontractor", "bidder"],
  "Name": ["contactname", "contact", "name", "estimator", "estimatorname"],
  "Email": ["primaryemail", "email", "contactemail", "emailaddress"],
  "Bid Date": ["biddate", "bid", "biddue", "duedate"],
  "Project Title": ["projecttitle", "project", "projectname", "title"],
  "Quick Link": ["quicklink", "link", "url", "bidlink"],
  "Phone": ["phone", "contactphone", "phonenumber"],
};
export const PLATFORM_COLUMN = "Platform";

const normHeader = (h) => String(h ?? "").replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * canonical column -> index of the header that supplies it (or -1).
 * A header that already has the canonical name always wins, so a sheet with both "Email" and
 * "Primary Email" never ends up with two columns called Email.
 */
function matchColumns(headers) {
  const trimmed = (headers || []).map((h) => String(h ?? "").replace(/^\uFEFF/, "").trim());
  const norm = trimmed.map(normHeader);
  const out = {};
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    let idx = trimmed.indexOf(canonical);
    for (let a = 0; idx < 0 && a < aliases.length; a++) idx = norm.indexOf(aliases[a]);
    out[canonical] = idx;
  }
  out[PLATFORM_COLUMN] = norm.indexOf("platform");
  out.first = norm.indexOf("firstname");
  out.last = norm.indexOf("lastname");
  return out;
}

/** The stage a bid invitation gets. It matches none of AGC/LBA/CM/PB, so no cold sequence applies. */
export const BID_INVITE_STAGE = "Bid Invite";

/**
 * Columns the bid sheet does not have at all, and what to put there.
 *
 * Stage is "Bid Invite" on every bid row (it used to be "CM", which opened a cold-style
 * sequence). The SUB WF only branches on AGC/LBA, pcUK maps only AGC/LBA/CM/PB/OB, and
 * STAGE_TRIGGER maps "Bid Invite" to null, so nothing cold or CMD-driven picks these rows up.
 * A sheet's own Stage column is overridden too: bid invitations have no project stage.
 *
 * Phone / City + State / Start are genuinely absent from the source. Empty is honest;
 * an empty Start also means the scorer's proximity term and its 120-day auto-archive
 * both sit out, which is why Lead Origin carries the weight for this source instead.
 */
const AGGREGATOR_CONSTANTS = {
  "Stage": BID_INVITE_STAGE,
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

/**
 * The Platform column (and a bare short code in a Lead Origin column) -> platform name.
 * Case-insensitive and trimmed. null means "not one of the four", so the caller can refuse it.
 */
const PLATFORM_BY_CODE = {
  bc: "BuildingConnected", buildingconnected: "BuildingConnected",
  cc: "ConstructConnect", constructconnect: "ConstructConnect",
  isqft: "iSqFt", isquarefoot: "iSqFt",
  other: "Other",
};
export function platformFromColumn(value) {
  return PLATFORM_BY_CODE[normHeader(value)] || null;
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

/**
 * Non-blank rows with the record number each came from (1 = first line of the file, blank
 * records counted), so an error can point at the row Derek sees in his spreadsheet.
 */
export function parseCsvRecords(text) {
  const records = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); records.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  return records
    .map((cells, i) => ({ cells, record: i + 1 }))
    .filter((r) => r.cells.some((v) => v && v.trim()));
}

export function parseCsv(text) {
  return parseCsvRecords(text).map((r) => r.cells);
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
 * What a header row has, for refusing the wrong file on the wrong button and naming what is
 * missing. `looksLikeBid` is true when there is no "Winning Bidder" column and there is a
 * Platform column or an email column. The CMD importer needs "Winning Bidder", so a file with
 * an email column and no such column cannot be a CMD sheet, whatever its company header is called.
 */
export function bidSheetColumns(headers) {
  const list = headers || [];
  const m = matchColumns(list);
  const winningBidder = list.some((h) => String(h ?? "").replace(/^\uFEFF/, "").trim() === "Winning Bidder");
  const company = m["Winning Bidder"] >= 0;
  const email = m["Email"] >= 0;
  const platform = m[PLATFORM_COLUMN] >= 0;
  return { company, email, platform, winningBidder, looksLikeBid: !winningBidder && (platform || email) };
}

/**
 * Which sheet is this? Returns "cmd", "bid-aggregator", or "unknown".
 *
 * Deliberately keyed on the columns that DIFFER between the two rather than on
 * filename, which Derek changes month to month. "unknown" is a real answer: an
 * unrecognised file is passed through untouched rather than guessed at.
 *
 * A bid sheet is recognised when there is no "Winning Bidder" column and either
 *   (a) it has exactly Company + Contact Name + Primary Email (the original tracker), or
 *   (b) it has a Platform column plus company and email columns under any of the aliases
 *       above, or
 *   (c) the caller says it is a bid sheet (`kind: "bid_sheet"`, from the upload button) and
 *       company + email are found by alias alone.
 * A contact name is optional (First Name + Last Name, Estimator Name, or none at all).
 * One-argument calls behave as before apart from (b).
 */
export function detectSource(headers, { kind = null } = {}) {
  const list = headers || [];
  const set = new Set(list.map((h) => String(h || "").trim()));
  if (!set.has("Winning Bidder")) {
    if (["Company", "Contact Name", "Primary Email"].every((h) => set.has(h))) return "bid-aggregator";
    const m = matchColumns(list);
    const core = m["Winning Bidder"] >= 0 && m["Email"] >= 0;
    if (core && (m[PLATFORM_COLUMN] >= 0 || kind === "bid_sheet")) return "bid-aggregator";
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

/** First day a bid counts for the follow-up engine. Earlier bids only raise a warning. */
export const DEFAULT_MIN_BID_DATE = "2026-09-01";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_HEAD = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
// An optional time, with an optional "at" or comma before it and an optional zone after it.
const TIME_TAIL = /(?:(?:[\s,]+(?:at\s+)?|T)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[ap]\.?m\.?)?\s*(?:z|utc|gmt|[ecmp][sd]?t|[+-]\d{2}:?\d{2})?)?$/i;

function isoDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && y >= 1900 && y <= 2100)) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A typed bid date -> "YYYY-MM-DD", or null. Accepts M/D/YYYY, M/D/YY, ISO, and "Mon D, YYYY",
 * each with an optional time. The date is read as typed: no time zone shift, so a 11 PM bid
 * stays on its own day.
 */
export function parseBidDate(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  // A bare number is an Excel serial date (days since 1899-12-30; the fraction is the time of day).
  if (/^\d{4,6}(?:\.\d+)?$/.test(v)) {
    const n = Math.floor(Number(v));
    if (n < 20000 || n > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  const bare = v.replace(WEEKDAY_HEAD, "").replace(TIME_TAIL, "").trim();
  let m = bare.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = bare.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) return isoDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = bare.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (m) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return mon ? isoDate(+m[3], mon, +m[2]) : null;
  }
  // 3-Nov-26, 03-Nov-2026, 3 Nov 2026
  m = bare.match(/^(\d{1,2})[-\s]([a-z]{3,9})\.?[-\s,]+(\d{4}|\d{2})$/i);
  if (m) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    return mon ? isoDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon, +m[1]) : null;
  }
  return null;
}

// --- The whole job ---

/**
 * @param {string} csvText
 * @param {{kind?: string|null, minBidDate?: string}} [opts]  `kind` is the upload button
 *        ("bid_sheet" | "project_list"); it only widens bid-sheet header detection.
 * @returns {{csv: string, source: string, renamed: string[], injected: string[],
 *            platforms: Record<string, number>, bidDates: {parsed: number, missing: number, beforeFloor: number},
 *            platformErrors: {row: number, value: string}[], warnings: string[],
 *            bidColumns: ReturnType<typeof bidSheetColumns>}}
 *          `csv` is safe to hand straight to the n8n webhook. `platforms` counts bid rows per
 *          Lead Origin value. `platformErrors` lists rows whose Platform cell is not BC, CC,
 *          ISQFT or Other; `row` is the line the row sits on in the file, blank lines counted.
 *          `bidColumns` says which key columns the header row had, for refusing a file with a
 *          message that names what is missing.
 */
export function normalizeLeadCsv(csvText, { kind = null, minBidDate = DEFAULT_MIN_BID_DATE } = {}) {
  const records = parseCsvRecords(String(csvText || ""));
  const bidColumns = bidSheetColumns(records.length ? records[0].cells : []);
  const base = () => ({
    renamed: [], injected: [], platforms: {}, platformErrors: [], warnings: [], bidColumns,
    bidDates: { parsed: 0, missing: 0, beforeFloor: 0 },
  });
  const floor = /^\d{4}-\d{2}-\d{2}$/.test(String(minBidDate || "")) ? minBidDate : DEFAULT_MIN_BID_DATE;
  if (records.length < 2) {
    const src = records.length ? detectSource(records[0].cells, { kind }) : "unknown";
    return { csv: String(csvText || ""), source: src, ...base() };
  }

  const headers = records[0].cells.map((h) => String(h).replace(/^﻿/, "").trim());
  const source = detectSource(headers, { kind });
  if (source === "unknown") {
    return { csv: String(csvText || ""), source, ...base() };
  }
  const isBid = source === "bid-aggregator";

  const result = base();
  const cols = isBid ? matchColumns(headers) : {};
  const outHeaders = headers.map((h, i) => {
    if (isBid) {
      for (const canonical of Object.keys(ALIASES)) {
        if (cols[canonical] === i && h !== canonical) {
          result.renamed.push(h);
          return canonical;
        }
      }
    }
    return h;
  });

  const constants = isBid ? AGGREGATOR_CONSTANTS : {};
  for (const col of Object.keys(constants)) {
    if (!outHeaders.includes(col)) { outHeaders.push(col); result.injected.push(col); }
  }
  // The importer reads "Name". A sheet with First Name + Last Name, or no contact column, gets one.
  if (isBid && !outHeaders.includes("Name")) { outHeaders.push("Name"); result.injected.push("Name"); }
  // A sheet that already carries Lead Origin keeps its own values; only append when absent.
  if (!outHeaders.includes(ORIGIN_COLUMN)) {
    outHeaders.push(ORIGIN_COLUMN);
    result.injected.push(ORIGIN_COLUMN);
  }
  if (!outHeaders.includes(CLEAN_VALUE_COLUMN)) {
    outHeaders.push(CLEAN_VALUE_COLUMN);
    result.injected.push(CLEAN_VALUE_COLUMN);
  }

  const origin = ORIGIN_BY_SOURCE[source] || "";
  const rawValueIdx = headers.indexOf(RAW_VALUE_COLUMN);
  const quickLinkIdx = isBid ? cols["Quick Link"] : headers.indexOf("Quick Link");
  const platformIdx = isBid ? cols[PLATFORM_COLUMN] : -1;
  const bidDateOut = outHeaders.indexOf("Bid Date");
  const stageOut = outHeaders.indexOf("Stage");
  const originOut = outHeaders.indexOf(ORIGIN_COLUMN);
  const width = headers.length;
  const outRows = [outHeaders];
  for (const { cells: r, record } of records.slice(1)) {
    const parsed = rawValueIdx >= 0 ? parseProjectValue(r[rawValueIdx]) : null;
    const cells = outHeaders.map((col, i) => {
      if (col === CLEAN_VALUE_COLUMN) return parsed === null ? "" : String(parsed);
      if (i < width) return r[i] ?? "";
      if (col === ORIGIN_COLUMN) return origin;
      if (col === "Name") return [r[cols.first], r[cols.last]].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
      return constants[col] ?? "";
    });

    if (isBid) {
      // Platform column first, then a bare short code already in Lead Origin, then the link domain.
      const own = String(cells[originOut] ?? "").trim();
      let platform = null;
      const typed = platformIdx >= 0 ? String(r[platformIdx] ?? "").trim() : "";
      if (typed) {
        platform = platformFromColumn(typed);
        if (!platform) result.platformErrors.push({ row: record, value: typed });
      }
      const fullTag = own.match(/^bid invite\s*:\s*(.*)$/i);
      if (fullTag) {
        // Already tagged: tidy the case and spacing so every guard and check sees "Bid Invite: <Platform>".
        const part = fullTag[1].trim();
        const canonical = platformFromColumn(part) || (/^smartbid$/i.test(part) ? "SmartBid" : part);
        cells[originOut] = canonical ? `${origin}: ${canonical}` : origin;
      } else if (/^bid invite$/i.test(own) || !own) {
        if (platform) cells[originOut] = `${origin}: ${platform}`;
        else {
          const fromLink = quickLinkIdx >= 0 ? detectPlatform(r[quickLinkIdx]) : null;
          cells[originOut] = fromLink ? `${origin}: ${fromLink}` : origin;
        }
      } else if (platform) {
        cells[originOut] = `${origin}: ${platform}`;
      } else {
        const fromCode = platformFromColumn(own);
        // Any other value (e.g. "CMD") stays as typed; checkUploadKind refuses the file.
        if (fromCode) cells[originOut] = `${origin}: ${fromCode}`;
      }
      cells[stageOut] = BID_INVITE_STAGE;

      const iso = bidDateOut >= 0 ? parseBidDate(cells[bidDateOut]) : null;
      if (iso) {
        cells[bidDateOut] = iso;
        result.bidDates.parsed++;
        if (iso < floor) result.bidDates.beforeFloor++;
      } else {
        result.bidDates.missing++;
      }
      const o = cells[originOut];
      result.platforms[o] = (result.platforms[o] || 0) + 1;
    }
    outRows.push(cells);
  }

  if (isBid) {
    const { missing, beforeFloor } = result.bidDates;
    if (missing) result.warnings.push(`${missing} ${missing === 1 ? "row has" : "rows have"} no readable bid date.`);
    if (beforeFloor) result.warnings.push(`${beforeFloor} ${beforeFloor === 1 ? "row has" : "rows have"} a bid date before ${floor}.`);
  }

  return { csv: toCsv(outRows), source, ...result, renamed: result.renamed.sort() };
}
