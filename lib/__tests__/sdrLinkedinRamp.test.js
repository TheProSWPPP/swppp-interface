import {describe,it,expect} from 'vitest';
import {rampInviteBudget,effectiveInviteBudget,nextInviteAllowedAt,spacingJitter,LINKEDIN_WINDOW_MINUTES,nextLocalDayStart} from '../sdrLinkedinRamp.js';

// 2026-11-02 is a Monday; noon Central on each day.
const on=days=>new Date(Date.UTC(2026,10,2+days,18,0,0));
describe('LinkedIn invite ramp from the first live day',()=>{
 it('gives 5 a day in week 1, 10 in week 2, then 15',()=>{
  const start='2026-11-02';
  for(const [day,budget] of [[0,5],[6,5],[7,10],[13,10],[14,15],[40,15]])expect(rampInviteBudget({rampStartedOn:start,now:on(day)}),`day ${day}`).toBe(budget);
 });
 it('gives nothing before the ramp starts or without a start date',()=>{
  expect(rampInviteBudget({rampStartedOn:null,now:on(0)})).toBe(0);
  expect(rampInviteBudget({rampStartedOn:'2026-11-03',now:on(0)})).toBe(0);
  expect(rampInviteBudget({rampStartedOn:new Date(2026,10,2),now:on(7)})).toBe(10);
 });
 it('counts the local Central day, not the UTC day',()=>{
  // 2026-11-09 01:30Z is still Sunday 2026-11-08 in Chicago: day 6, so 5.
  expect(rampInviteBudget({rampStartedOn:'2026-11-02',now:new Date('2026-11-09T01:30:00Z')})).toBe(5);
 });
 it('uses the lower of the campaign budget and the ramp',()=>{
  expect(effectiveInviteBudget(15,5)).toBe(5);expect(effectiveInviteBudget(3,10)).toBe(3);expect(effectiveInviteBudget(undefined,10)).toBe(0);expect(effectiveInviteBudget(15,0)).toBe(0);
 });
 it('spaces invites across the window, never closer than 0.7 of the interval',()=>{
  const last=new Date('2026-11-02T14:00:00Z');
  for(const budget of [5,10,15])for(let seed=0;seed<200;seed++){
   const gap=nextInviteAllowedAt({lastInviteAt:last,budget,seed:`acct:${seed}`})-last,interval=LINKEDIN_WINDOW_MINUTES/budget*60_000;
   expect(gap).toBeGreaterThanOrEqual(0.7*interval-1);expect(gap).toBeLessThanOrEqual(1.3*interval+1);
  }
  expect(spacingJitter('same')).toBe(spacingJitter('same'));
  expect(nextInviteAllowedAt({lastInviteAt:null,budget:5,seed:'x'})).toBeNull();
 });
 it('finds the next local midnight across the November DST change',()=>{
  expect(nextLocalDayStart(new Date('2026-10-31T20:00:00Z')).toISOString()).toBe('2026-11-01T05:00:00.000Z');
  expect(nextLocalDayStart(new Date('2026-11-01T20:00:00Z')).toISOString()).toBe('2026-11-02T06:00:00.000Z');
 });
});
