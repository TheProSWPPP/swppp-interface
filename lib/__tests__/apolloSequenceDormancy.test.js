import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apollo from '../apolloClient.js';
import * as budget from '../apolloMessageSearchBudget.js';
import { sequenceDormancy, readSequenceDormancy, _resetSequenceDormancy } from '../apolloSequenceDormancy.js';
import { pollPermitEngagement, _resetPermitReadState } from '../permitEngagementSync.js';
vi.mock('../apolloClient.js', () => ({ searchEmailerMessages: vi.fn(), getSequenceDetail: vi.fn() }));

const NOW = Date.parse('2026-10-26T12:00:00Z');
const detail = (campaign) => ({ emailer_campaign: { active: true, archived: false, unique_scheduled: 0, last_used_at: '2026-09-17T20:41:41Z', ...campaign } });

describe('sequence dormancy', () => {
  it('is dormant when archived, inactive, or finished with nothing scheduled for 14 days', () => {
    expect(sequenceDormancy(detail({}), NOW)).toEqual({ dormant: true, reason: 'finished' });
    expect(sequenceDormancy(detail({ archived: true }), NOW).reason).toBe('archived');
    expect(sequenceDormancy(detail({ active: false }), NOW).reason).toBe('inactive');
  });
  it('stays active while anything is scheduled, a contact was added recently, or the shape is unknown', () => {
    expect(sequenceDormancy(detail({ unique_scheduled: 11 }), NOW).dormant).toBe(false);
    expect(sequenceDormancy(detail({ last_used_at: '2026-10-20T16:59:11Z' }), NOW).dormant).toBe(false);
    expect(sequenceDormancy({ emailer_steps: [] }, NOW)).toEqual({ dormant: false, reason: 'detail_unavailable' });
    expect(sequenceDormancy(detail({ unique_scheduled: undefined }), NOW).dormant).toBe(false);
  });
  it('a failed detail read never marks a sequence dormant', async () => {
    _resetSequenceDormancy();
    expect(await readSequenceDormancy('x', { now: NOW, read: async () => { throw new Error('down'); } })).toEqual({ dormant: false, reason: 'detail_unavailable' });
  });
});

// In-memory stand-in for the permit tables; it only needs the statements the poll issues.
function fakeDb() {
  const saved = new Map();
  return {
    saved,
    async query(sql, params = []) {
      if (/^\s*(CREATE|ALTER)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM permit_msgp_template/.test(sql)) return { rows: [{ seq: 'permit-seq' }] };
      if (/SELECT state FROM sdr_apollo_poll_state/.test(sql)) return { rows: saved.has(params[0]) ? [{ state: saved.get(params[0]) }] : [] };
      if (/INSERT INTO sdr_apollo_poll_state/.test(sql)) { saved.set(params[0], JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('permit engagement poll on a finished sequence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    vi.stubEnv('PERMIT_ENGAGEMENT_SYNC', 'true'); vi.stubEnv('APOLLO_API_KEY', 'test-only');
    _resetSequenceDormancy(); _resetPermitReadState(); budget._reset(); vi.clearAllMocks();
    // 1,049 messages = 11 pages, the live permit sequence.
    apollo.searchEmailerMessages.mockImplementation(async ({ page }) => ({ emailer_messages: Array.from({ length: page < 11 ? 100 : 49 }, (_, i) => ({ id: `p${page}-${i}` })) }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('reads a finished sequence in full once a day instead of every 15 minutes, across restarts', async () => {
    apollo.getSequenceDetail.mockResolvedValue(detail({}));
    const db = fakeDb();
    const first = await pollPermitEngagement(db, { db, log: { error() {} } });
    expect(first.scanned).toBe(1049);
    expect(apollo.searchEmailerMessages).toHaveBeenCalledTimes(11);
    // Next 15-minute pass, and a pass after a redeploy (in-memory state gone): no reads.
    vi.setSystemTime(NOW + 15 * 60_000);
    expect((await pollPermitEngagement(db, { db, log: { error() {} } })).skippedDormant).toHaveLength(1);
    _resetPermitReadState(); _resetSequenceDormancy();
    expect((await pollPermitEngagement(db, { db, log: { error() {} } })).skippedDormant[0]).toMatchObject({ sequence: 'permit-seq', reason: 'finished' });
    expect(apollo.searchEmailerMessages).toHaveBeenCalledTimes(11);
    // A day later it is read again (late replies still surface).
    vi.setSystemTime(NOW + 24 * 60 * 60_000 + 1);
    expect((await pollPermitEngagement(db, { db, log: { error() {} } })).scanned).toBe(1049);
    expect(apollo.searchEmailerMessages).toHaveBeenCalledTimes(22);
  });
  it('keeps reading an active sequence every pass, and an interrupted read is not counted as done', async () => {
    apollo.getSequenceDetail.mockResolvedValue(detail({ unique_scheduled: 3 }));
    const db = fakeDb();
    await pollPermitEngagement(db, { db, log: { error() {} } });
    await pollPermitEngagement(db, { db, log: { error() {} } });
    expect(apollo.searchEmailerMessages).toHaveBeenCalledTimes(22);
    apollo.getSequenceDetail.mockResolvedValue(detail({}));
    _resetSequenceDormancy(); _resetPermitReadState(); apollo.searchEmailerMessages.mockClear();
    const fresh = fakeDb();
    apollo.searchEmailerMessages.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await pollPermitEngagement(fresh, { db: fresh, log: { error() {} } });
    expect(fresh.saved.has('permit_engagement')).toBe(false);
    await pollPermitEngagement(fresh, { db: fresh, log: { error() {} } });
    expect(apollo.searchEmailerMessages).toHaveBeenCalledTimes(12);
  });
});
