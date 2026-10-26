import { describe, expect, it } from 'vitest';
import { defaultMonthPeriod, monthToDateWindow, neverCalculated, comparisonWindow } from './metricDisplay';

describe('default reporting period includes the current month', () => {
  it('uses this month through yesterday when a full day exists', () => {
    expect(monthToDateWindow('2026-10-26')).toEqual({ from: '2026-10-01', to: '2026-10-26' });
    expect(defaultMonthPeriod('2026-10-26')).toEqual({ period: 'month', window: { from: '2026-10-01', to: '2026-10-26' } });
  });
  it('falls back to last month on the 1st', () => {
    expect(monthToDateWindow('2026-11-01')).toBeNull();
    expect(defaultMonthPeriod('2026-11-01')).toEqual({ period: 'lastmonth', window: { from: '2026-10-01', to: '2026-11-01' } });
    expect(defaultMonthPeriod('2026-01-01').window).toEqual({ from: '2025-12-01', to: '2026-01-01' });
  });
  it('compares this month with the same days last month', () => {
    expect(comparisonWindow({ from: '2026-10-01', to: '2026-10-26' }, 'month')).toEqual({ from: '2026-09-01', to: '2026-09-26' });
  });
});

describe('metrics that are never calculated are hidden', () => {
  it('flags only unavailable metrics with no data source', () => {
    expect(neverCalculated({ value: null, state: 'unavailable', reason: 'open_tracking_unverified' })).toBe(true);
    expect(neverCalculated({ value: null, state: 'unavailable', reason: 'accounting_not_connected' })).toBe(true);
    expect(neverCalculated({ value: null, state: 'unavailable', reason: 'deal_links_missing' })).toBe(false);
    expect(neverCalculated({ value: 3, state: 'partial', reason: 'incomplete_coverage' })).toBe(false);
    expect(neverCalculated(undefined)).toBe(false);
  });
});
