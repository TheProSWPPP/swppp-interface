import type { Metric,MetricsQuery } from '../../../lib/sdrMetricsApi';
export type MetricFormat='count'|'rate'|'currency';
export const unavailable:Metric={value:null,state:'unavailable'};
const explanations:Record<string,string>={
  open_tracking_unverified:'Connect and verify email-open tracking to measure this rate.',
  spam_placement_unverified:'Verify inbox or spam placement before measuring this rate.',
  no_denominator:'No records qualify for this rate in this period.',
  incomplete_coverage:'Some history is missing. These totals may be lower than the actual activity.',
  reporting_not_initialized:'Reporting history has not been connected yet.',
  no_visible_mailboxes:'No authorised sender mailboxes are available.',
  cohort_maturing_30_days:'Contacts still have time to reply within the 30-day window.',
  cohort_maturing_60_days:'Projects still have time to win within the 60-day window.',
  reply_links_missing:'Some received replies need a verified message or thread link.',
  outreach_classification_incomplete:'Some outbound messages still need evidence that they were sales outreach rather than warmup or automatic mail.',
  cohort_reconciliation_missing:'The first-touch message IDs need to be checked against the independent source before this rate can be shown.',
  identity_reconciliation_missing:'A contacted address needs a verified project identity before it can enter this cohort.',
  deal_links_missing:'The link between outreach and sales needs to be confirmed.',
  qualified_quote_mapping_missing:'The quote evidence, first quote dates and deal IDs need to be independently reconciled.',
  due_step_receipts_missing:'We need to compare scheduled follow-ups with emails actually sent.',
  duplicate_review_missing:'Possible duplicate emails need review before we can show a rate.',
  accounting_not_connected:'Collected payments are not connected.',
  crm_reconciliation_needed:'Active CRM leads need to be reconciled before supply can be counted.',
  company_sales_admin_only:'Company sales are available to administrators.',
  no_valued_wins:'No won deals with a known USD value in this period.',
  deal_sync_missing:'Sales history collection is incomplete.',
  crm_sales_dates_need_review:'Some deals were marked won in a bulk update. Their original sale dates need review before period comparisons are reliable.',
  inbox_coverage_incomplete:'Received-message history has not been completely collected for this period.',
};
export function metricText(metric:Metric,format:MetricFormat):string {
  if(metric.state==='unavailable') return 'Unavailable';
  if(metric.value==null || !Number.isFinite(metric.value)) return metric.reason==='no_denominator' ? 'No qualifying data' : 'Unavailable';
  if(format==='rate') return `${(metric.value*100).toFixed(1)}%`;
  if(format==='currency') return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(metric.value);
  return new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(metric.value);
}
export function metricExplanation(metric:Metric):string {
  const fraction=metric.numerator!=null && metric.denominator!=null ? `${metric.numerator.toLocaleString('en-US')} / ${metric.denominator.toLocaleString('en-US')}. ` : '';
  return fraction+(metric.reason ? explanations[metric.reason]||'Additional evidence is needed.' : '');
}
export function shiftDate(date:string,days:number):string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime()+days*86400000).toISOString().slice(0,10);
}
export function previousWindow(query:{from:string;to:string}):{from:string;to:string} {
  const days=(new Date(query.to).getTime()-new Date(query.from).getTime())/86400000;
  return {from:shiftDate(query.from,-days),to:query.from};
}
export function comparisonWindow(query:{from:string;to:string},period:string):{from:string;to:string} {
  if(period.endsWith('months')) {const months=Number(period.replace('months',''));const date=new Date(`${query.from}T12:00:00Z`);date.setUTCMonth(date.getUTCMonth()-months);return {from:date.toISOString().slice(0,10),to:query.from};}
  if(period==='lastmonth') return {from:shiftDate(query.from,-1).slice(0,8)+'01',to:query.from};
  if(period==='month') {
    const from=shiftDate(query.from,-1).slice(0,8)+'01';
    const days=(new Date(query.to).getTime()-new Date(query.from).getTime())/86400000;
    const to=shiftDate(from,days);
    return {from,to:to<query.from?to:query.from};
  }
  return previousWindow(query);
}
export function defaultWindow(now=new Date()):{from:string;to:string} {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value]));
  const to=`${parts.year}-${parts.month}-${parts.day}`;
  return {from:shiftDate(to,-30),to};
}

export function snapshotLabel(query:MetricsQuery,sequenceName?:string):string {
  return `${query.from} through ${shiftDate(query.to,-1)} • ${query.mailbox||'All visible senders'} • ${query.source||'All sources'} • ${query.sequence?(sequenceName||'Selected sequence'):'All sequences'} • Chicago time`;
}
export function cohortMaturity(metric:Metric,provisional=false):string {
  return provisional?'Reply window still open':metric.reason?.startsWith('cohort_maturing')?'Reply window still open':metric.state==='partial'?'Reply history incomplete':metric.state==='unavailable'?'Reply history unavailable':'30-day reply window';
}
