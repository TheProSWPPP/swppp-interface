import {useEffect,useState} from 'react';
import {ArrowUpRight,RefreshCw} from 'lucide-react';
import {getRecentReplies,type ReplyContext,type RecentRepliesResponse} from '../../../lib/sdrOperationsApi';
import {runLatestRead} from '../../../lib/sdrReadRequest';
import {replyTime,projectLabel,ownerLabel} from './replyDisplay';
export function OutreachTodaySnapshot({data,onOpenReplies}:{data:RecentRepliesResponse;onOpenReplies?:(context:ReplyContext)=>void}) {
 return <>
  <div className="sdr-today-window"><div><strong>{data.total===null?'Count unavailable':`${data.total.toLocaleString('en-US')} observed ${data.total===1?'reply':'replies'}`}</strong><span>{replyTime(data.context.from)} to {replyTime(data.context.to)} (end excluded) · {data.context.mailbox||'Your visible inboxes'}</span><span>Checked {replyTime(data.context.asOf)} · {data.coverage.state==='partial'?'Partial inbox coverage':'Inbox coverage unknown'}</span></div>{onOpenReplies&&data.state==='available'&&<button className="sdr-reply-button sdr-reply-primary" onClick={()=>onOpenReplies(data.context)}>View recent replies <ArrowUpRight size={17} aria-hidden="true"/></button>}</div>
  {data.state==='unavailable'?<p className="sdr-reply-notice">Recent reply history is unavailable. Buyer work and response status are unknown.</p>:data.total===0?<p className="sdr-reply-notice">No human replies recorded in this window. Coverage may be incomplete.</p>:<ul className="sdr-today-rows">{data.items.map(reply=><li key={reply.id}><div><strong>{reply.prospectEmail||projectLabel(reply)}</strong><span>{projectLabel(reply)} · {ownerLabel(reply)}</span></div><div><span>Incoming {replyTime(reply.receivedAt)}</span><span>{reply.response.status==='recorded'?`Staff touch ${replyTime(reply.response.at)}`:'Needs review · staff response unknown'}</span></div><div><span>Deadline unknown</span><span>{reply.response.status==='recorded'?'Next action unverified':'Next: review conversation'}</span></div></li>)}</ul>}
  <p className="sdr-today-caveat">Live bid status, Qualified 1st Contact / Closing Call stage and deadlines are not verified in this feed. Staff, other inbox and call responses may be missing. {data.coverage.lastCollectedAt&&`Last collection: ${replyTime(data.coverage.lastCollectedAt)}.`}</p>
 </>;
}
export default function OutreachToday({onOpenReplies}:{onOpenReplies?:(context:ReplyContext)=>void}) {
 const [data,setData]=useState<RecentRepliesResponse|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(true),[reload,setReload]=useState(0);
 useEffect(()=>runLatestRead(signal=>getRecentReplies({limit:3},signal),{success:value=>{setData(value);setError(false);},error:()=>setError(true),settled:()=>setLoading(false)}),[reload]);
 const refresh=()=>{setLoading(true);setReload(value=>value+1);};
 return <section className="sdr-today" aria-labelledby="outreach-today-title">
  <header className="sdr-today-heading"><div><h2 id="outreach-today-title">Recent replies</h2></div><button className="sdr-reply-button" onClick={refresh} disabled={loading} aria-label="Refresh recent replies"><RefreshCw size={17} aria-hidden="true"/>{loading?'Checking…':'Refresh replies'}</button></header>
  {error&&<div role="alert" className="sdr-reply-notice">Recent replies could not be refreshed. {data?'The snapshot below is stale. ':''}<button onClick={refresh}>Retry replies</button></div>}
  {!data&&loading&&<p className="sdr-reply-notice" role="status">Loading recent replies…</p>}
  {data&&<div aria-busy={loading}><OutreachTodaySnapshot data={data} onOpenReplies={onOpenReplies}/>{loading&&<p className="sdr-today-updating" role="status">Updating this snapshot…</p>}</div>}
 </section>;
}
