import type {Metric, MetricsResponse} from '../../lib/sdrMetricsApi';
import {monthlySales,type SalesMonth} from '../sdr/dashboard/salesMonths';

export type SalesMeasure = 'sales' | 'revenue' | 'average';
export type TrendMonth = SalesMonth & {inProgress?:boolean};

// Complete months from the selected period, then the current month to date when it directly follows them.
export function trendMonths(data:MetricsResponse, inProgress?:MetricsResponse):TrendMonth[] {
  const rows:TrendMonth[] = monthlySales(data.activity,data.window);
  if (!inProgress || inProgress.window.from!==data.window.to) return rows;
  return [...rows,...monthlySales(inProgress.activity,inProgress.window).filter(row=>!rows.some(item=>item.month===row.month)).map(row=>({...row,inProgress:true}))];
}
const keys = {sales:'company_won_deals', revenue:'company_won_booked_value', average:'company_average_won_deal_value'} as const;

export function monthMetric(data:MetricsResponse|undefined, row:SalesMonth|undefined, measure:SalesMeasure):Metric {
  if (!data || !row) return {value:null,state:'unavailable'};
  const source = data.metrics[keys[measure]];
  const dateWarning = data.company_sales?.date_warnings?.some(warning=>warning.month===row.month);
  const state = row.partialMonth ? 'partial' : source.reason==='crm_sales_dates_need_review' && !dateWarning ? 'available' : source.state;
  if (measure==='average' && state==='available' && row.valuedWins===0) return {value:null,state:'unavailable',reason:'no_valued_wins'};
  return {...source,value:row[measure],state,reason:dateWarning?'crm_sales_dates_need_review':row.partialMonth?'partial_month':state==='available'?undefined:source.reason};
}

export function comparable(current:Metric, previous:Metric):boolean {
  return current.state==='available' && previous.state==='available' && current.value!==null && previous.value!==null;
}

export function changeTone(current:Metric, previous:Metric):string {
  if (!comparable(current,previous)) return 'unknown';
  return current.value! > previous.value! ? 'up' : current.value! < previous.value! ? 'down' : 'flat';
}

export const salesAmount=(value:number|null,currency=false)=>value===null?'Unavailable':new Intl.NumberFormat('en-US',currency?{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}:{maximumFractionDigits:0}).format(value);
