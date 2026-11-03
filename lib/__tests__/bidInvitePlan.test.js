import { describe, it, expect } from 'vitest';
import { nextWindowSlot, inSendWindow, stateTimezone, e1DueAt, e2DueAt, e3DueAt, applyThreeDayRule, buildBatches, jitterMinutes, MAX_JITTER_MINUTES } from '../bidInvitePlan.js';

const Z = (s) => new Date(s);
const iso = (d) => d.toISOString();
// 2026-11-03 is a Tuesday. US daylight saving time ended on Sunday 2026-11-01 (Chicago = UTC-6 after, UTC-5 before).

describe('send windows (recipient time zone, weekdays, 06:30-08:30 and 16:00-17:30)', () => {
  const CHI = 'America/Chicago';
  it('window edges', () => {
    expect(inSendWindow(Z('2026-11-03T12:29:00Z'), CHI)).toBe(false); // 06:29
    expect(inSendWindow(Z('2026-11-03T12:30:00Z'), CHI)).toBe(true);  // 06:30
    expect(inSendWindow(Z('2026-11-03T14:29:00Z'), CHI)).toBe(true);  // 08:29
    expect(inSendWindow(Z('2026-11-03T14:30:00Z'), CHI)).toBe(false); // 08:30
    expect(inSendWindow(Z('2026-11-03T22:00:00Z'), CHI)).toBe(true);  // 16:00
    expect(inSendWindow(Z('2026-11-03T23:29:00Z'), CHI)).toBe(true);  // 17:29
    expect(inSendWindow(Z('2026-11-03T23:30:00Z'), CHI)).toBe(false); // 17:30
    expect(iso(nextWindowSlot(Z('2026-11-03T12:29:00Z'), CHI))).toBe('2026-11-03T12:30:00.000Z');
    expect(iso(nextWindowSlot(Z('2026-11-03T12:30:00Z'), CHI))).toBe('2026-11-03T12:30:00.000Z');
    expect(iso(nextWindowSlot(Z('2026-11-03T14:30:00Z'), CHI))).toBe('2026-11-03T22:00:00.000Z');
    expect(iso(nextWindowSlot(Z('2026-11-03T23:30:00Z'), CHI))).toBe('2026-11-04T12:30:00.000Z');
  });
  it('Saturday goes to Monday 06:30, Friday evening too', () => {
    expect(iso(nextWindowSlot(Z('2026-11-07T16:00:00Z'), CHI))).toBe('2026-11-09T12:30:00.000Z');
    expect(iso(nextWindowSlot(Z('2026-11-06T23:45:00Z'), CHI))).toBe('2026-11-09T12:30:00.000Z');
    expect(inSendWindow(Z('2026-11-07T13:00:00Z'), CHI)).toBe(false); // Saturday 07:00
  });
  it('DST week: Saturday before the change lands on Monday 06:30 standard time', () => {
    expect(iso(nextWindowSlot(Z('2026-10-31T15:00:00Z'), CHI))).toBe('2026-11-02T12:30:00.000Z');
    expect(iso(nextWindowSlot(Z('2026-10-30T10:00:00Z'), CHI))).toBe('2026-10-30T11:30:00.000Z'); // Friday, still daylight time
  });
  it('uses the recipient zone, not ours', () => {
    const at = Z('2026-11-03T12:00:00Z');
    expect(inSendWindow(at, 'America/New_York')).toBe(true); // 07:00 Eastern
    expect(inSendWindow(at, 'America/Phoenix')).toBe(false); // 05:00 Arizona
    expect(iso(nextWindowSlot(at, 'America/Phoenix'))).toBe('2026-11-03T13:30:00.000Z');
    expect(iso(nextWindowSlot(at, 'America/Los_Angeles'))).toBe('2026-11-03T14:30:00.000Z');
  });
  it('a stable 0-45 minute jitter from the batch id, inside the window', () => {
    const key = 'batch-7';
    const a = nextWindowSlot(Z('2026-11-03T12:00:00Z'), CHI, { jitterKey: key });
    expect(+a).toBe(+nextWindowSlot(Z('2026-11-03T12:00:00Z'), CHI, { jitterKey: key }));
    expect(+a - +Z('2026-11-03T12:30:00Z')).toBe(jitterMinutes(key) * 60000);
    expect(jitterMinutes(key)).toBeLessThanOrEqual(MAX_JITTER_MINUTES);
    expect(inSendWindow(a, CHI)).toBe(true);
  });
  it('time zone from the organization state, Central by default', () => {
    expect(stateTimezone('TX')).toBe('America/Chicago');
    expect(stateTimezone('Texas')).toBe('America/Chicago');
    expect(stateTimezone('fl')).toBe('America/New_York');
    expect(stateTimezone('AZ')).toBe('America/Phoenix');
    expect(stateTimezone('California')).toBe('America/Los_Angeles');
    expect(stateTimezone('New Mexico')).toBe('America/Denver');
    for (const v of [null, '', 'Ontario', 'XX']) expect(stateTimezone(v)).toBe('America/Chicago');
  });
});

