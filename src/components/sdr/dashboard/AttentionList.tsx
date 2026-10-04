import { AlertCircle,ArrowUpRight,CheckCircle2 } from 'lucide-react';
import type { MetricsResponse } from '../../../lib/sdrMetricsApi';
const labels:Record<string,string>={reporting_not_initialized:'Connect email and sales history',reporting_coverage_incomplete:'Check incomplete email and reply history',reporting_stale:'Check the delayed data update',source_links_missing:'Review emails with an unknown lead source',deal_coverage_incomplete:'Complete the sales history for this period'};
export default function AttentionList({items,onNavigate}:{items:MetricsResponse['attention'];onNavigate:(target:string)=>void}) {
  return <section aria-label="Needs attention" className={`sdr-attention ${items.length?'sdr-attention-pending':''}`}>
    <div className="sdr-attention-title">{items.length?<AlertCircle aria-hidden="true"/>:<CheckCircle2 aria-hidden="true"/>}<h2>{items.length?'Before you use these numbers':'Data checks'}</h2></div>
    {items.length===0?<p>No gaps found in the reporting data. Checks for replies needing action and missed follow-ups are not connected yet.</p>:<ul>{items.map(item=><li key={item.kind}>
      <button type="button" onClick={()=>onNavigate(item.target)} className="sdr-attention-action">
        <span>{labels[item.kind]||'Review incomplete data'}{item.oldest_at && <span className="sdr-attention-date">Last full update: {new Date(item.oldest_at).toLocaleDateString('en-US')}</span>}</span><span className="sdr-attention-count">{item.kind==='source_links_missing'?`${item.count.toLocaleString('en-US')} emails`:item.kind==='reporting_coverage_incomplete'?`${item.count.toLocaleString('en-US')} senders`:'Review'} <ArrowUpRight aria-hidden="true" className="h-4 w-4"/></span>
      </button>
    </li>)}</ul>}
  </section>;
}
