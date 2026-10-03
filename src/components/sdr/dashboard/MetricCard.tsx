import { useEffect,useId,useState } from 'react';
import { Info,type LucideIcon } from 'lucide-react';
import type { Metric } from '../../../lib/sdrMetricsApi';
import { metricText,metricExplanation,type MetricFormat } from './metricDisplay';
export default function MetricCard({label,metric,format='count',detail,previous,icon:Icon,maturity,compact=false}:{label:string;metric:Metric;format?:MetricFormat;detail:string;previous?:Metric;icon?:LucideIcon;maturity?:string;compact?:boolean}) {
  const explanation=format==='rate'&&metric.reason==='incomplete_coverage'?`${metricExplanation({...metric,reason:undefined})}Complete history is needed to calculate this rate.`:metricExplanation(metric);
  const helpId=useId();
  const [showHelp,setShowHelp]=useState(false);
  useEffect(()=>{
    if(!showHelp) return;
    const dismiss=(event:KeyboardEvent)=>{if(event.key==='Escape') setShowHelp(false);};
    document.addEventListener('keydown',dismiss);
    return ()=>document.removeEventListener('keydown',dismiss);
  },[showHelp]);
  return <article aria-label={label} className={`sdr-metric sdr-metric-${metric.state}`}>
    <div className="sdr-metric-heading">
      <div className="sdr-metric-label">{Icon && <Icon aria-hidden="true" className="h-4 w-4"/>}<h3>{label}</h3></div>
      <div className="sdr-help" onMouseEnter={()=>setShowHelp(true)} onMouseLeave={event=>{if(!event.currentTarget.contains(document.activeElement)) setShowHelp(false);}}>
        <button type="button" aria-label={`About ${label}`} aria-describedby={showHelp?helpId:undefined} onFocus={()=>setShowHelp(true)} onBlur={()=>setShowHelp(false)} onClick={()=>setShowHelp(true)}><Info aria-hidden="true" className="h-4 w-4"/></button>
        {showHelp && <div id={helpId} role="tooltip" className="sdr-help-content">{detail}{explanation && <p>{explanation}</p>}</div>}
      </div>
    </div>
    <div className={`sdr-metric-value ${metric.value==null||metric.state==='unavailable'?'sdr-metric-unknown':''}`}>{compact&&metric.state==='unavailable'?<span aria-label="Unavailable">Unavailable</span>:metricText(metric,format)}</div>
    {maturity&&metric.state!=='unavailable'&&<p className="sdr-cohort-maturity">{maturity}</p>}
    {!compact&&<p className="sdr-metric-description">{detail}</p>}
    <div className="sdr-metric-footnote">
      {metric.state!=='available' && !(compact&&metric.state==='unavailable') && <span className={`sdr-state sdr-state-${metric.state}`}>{metric.state==='partial'?'Partial data':'Not available yet'}</span>}
      {explanation && (!compact || metric.state==='unavailable') && <p>{explanation}</p>}
    </div>
    {previous && <p className="sdr-previous">Previous period: {metricText(previous,format)}{previous.state==='partial'?' (partial data)':''}</p>}
  </article>;
}