describe('when each email is due', () => {
  it('nothing before the bid date: a future bid waits 2 business days after it (Fri -> Tue)', () => {
    expect(iso(e1DueAt({ bidDate: '2026-11-06', firstSeenAt: Z('2026-11-03T15:00:00Z') }))).toBe('2026-11-10T06:00:00.000Z');
    expect(iso(e1DueAt({ bidDate: '2026-11-03', firstSeenAt: Z('2026-11-03T15:00:00Z') }))).toBe('2026-11-05T06:00:00.000Z'); // bid today
  });
  it('bid already passed at upload: due right away (then the next window)', () => {
    const seen = Z('2026-11-03T15:00:00Z');
    expect(iso(e1DueAt({ bidDate: '2026-10-20', firstSeenAt: seen }))).toBe(iso(seen));
    expect(iso(nextWindowSlot(e1DueAt({ bidDate: '2026-10-20', firstSeenAt: seen }), 'America/Chicago'))).toBe('2026-11-03T22:00:00.000Z');
    expect(e1DueAt({ bidDate: null, firstSeenAt: seen })).toBeNull();
  });
  it('Saturday upload of a passed bid goes out Monday 06:30 local', () => {
    const sat = Z('2026-11-07T17:00:00Z');
    expect(iso(nextWindowSlot(e1DueAt({ bidDate: '2026-10-01', firstSeenAt: sat }), 'America/New_York'))).toBe('2026-11-09T11:30:00.000Z');
  });
  it('Email 2 at max(bid + 28 days, Email 1 + 14 days); Email 3 at max(bid + 42, Email 2 + 14)', () => {
    // Fresh bid: the bid anchor wins.
    expect(iso(e2DueAt({ anchor: '2026-11-06', e1SentAt: Z('2026-11-10T13:00:00Z') }))).toBe('2026-12-04T06:00:00.000Z');
    expect(iso(e3DueAt({ anchor: '2026-11-06', e2SentAt: Z('2026-12-04T13:00:00Z') }))).toBe('2026-12-18T13:00:00.000Z');
    // A 50-day-old bid: two weeks after the email before it wins.
    expect(iso(e2DueAt({ anchor: '2026-09-14', e1SentAt: Z('2026-11-03T13:00:00Z') }))).toBe('2026-11-17T13:00:00.000Z');
    expect(iso(e3DueAt({ anchor: '2026-09-14', e2SentAt: Z('2026-11-17T13:00:00Z') }))).toBe('2026-12-01T13:00:00.000Z');
  });
});

describe('3-day rule', () => {
  const due = Z('2026-11-10T13:00:00Z');
  it('pushes past 72 hours after our last email from any source', () => {
    expect(iso(applyThreeDayRule(due, { lastOutboundAt: Z('2026-11-08T13:00:00Z') }))).toBe('2026-11-11T13:00:00.000Z');
    expect(iso(applyThreeDayRule(due, { lastOutboundAt: Z('2026-11-01T13:00:00Z') }))).toBe(iso(due));
  });
  it('stays clear of another sequence step scheduled near it', () => {
    expect(iso(applyThreeDayRule(due, { nextScheduledAt: Z('2026-11-11T13:00:00Z') }))).toBe('2026-11-14T13:00:00.000Z');
    expect(iso(applyThreeDayRule(due, { nextScheduledAt: Z('2026-11-20T13:00:00Z') }))).toBe(iso(due));
  });
});

describe('grouping by contact', () => {
  const lead = (id, email, bidDate, shortName, customer = false) => ({ leadId: id, email, bidDate, shortName, customer, personId: 'p1' });
  it('6 bids for one contact = 1 batch, 3 projects named newest first, all 6 covered', () => {
    const leads = [
      lead('a', 'Rodger@GC.test ', '2026-09-10', 'Alpha SWPPP'), lead('b', 'rodger@gc.test', '2026-10-01', 'Bravo SWPPP'),
      lead('c', 'rodger@gc.test', '2026-09-20', 'Charlie SWPPP'), lead('d', 'rodger@gc.test', '2026-10-15', 'Delta SWPPP'),
      lead('e', 'rodger@gc.test', '2026-09-01', 'Echo SWPPP'), lead('f', 'rodger@gc.test', '2026-10-05', 'Fox SWPPP'),
    ];
    const batches = buildBatches(leads);
    expect(batches).toHaveLength(1);
    expect(batches[0].email).toBe('rodger@gc.test');
    expect(batches[0].names).toEqual(['Delta SWPPP', 'Fox SWPPP', 'Bravo SWPPP']);
    expect(batches[0].namedLeadIds).toEqual(['d', 'f', 'b']);
    expect(batches[0].leadIds).toHaveLength(6);
    expect(batches[0].anchor).toBe('2026-10-15');
    expect(batches[0].customer).toBe(false);
  });
  it('one customer lead makes the whole batch a customer batch', () => {
    const [b] = buildBatches([lead('a', 'x@gc.test', '2026-10-01', 'A SWPPP'), lead('b', 'x@gc.test', '2026-10-02', 'B SWPPP', true)]);
    expect(b.customer).toBe(true);
  });
  it('the same project from two platforms is named once', () => {
    const [b] = buildBatches([lead('a', 'x@gc.test', '2026-10-01', 'Wharton SWPPP'), lead('b', 'x@gc.test', '2026-10-01', 'Wharton SWPPP')]);
    expect(b.names).toEqual(['Wharton SWPPP']);
    expect(b.leadIds).toEqual(['a', 'b']);
  });
  it('different contacts get their own batch', () => {
    expect(buildBatches([lead('a', 'x@gc.test', '2026-10-01', 'A SWPPP'), lead('b', 'y@gc.test', '2026-10-01', 'B SWPPP')])).toHaveLength(2);
  });
});
