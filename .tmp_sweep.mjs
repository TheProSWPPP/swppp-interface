import pg from 'pg';
import * as pd from './lib/pipedriveClient.js';
import { sweepSentOutreach } from './lib/outreachSync.js';

// Runs 1 and 2 both died on "read ETIMEDOUT" about 24 minutes in. This run records where:
// which call was in flight, and how long since the last page and the last query came back.
const pool = new pg.Pool({ connectionString: process.env.SWAP_DB, max: 2, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
const clean = error => String(error?.message || error).replace(/[0-9a-f]{40}/g, '<HEX40>').replace(/postgres:\/\/\S+/g, '<DB>').slice(0, 300);
const started = Date.now();
const at = () => Math.round((Date.now() - started) / 1000);
const seen = { pages: 0, start: 0, items: 0, queries: 0, inFlight: 'none', since: Date.now(), lastPageAt: 0, lastQueryAt: 0, slowPageMs: 0, slowQueryMs: 0, more: null };
const where = () => JSON.stringify({ ...seen, since: undefined, inFlightSeconds: Math.round((Date.now() - seen.since) / 1000), at: at() });
pool.on('error', error => console.log('pool error:', clean(error), where()));
process.on('uncaughtException', error => { console.log('uncaught:', clean(error), where()); process.exit(1); });
const client = {
  listMailThreads: async args => {
    seen.inFlight = 'pipedrive'; seen.since = Date.now(); seen.start = args.start;
    const answer = await pd.listMailThreads(args);
    seen.slowPageMs = Math.max(seen.slowPageMs, Date.now() - seen.since);
    seen.pages++; seen.items += answer.data.length; seen.lastPageAt = at(); seen.more = answer.pagination?.more_items_in_collection ?? null;
    seen.inFlight = 'none'; seen.since = Date.now();
    if (seen.pages % 25 === 0) console.log('page', where());
    return answer;
  },
};
const watched = {
  connect: async () => {
    const db = await pool.connect();
    const query = db.query.bind(db);
    db.query = async (...args) => {
      seen.inFlight = 'db'; seen.since = Date.now();
      try { return await query(...args); }
      finally { seen.slowQueryMs = Math.max(seen.slowQueryMs, Date.now() - seen.since); seen.queries++; seen.lastQueryAt = at(); seen.inFlight = 'none'; seen.since = Date.now(); }
    };
    db.on('error', error => console.log('client error:', clean(error), where()));
    return db;
  },
};
try {
  const before = await pool.query('SELECT last_swept_at, last_thread_ts, backfilled_at FROM sdr_outreach_sweep_state WHERE id = 1');
  console.log('before', JSON.stringify(before.rows[0] ?? null));
  const result = await sweepSentOutreach(watched, { full: true, client, onLock: held => console.log('lock', held) });
  console.log('result', JSON.stringify(result), 'seconds', at());
  const after = await pool.query('SELECT last_swept_at, last_thread_ts, backfilled_at FROM sdr_outreach_sweep_state WHERE id = 1');
  console.log('after', JSON.stringify(after.rows[0] ?? null));
} catch (error) {
  console.log('sweep failed:', clean(error), where());
} finally {
  await pool.end().catch(() => {});
}
