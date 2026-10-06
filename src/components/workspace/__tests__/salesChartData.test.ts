import {describe,expect,it} from 'vitest';
import type {MetricsResponse} from '../../../lib/sdrMetricsApi';
import {comparable,monthMetric,changeTone} from '../salesChartData';
import {monthlySales} from '../../sdr/dashboard/salesMonths';

const rows=monthlySales([
 {date:'2026-04-01',company_won_deals:93,company_won_booked_value:167200,company_valued_wins:93},
 {date:'2026-05-01',company_won_deals:37,company_won_booked_value:79558,company_valued_wins:37},
],{from:'2026-04-01',to:'2026-06-01'});
const data={metrics:{company_won_deals:{value:130,state:'partial',reason:'crm_sales_dates_need_review'},company_won_booked_value:{value:246758,state:'partial',reason:'crm_sales_dates_need_review'},company_average_won_deal_value:{value:246758/130,state:'partial',reason:'crm_sales_dates_need_review'}},company_sales:{date_warnings:[{month:'2026-04',count:67,reason:'bulk update'}]}} as MetricsResponse;
describe('sales chart trust boundaries',()=>{
 it('withholds comparisons for flagged months while permitting clean months in the same response',()=>{
  const april=monthMetric(data,rows[0],'sales'),may=monthMetric(data,rows[1],'sales');
  expect(april).toMatchObject({value:93,state:'partial',reason:'crm_sales_dates_need_review'});
  expect(may).toMatchObject({value:37,state:'available'});
  expect(comparable(april,may)).toBe(false);
  expect(changeTone(april,may)).toBe('unknown');
 });
 it('does not turn partial history into available months or invent missing values',()=>{
  const incomplete={...data,metrics:{...data.metrics,company_won_deals:{value:130,state:'partial' as const,reason:'incomplete_coverage'}}};
  expect(monthMetric(incomplete,rows[1],'sales').state).toBe('partial');
  expect(monthMetric(undefined,undefined,'sales')).toEqual({value:null,state:'unavailable'});
  expect(comparable({value:null,state:'available'},{value:0,state:'available'})).toBe(false);
 });
 it('withholds clipped months and preserves weighted averages from valued sales',()=>{
  const clipped={...rows[1],partialMonth:true};
  expect(monthMetric(data,clipped,'revenue').state).toBe('partial');
  expect(monthMetric(data,rows[1],'average').value).toBe(79558/37);
 });
 it('uses numeric signs only for usable values, including real zero',()=>{
  expect(changeTone({value:0,state:'available'},{value:2,state:'available'})).toBe('down');
  expect(changeTone({value:2,state:'available'},{value:0,state:'available'})).toBe('up');
  expect(changeTone({value:2,state:'unavailable'},{value:0,state:'available'})).toBe('unknown');
 });
 it('distinguishes a complete month with no valued sales from incomplete history',()=>{
  expect(monthMetric(data,{...rows[1],sales:0,revenue:0,valuedWins:0,average:null},'average')).toEqual({value:null,state:'unavailable',reason:'no_valued_wins'});
 });
});
