import type {Metric} from './sdrMetricsApi';
export function comparisonWindow(window:{from:string;to:string}):{from:string;to:string}{
 const from=new Date(window.from+'T12:00:00Z'),to=new Date(window.to+'T12:00:00Z');
 if(window.from.endsWith('-01')&&window.to.endsWith('-01')){
  const months=(to.getUTCFullYear()-from.getUTCFullYear())*12+to.getUTCMonth()-from.getUTCMonth();
  from.setUTCMonth(from.getUTCMonth()-months);return {from:from.toISOString().slice(0,10),to:window.from};
 }
 from.setUTCDate(from.getUTCDate()-(to.getTime()-from.getTime())/86400000);
 return {from:from.toISOString().slice(0,10),to:window.from};
}
export function changeText(current:Metric|undefined,previous:Metric|undefined,currency=false):string{
 if([current?.reason,previous?.reason].some(reason=>reason==='no_valued_wins'||reason==='no_denominator'))return 'No valued sales to compare';
 if(current?.state!=='available'||previous?.state!=='available'||current.value===null||previous.value===null)return current?.reason==='crm_sales_dates_need_review'||previous?.reason==='crm_sales_dates_need_review'?'Comparison unavailable: sale dates need review':'Comparison unavailable: incomplete history';
 const delta=current.value-previous.value;
 const sign=delta<0?'−':delta>0?'+':'';
 const amount=new Intl.NumberFormat('en-US',currency?{style:'currency',currency:'USD',maximumFractionDigits:2}:{maximumFractionDigits:1}).format(Math.abs(delta));
 const percent=previous.value===0?'previously zero':`${delta<0?'−':delta>0?'+':''}${Math.abs(delta/previous.value*100).toFixed(1)}%`;
 return `${sign}${amount} (${percent})`;
}
