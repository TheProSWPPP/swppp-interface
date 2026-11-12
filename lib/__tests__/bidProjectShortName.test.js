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
    expect(projectShortName('wharton swppp')).toBe('Wharton SWPPP');
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
  it('ALL-CAPS titles become title case; short acronyms stay upper case', () => {
    expect(projectShortName('UTMB CLC PARKING LOT, ALL TRADES')).toBe('UTMB CLC Parking Lot SWPPP');
    expect(projectShortName('FORT BEND ISD NATATORIUM (BID PACKAGE 2)')).toBe('Fort Bend ISD Natatorium SWPPP');
    expect(projectShortName('TXDOT US 59 WIDENING')).toBe('TxDOT US 59 Widening SWPPP');
    expect(projectShortName('CITY OF SUGAR LAND FIRE STATION 8')).toBe('City of Sugar Land Fire Station 8 SWPPP');
    expect(projectShortName('KATY HIGH SCHOOL GOLF CENTER')).toBe('Katy High School Golf Center SWPPP');
    expect(projectShortName('THE WOODLANDS HOA AMENITY')).toBe('The Woodlands HOA Amenity SWPPP');
    expect(projectShortName('SH-288 TCEQ POND, USACE')).toBe('SH-288 TCEQ Pond USACE SWPPP');
    // Mixed case is left exactly as typed.
    expect(projectShortName('TxDOT FM 1093 Widening')).toBe('TxDOT FM 1093 Widening SWPPP');
  });
  it("Derek's call example: a spelled-out owner followed by its acronym keeps the acronym only", () => {
    expect(projectShortName('University of Texas, UTMB, CLC parking lot, all trades')).toBe('UTMB CLC Parking Lot SWPPP');
    expect(projectShortName('UNIVERSITY OF TEXAS, UTMB, CLC PARKING LOT, ALL TRADES')).toBe('UTMB CLC Parking Lot SWPPP');
    expect(projectShortName('University of Texas, UTMB, CLC Parking Lot, All Trades')).toBe('UTMB CLC Parking Lot SWPPP');
  });
  it('drops the spelled-out owner for other real-looking titles', () => {
    expect(projectShortName('Texas Department of Transportation, TxDOT, US 59 Widening')).toBe('TxDOT US 59 Widening SWPPP');
    expect(projectShortName('Katy Independent School District, KISD, Elementary 45 - Sitework')).toBe('KISD Elementary 45 SWPPP');
    expect(projectShortName('Harris County Flood Control District, HCFCD, Brays Bayou Detention')).toBe('HCFCD Brays Bayou Detention SWPPP');
    expect(projectShortName('Texas A&M University, TAMU, Rec Center Addition')).toBe('TAMU Rec Center Addition SWPPP');
    expect(projectShortName('City of Houston, COH, Fire Station 12 (Bid Package 3)')).toBe('COH Fire Station 12 SWPPP');
  });
  it('keeps the earlier part when the acronym does not abbreviate it', () => {
    // One word is never treated as a spelled-out owner.
    expect(projectShortName('Houston, HISD, Elementary School')).toBe('Houston HISD Elementary School SWPPP');
    // The acronym's letters do not start with the earlier part's initials.
    expect(projectShortName('Memorial Hermann, UTMB, Katy Clinic')).toBe('Memorial Hermann UTMB Katy Clinic SWPPP');
    // A part with numbers is a project, not an owner.
    expect(projectShortName('Fire Station 8, FS, Renovation')).toBe('Fire Station 8 FS Renovation SWPPP');
    // A 2-letter acronym that is not a known one never stands in for the earlier part.
    expect(projectShortName('Parking Garage, PG, Phase 2')).toBe('Parking Garage PG Phase 2 SWPPP');
    // A known 2-letter one does.
    expect(projectShortName('University Texas, UT, Rec Center')).toBe('UT Rec Center SWPPP');
    // An acronym before the long name is left alone.
    expect(projectShortName('UTMB, University of Texas Clinic')).toBe('UTMB University of Texas Clinic SWPPP');
  });
  it('words typed all in lower case get a capital; joining words and mixed case stay as typed', () => {
    expect(projectShortName('Katy ISD - new gym')).toBe('Katy ISD New Gym SWPPP');
    expect(projectShortName('city of sugar land fire station')).toBe('City of Sugar Land Fire Station SWPPP');
    expect(projectShortName('TxDOT FM 1093 widening')).toBe('TxDOT FM 1093 Widening SWPPP');
  });
  it('Roman numerals stay upper case', () => {
    expect(projectShortName('Katy Library phase ii')).toBe('Katy Library Phase II SWPPP');
    expect(projectShortName('katy medical building iv - sitework')).toBe('Katy Medical Building IV SWPPP');
    expect(projectShortName('KATY MEDICAL BUILDING VIII')).toBe('Katy Medical Building VIII SWPPP');
    expect(projectShortName('KATY HIGH SCHOOL PHASE III')).toBe('Katy High School Phase III SWPPP');
    expect(projectShortName('Bay City Fire Station Phase VI')).toBe('Bay City Fire Station Phase VI SWPPP');
  });
  it('is deterministic', () => {
    const t = 'Sugar Land Town Square, Phase 2 - All Packages';
    expect(projectShortName(t)).toBe(projectShortName(t));
    expect(projectShortName(t)).toBe('Sugar Land Town Square Phase 2 SWPPP');
  });
  it("capitals after an apostrophe: O'REILLY keeps its R, ALLSUP'S keeps a small s", () => {
    expect(projectShortName("O'REILLY AUTO PARTS")).toBe("O'Reilly Auto Parts SWPPP");
    expect(projectShortName("ALLSUP'S - LORENZO, TX")).toBe("Allsup's Lorenzo TX SWPPP");
  });
});
