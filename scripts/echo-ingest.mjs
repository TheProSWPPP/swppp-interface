// Pull EPA ECHO CWA compliance per permit, fold "compliance pain" into score.
// Usage: DATABASE_URL=<railway-public-url> node scripts/echo-ingest.mjs [limit]
import pg from "pg";
import { pathToFileURL } from "node:url";
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
  let done = 0, withPain = 0, skipped = 0;
  for (const row of rows) {
    const counts = parseEchoSummary(await fetchEcho(row.external_permit_nmbr));
    // ECHO error or fetch failure (incl. throttling): leave the existing row UNTOUCHED.
    // Overwriting with zeros would silently wipe real violation data + reset the score.
    if (counts.error) {
      skipped++;
      if (skipped >= 10) { log(`  aborting: ${skipped} consecutive ECHO errors (likely throttled — 300/hr, 1500/day)`); break; }
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      continue;
    }
    skipped = 0;
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
  await pool.query(
    `UPDATE permit_operators o
        SET best_score = s.mx, updated_at = NOW()
       FROM (SELECT operator_key, MAX(score) AS mx FROM permit_facilities GROUP BY operator_key) s
      WHERE o.operator_key = s.operator_key`
  );
  return { processed: done, withPain, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set (use Railway public URL)");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const limit = parseInt(process.argv[2] || "0", 10);
  runEchoRefresh(pool, { limit, log: (m) => process.stdout.write(m + "\r") })
    .then((r) => { console.log(`\nECHO refresh done: ${JSON.stringify(r)}`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
