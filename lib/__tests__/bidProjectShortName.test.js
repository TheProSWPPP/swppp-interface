import { describe, it, expect } from 'vitest';
import { projectShortName, MAX_NAME_LENGTH } from '../bidProjectShortName.js';

describe('bid project short name', () => {
  it('drops scope words and puts SWPPP at the end (the examples Derek was shown)', () => {
    expect(projectShortName('UTMB CLC Parking Lot, All Trades')).toBe('UTMB CLC Parking Lot SWPPP');
    expect(projectShortName('Zavala County Jail - Sitework')).toBe('Zavala County Jail SWPPP');
    expect(projectShortName('Fort Bend ISD Natatorium (Bid Package 2)')).toBe('Fort Bend ISD Natatorium SWPPP');
    expect(projectShortName('Hwy 59 Widening - Stormwater Pollution Prevention Plan')).toBe('Hwy 59 Widening SWPPP');
  });
  it('never doubles SWPPP', () => {
    expect(projectShortName('Wharton SWPPP')).toBe('Wharton SWPPP');
    expect(projectShortName('Wharton - SWPPP')).toBe('Wharton SWPPP');
    expect(projectShortName('wharton swppp')).toBe('wharton SWPPP');
  });
  it('drops more scope segments: rebid, addendum, ITB, division, civil, contractor bids', () => {
    expect(projectShortName('Katy Library Renovation - REBID')).toBe('Katy Library Renovation SWPPP');
    expect(projectShortName('Katy Library; Addendum 3; ITB')).toBe('Katy Library SWPPP');
    expect(projectShortName('Bay City Fire Station | Div 31 Earthwork')).toBe('Bay City Fire Station SWPPP');
    expect(projectShortName('Pearland Clinic - Civil - Subcontractor Bids')).toBe('Pearland Clinic SWPPP');
  });
  it('returns null when nothing usable is left', () => {
    expect(projectShortName('ALL TRADES')).toBeNull();
    expect(projectShortName('')).toBeNull();
    expect(projectShortName(null)).toBeNull();
    expect(projectShortName('SWPPP')).toBeNull();
    expect(projectShortName('12 - 34')).toBeNull();
  });
  it('cuts long titles on a word boundary', () => {
    const name = projectShortName('Brazoria County Regional Detention Center Expansion and Parking Improvements');
    expect(name).toBe('Brazoria County Regional Detention Center SWPPP');
    expect(name.replace(/ SWPPP$/, '').length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });
  it('is deterministic', () => {
    const t = 'Sugar Land Town Square, Phase 2 - All Packages';
    expect(projectShortName(t)).toBe(projectShortName(t));
    expect(projectShortName(t)).toBe('Sugar Land Town Square Phase 2 SWPPP');
  });
});
