import { expect, it } from 'vitest';
import { metricText, metricExplanation, previousWindow, defaultWindow,cohortMaturity,snapshotLabel,comparisonWindow } from './metricDisplay';
it('shows genuine zero and preserves unavailable evidence', () => {
  expect(metricText({ value:0,state:'available' },'count')).toBe('0');
  expect(metricText({ value:null,state:'unavailable',reason:'not_linked' },'rate')).toBe('Unavailable');
  expect(metricText({ value:null,state:'available',denominator:0,reason:'no_denominator' },'rate')).toBe('No qualifying data');
});
it('formats rates with visible units and handles partial numeric values', () => {
  expect(metricText({ value:.05,state:'available',numerator:5,denominator:100 },'rate')).toBe('5.0%');
  expect(metricText({ value:2125.5,state:'partial' },'currency')).toBe('$2,125.50');
  expect(metricExplanation({ value:.05,state:'partial',numerator:5,denominator:100,reason:'cohort_maturing_30_days' })).toContain('5 / 100');
});
it('compares equal calendar lengths across month and DST boundaries', () => {
  expect(previousWindow({ from:'2026-11-01',to:'2026-11-02' })).toEqual({from:'2026-10-31',to:'2026-11-01'});
  expect(previousWindow({ from:'2026-09-01',to:'2026-10-01' })).toEqual({from:'2026-08-02',to:'2026-09-01'});
});
it('matches backend complete Chicago days before local midnight', () => {
  expect(defaultWindow(new Date('2026-10-03T02:00:00Z'))).toEqual({from:'2026-09-02',to:'2026-10-02'});
});

it('keeps missing inbox history distinct from an immature reply cohort',()=>{
 expect(metricExplanation({value:.04,state:'partial',reason:'inbox_coverage_incomplete'})).toContain('not been completely collected');
 expect(metricExplanation({value:.04,state:'partial',reason:'reply_links_missing'})).toContain('verified message');
});
it('explains why conversion remains unavailable despite partial event counts',()=>{
 expect(metricExplanation({value:null,state:'unavailable',reason:'outreach_classification_incomplete'})).toContain('outreach');
 expect(metricExplanation({value:null,state:'unavailable',reason:'cohort_reconciliation_missing'})).toContain('message IDs');
 expect(metricExplanation({value:null,state:'unavailable',reason:'identity_reconciliation_missing'})).toContain('identity');
 expect(metricExplanation({value:null,state:'unavailable',reason:'qualified_quote_mapping_missing'})).toContain('quote evidence');
});

it('labels maturing and provisional cohorts beside their rates',()=>{
 expect(cohortMaturity({value:.04,state:'partial',reason:'cohort_maturing_30_days'})).toBe('Reply window still open');
 expect(cohortMaturity({value:.04,state:'available'},true)).toBe('Reply window still open');
 expect(cohortMaturity({value:null,state:'unavailable'})).toBe('Reply history unavailable');
});

it('identifies the loaded sequence in a retained snapshot',()=>{
 expect(snapshotLabel({from:'2026-09-01',to:'2026-10-01',sequence:'a'},'SWPPP - AGC')).toContain('SWPPP - AGC');
});

it('compares full calendar months and current-month elapsed days',()=>{
 expect(comparisonWindow({from:'2026-09-01',to:'2026-10-01'},'lastmonth')).toEqual({from:'2026-08-01',to:'2026-09-01'});
 expect(comparisonWindow({from:'2026-10-01',to:'2026-10-03'},'month')).toEqual({from:'2026-09-01',to:'2026-09-03'});
 expect(comparisonWindow({from:'2026-03-01',to:'2026-03-31'},'month')).toEqual({from:'2026-02-01',to:'2026-03-01'});
});
