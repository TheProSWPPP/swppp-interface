import {useCallback,useEffect,useRef,useState} from 'react';
import {ExternalLink,RefreshCw} from 'lucide-react';
import {crmPlainText,crmFollowupUnavailableMessage} from './crmViewState';
import {sdrCrmApi,type CrmFollowUp,type CrmHealth} from '../../lib/sdrCrmApi';

const when=(value:string|null|undefined)=>value?new Date(value).toLocaleString():'Unknown';
const plain=crmPlainText;
const dueAge=(value:string|null)=>{
  if(!value) return 'No due date';
  const days=Math.floor((Date.now()-new Date(`${value}T00:00:00`).getTime())/86_400_000);
  return days>0?`${days} days overdue`:days===0?'Due today':`Due in ${-days} days`;
};
const sourceLink=(value:string|null)=>value&&/^https:\/\/[^/]*pipedrive\.com\//i.test(value)?value:null;

export default function CrmFollowUps({onOpenLead}:{onOpenLead:(leadId:string)=>void}) {
  const requestGeneration=useRef(0);
  const invalidateRequests=useCallback(()=>{requestGeneration.current++;},[]);
  const [items,setItems]=useState<CrmFollowUp[]|null>(null);
  const [health,setHealth]=useState<CrmHealth|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [unavailable,setUnavailable]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [lifecycle,setLifecycle]=useState('active');
  const [owner,setOwner]=useState('all');
  const [activityType,setActivityType]=useState('all');
  const [userNames,setUserNames]=useState<Record<string,string>>({});
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const load=useCallback(async(cursor:string|null=null)=>{
    const generation=++requestGeneration.current;
    setLoading(true);setError(null);
    try {
      const params=new URLSearchParams();
      if(lifecycle!=='all') params.set('lifecycle',lifecycle);
      if(owner!=='all') params.set('ownerId',owner);
      if(activityType!=='all') params.set('activityType',activityType);
      if(cursor) params.set('cursor',cursor);
      const data=await sdrCrmApi.followups(params.size?`?${params}`:'');
      if(generation!==requestGeneration.current)return;
      setUnavailable(data.unavailable||null);
      setItems(previous=>cursor?[...(previous||[]),...data.items]:data.items);setHealth(data.freshness);setNextCursor(data.nextCursor);
    } catch(cause) {if(generation===requestGeneration.current)setError((cause as Error).message);} finally {if(generation===requestGeneration.current)setLoading(false);}
  },[lifecycle,owner,activityType]);
  useEffect(()=>{void load();return invalidateRequests;},[load,invalidateRequests]);
  useEffect(()=>{sdrCrmApi.users().then(data=>setUserNames(Object.fromEntries(data.users.map(user=>[user.id,user.name])))).catch(()=>{});},[]);
  const coverage=health?.scopes?.find(scope=>scope.scope==='activities');
  const owners=Object.entries(userNames).length?Object.entries(userNames):Array.from(new Map((items||[]).filter(item=>item.ownerId).map(item=>[item.ownerId!,item.ownerName||item.ownerId!])).entries());
  return <section className="space-y-4" aria-label="CRM follow-ups">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-xl font-bold text-[#0c2039]">CRM follow-ups</h1><p className="text-sm text-slate-600">Open Pipedrive tasks and calls linked to projects. Old overdue tasks are backlog, not proof of a current opportunity.</p></div>
      <div className="flex flex-wrap items-center gap-2"><label className="text-xs font-semibold text-slate-600" htmlFor="crm-lifecycle">Lifecycle</label><select id="crm-lifecycle" value={lifecycle} onChange={event=>setLifecycle(event.target.value)} className="min-h-10 rounded border border-slate-300 bg-white px-2 text-sm"><option value="all">All</option><option value="active">Active</option><option value="archived">Archived</option></select><label className="text-xs font-semibold text-slate-600" htmlFor="crm-owner">Owner</label><select id="crm-owner" value={owner} onChange={event=>setOwner(event.target.value)} className="min-h-10 rounded border border-slate-300 bg-white px-2 text-sm"><option value="all">All owners</option>{owners.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><label className="text-xs font-semibold text-slate-600" htmlFor="crm-activity-type">Activity</label><select id="crm-activity-type" value={activityType} onChange={event=>setActivityType(event.target.value)} className="min-h-10 rounded border border-slate-300 bg-white px-2 text-sm"><option value="all">All types</option><option value="call">Calls</option><option value="task">Tasks</option><option value="email">Email activities</option></select><button type="button" onClick={()=>void load()} disabled={loading} className="inline-flex min-h-10 items-center gap-1 rounded border border-slate-300 px-3 text-sm font-semibold text-[#173e66] disabled:opacity-50"><RefreshCw size={15}/>Refresh</button></div>
    </div>
    <p className="text-xs text-slate-600">Activity coverage: {coverage?.status||'unknown'} · last checked {when(coverage?.checkedAt)}{health?.inbox?.dead?` · ${health.inbox.dead} events need attention`:''}</p>
    {loading&&<p role="status" className="rounded border border-slate-200 p-4 text-sm text-slate-600">Loading CRM follow-ups…</p>}
    {error&&<div role="alert" className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">Could not load CRM follow-ups: {error}<button type="button" onClick={()=>void load()} className="ml-3 font-semibold underline">Retry</button></div>}
    {!loading&&!error&&unavailable&&<p role="alert" className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{crmFollowupUnavailableMessage(unavailable)}</p>}
    {!loading&&!error&&!unavailable&&items?.length===0&&<p className="rounded border border-slate-200 p-4 text-sm text-slate-600">No open follow-ups in the observed CRM records for this filter. Check coverage before treating this as complete.</p>}
    {!error&&!unavailable&&Boolean(items?.length)&&<div className="overflow-x-auto rounded border border-slate-200"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-[#edf3f9] text-xs font-semibold uppercase tracking-wide text-[#173e66]"><tr><th className="px-3 py-2">Due</th><th className="px-3 py-2">Follow-up</th><th className="px-3 py-2">Owner</th><th className="px-3 py-2">Project</th><th className="px-3 py-2">Source</th></tr></thead><tbody>{items?.map(item=><tr key={item.id} className="border-t border-slate-200 align-top"><td className="whitespace-nowrap px-3 py-3">{item.dueDate||'No date'} {item.dueTime||''}<div className="text-xs text-slate-500">{dueAge(item.dueDate)}</div></td><td className="px-3 py-3"><strong className="text-[#0c2039]">{item.subject||'Untitled activity'}</strong><div className="text-xs text-slate-500">{item.type==='email'?'Email activity · not a send receipt':item.type||'Activity type unknown'}</div>{item.note&&<p className="mt-1 max-w-xl whitespace-pre-wrap text-xs text-slate-600">{plain(item.note)}</p>}</td><td className="px-3 py-3">{item.ownerName||userNames[item.ownerId||'']||'Owner unknown'}</td><td className="px-3 py-3"><button type="button" onClick={()=>onOpenLead(item.leadId)} className="font-semibold text-[#173e66] underline" title={item.leadId}>{item.leadTitle||'Untitled project'}</button><div className="text-xs text-slate-500">{item.leadLifecycle||'Lifecycle unknown'}</div></td><td className="px-3 py-3 text-xs">Last CRM change {when(item.sourceUpdatedAt)}{sourceLink(item.sourceUrl)&&<a href={sourceLink(item.sourceUrl)!} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 font-semibold text-[#173e66] underline">Pipedrive <ExternalLink size={12}/></a>}</td></tr>)}</tbody></table></div>}
    {!error&&!unavailable&&nextCursor&&<button type="button" onClick={()=>void load(nextCursor)} disabled={loading} className="min-h-10 rounded border border-slate-300 px-3 font-semibold text-[#173e66] disabled:opacity-50">{loading?'Loading more…':'Load more follow-ups'}</button>}
  </section>;
}
