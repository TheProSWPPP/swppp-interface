import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { baselineFor, evaluateVolume, chicagoDay, previousSendingDays, volumeAlertText, runVolumeWatch, parseSkipDates, createVolumeAlertNotifier } from '../sdrVolumeWatch.js';

// Wednesday 2026-11-04, 09:00 Chicago (CST): yesterday (Tue Nov 3) is the evaluated day.
const now = new Date('2026-11-04T15:00:00Z');
const PRIOR = ['2026-11-02', '2026-10-30', '2026-10-29', '2026-10-28', '2026-10-27', '2026-10-26', '2026-10-23'];
const box = (email, extra = {}) => ({ id: email, email, active: true, warmup_status: 'ready', warmup_started_at: '2026-09-01T00:00:00Z', ...extra });
const rowsFor = (mailbox, perDay, days = PRIOR, extra = {}) => days.map(day => ({ mailbox_email: mailbox, day, sent: perDay, first_touches: perDay, ...extra }));
const evaluate = (rows, extra = {}) => evaluateVolume({ rows, mailboxes: [box('m@proswppp.co')], now, ...extra });

describe('baseline', () => {
  it('uses the 7 previous weekdays, excluding weekends and the day itself', () => {
    expect(previousSendingDays('2026-11-03')).toEqual(PRIOR);
    const rows = [...rowsFor('m', 10), ...rowsFor('m', 100, ['2026-10-31', '2026-11-01', '2026-11-03'])];
    expect(baselineFor(rows, { day: '2026-11-03' })).toEqual({ mean: 10, days: PRIOR });
  });
  it('counts missing days as zero and can include weekends when asked', () => {
    expect(baselineFor(rowsFor('m', 14, PRIOR.slice(0, 2)), { day: '2026-11-03' }).mean).toBe(4);
    expect(previousSendingDays('2026-11-03', { includeWeekends: true })).toEqual(['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29', '2026-10-28', '2026-10-27']);
    expect(previousSendingDays('2026-11-03', { skipDates: ['2026-11-02'] })[0]).toBe('2026-10-30');
    expect(parseSkipDates('2026-11-26, bad,2026-12-25')).toEqual(['2026-11-26', '2026-12-25']);
  });
  it('buckets by Chicago day across the daylight saving change', () => {
    expect(chicagoDay(new Date('2026-10-31T04:30:00Z'))).toBe('2026-10-30'); // 23:30 CDT
    expect(chicagoDay(new Date('2026-11-02T05:30:00Z'))).toBe('2026-11-01'); // 23:30 CST
    expect(chicagoDay(new Date('2026-11-02T06:30:00Z'))).toBe('2026-11-02');
    expect(chicagoDay(new Date('2026-03-09T04:30:00Z'))).toBe('2026-03-08');
  });
});

describe('evaluateVolume', () => {
  it('alerts when yesterday is below half the average, and not at exactly half', () => {
    const dip = evaluate([...rowsFor('m@proswppp.co', 10), ...rowsFor('m@proswppp.co', 3, ['2026-11-03'])]);
    expect(dip).toEqual([expect.objectContaining({ mailbox: 'm@proswppp.co', day: '2026-11-03', kind: 'volume_dip', sent: 3, baseline: 10 })]);
    expect(evaluate([...rowsFor('m@proswppp.co', 10), ...rowsFor('m@proswppp.co', 5, ['2026-11-03'])])).toEqual([]);
  });
  it('ignores mailboxes whose average is under 5 a day', () => {
    expect(evaluate(rowsFor('m@proswppp.co', 4))).toEqual([]);
  });
  it('treats an intentionally lowered cap as explained, not a dip', () => {
    const alerts = evaluate(rowsFor('m@proswppp.co', 10), { capFor: () => 3 });
    expect(alerts.map(a => a.kind)).toEqual(['cap_lowered']);
    expect(alerts[0].evidence).toMatchObject({ cap: 3, detected_as: 'volume_dip', first_touch_baseline: 10 });
    expect(evaluate(rowsFor('m@proswppp.co', 10), { capFor: () => 40 }).map(a => a.kind)).toEqual(['volume_dip']);
  });
  it('on Monday morning compares Friday against the weekdays before it', () => {
    const monday = new Date('2026-11-09T15:00:00Z');
    const fridayPrior = ['2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02', '2026-10-30', '2026-10-29', '2026-10-28'];
    const alerts = evaluateVolume({ rows: [...rowsFor('m@proswppp.co', 10, fridayPrior), ...rowsFor('m@proswppp.co', 1, ['2026-11-06'])], mailboxes: [box('m@proswppp.co')], now: monday });
    expect(alerts).toEqual([expect.objectContaining({ day: '2026-11-06', kind: 'volume_dip', evidence: expect.objectContaining({ baseline_days: fridayPrior }) })]);
  });
  it('folds the moved admin@ address into mf@', () => {
    const rows = [...rowsFor('admin@proswppp.co', 10), ...rowsFor('admin@proswppp.co', 2, ['2026-11-03']), ...rowsFor('mf@proswppp.co', 2, ['2026-11-03'])];
    expect(evaluateVolume({ rows, mailboxes: [box('mf@proswppp.co'), box('admin@proswppp.co')], now }))
      .toEqual([expect.objectContaining({ mailbox: 'mf@proswppp.co', sent: 4 })]);
    const ok = [...rowsFor('admin@proswppp.co', 10), ...rowsFor('admin@proswppp.co', 4, ['2026-11-03']), ...rowsFor('mf@proswppp.co', 4, ['2026-11-03'])];
    expect(evaluateVolume({ rows: ok, mailboxes: [box('mf@proswppp.co')], now })).toEqual([]);
  });
  it('skips paused, disabled, inactive and still-ramping mailboxes', () => {
    const rows = rowsFor('m@proswppp.co', 10);
    for (const extra of [{ active: false }, { warmup_status: 'paused' }, { warmup_status: 'disabled' }, { warmup_started_at: '2026-10-30T00:00:00Z' }, { warmup_started_at: null }])
      expect(evaluateVolume({ rows, mailboxes: [box('m@proswppp.co', extra)], now })).toEqual([]);
  });
  it('flags a mailbox with nothing sent by noon on a sending day', () => {
    const rows = [...rowsFor('m@proswppp.co', 10), ...rowsFor('m@proswppp.co', 9, ['2026-11-03'])];
    const at = time => evaluateVolume({ rows, mailboxes: [box('m@proswppp.co')], now: new Date(time) });
    expect(at('2026-11-04T17:59:00Z')).toEqual([]);
    expect(at('2026-11-04T18:00:00Z')).toEqual([expect.objectContaining({ kind: 'stalled_today', day: '2026-11-04', sent: 0 })]);
    expect(evaluateVolume({ rows: [...rows, ...rowsFor('m@proswppp.co', 1, ['2026-11-04'])], mailboxes: [box('m@proswppp.co')], now: new Date('2026-11-04T19:00:00Z') })).toEqual([]);
    // Saturday: sequences do not send, so no stall alert.
    expect(evaluateVolume({ rows, mailboxes: [box('m@proswppp.co')], now: new Date('2026-11-07T19:00:00Z') }).filter(a => a.kind === 'stalled_today')).toEqual([]);
  });
});

