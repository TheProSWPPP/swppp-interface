import {useId,useState} from 'react';
import type {MetricsResponse} from '../../../lib/sdrMetricsApi';
import {monthlySales} from './salesMonths';
import {metricText,shiftDate} from './metricDisplay';
const monthLabel=(month:string)=>new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'America/Chicago'});
const amount=(value:number|null,currency=false)=>value===null?'Unavailable':metricText({value,state:'available'},currency?'currency':'count');
export default function MonthlySales({data,stale,onSelectMonth}:{data:MetricsResponse;stale:boolean;onSelectMonth:(from:string,to:string)=>void}) {
  const id=useId();
  const [metric,setMetric]=useState<'sales'|'revenue'>('sales');
  const [chart,setChart]=useState<'bars'|'line'>('bars');
  const rows=monthlySales(data.activity||[],data.window);
  const salesState=data.metrics.company_won_deals.state;
  const revenueState=data.metrics.company_won_booked_value.state;
  const averageState=data.metrics.company_average_won_deal_value.state;
  const state=metric==='sales'?salesState:revenueState;
  const max=Math.max(1,...rows.map(row=>row[metric]||0));
  const plotWidth=Math.max(600,rows.length*78);
  const x=(index:number)=>rows.length===1?plotWidth/2:40+index*(plotWidth-80)/(rows.length-1);
  const path=rows.map((row,index)=>{const value=row[metric];if(value===null)return '';
    const command=index>0&&rows[index-1][metric]!==null&&rows[index-1].to===row.from?'L':'M';return `${command}${x(index)},${150-value/max*130}`;}).join(' ');
  const description=rows.map(row=>`${monthLabel(row.month)}: ${amount(row[metric],metric==='revenue')}${metric==='sales'?' sales':''}`).join('; ');
  return <section className="sdr-monthly-sales sdr-timeline" aria-labelledby={`${id}-title`}>
    <div className="sdr-results-heading"><div><h2 id={`${id}-title`}>Sales by month</h2><p>Sales count and booked revenue · All company channels · Chicago time</p></div>
      <div className="sdr-monthly-controls"><div className="sdr-mode" role="group" aria-label="Monthly sales metric">{(['sales','revenue'] as const).map(value=><button type="button" key={value} className="sdr-mode-button" aria-pressed={metric===value} onClick={()=>setMetric(value)}>{value==='sales'?'Sales count':'Booked revenue'}</button>)}</div>
      <div className="sdr-mode" role="group" aria-label="Monthly chart style">{(['bars','line'] as const).map(value=><button type="button" key={value} className="sdr-mode-button" aria-pressed={chart===value} onClick={()=>setChart(value)}>{value==='bars'?'Bars':'Line'}</button>)}</div></div>
    </div>
    <p className="sdr-timeline-note">{stale?'This retained snapshot is stale. ':''}{state==='partial'?'Recorded totals; selected metric coverage is incomplete. ':state==='unavailable'?'Company sales are unavailable for this view. ':''}Open a month below to inspect its dates. Booked revenue is USD; average sale uses only USD sales with a known value.</p>
    {!rows.length?<p className="sdr-timeline-note">Monthly sales history is unavailable. Refresh the dashboard to retry.</p>:<>
      {chart==='bars'?<div className="sdr-monthly-bars" role="group" aria-label={`Monthly ${metric==='sales'?'sales count':'booked revenue'} chart`}>{rows.map(row=><div className="sdr-monthly-column" key={row.month}><span className="sdr-monthly-value">{amount(row[metric],metric==='revenue')}</span><div className="sdr-monthly-track"><span className={`sdr-monthly-bar ${row[metric]===null?'is-unavailable':''}`} style={{height:row[metric]===null?'100%':`${(row[metric]||0)/max*100}%`}}/></div><span>{monthLabel(row.month)}</span>{row.partialMonth&&<small>Partial month</small>}</div>)}</div>:<div className="sdr-monthly-line"><div style={{minWidth:plotWidth}}><svg viewBox={`0 0 ${plotWidth} 190`} role="img" aria-labelledby={`${id}-chart-title ${id}-chart-description`}><title id={`${id}-chart-title`}>Monthly {metric==='sales'?'sales count':'booked revenue'}</title><desc id={`${id}-chart-description`}>{description}</desc><path d={`M40,150H${plotWidth-40}`} className="sdr-monthly-baseline"/><path d={path} className="sdr-monthly-path"/>{rows.map((row,index)=>row[metric]!==null&&<circle key={row.month} cx={x(index)} cy={150-(row[metric]||0)/max*130} r="4" className="sdr-monthly-dot"/>)}{rows.map((row,index)=><text key={`label-${row.month}`} x={x(index)} y="180" textAnchor="middle" className="sdr-monthly-axis-label">{monthLabel(row.month)}</text>)}</svg></div></div>}
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm"><caption className="px-5 py-3 text-left text-slate-600">Recorded monthly totals{salesState==='partial'?' · Partial sales history':''}. Each sale counted once by its Pipedrive deal ID and won date.</caption><thead className="border-y border-slate-100 bg-slate-50"><tr><th className="px-5 py-3 text-left">Month</th><th className="px-5 py-3 text-right">Sales count</th><th className="px-5 py-3 text-right">Booked revenue{revenueState!=='available'&&<span className="block text-xs font-normal">{revenueState==='partial'?'Partial values':'Unavailable'}</span>}</th><th className="px-5 py-3 text-right">Average sale{averageState!=='available'&&<span className="block text-xs font-normal">{averageState==='partial'?'Known USD values only':'Unavailable'}</span>}</th><th className="px-5 py-3 text-right">Sales change</th></tr></thead><tbody>{rows.map((row,index)=>{const previous=rows[index-1];const change=previous&&previous.to===row.from&&!row.partialMonth&&!previous.partialMonth&&row.sales!==null&&previous.sales!==null?row.sales-previous.sales:null;return <tr key={row.month} className="border-b border-slate-100"><th scope="row" className="px-5 py-2 text-left font-normal"><button type="button" className="sdr-month-link" onClick={()=>onSelectMonth(row.from,row.to)}>{monthLabel(row.month)}</button>{row.partialMonth&&<span className="block text-xs text-slate-600">Partial month: {row.from} through {shiftDate(row.to,-1)}</span>}</th><td className="px-5 py-3 text-right tabular-nums">{amount(row.sales)}</td><td className="px-5 py-3 text-right tabular-nums">{amount(row.revenue,true)}</td><td className="px-5 py-3 text-right tabular-nums">{amount(row.average,true)}</td><td className="px-5 py-3 text-right tabular-nums">{change===null?'Unavailable':`${change>0?'+':''}${change} sales`}</td></tr>;})}</tbody></table></div>
    </>}
    <p className="sdr-timeline-note">Sales change compares adjacent complete calendar months in this view. Missing or clipped months are not compared. Partial history can undercount totals.</p>
  </section>;
}
