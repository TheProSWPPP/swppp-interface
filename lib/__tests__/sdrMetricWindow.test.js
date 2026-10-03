import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { calendarDate, parseMetricWindow } from '../sdrMetricWindow.js';
const now = new Date('2026-10-03T02:00:00Z'); // October 2 in Chicago.
it('defaults to 30 complete Chicago calendar days', () => {
  expect(parseMetricWindow({}, now)).toEqual({ from: '2026-09-02', to: '2026-10-02', timezone: 'America/Chicago', provisional: false });
});
it.each(['2026-02-29', '2026-04-31', '2026-9-1', 'garbage', ['2026-09-01']])('rejects impossible or non-scalar dates: %s', date => {
  expect(() => calendarDate(date)).toThrow('invalid_date');
});
it.each([
  [{ from: '2026-09-02', to: '2026-09-02' }, 'invalid_range'],
  [{ from: '2026-09-03', to: '2026-09-02' }, 'invalid_range'],
  [{ from: '2025-09-01', to: '2026-09-03' }, 'invalid_range'],
  [{ timezone: 'UTC' }, 'unsupported_timezone'],
])('rejects invalid ranges and timezones', (query, message) => {
  expect(() => parseMetricWindow(query, now)).toThrow(message);
});
it('marks today provisional and accepts a 366-day range', () => {
  expect(parseMetricWindow({ from: '2026-10-02', to: '2026-10-03' }, now).provisional).toBe(true);
  expect(parseMetricWindow({ from: '2025-10-01', to: '2026-10-02' }, now).provisional).toBe(false);
});
describe.skipIf(!process.env.SDR_TEST_DATABASE_URL)('Postgres DST boundaries', () => {
  it('uses a 25-hour local day with inclusive start and exclusive end', async () => {
    const pool = new pg.Pool({ connectionString: process.env.SDR_TEST_DATABASE_URL });
    try {
      const window = parseMetricWindow({ from: '2026-11-01', to: '2026-11-02' }, now);
      const { rows } = await pool.query(`WITH bounds AS (
        SELECT ($1::date::timestamp AT TIME ZONE $3) AS lo, ($2::date::timestamp AT TIME ZONE $3) AS hi)
        SELECT EXTRACT(epoch FROM (hi-lo))/3600 AS hours,
          '2026-11-01T05:00:00Z'::timestamptz >= lo AS inclusive,
          '2026-11-02T06:00:00Z'::timestamptz < hi AS exclusive FROM bounds`, [window.from, window.to, window.timezone]);
      expect(rows[0]).toMatchObject({ hours: '25.0000000000000000', inclusive: true, exclusive: false });
    } finally { await pool.end(); }
  });
});
