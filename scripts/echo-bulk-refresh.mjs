// Bulk ECHO compliance refresh via EPA ZIP download (avoids per-permit API rate caps).
//
// REQUIREMENTS:
//   - `unzip` must be installed and on PATH (used to extract the EPA ZIP archive).
//   - DATABASE_URL must be the Railway public URL (ssl:rejectUnauthorized=false).
//
// Usage:
//   DATABASE_URL=<railway-public-url> node scripts/echo-bulk-refresh.mjs
//
// What it does:
//   1. Downloads https://echo.epa.gov/files/echodownloads/npdes_downloads.zip to /tmp
//   2. Unzips NPDES_QNCR_HISTORY.csv + NPDES_INSPECTIONS.csv (shell: `unzip`)
//   3. Streams both CSVs via readline; maps NPDES_ID → compliance pain using the same
//      logic as lib/echoCompliance.js (QNCR HLRNC codes, YEARQTR>=20251, inspections>=2023)
//   4. Bulk-UPDATEs permit_facilities (compliance_flags + score) via unnest
//   5. Refreshes permit_operators.best_score

import pg from "pg";
import https from "node:https";
import fs from "node:fs";
import { execFile } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { compliancePain } from "../lib/echoCompliance.js";
import { scoreFacility } from "../lib/permitScoring.js";

const ZIP_URL = "https://echo.epa.gov/files/echodownloads/npdes_downloads.zip";
const ZIP_PATH = "/tmp/echo_npdes_downloads.zip";
const EXTRACT_DIR = "/tmp/echo_npdes_extract";

// ── Download helpers ────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) =>
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // follow redirect
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      }).on("error", reject);
    get(url);
  });
}

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile(
      "unzip",
      ["-o", "-j", zipPath, "NPDES_QNCR_HISTORY.csv", "NPDES_INSPECTIONS.csv", "-d", destDir],
      { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`unzip failed: ${stderr || err.message}`));
        resolve();
      }
    );
  });
}

// ── CSV line parser (handles quoted fields) ─────────────────────────────────

function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

async function streamCsv(filePath, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = true; continue; } // skip header row
    if (line.trim()) onRow(parseCsvLine(line));
  }
}

// ── Compliance aggregation ─────────────────────────────────────────────────
// QNCR columns: col0=NPDES_ID, col1=YEARQTR, col2=HLRNC
// INSPECTIONS columns: col1=NPDES_ID, col8=ACTUAL_END_DATE
// HLRNC codes: S/D/E/V = any noncompliance; S/D/E = significant

const SIGNIFICANT_HLRNC = new Set(["S", "D", "E"]);
const ANY_HLRNC = new Set(["S", "D", "E", "V"]);

