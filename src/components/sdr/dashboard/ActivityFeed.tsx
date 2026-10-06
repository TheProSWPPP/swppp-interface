import {useEffect,useRef,useState} from 'react';
import {ArrowDownLeft,ArrowUpRight,Pause,Play,RefreshCw} from 'lucide-react';
import {getActivityFeed,type ActivityFeedResponse,type ActivityKind} from '../../../lib/sdrActivityApi';
import {pipedriveLeadUrl} from '../../../lib/sdrApi';
import './activityFeed.css';

const activityTime=(value:string)=>new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
export function ActivityRows({items,newIds=[]}:{items:ActivityFeedResponse['items'];newIds?:string[]}) {
 return <ol className="sdr-activity-rows">{items.map(item=><li key={item.id} className={`${item.kind==='reply'?'is-reply':'is-sent'}${newIds.includes(item.id)?' is-new':''}`}>
  <span className="sdr-activity-kind">{item.kind==='reply'?<ArrowDownLeft size={15} aria-hidden="true"/>:<ArrowUpRight size={15} aria-hidden="true"/>}{item.kind==='reply'?'Reply':'Sent'}</span>
  <div className="sdr-activity-contact"><strong title={item.contact}>{item.contact}</strong><span>{item.kind==='reply'?'To':'From'} {item.mailbox}{item.projectTitle&&<> · {item.projectTitle}</>}</span></div>
  <time dateTime={item.occurredAt}>{activityTime(item.occurredAt)}</time>
  {item.projectId?<a className="sdr-activity-link" href={pipedriveLeadUrl(item.projectId)} target="_blank" rel="noopener noreferrer" aria-label={`Open project for ${item.contact}`}><ArrowUpRight size={17} aria-hidden="true"/></a>:<span className="sdr-activity-no-link"/>}
 </li>)}</ol>;
}
export default function ActivityFeed({refreshKey}:{refreshKey:number}) {
 const [kind,setKind]=useState<ActivityKind>('all'),[paused,setPaused]=useState(false),[reload,setReload]=useState(0);
 const [snapshot,setSnapshot]=useState<{kind:ActivityKind;data:ActivityFeedResponse}|null>(null),[error,setError]=useState(false),[newIds,setNewIds]=useState<string[]>([]);
 const pauseRef=useRef(false);pauseRef.current=paused;
 const previousRef=useRef<{kind:ActivityKind;data:ActivityFeedResponse}|null>(null);
 const data=snapshot?.kind===kind?snapshot.data:null;
 useEffect(()=>{
  const controller=new AbortController();let busy=false;
  const read=async()=>{
   if(busy)return;busy=true;const startedPaused=pauseRef.current;
   try {
    const next=await getActivityFeed(kind,controller.signal);
    if(controller.signal.aborted||(pauseRef.current&&!startedPaused))return;
    const previous=previousRef.current?.kind===kind?previousRef.current.data:null;
    const known=new Set(previous?.items.map(item=>item.id));
    setNewIds(previous?next.items.filter(item=>!known.has(item.id)).map(item=>item.id):[]);
    previousRef.current={kind,data:next};setSnapshot({kind,data:next});setError(false);
   }catch{if(!controller.signal.aborted)setError(true);}finally{busy=false;}
  };
  void read();
  const timer=window.setInterval(()=>{if(!pauseRef.current&&document.visibilityState==='visible')void read();},30000);
  return ()=>{controller.abort();window.clearInterval(timer);};
 },[kind,reload,refreshKey]);
 return <section className="sdr-activity" aria-labelledby="sdr-activity-title">
  <header><div className="sdr-activity-heading"><h2 id="sdr-activity-title">Latest activity</h2><span className="sdr-activity-status">{error?'Refresh failed':paused?'Updates paused':'Refreshes every 30s'}</span></div>
   <div className="sdr-activity-controls"><div role="group" aria-label="Activity type">{(['all','sent','reply'] as const).map(value=><button key={value} aria-pressed={kind===value} onClick={()=>{setKind(value);setError(false);}}>{value==='all'?'All':value==='sent'?'Sent':'Replies'}</button>)}</div>
    <button onClick={()=>setPaused(value=>!value)} aria-label={paused?'Resume activity updates':'Pause activity updates'} aria-pressed={paused}>{paused?<Play size={16}/>:<Pause size={16}/>}</button>
    <button onClick={()=>setReload(value=>value+1)} aria-label="Refresh activity"><RefreshCw size={16}/></button>
   </div>
  </header>
  <div className="sdr-activity-scroll" tabIndex={0} role="region" aria-label="Recent send and reply events">
   {error&&<p className="sdr-activity-notice" role="alert">Activity could not refresh. {data?'Showing the previous records. ':''}<button onClick={()=>setReload(value=>value+1)}>Retry</button></p>}
   {!data&&!error&&<p className="sdr-activity-notice" role="status">Loading activity…</p>}
   {data&&(data.items.length?<ActivityRows items={data.items} newIds={newIds}/>:<p className="sdr-activity-notice">No {kind==='sent'?'sends':kind==='reply'?'human replies':'events'} recorded in the last 7 days.</p>)}
  </div>
  <footer><span>Last 7 days · Chicago time · Collected records</span><details><summary>Collection times</summary><p>Feed checked: {data?activityTime(data.checkedAt):'Unknown'}<br/>Send sync: {data?.sources.sends?activityTime(data.sources.sends):'Unknown'}<br/>Reply sync: {data?.sources.replies?activityTime(data.sources.replies):'Unknown'}<br/>History may be incomplete. Provider collection runs separately from this feed.</p></details></footer>
 </section>;
}
