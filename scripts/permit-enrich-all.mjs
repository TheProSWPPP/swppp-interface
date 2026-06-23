#!/usr/bin/env node
// Whole-pool TCEQ enrichment: give every TX operator at least one mailing address.
//
//   node scripts/permit-enrich-all.mjs [cap] [--phones]
//
// Selects one best permit per operator that has NO enriched permit yet (hottest first)
// and scrapes its TCEQ wq_dpa detail. Sequential with polite pacing so TCEQ doesn't
// throttle. Idempotent: re-running only picks up operators still missing an address.
//
// By default does TCEQ only (free, no API keys). Pass --phones to also auto-fill phones
// for the operators it enriches (needs APOLLO_API_KEY + GEMINI_API_KEY) — for the big
// one-time backfill prefer running scripts/permit-phones.mjs as a separate monitored pass.
//
// Needs DATABASE_URL (use the PUBLIC Railway URL when running locally).

import pg from "pg";
import { pathToFileURL } from "url";
import { enrichBatch } from "../lib/permitEnrich.js";

async function main() {
  const cap = Math.max(1, parseInt(process.argv[2], 10) || 6000);
  const phoneFind = process.argv.includes("--phones");
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) { console.error("DATABASE_URL not set"); process.exit(1); }
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  console.log(`Full TCEQ enrich (scope=all, cap ${cap}, phones=${phoneFind})...`);
  const r = await enrichBatch(pool, { cap, scope: "all", phoneFind });
  console.log(`Processed ${r.processed}: ${r.ok} enriched, ${r.fail} failed.`);
  if (r.phones) console.log(`Phones: ${r.phones.apollo} Apollo, ${r.phones.gemini} Gemini, ${r.phones.none} none.`);
  const tot = await pool.query(`SELECT count(DISTINCT operator_key)::int n FROM permit_facilities f
    WHERE f.state='TX' AND EXISTS (SELECT 1 FROM permit_enrichment e JOIN permit_facilities ff ON ff.external_permit_nmbr=e.external_permit_nmbr WHERE ff.operator_key=f.operator_key)`);
  console.log(`Operators with an address now: ${tot.rows[0].n}`);
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
