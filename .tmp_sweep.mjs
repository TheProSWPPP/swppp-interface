import pg from 'pg';
import { sweepSentOutreach } from './lib/outreachSync.js';

const pool = new pg.Pool({ connectionString: process.env.SWAP_DB, max: 2 });
try {
  const before = await pool.query('SELECT last_swept_at, last_thread_ts, backfilled_at FROM sdr_outreach_sweep_state WHERE id = 1');
  console.log('before', JSON.stringify(before.rows[0] ?? null));
  const started = Date.now();
  const result = await sweepSentOutreach(pool, { full: true, onLock: held => console.log('lock', held) });
  console.log('result', JSON.stringify(result), 'seconds', Math.round((Date.now() - started) / 1000));
  const after = await pool.query('SELECT last_swept_at, last_thread_ts, backfilled_at FROM sdr_outreach_sweep_state WHERE id = 1');
  console.log('after', JSON.stringify(after.rows[0] ?? null));
} catch (error) {
  console.log('sweep failed:', String(error?.message || error).replace(/[0-9a-f]{40}/g, '<HEX40>').slice(0, 300));
} finally {
  await pool.end();
}
