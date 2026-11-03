import {describe,it,expect} from 'vitest';
import * as oldPath from '../bidFollowUpClock.js';
import {addBusinessDays,chicagoNow} from '../businessDays.js';

// The before-bid task clock was removed (2026-11-03); only the business-day helpers remain.
describe('business days',()=>{
 it('skips weekends both ways',()=>{
  expect(addBusinessDays('2026-10-26',-2)).toBe('2026-10-22'); // Mon -> Thu
  expect(addBusinessDays('2026-10-23',5)).toBe('2026-10-30');  // Fri -> Fri
  expect(addBusinessDays('2026-10-23',1)).toBe('2026-10-26');  // Fri -> Mon
 });
 it('reads the Chicago calendar day',()=>{
  expect(chicagoNow(new Date('2026-10-22T04:30:00Z'))).toEqual({today:'2026-10-21',hour:23});
  expect(chicagoNow(new Date('2026-10-22T12:00:00Z'))).toEqual({today:'2026-10-22',hour:7});
 });
 it('stays importable from the old path, and the old clock is gone',()=>{
  expect(oldPath.addBusinessDays).toBe(addBusinessDays);
  expect(oldPath.chicagoNow).toBe(chicagoNow);
  expect(Object.keys(oldPath).sort()).toEqual(['addBusinessDays','chicagoNow']);
 });
});
