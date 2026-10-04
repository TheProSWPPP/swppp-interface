import { useId, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { MetricsResponse } from '../../../lib/sdrMetricsApi';
import { shiftDate, metricText, metricExplanation } from './metricDisplay';

const dateLabel = (value:string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month:'short',day:'numeric',timeZone:'America/Chicago' });
export default function ActivityTimeline({data}:{data:MetricsResponse}) {
  const [view,setView]=useState<'email'|'sales'>('email');
  const id=useId();
  const reduced=useReducedMotion();
  const activity=data.activity||[];
  const weekly=activity.length>45;
  const points=weekly?activity.reduce<MetricsResponse['activity']>((groups,point,index)=>{
    if(index%7===0) groups.push({...point});
    else {
      const group=groups[groups.length-1];
      group.messages_completed+=point.messages_completed;group.human_replies_received+=point.human_replies_received;
      group.company_won_deals=group.company_won_deals===null||point.company_won_deals===null?null:group.company_won_deals+point.company_won_deals;
      group.company_won_booked_value=group.company_won_booked_value===null||point.company_won_booked_value===null?null:group.company_won_booked_value+point.company_won_booked_value;
    }
    return groups;
  },[]):activity;
  const value=(point:MetricsResponse['activity'][number])=>view==='email'?point.messages_completed:point.company_won_booked_value;
  const maximum=Math.max(1,...points.map(point=>value(point)||0));
  const label=(point:MetricsResponse['activity'][number],index:number)=>{
    const range=weekly?`${dateLabel(point.date)} through ${dateLabel(activity[Math.min(index*7+6,activity.length-1)].date)}`:dateLabel(point.date);
    return view==='email'?`${range}: ${point.messages_completed.toLocaleString('en-US')} emails sent, ${point.human_replies_received.toLocaleString('en-US')} human reply events`:`${range}: ${point.company_won_booked_value===null?'company sales unavailable':`${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(point.company_won_booked_value)} company sales, ${point.company_won_deals} won deals`}`;
  };
  return <section className="sdr-timeline" aria-labelledby={`${id}-title`}>
    <div className="sdr-results-heading"><div><h2 id={`${id}-title`}>Activity over time</h2><p>{dateLabel(data.window.from)} through {dateLabel(shiftDate(data.window.to,-1))} · {weekly?'Weekly totals':'Daily totals'} · Chicago time</p></div><div className="sdr-mode" role="group" aria-label="Timeline metric">{(['email','sales'] as const).map(option=><button key={option} type="button" className="sdr-mode-button" aria-pressed={view===option} onClick={()=>setView(option)}>{view===option&&<motion.span className="sdr-tab-highlight" layoutId={`${id}-timeline`} transition={{duration:reduced?0:.18}}/>}<span>{option==='email'?'Emails sent':'Company sales'}</span></button>)}</div></div>
    <p className="sdr-timeline-note">{view==='email'?'Observed sends and human reply events for the selected outreach filters. Partial history can undercount activity.':'All company channels, independent of sender, source and sequence filters. Sales appear on their won date.'}</p>
    {view==='sales' && data.metrics.company_won_booked_value?.state!=='available' && <p className="sdr-timeline-note">{data.metrics.company_won_booked_value?.state==='partial'?'Company sales history is partial. Daily totals may be lower than actual sales.':`Company sales are unavailable. ${data.metrics.company_won_booked_value?metricExplanation(data.metrics.company_won_booked_value):'Connect and verify company sales history.'}`} Hatched dates have no verified sales total.</p>}
    {points.length?<><div className="sdr-timeline-chart" role="group" aria-label={view==='email'?'Recorded email activity by date':'Company won sales by date'}>{points.map((point,index)=><div key={point.date} className="sdr-timeline-day" tabIndex={0} role="img" aria-label={label(point,index)}><motion.span className={`sdr-timeline-bar ${value(point)===null?'is-unavailable':''}`} style={{height:value(point)===null?'100%':`${Math.max(0,(value(point)||0)/maximum*100)}%`}} initial={false} whileHover={reduced?undefined:{scaleY:1.04}} transition={{duration:reduced?0:.15}}/>{view==='email'&&point.human_replies_received>0&&<span className="sdr-timeline-replies" aria-hidden="true"/>}<span className="sdr-enrollment-tooltip" aria-hidden="true">{label(point,index)}</span></div>)}</div><div className="sdr-timeline-axis"><span>{dateLabel(points[0].date)}</span><span>{dateLabel(shiftDate(data.window.to,-1))}</span></div>{view==='email'&&<p className="sdr-timeline-legend"><span/> Blue bars: emails sent <i/> Orange marks: human replies recorded</p>}</>:<p className="sdr-timeline-note">Daily reporting history is not available for this period yet.</p>}
    {activity.length>0 && <details className="sdr-timeline-records"><summary>View recorded daily totals</summary><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><caption className="p-4 text-left">Observed daily records. Email activity follows your filters; company sales include all channels. Partial history can undercount totals.</caption><thead className="border-y border-slate-100 bg-slate-50"><tr><th className="px-4 py-3 text-left">Date (CT)</th><th className="px-4 py-3 text-right">Emails sent</th><th className="px-4 py-3 text-right">Human replies</th><th className="px-4 py-3 text-right">Company sales</th><th className="px-4 py-3 text-right">Orders won</th></tr></thead><tbody>{activity.map(point=><tr key={point.date} className="border-b border-slate-100"><th scope="row" className="px-4 py-3 text-left font-normal">{point.date}</th><td className="px-4 py-3 text-right">{point.messages_completed.toLocaleString('en-US')}</td><td className="px-4 py-3 text-right">{point.human_replies_received.toLocaleString('en-US')}</td><td className="px-4 py-3 text-right">{metricText({value:point.company_won_booked_value,state:point.company_won_booked_value===null?'unavailable':data.metrics.company_won_booked_value?.state||'partial'},'currency')}</td><td className="px-4 py-3 text-right">{point.company_won_deals===null?'Unavailable':point.company_won_deals.toLocaleString('en-US')}</td></tr>)}</tbody></table></div></details>}
  </section>;
}
