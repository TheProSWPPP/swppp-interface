import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import { sweepSentOutreach } from '../outreachSync.js';

// The sent-folder sweep feeds sdr_outreach_log, the record of hand emails per lead. The company
// swap (lib/sdrCompanySwap.js) trusts that record only when the sweep says it is whole.
const db = reportingTestDb('outreach_sweep');

// A sent folder of `count` threads, newest first, one lead each, an hour apart.
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const folder = (count, { newestAt = NOW } = {}) => Array.from({ length: count }, (_, i) => ({
  id: 1000 + i, lead_id: `lead-${i}`, subject: `Thread ${i}`,
  last_message_sent_timestamp: new Date(newestAt - i * 3600 * 1000).toISOString(),
  parties: { from: [{ name: 'Derek', email_address: 'dc@proswppp.com', latest_sent: true }] },
}));
// Pipedrive's paging, as read from the live sent folder: every page says whether more follow,
// and the last one has no next_start.
//   paging(page, start): replaces the pagination block; beforePage(state, threads): runs before a
//   page is served, to play a change to the folder (or a pause) in the middle of a sweep.
const mailbox = (threads, { paging = null, beforePage = null } = {}) => {
  const state = { pages: 0, starts: [] };
  return { state, client: { listMailThreads: async ({ start = 0, limit = 100 } = {}) => {
    state.pages++; state.starts.push(start);
    await beforePage?.(state, threads);
    const data = threads.slice(start, start + limit);
    const more = start + limit < threads.length;
    const pagination = { start, limit, more_items_in_collection: more, next_start: more ? start + limit : null };
    return { data, pagination: paging ? paging(pagination, start) : pagination };
  } } };
};

