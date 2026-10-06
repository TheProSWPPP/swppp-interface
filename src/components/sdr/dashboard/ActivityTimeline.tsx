import {useId} from 'react';
import type {MetricsResponse} from '../../../lib/sdrMetricsApi';
import {shiftDate} from './metricDisplay';
const dateLabel=(value:string)=>new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/Chicago'});
export default function ActivityTimeline({data}:{data:MetricsResponse}) {
 const id=useId(),activity=data.activity||[],weekly=activity.length>45;
 const repliesAvailable=data.metrics.human_replies_received?.state==='available';
 const points=weekly?activity.reduce<MetricsResponse['activity']>((groups,point,index)=>{
  if(index%7===0)groups.push({...point});else{const group=groups[groups.length-1];group.messages_completed+=point.messages_completed;group.human_replies_received+=point.human_replies_received;}return groups;
 },[]):activity;
 const maximum=Math.max(1,...points.map(point=>point.messages_completed));
 const label=(point:MetricsResponse['activity'][number],index:number)=>`${weekly?`${dateLabel(point.date)} through ${dateLabel(activity[Math.min(index*7+6,activity.length-1)].date)}`:dateLabel(point.date)}: ${point.messages_completed.toLocaleString('en-US')} emails sent${repliesAvailable?`, ${point.human_replies_received.toLocaleString('en-US')} human reply events`:''}`;
 return <section className="sdr-timeline" aria-labelledby={`${id}-title`}>
  <div className="sdr-results-heading"><div><h2 id={`${id}-title`}>Emails over time</h2><p>{dateLabel(data.window.from)} through {dateLabel(shiftDate(data.window.to,-1))} · {weekly?'Weekly totals':'Daily totals'} · Chicago time</p></div></div>
  {points.length?<><div className="sdr-timeline-chart" role="group" aria-label="Recorded email activity by date">{points.map((point,index)=><div key={point.date} className="sdr-timeline-day" tabIndex={0} role="img" aria-label={label(point,index)}><span className="sdr-timeline-bar" style={{height:`${point.messages_completed/maximum*100}%`}}/>{repliesAvailable&&point.human_replies_received>0&&<span className="sdr-timeline-replies" aria-hidden="true"/>}<span className="sdr-enrollment-tooltip" aria-hidden="true">{label(point,index)}</span></div>)}</div><div className="sdr-timeline-axis"><span>{dateLabel(points[0].date)}</span><span>{dateLabel(shiftDate(data.window.to,-1))}</span></div>{repliesAvailable&&<p className="sdr-timeline-legend"><span/> Emails sent <i/> Human replies</p>}</>:<p className="sdr-timeline-note">Daily reporting history is not available for this period yet.</p>}
  {activity.length>0&&<details className="sdr-timeline-records"><summary>Daily records</summary><div className="overflow-x-auto"><table className="w-full text-sm"><caption className="p-4 text-left">Recorded activity for the selected outreach filters.</caption><thead className="border-y border-slate-100 bg-slate-50"><tr><th className="px-4 py-3 text-left">Date (CT)</th><th className="px-4 py-3 text-right">Emails sent</th>{repliesAvailable&&<th className="px-4 py-3 text-right">Human replies</th>}</tr></thead><tbody>{activity.map(point=><tr key={point.date} className="border-b border-slate-100"><th scope="row" className="px-4 py-3 text-left font-normal">{point.date}</th><td className="px-4 py-3 text-right">{point.messages_completed.toLocaleString('en-US')}</td>{repliesAvailable&&<td className="px-4 py-3 text-right">{point.human_replies_received.toLocaleString('en-US')}</td>}</tr>)}</tbody></table></div></details>}
 </section>;
}
