#!/usr/bin/env node
// Repeatable phone enrichment for permit operators (Derek's call/mail list).
//
//   node scripts/permit-phones.mjs [cap]
//
// Fills phones for addressable TX operators that don't have one yet (hottest first),
// using Apollo /organizations/enrich by known domain, falling back to Gemini grounded
// Google Search by company name + city. Persists to permit_operator_phone. Idempotent
// and capped, so re-running only tops up and never re-spends on solved operators.
//
// Needs env: DATABASE_URL (use the PUBLIC Railway URL when running locally), APOLLO_API_KEY,
// GEMINI_API_KEY. From the repo on Railway these are already set; locally pass
// DATABASE_URL=<public url> and run via `railway run` for the API keys.

import pg from "pg";
import { pathToFileURL } from "url";
import { findPhonesForOperators } from "../lib/permitPhoneFind.js";

async function main() {
  const cap = Math.max(1, parseInt(process.argv[2], 10) || 400);
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) { console.error("DATABASE_URL not set"); process.exit(1); }
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  console.log(`Finding phones (cap ${cap})...`);
  const r = await findPhonesForOperators(pool, { cap });
  console.log(`Checked ${r.checked}: ${r.apollo} via Apollo, ${r.gemini} via Gemini, ${r.none} none.`);
  const tot = await pool.query(`SELECT count(*)::int n, count(*) FILTER (WHERE source='gemini_grounded')::int gem FROM permit_operator_phone WHERE phone<>''`);
  console.log(`Total phones stored: ${tot.rows[0].n} (${tot.rows[0].gem} web-sourced via Gemini).`);
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
