import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DBU, ssl:{rejectUnauthorized:false} });
const c = await pool.connect();
const before = await c.query(`select email, warmup_started_at from sdr_mailboxes where id='f116cc48-c5f7-481c-bcab-8938ccdcd7a5'`);
console.log("before:", JSON.stringify(before.rows[0]));
await c.query(`update sdr_mailboxes set warmup_started_at = null where id='f116cc48-c5f7-481c-bcab-8938ccdcd7a5'`);
const after = await c.query(`select email, warmup_started_at from sdr_mailboxes where id='f116cc48-c5f7-481c-bcab-8938ccdcd7a5'`);
console.log("after :", JSON.stringify(after.rows[0]));
c.release(); await pool.end();
