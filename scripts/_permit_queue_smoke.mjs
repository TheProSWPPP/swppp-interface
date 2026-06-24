// SAFE smoke test: exercise generatePermitDrafts against prod (NO Apollo, NO send,
// NO credit cost), print the rendered drafts, then DELETE the test rows. Env: DATABASE_URL.
import pg from "pg";
import { ensurePermitDraftSchema, generatePermitDrafts } from "../lib/permitDrafts.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

await ensurePermitDraftSchema(pool);
const before = (await pool.query(`SELECT count(*)::int n FROM permit_drafts`)).rows[0].n;
console.log(`permit_drafts before: ${before}`);

const res = await generatePermitDrafts(pool, { cap: 3 });
console.log("generate result:", JSON.stringify(res));

const { rows } = await pool.query(
  `SELECT id, operator_name, contact_name, email, assigned_email, apollo_sequence_id, subject, body
     FROM permit_drafts ORDER BY created_at DESC LIMIT $1`,
  [Math.max(res.created, 0)],
);
for (const r of rows) {
  console.log(`\n=== ${r.operator_name} → ${r.email} (${r.contact_name || "no name"})  from: ${r.assigned_email || "(no mailbox enabled → default sig)"}  seq: ${r.apollo_sequence_id || "none"}`);
  console.log(`SUBJECT: ${r.subject}`);
  console.log(`BODY:\n${r.body}`);
}

// Clean up the test rows so prod is left untouched.
const ids = rows.map((r) => r.id);
if (ids.length) await pool.query(`DELETE FROM permit_drafts WHERE id = ANY($1)`, [ids]);
const after = (await pool.query(`SELECT count(*)::int n FROM permit_drafts`)).rows[0].n;
console.log(`\nCleaned up ${ids.length} test drafts. permit_drafts after: ${after}`);

await pool.end();
