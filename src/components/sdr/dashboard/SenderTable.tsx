import type { MetricsResponse,MetricKey } from '../../../lib/sdrMetricsApi';
import { metricText,metricExplanation,unavailable } from './metricDisplay';
const columns:Array<{key:MetricKey;label:string;rate?:boolean}>=[
  {key:'messages_completed',label:'Emails sent'},{key:'first_touches',label:'First emails'},{key:'followups_completed',label:'Follow-ups'},
  {key:'human_replies_received',label:'Human replies'},{key:'bounce_events',label:'Bounce flags'},{key:'spam_blocked_events',label:'Spam blocks'},{key:'human_reply_rate',label:'Reply rate',rate:true},
];
const rates:Array<{key:MetricKey;label:string}>=[{key:'positive_reply_rate',label:'Interested reply rate'},{key:'followup_completion_rate',label:'Follow-up completion'},{key:'bounce_rate',label:'Bounce rate'}];
export default function SenderTable({senders,names}:{senders:MetricsResponse['senders'];names:Record<string,string>}) {
  const senderName=(sender:MetricsResponse['senders'][number])=><><div className="font-medium text-slate-900">{names[sender.mailbox]||sender.display_name}</div><div className="text-xs text-slate-600">{sender.mailbox}</div></>;
  const visibleColumns=columns.filter(col=>senders.some(sender=>sender.metrics[col.key]?.value!=null&&sender.metrics[col.key]?.state!=='unavailable'));
  const visibleRates=rates.filter(col=>senders.some(sender=>sender.metrics[col.key]?.state==='available'));
  return <><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
    <caption className="p-4 text-left text-sm text-slate-600">Recorded email activity.</caption>
    <thead className="border-y border-slate-100 bg-slate-50"><tr><th className="px-4 py-3 text-left font-medium">Sender</th>{visibleColumns.map(col=><th key={col.key} className="px-3 py-3 text-right font-medium">{col.label}</th>)}</tr></thead>
    <tbody>{senders.map(sender=><tr key={sender.mailbox} className="border-b border-slate-100 align-top"><th scope="row" className="px-4 py-3 text-left font-normal">{senderName(sender)}</th>{visibleColumns.map(col=>{const metric=sender.metrics[col.key]||unavailable;return <td key={col.key} className="px-3 py-3 text-right tabular-nums text-slate-700">{metricText(metric,col.rate?'rate':'count')}{metric.state==='partial'&&<span className="ml-1 text-amber-700">*</span>}</td>;})}</tr>)}</tbody>
  </table></div><p className="p-4 text-sm text-slate-600">* Collected records; history is incomplete.</p>{senders.length===0&&<p className="p-4 text-sm text-slate-600">No authorised sender history is available.</p>}
  {visibleRates.length>0&&<details className="sdr-timeline-records"><summary>Interested replies, follow-up completion and bounce rates</summary><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><caption className="p-4 text-left">Rate totals and the evidence still needed. Follow-up completion requires verified scheduling data.</caption><thead className="border-y border-slate-100 bg-slate-50"><tr><th className="px-4 py-3 text-left">Sender</th>{visibleRates.map(rate=><th key={rate.key} className="px-4 py-3 text-right">{rate.label}</th>)}</tr></thead><tbody>{senders.map(sender=><tr key={sender.mailbox} className="border-b border-slate-100 align-top"><th scope="row" className="px-4 py-3 text-left font-normal">{senderName(sender)}</th>{visibleRates.map(rate=>{const metric=sender.metrics[rate.key]||unavailable;return <td key={rate.key} className="px-4 py-3 text-right"><strong className="font-medium">{metricText(metric,'rate')}{metric.state==='partial'?' (partial)':''}</strong><p className="mt-1 text-left text-xs text-slate-600">{metricExplanation(metric)}</p></td>;})}</tr>)}</tbody></table></div></details>}
  </>;
}
