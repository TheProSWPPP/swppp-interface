import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import * as budget from '../apolloMessageSearchBudget.js';

const db = reportingTestDb('apollo_message_budget');
const pool = db?.pool;
describe.skipIf(!pool)('shared Apollo message-search ledger survives a restart', () => {
  beforeAll(async () => {
    await db.setup();
    await pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-apollo-cursors.sql', import.meta.url), 'utf8').then((sql) => sql.replace(/ALTER TABLE sdr_sends[^;]*;/, '')));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { budget._reset(); await pool.query('TRUNCATE sdr_apollo_poll_state'); });

  it('restores the 24h call count and an open breaker after a deploy', async () => {
    for (let i = 0; i < 1049; i++) budget.recordCall();
    budget.noteRateLimit({ retryAfterSec: 600 }, 'test');
    expect(await budget.persist(pool)).toBe(true);
    budget._reset();
    expect(budget.callsInWindow()).toBe(0);
    expect(await budget.hydrate(pool)).toEqual({ hydrated: true, restored: 1049 });
    expect(budget.callsInWindow()).toBe(1049);
    expect(budget.remaining()).toBe(budget.DAILY_CALL_CEILING - 1049);
    expect(budget.isRateLimited()).toBe(true);
    // Hydrating twice in one process cannot double count.
    expect((await budget.hydrate(pool)).hydrated).toBe(false);
    expect(budget.callsInWindow()).toBe(1049);
  });
  it('drops calls older than 24h and malformed buckets', async () => {
    const now = Date.now();
    await pool.query("INSERT INTO sdr_apollo_poll_state(scope,state) VALUES('message_search_budget',$1)", [JSON.stringify({ calls: [[now - 25 * 3600_000, 500], [now - 60_000, 7], ['x', 3], [now, -2]] })]);
    await budget.hydrate(pool);
    expect(budget.callsInWindow()).toBe(7);
  });
  it('keeps working in memory when the table is missing', async () => {
    await pool.query('ALTER TABLE sdr_apollo_poll_state RENAME TO absent_state');
    try {
      expect(await budget.hydrate(pool)).toEqual({ hydrated: false, reason: 'unavailable' });
      budget.recordCall();
      expect(await budget.persist(pool)).toBe(false);
      expect(budget.callsInWindow()).toBe(1);
    } finally { await pool.query('ALTER TABLE absent_state RENAME TO sdr_apollo_poll_state'); }
  });
});
