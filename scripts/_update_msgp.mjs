// One-off: update the live permit_msgp_template body (blue Georgia + Derek sig).
// Reads scripts/_msgp_body.html. DBURL from env.
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const body = readFileSync(join(__dir, "_msgp_body.html"), "utf8").trim();
const subject = "Action needed: your TXR050000 stormwater permit expires Aug 13";

const pool = new pg.Pool({
  connectionString: process.env.DBURL,
  ssl: { rejectUnauthorized: false },
});

try {
  const r = await pool.query(
    `UPDATE permit_msgp_template
       SET subject = $1, body_html = $2, updated_at = NOW()
     WHERE id = 1
     RETURNING subject, length(body_html) AS body_len, updated_at`,
    [subject, body]
  );
  console.log("Updated:", JSON.stringify(r.rows[0], null, 2));
} catch (e) {
  console.error("ERR:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