describe('alert text', () => {
  it('reads as plain English with a findable marker and no dashes', () => {
    const text = volumeAlertText({ id: 'abc', kind: 'volume_dip', mailbox: 'mf@proswppp.co', day: '2026-11-03', sent: 3, baseline: 10.4,
      evidence: { basis: 'facts', cap: 40, first_touches: 1, followups: 2, last_sent_at: '2026-11-03T15:10:00Z', baseline_days: PRIOR, bounce: { sent: 30, bounced: 2 } } });
    expect(text.subject).toBe('Sending volume dropped: mf@proswppp.co');
    expect(text.bodyText).toContain('mf@proswppp.co sent 3 emails on Tue, Nov 3. The average over the previous 7 sending days was 10.4 a day.');
    expect(text.bodyText).toContain('[SDR volume alert abc]');
    expect(text.bodyText).not.toMatch(/[\u2013\u2014]/);
    const stalled = volumeAlertText({ id: 'x', kind: 'stalled_today', mailbox: 'm@proswppp.co', day: '2026-11-04', sent: 0, baseline: 9, evidence: { basis: 'enrollments' } });
    expect(stalled.subject).toBe('No emails sent yet today: m@proswppp.co');
    expect(stalled.bodyText).toContain('new sequence enrollments only');
  });
});