async function buildComplianceMap(qncrPath, inspPath) {
  // Map: NPDES_ID → { vioLast4Q, sv, cv, insp }
  const map = new Map();

  const getOrCreate = (id) => {
    if (!map.has(id)) map.set(id, { sv: 0, cv: 0, vioLast4Q: 0, insp: 0 });
    return map.get(id);
  };

  // QNCR — YEARQTR >= 20251 (recent quarters)
  await streamCsv(qncrPath, (cols) => {
    const id = (cols[0] || "").trim();
    const yearqtr = parseInt(cols[1] || "0", 10);
    const hlrnc = (cols[2] || "").trim().toUpperCase();
    if (!id || !hlrnc) return;
    const rec = getOrCreate(id);
    if (ANY_HLRNC.has(hlrnc)) {
      rec.cv++;
      if (yearqtr >= 20251) rec.vioLast4Q++;
    }
    if (SIGNIFICANT_HLRNC.has(hlrnc)) rec.sv++;
  });

  // INSPECTIONS — ACTUAL_END_DATE year >= 2023
  await streamCsv(inspPath, (cols) => {
    const id = (cols[1] || "").trim();
    const dateStr = (cols[8] || "").trim();
    if (!id || !dateStr) return;
    const year = parseInt(dateStr.slice(0, 4), 10);
    if (year >= 2023) getOrCreate(id).insp++;
  });

  return map;
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function runEchoBulkRefresh({ pool: injectedPool } = {}) {
  const ownPool = !injectedPool;
  if (ownPool && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set (use Railway public URL)");
  }

  const pool = injectedPool || new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // 1. Fetch all TX permit_facilities we care about
    console.log("Loading TX permit pool from DB...");
    const { rows: facilities } = await pool.query(
      `SELECT f.external_permit_nmbr, f.original_issue_date,
              COALESCE(o.facility_count, 1) AS facility_count
         FROM permit_facilities f
         LEFT JOIN permit_operators o USING (operator_key)
        WHERE f.state = 'TX'`
    );
    console.log(`  ${facilities.length} TX facilities loaded`);

    // Build a Set of NPDES IDs we care about (for fast lookup)
    const ourIds = new Set(facilities.map((r) => r.external_permit_nmbr));

    // 2. Download ZIP
    console.log(`Downloading ${ZIP_URL} ...`);
    await downloadFile(ZIP_URL, ZIP_PATH);
    const zipSizeMb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
    console.log(`  Downloaded ${zipSizeMb} MB → ${ZIP_PATH}`);

    // 3. Extract CSVs
    console.log("Extracting NPDES_QNCR_HISTORY.csv + NPDES_INSPECTIONS.csv ...");
    await unzip(ZIP_PATH, EXTRACT_DIR);
    console.log("  Extracted.");

    const qncrPath = `${EXTRACT_DIR}/NPDES_QNCR_HISTORY.csv`;
    const inspPath = `${EXTRACT_DIR}/NPDES_INSPECTIONS.csv`;

    // 4. Build compliance map
    console.log("Streaming CSVs to build compliance map...");
    const complianceMap = await buildComplianceMap(qncrPath, inspPath);
    console.log(`  ${complianceMap.size} NPDES IDs found in compliance data`);

    // 5. Compute updates for our permits
    const permitKeys = [];
    const flagsArr = [];
    const scoreArr = [];

    for (const fac of facilities) {
      const id = fac.external_permit_nmbr;
      if (!ourIds.has(id)) continue;
      const counts = complianceMap.get(id) || { sv: 0, cv: 0, vioLast4Q: 0, insp: 0 };
      const pain = compliancePain(counts);
      const score = scoreFacility({
        original_issue_date: fac.original_issue_date
          ? String(fac.original_issue_date).slice(0, 10)
          : null,
        facility_count: fac.facility_count,
        compliance_pain: pain,
      });
      permitKeys.push(id);
      flagsArr.push(JSON.stringify({ ...counts, pain }));
      scoreArr.push(score);
    }

    console.log(`Updating ${permitKeys.length} facilities in DB...`);

    // 6. Bulk UPDATE via unnest
    await pool.query(
      `UPDATE permit_facilities AS pf
          SET compliance_flags = u.flags::jsonb,
              score = u.score,
              updated_at = NOW()
         FROM unnest($1::text[], $2::text[], $3::float8[]) AS u(permit_nmbr, flags, score)
        WHERE pf.external_permit_nmbr = u.permit_nmbr`,
      [permitKeys, flagsArr, scoreArr]
    );
    console.log("  permit_facilities updated.");

    // 7. Refresh best_score in permit_operators
    await pool.query(
      `UPDATE permit_operators o
          SET best_score = s.mx, updated_at = NOW()
         FROM (SELECT operator_key, MAX(score) AS mx FROM permit_facilities GROUP BY operator_key) s
        WHERE o.operator_key = s.operator_key`
    );
    console.log("  permit_operators.best_score refreshed.");

    const withPain = flagsArr.filter((f) => {
      try { return JSON.parse(f).pain > 0; } catch { return false; }
    }).length;
    console.log(`Done: ${permitKeys.length} facilities updated, ${withPain} with compliance pain > 0.`);
    return { updated: permitKeys.length, withPain };
  } finally {
    if (ownPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEchoBulkRefresh().catch((e) => { console.error(e); process.exit(1); });
}
