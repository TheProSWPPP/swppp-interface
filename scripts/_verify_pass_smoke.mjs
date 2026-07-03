// scripts/_verify_pass_smoke.mjs
// DATABASE_URL=... NEVERBOUNCE_API_KEY=... EMAIL_VERIFY_PROVIDER=neverbounce \
// PIPEDRIVE_API_TOKEN=... APOLLO_API_KEY=... node scripts/_verify_pass_smoke.mjs
import pg from "pg";
import { runVerificationPass } from "../lib/emailVerifyRefresh.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const stats = await runVerificationPass(pool, { cap: 3, limit: 5 }); // tiny: ≤5 leads, ≤3 Apollo lookups
console.log("RESULT", stats);
await pool.end();
