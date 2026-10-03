import { ArrowUpRight,Mail,MessageCircle } from 'lucide-react';
import type { MetricsResponse } from '../../../lib/sdrMetricsApi';
import { metricText,metricExplanation,shiftDate,cohortMaturity } from './metricDisplay';
export default function OutreachActivity({data,onNavigate}:{data:MetricsResponse;onNavigate:(target:string)=>void}) {
  const {first_touches:first,followups_completed:followup,messages_completed:total,human_reply_rate:reply,positive_reply_rate:positive}=data.metrics;
  const hasComposition=first.state!=='unavailable'&&followup.state!=='unavailable'&&first.value!==null&&followup.value!==null;
  const sum=hasComposition?first.value!+followup.value!:0;
  const firstShare=sum>0?first.value!/sum*100:0;
  const replyKnown=reply.state!=='unavailable'&&reply.value!==null;
  return <section className="sdr-activity-panel" aria-labelledby="outreach-activity-title">
    <div className="sdr-panel-heading"><div><h2 id="outreach-activity-title">The conversations you’re starting</h2><p>Period sending activity; first-touch cohort replies.</p></div><Mail size={20} aria-hidden="true"/></div>
    <div className="sdr-activity-body"><div className="sdr-send-composition"><div className="sdr-chart-total"><strong>{metricText(total,'count')}</strong><span>emails sent{total.state==='partial'?' · Partial data':''}</span></div>
      <div className={`sdr-composition-bar ${!hasComposition?'is-unknown':''}`} role="img" aria-label={hasComposition?`${metricText(first,'count')} first emails and ${metricText(followup,'count')} follow-ups`:'Email breakdown unavailable'}>
        {hasComposition&&sum>0&&<><span style={{width:`${firstShare}%`}}/><span style={{width:`${100-firstShare}%`}}/></>}
      </div>
      <div className="sdr-composition-legend"><div><span className="sdr-legend-dot"/><span>First emails</span><strong>{metricText(first,'count')}</strong>{first.state==='partial'&&<small>Partial</small>}</div><div><span className="sdr-legend-dot followup"/><span>Follow-ups</span><strong>{metricText(followup,'count')}</strong>{followup.state==='partial'&&<small>Partial</small>}</div></div>
      <p className="sdr-chart-note">Recorded sends. Delivery is not confirmed.</p>
    </div><div className="sdr-reply-summary"><MessageCircle size={19} aria-hidden="true"/><div className="sdr-reply-number">{metricText(reply,'rate')}</div><h3>of the first-touch cohort replied</h3><p>{replyKnown&&reply.numerator!=null&&reply.denominator!=null?`${reply.numerator.toLocaleString('en-US')} of ${reply.denominator.toLocaleString('en-US')} people in the first-touch cohort`:'Verified reply links are needed to measure this.'}</p><p className="sdr-cohort-maturity">{cohortMaturity(reply,data.window.provisional)}</p><p>Cohort: {data.window.from} through {shiftDate(data.window.to,-1)}. Observation cutoff: {data.observation_cutoff?new Date(data.observation_cutoff).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT':'Unknown'}.</p><span className="sdr-state sdr-state-partial">{reply.state==='partial'||reply.state==='unavailable'?metricExplanation({...reply,numerator:undefined,denominator:undefined})||'Reply history incomplete':'30-day reply window'}</span><div className="sdr-positive-replies"><span>Interested replies</span><strong>{metricText(positive,'rate')}</strong>{positive.state==='partial'&&<small>Partial</small>}</div></div></div>
    <div className="sdr-panel-footer"><span>Replies exclude automatic responses and bounces.</span><button onClick={()=>onNavigate('inbox')}>Open inbox <ArrowUpRight size={15} aria-hidden="true"/></button></div>
  </section>;
}
