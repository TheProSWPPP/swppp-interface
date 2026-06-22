// Enrich ONE representative facility per violation-tier (pain>=12) operator that
// doesn't already have an enriched facility. Gives every hot operator a mailing
// address for the operator-deduped direct-mail CSV, without scraping all facilities.
// Reuses the blessed enrichOne (TCEQ scrape + parse + DB write). DBURL from env.
import pg from "pg";
import { enrichOne } from "../lib/permitEnrich.js";

const pool = new pg.Pool({
  connectionString: process.env.DBURL,
  ssl: { rejectUnauthorized: false },
});

// Top-score promoted facility per hot operator that has zero enriched facilities.
const { rows } = await pool.query(`
  WITH hot AS (
    SELECT operator_key
      FROM permit_facilities
     WHERE operator_key IS NOT NULL
     GROUP BY operator_key
    HAVING COALESCE(MAX((compliance_flags->>'pain')::int),0) >= 12
       AND BOOL_OR(status='enriched') = false
  )
  SELECT DISTINCT ON (f.operator_key) f.operator_key, f.external_permit_nmbr
    FROM permit_facilities f
    JOIN hot h ON h.operator_key = f.operator_key
   WHERE f.status='promoted'
   ORDER BY f.operator_key, f.score DESC
`);

console.log(`Enriching ${rows.length} hot operators (one facility each)...`);
let ok = 0, fail = 0;
for (let i = 0; i < rows.length; i++) {
  try {
    const res = await enrichOne(pool, rows[i].external_permit_nmbr);
    res.ok ? ok++ : fail++;
  } catch (e) {
    fail++;
  }
  if ((i + 1) % 25 === 0 || i === rows.length - 1) {
    console.log(`  ${i + 1}/${rows.length}  ok=${ok} fail=${fail}`);
  }
  if (i < rows.length - 1) await new Promise((r) => setTimeout(r, 800));
}
console.log(`DONE ok=${ok} fail=${fail}`);
await pool.end();