const db = reportingTestDb('volume_watch');
describe.skipIf(!db)('volume watch (local Postgres)', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_mailboxes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, active boolean DEFAULT true, warmup_status text DEFAULT 'ready',
        warmup_started_at timestamptz DEFAULT '2026-09-01', daily_send_limit int DEFAULT 40);
      CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipedrive_lead_id text, mailbox_id uuid, status text DEFAULT 'enrolled', sent_at timestamptz);
      CREATE TABLE sdr_engagement_events(pipedrive_lead_id text, event_type text, occurred_at timestamptz);
      CREATE TABLE sdr_message_facts(provider text, provider_message_id text, direction text, mailbox_email text, sequence_step int, occurred_at timestamptz, provider_status text, is_test boolean DEFAULT false);
      CREATE VIEW sdr_reporting_messages AS SELECT * FROM sdr_message_facts WHERE NOT is_test;
      CREATE TABLE sdr_reply_routes(mailbox_email text, forward_to text, active boolean, verified_at timestamptz);
      CREATE TABLE sdr_inbox_accounts(mailbox_email text, refresh_token text);`);
    await db.pool.query(await readFile(new URL('../../migrations/2026-11-03-sdr-volume-alerts.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-11-03-sdr-volume-alerts.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE sdr_volume_alerts, sdr_mailboxes, sdr_sends, sdr_engagement_events, sdr_message_facts, sdr_reply_routes, sdr_inbox_accounts');
    await db.pool.query("INSERT INTO sdr_mailboxes(email) VALUES ('dc@proswppp.co'),('mf@proswppp.co'),('th@proswppp.co')");
  });
  const facts = async (mailbox, perDay, days) => {
    for (const day of days) for (let i = 0; i < perDay; i++) await db.pool.query(`INSERT INTO sdr_message_facts VALUES ('apollo',$1,'out',$2,$3,$4,'completed',false)`,
      [`${mailbox}-${day}-${i}`, mailbox, i % 2 ? 2 : 1, `${day}T15:00:00Z`]);
  };
  const env = { SDR_REPORTING_INGEST_ENABLED: 'true' };

  it('records each dip once and notifies once across reruns', async () => {
    await facts('dc@proswppp.co', 10, PRIOR); await facts('dc@proswppp.co', 2, ['2026-11-03']);
    await facts('admin@proswppp.co', 8, PRIOR); await facts('mf@proswppp.co', 1, ['2026-11-03']);
    await facts('th@proswppp.co', 6, [...PRIOR, '2026-11-03']);
    const notify = vi.fn(async () => ({ id: 'sent' }));
    const first = await runVolumeWatch(db.pool, { now, notify, env });
    expect(first).toMatchObject({ coverage: 'complete', counts: { created: 2, notified: 2, enrollment_basis: 0 } });
    expect(notify.mock.calls.map(c => c[0].mailbox).sort()).toEqual(['dc@proswppp.co', 'mf@proswppp.co']);
    expect(notify.mock.calls[0][0]).toMatchObject({ day: '2026-11-03', kind: 'volume_dip' });
    const again = await runVolumeWatch(db.pool, { now: new Date(+now + 30 * 60000), notify, env });
    expect(again.counts).toMatchObject({ created: 0, notified: 0 });
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_volume_alerts')).rows[0].n).toBe(2);
  });
  it('retries a failed notification on the next run', async () => {
    await facts('dc@proswppp.co', 10, PRIOR);
    const notify = vi.fn().mockRejectedValueOnce(new Error('gmail down')).mockResolvedValue({ id: 'ok' });
    expect((await runVolumeWatch(db.pool, { now, notify, env })).counts).toMatchObject({ failed: 1, notified: 0 });
    expect((await runVolumeWatch(db.pool, { now, notify, env })).counts).toMatchObject({ failed: 0, notified: 1 });
  });
  it('falls back to enrollments when message facts are not collected', async () => {
    const id = (await db.pool.query("SELECT id FROM sdr_mailboxes WHERE email='th@proswppp.co'")).rows[0].id;
    for (const day of PRIOR) for (let i = 0; i < 6; i++) await db.pool.query('INSERT INTO sdr_sends(pipedrive_lead_id,mailbox_id,sent_at) VALUES($1,$2,$3)', [`${day}-${i}`, id, `${day}T16:00:00Z`]);
    const notify = vi.fn(async () => ({ id: 'ok' }));
    const result = await runVolumeWatch(db.pool, { now, notify, env: {} });
    expect(result.counts).toMatchObject({ created: 1, enrollment_basis: 1 });
    expect((await db.pool.query('SELECT mailbox_email, sent, evidence FROM sdr_volume_alerts')).rows[0]).toMatchObject({ mailbox_email: 'th@proswppp.co', sent: 0, evidence: { basis: 'enrollments' } });
  });
  it('closes a no-sends-yet alert once the mailbox sends', async () => {
    await facts('dc@proswppp.co', 10, [...PRIOR, '2026-11-03']);
    const noon = new Date('2026-11-04T18:30:00Z');
    await runVolumeWatch(db.pool, { now: noon, env });
    await facts('dc@proswppp.co', 1, ['2026-11-04']);
    await runVolumeWatch(db.pool, { now: new Date(+noon + 1800000), env });
    expect((await db.pool.query('SELECT kind, resolved_at IS NOT NULL AS resolved FROM sdr_volume_alerts')).rows).toEqual([{ kind: 'stalled_today', resolved: true }]);
  });
  it('sends the notification from another connected mailbox to the configured people', async () => {
    await db.pool.query("INSERT INTO sdr_inbox_accounts VALUES ('dc@proswppp.co','t'),('jg@proswppp.co','t')");
    await db.pool.query("INSERT INTO sdr_reply_routes VALUES ('dc@proswppp.co','dan@proswppp.com',true,NOW())");
    const gmail = { sendMail: vi.fn(async () => ({ id: 'm1' })) };
    const notify = createVolumeAlertNotifier({ pool: db.pool, gmail, getToken: async m => `token:${m}`, to: ['ivan@example.test'], notifyOwner: true });
    await notify({ id: 'a1', mailbox: 'dc@proswppp.co', mailbox_email: 'dc@proswppp.co', kind: 'volume_dip', day: '2026-11-03', sent: 2, baseline: 10, evidence: {} });
    expect(gmail.sendMail).toHaveBeenCalledWith('token:jg@proswppp.co', expect.objectContaining({ from: 'jg@proswppp.co', to: ['ivan@example.test', 'dan@proswppp.com'], messageId: '<sdr-volume-a1@proswppp.co>' }));
  });
});
