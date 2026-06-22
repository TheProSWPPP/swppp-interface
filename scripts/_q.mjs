// Ad-hoc query helper. Usage: node scripts/_q.mjs "SQL"
// Reads DBURL from env. SSL relaxed for Railway public proxy.
import pg from "pg";

const sql = process.argv[2];
if (!sql) { console.error("usage: node scripts/_q.mjs \"SQL\""); process.exit(1); }

const pool = new pg.Pool({
  connectionString: process.env.DBURL,
  ssl: { rejectUnauthorized: false },
});

try {
  const r = await pool.query(sql);
  console.log(JSON.stringify(r.rows, null, 2));
} catch (e) {
  console.error("ERR:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