describe.skipIf(!db)('sent-folder sweep completeness', () => {
  const q = (text, params) => db.pool.query(text, params);
  const ledger = async () => (await q('SELECT pipedrive_lead_id FROM sdr_outreach_log')).rows.map(r => r.pipedrive_lead_id);
  const stateRow = async () => (await q('SELECT last_thread_ts, backfilled_at FROM sdr_outreach_sweep_state WHERE id = 1')).rows[0];

  beforeAll(async () => {
    await db.setup();
    await q(`CREATE TABLE sdr_outreach_log(pipedrive_lead_id text NOT NULL,source text NOT NULL,sent_at timestamptz NOT NULL,sender_name text,
        sender_email text,subject text,external_ref text,updated_at timestamptz NOT NULL DEFAULT NOW(),PRIMARY KEY(pipedrive_lead_id,source));
      CREATE TABLE sdr_outreach_sweep_state(id int PRIMARY KEY DEFAULT 1 CHECK(id = 1),last_swept_at timestamptz,last_thread_ts timestamptz,
        backfilled_at timestamptz)`);
  });
  afterAll(async () => await db.close());
  beforeEach(async () => {
    await q('TRUNCATE sdr_outreach_log, sdr_outreach_sweep_state');
    await q('INSERT INTO sdr_outreach_sweep_state(id) VALUES(1)');
  });

  // Pages overlap by 10 threads, so 250 threads are 3 pages (from 0, 90, 180) and 270 reads.
  it('a first sweep that reads the folder to its end leaves a whole ledger', async () => {
    const { client, state } = mailbox(folder(250));
    expect(await sweepSentOutreach(db.pool, { client })).toMatchObject({ scanned: 270, leadsUpserted: 270, undated: 0, complete: true, backfilled: true });
    expect(state.starts).toEqual([0, 90, 180]);
    expect(await ledger()).toHaveLength(250);
    expect((await stateRow()).backfilled_at).not.toBeNull();
  });

  it('an incremental sweep stops at the watermark and keeps the ledger whole', async () => {
    const threads = folder(250);
    await sweepSentOutreach(db.pool, { client: mailbox(threads).client });
    const newer = [{ ...folder(1, { newestAt: NOW + 3600 * 1000 })[0], id: 1, lead_id: 'lead-new' }, ...threads];
    const { client, state } = mailbox(newer);
    expect(await sweepSentOutreach(db.pool, { client })).toMatchObject({ complete: true, backfilled: true });
    expect(state.pages).toBe(1);
    expect(await ledger()).toContain('lead-new');
  });

  // A sweep that stops at its page cap still moves the watermark, so the next incremental
  // sweep reaches that watermark at once and never reads the older threads.
  it('a sweep stopped at its page cap leaves the ledger unverified until a full sweep finishes', async () => {
    const threads = folder(250);
    const capped = await sweepSentOutreach(db.pool, { client: mailbox(threads).client, maxPages: 1 });
    expect(capped).toMatchObject({ scanned: 100, complete: false, backfilled: false });
    expect((await stateRow()).last_thread_ts).not.toBeNull();
    expect(await ledger()).not.toContain('lead-240');

    const next = await sweepSentOutreach(db.pool, { client: mailbox(threads).client });
    expect(next).toMatchObject({ complete: true, backfilled: false });
    expect(await ledger()).not.toContain('lead-240');

    const full = await sweepSentOutreach(db.pool, { client: mailbox(threads).client, full: true });
    expect(full).toMatchObject({ scanned: 270, complete: true, backfilled: true });
    expect(await ledger()).toContain('lead-240');
    expect(await sweepSentOutreach(db.pool, { client: mailbox(threads).client })).toMatchObject({ complete: true, backfilled: true });
  });

  it('a capped sweep after a whole one marks the ledger unverified again', async () => {
    const threads = folder(250);
    await sweepSentOutreach(db.pool, { client: mailbox(threads).client });
    const later = folder(450, { newestAt: NOW + 400 * 3600 * 1000 });
    expect(await sweepSentOutreach(db.pool, { client: mailbox(later).client, maxPages: 2 })).toMatchObject({ complete: false, backfilled: false });
    expect((await stateRow()).backfilled_at).toBeNull();
    expect(await sweepSentOutreach(db.pool, { client: mailbox(later).client })).toMatchObject({ complete: true, backfilled: false });
  });

  it('a full sweep stopped at its page cap is not a backfill', async () => {
    expect(await sweepSentOutreach(db.pool, { client: mailbox(folder(250)).client, full: true, maxPages: 2 })).toMatchObject({ complete: false, backfilled: false });
    expect((await stateRow()).backfilled_at).toBeNull();
  });

  it('a sweep that fails leaves the watermark and the backfill mark as they were', async () => {
    await sweepSentOutreach(db.pool, { client: mailbox(folder(50)).client });
    const before = await stateRow();
    await expect(sweepSentOutreach(db.pool, { client: { listMailThreads: async () => { throw new Error('Pipedrive unreachable'); } } })).rejects.toThrow('Pipedrive unreachable');
    expect(await stateRow()).toEqual(before);
    // And the next run is not locked out.
    expect(await sweepSentOutreach(db.pool, { client: mailbox(folder(50)).client })).toMatchObject({ complete: true, backfilled: true });
  });

  it('an empty folder that says it has ended is a whole ledger', async () => {
    expect(await sweepSentOutreach(db.pool, { client: mailbox([]).client })).toMatchObject({ scanned: 0, complete: true, backfilled: true });
  });

  // Only Pipedrive's own "no more pages" ends the folder. Anything short of that leaves the
  // rest unread, and the run says so.
  const unclear = {
    'no pagination block at all': () => undefined,
    'an empty pagination block': () => ({}),
    'no word on whether more follow': p => ({ ...p, more_items_in_collection: undefined }),
    'more pages promised with no next start': p => ({ ...p, more_items_in_collection: true, next_start: null }),
    'more pages promised from where this one began': (p, start) => ({ ...p, more_items_in_collection: true, next_start: start }),
    'more pages promised from an earlier start': (p, start) => ({ ...p, more_items_in_collection: true, next_start: start - 50 }),
    'a next start that is not a number': p => ({ ...p, more_items_in_collection: true, next_start: 'abc' }),
  };
  for (const [what, paging] of Object.entries(unclear)) {
    it(`a page with ${what} is not the end of the folder`, async () => {
      const { client, state } = mailbox(folder(60), { paging });
      expect(await sweepSentOutreach(db.pool, { client })).toMatchObject({ scanned: 60, complete: false, backfilled: false });
      expect(state.pages).toBe(1);
      expect((await stateRow()).backfilled_at).toBeNull();
    });
  }
  it('an empty page that promises more is not the end of the folder', async () => {
    // Pipedrive keeps saying more follow and hands out empty pages: the sweep runs to its cap.
    const paging = (p, start) => ({ ...p, more_items_in_collection: true, next_start: start + 100 });
    const { client, state } = mailbox([], { paging });
    expect(await sweepSentOutreach(db.pool, { client, maxPages: 4 })).toMatchObject({ scanned: 0, complete: false, backfilled: false });
    expect(state.pages).toBe(4);
  });
  it('an unclear page after a whole ledger marks it unverified again', async () => {
    await sweepSentOutreach(db.pool, { client: mailbox(folder(60)).client });
    expect((await stateRow()).backfilled_at).not.toBeNull();
    const later = folder(300, { newestAt: NOW + 500 * 3600 * 1000 });
    expect(await sweepSentOutreach(db.pool, { client: mailbox(later, { paging: () => ({}) }).client })).toMatchObject({ complete: false, backfilled: false });
    expect((await stateRow()).backfilled_at).toBeNull();
  });

  // A thread on a lead is mail on that lead, whatever timestamps it carries.
  it('logs a lead thread with no send time under the nearest time it carries', async () => {
    const [a, b, c] = folder(3);
    const threads = [a,
      { ...b, last_message_sent_timestamp: null, last_message_timestamp: 'not a date', first_message_timestamp: '2026-11-01T09:00:00.000Z' },
      { ...c, last_message_sent_timestamp: undefined, add_time: '2026-10-20T09:00:00.000Z' }];
    expect(await sweepSentOutreach(db.pool, { client: mailbox(threads).client })).toMatchObject({ leadsUpserted: 3, undated: 0, complete: true, backfilled: true });
    const rows = (await q("SELECT pipedrive_lead_id, sent_at FROM sdr_outreach_log ORDER BY pipedrive_lead_id")).rows;
    expect(rows.map(r => [r.pipedrive_lead_id, r.sent_at.toISOString()])).toEqual([['lead-0', a.last_message_sent_timestamp],
      ['lead-1', '2026-11-01T09:00:00.000Z'], ['lead-2', '2026-10-20T09:00:00.000Z']]);
  });
  it('a lead thread with no usable time at all cannot be logged, so the ledger is not whole', async () => {
    const threads = folder(5);
    threads[2] = { ...threads[2], last_message_sent_timestamp: null };
    const first = await sweepSentOutreach(db.pool, { client: mailbox(threads).client });
    expect(first).toMatchObject({ scanned: 5, leadsUpserted: 4, undated: 1, complete: true, backfilled: false });
    expect(await ledger()).not.toContain('lead-2');
    expect((await stateRow()).backfilled_at).toBeNull();
    // A thread with no lead and no time is nobody's mail: it does not count.
    threads[2] = { ...threads[2], lead_id: null };
    expect(await sweepSentOutreach(db.pool, { client: mailbox(threads).client, full: true })).toMatchObject({ undated: 0, complete: true, backfilled: true });
  });
  it('an undated lead thread met after a whole ledger marks it unverified again', async () => {
    const threads = folder(5);
    await sweepSentOutreach(db.pool, { client: mailbox(threads).client });
    expect((await stateRow()).backfilled_at).not.toBeNull();
    const withUndated = [{ id: 5, lead_id: 'lead-x', subject: 'No time', parties: {} }, ...threads];
    expect(await sweepSentOutreach(db.pool, { client: mailbox(withUndated).client })).toMatchObject({ undated: 1, complete: true, backfilled: false });
    expect((await stateRow()).backfilled_at).toBeNull();
  });

  // A thread deleted while the sweep runs moves every later thread up by one. Each page starts
  // a few threads before the last one ended, so the thread at the page edge is still read.
  it('reads the thread at a page edge when a thread is deleted mid-sweep', async () => {
    const threads = folder(250);
    const { client } = mailbox(threads, { beforePage: (state, list) => { if (state.pages === 2) list.splice(5, 3); } });
    expect(await sweepSentOutreach(db.pool, { client })).toMatchObject({ complete: true, backfilled: true });
    const logged = await ledger();
    for (const lead of ['lead-99', 'lead-100', 'lead-101', 'lead-102', 'lead-249']) expect(logged, lead).toContain(lead);
    expect(logged).toHaveLength(250);
  });

  // One sweep at a time. Two runs side by side could leave the watermark of one beside the
  // backfill mark of the other: a capped run moves the watermark, then a full run that began
  // earlier marks the ledger whole.
  describe('one sweep at a time', () => {
    const gate = () => { let open; const wait = new Promise(resolve => { open = resolve; }); return { wait, open }; };

    it('a second sweep in the same process stands aside', async () => {
      const g = gate();
      const slow = mailbox(folder(250), { beforePage: async state => { if (state.pages === 3) await g.wait; } });
      const first = sweepSentOutreach(db.pool, { client: slow.client, full: true });
      const other = mailbox(folder(250));
      expect(await sweepSentOutreach(db.pool, { client: other.client, maxPages: 1 })).toEqual({ skipped: 'already_running' });
      expect(other.state.pages).toBe(0);
      g.open();
      expect(await first).toMatchObject({ complete: true, backfilled: true });
    });

    it('a sweep in another process stands aside while one holds the database lock', async () => {
      // A second copy of the module has its own in-process flag, as another process would.
      vi.resetModules();
      const elsewhere = await import('../outreachSync.js');
      expect(elsewhere.sweepSentOutreach).not.toBe(sweepSentOutreach);

      const g = gate();
      let reached;
      const paused = new Promise(resolve => { reached = resolve; });
      // The full sweep has read every page and waits just before it writes its result.
      const slow = mailbox(folder(250), { beforePage: async state => { if (state.pages === 3) { reached(); await g.wait; } } });
      const full = sweepSentOutreach(db.pool, { client: slow.client, full: true });
      await paused;

      // Meanwhile a capped run from the other process would move the watermark and clear the mark.
      const capped = mailbox(folder(450, { newestAt: NOW + 400 * 3600 * 1000 }));
      expect(await elsewhere.sweepSentOutreach(db.pool, { client: capped.client, maxPages: 1 })).toEqual({ skipped: 'already_running' });
      expect(capped.state.pages).toBe(0);
      expect((await stateRow()).last_thread_ts).toBeNull();

      g.open();
      expect(await full).toMatchObject({ complete: true, backfilled: true });
      // With the lock free again the capped run goes ahead and the ledger is unverified, in that order.
      expect(await elsewhere.sweepSentOutreach(db.pool, { client: capped.client, maxPages: 1 })).toMatchObject({ complete: false, backfilled: false });
      expect((await stateRow()).backfilled_at).toBeNull();
    });

    it('a lock held by a connection outside the sweep keeps every sweep out, and frees them when it goes', async () => {
      const holder = await db.pool.connect();
      try {
        await holder.query("SELECT pg_advisory_lock(hashtextextended('sdr_outreach_sweep'::text, 0))");
        const { client, state } = mailbox(folder(50));
        const before = await stateRow();
        expect(await sweepSentOutreach(db.pool, { client, full: true })).toEqual({ skipped: 'already_running' });
        expect(state.pages).toBe(0);
        expect(await stateRow()).toEqual(before);
        await holder.query("SELECT pg_advisory_unlock(hashtextextended('sdr_outreach_sweep'::text, 0))");
        expect(await sweepSentOutreach(db.pool, { client })).toMatchObject({ complete: true, backfilled: true });
      } finally {
        holder.release();
      }
    });

    it('lets go of the lock after a failed sweep', async () => {
      await expect(sweepSentOutreach(db.pool, { client: { listMailThreads: async () => { throw new Error('Pipedrive unreachable'); } } })).rejects.toThrow('Pipedrive unreachable');
      const { rows } = await q("SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND objid = (hashtextextended('sdr_outreach_sweep'::text, 0) & 4294967295)::oid");
      expect(rows[0].held).toBe(0);
    });
  });
});
