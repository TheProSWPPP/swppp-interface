// Ingest active TXR050000 NOI permittees from EPA Envirofacts into Postgres.
// Usage: DATABASE_URL=<railway-public-url> node scripts/permit-ingest.mjs
import pg from "pg";
import { pathToFileURL } from "node:url";
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
    n++;
  }

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
  return { raw: rawTotal, facilities: n, operators: Object.keys(counts).filter(Boolean).length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set (use Railway public URL)");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  runPermitIngest(pool, { log: (m) => process.stdout.write(m + "\r") })
    .then((r) => { console.log(`\nDone: ${JSON.stringify(r)}`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
