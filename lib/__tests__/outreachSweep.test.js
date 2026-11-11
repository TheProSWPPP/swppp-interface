import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const mailbox = threads => {
  const state = { pages: 0 };
  return { state, client: { listMailThreads: async ({ start = 0, limit = 100 } = {}) => {
    state.pages++;
    const data = threads.slice(start, start + limit);
    const more = start + limit < threads.length;
    return { data, pagination: { more_items_in_collection: more, next_start: more ? start + limit : undefined } };
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

  it('a first sweep that reads the folder to its end leaves a whole ledger', async () => {
    const { client, state } = mailbox(folder(250));
    expect(await sweepSentOutreach(db.pool, { client })).toMatchObject({ scanned: 250, leadsUpserted: 250, complete: true, backfilled: true });
    expect(state.pages).toBe(3);
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
    expect(full).toMatchObject({ scanned: 250, complete: true, backfilled: true });
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
});
