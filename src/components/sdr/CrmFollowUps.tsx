import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,CalendarClock,ExternalLink,RefreshCw,ShieldAlert} from 'lucide-react';
import {crmPlainText,crmFollowupUnavailableMessage} from './crmViewState';
import {sdrCrmApi,type CrmFollowUp,type CrmHealth} from '../../lib/sdrCrmApi';
import {groupFollowups,followupNextAction,followupDue,chicagoDay} from './followupView';
import './followups.css';

const when=(value:string|null|undefined)=>value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Unknown';
const sourceLink=(value:string|null)=>value&&/^https:\/\/(?:[a-z0-9-]+\.)*pipedrive\.com\//i.test(value)?value:null;
const views=[['current','Current work'],['later','Later / undated'],['backlog','Older tasks'],['all','All tasks']] as const;
const stopText=(status:string)=>status==='confirmed'?'Provider stop confirmed':`Provider stop ${['unresolved','unverified','requested'].includes(status)?status:'status unknown'}. Queued mail may still send.`;

export default function CrmFollowUps({onOpenLead,isAdmin=false}:{onOpenLead:(leadId:string)=>void;isAdmin?:boolean}) {
 const requestGeneration=useRef(0);
 const [items,setItems]=useState<CrmFollowUp[]|null>(null);
 const [health,setHealth]=useState<CrmHealth|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [pageError,setPageError]=useState<{message:string;cursor:string}|null>(null);
 const [unavailable,setUnavailable]=useState<string|null>(null);
 const [loading,setLoading]=useState(true);
 const [dueView,setDueView]=useState('current');
 const [lifecycle,setLifecycle]=useState('active');
 const [owner,setOwner]=useState('all');
 const [activityType,setActivityType]=useState('all');
 const [userNames,setUserNames]=useState<Record<string,string>>({});
 const [ownerOptions,setOwnerOptions]=useState<Array<{id:string;name:string|null}>>([]);
 const [nextCursor,setNextCursor]=useState<string|null>(null);
 const load=useCallback(async(cursor:string|null=null)=>{
  const generation=++requestGeneration.current;
  setLoading(true);setError(null);setPageError(null);
  if(!cursor){setItems(null);setNextCursor(null);setUnavailable(null);}
  try {
   const params=new URLSearchParams({dueView,context:'1'});
   if(lifecycle!=='all')params.set('lifecycle',lifecycle);
   if(owner!=='all')params.set('ownerId',owner);
   if(activityType!=='all')params.set('activityType',activityType);
   if(cursor)params.set('cursor',cursor);
   const data=await sdrCrmApi.followups(`?${params}`);
   if(generation!==requestGeneration.current)return;
   setUnavailable(data.unavailable||null);
   setItems(previous=>data.unavailable?[]:cursor?[...(previous||[]),...data.items]:data.items);
   setHealth(data.freshness);setNextCursor(data.nextCursor);
   if(data.owners?.length||owner==='all')setOwnerOptions(data.owners||[]);
  }catch(cause){
   if(generation!==requestGeneration.current)return;
   const failure=cause as Error&{status?:number};
   if(cursor&&failure.status!==401&&failure.status!==403)setPageError({message:failure.message,cursor});
   else{setItems(null);setNextCursor(null);setError(failure.message);}
  }finally{if(generation===requestGeneration.current)setLoading(false);}
 },[dueView,lifecycle,owner,activityType]);
 useEffect(()=>{void load();return ()=>{requestGeneration.current++;};},[load]);
 useEffect(()=>{if(isAdmin)sdrCrmApi.users().then(data=>setUserNames(Object.fromEntries(data.users.map(user=>[user.id,user.name])))).catch(()=>{});},[isAdmin]);
 const coverage=health?.scopes?.find(scope=>scope.scope==='activities');
 const ownerName=(id:string|null|undefined,name:string|null|undefined)=>name||userNames[id||'']||(id?`Owner ${id}`:'Unassigned');
 const groups=groupFollowups(items||[]),today=chicagoDay();
 return <section className="crm-followups" aria-label="CRM follow-ups">
  <header className="fu-heading"><div><h1>Follow-ups</h1><p>Open calls and tasks by project.</p></div><button type="button" onClick={()=>void load()} disabled={loading} className="fu-button"><RefreshCw size={16} aria-hidden="true"/>Refresh</button></header>
  <div className="fu-views" role="group" aria-label="Follow-up period">{views.map(([value,label])=><button type="button" key={value} aria-pressed={dueView===value} onClick={()=>setDueView(value)}>{label}</button>)}</div>
  <div className="fu-filters">
   <label>Task owner<select value={owner} onChange={e=>setOwner(e.target.value)}><option value="all">All owners</option>{ownerOptions.map(({id,name})=><option key={id} value={id}>{ownerName(id,name)}</option>)}</select></label>
   <label>Activity<select value={activityType} onChange={e=>setActivityType(e.target.value)}><option value="all">All types</option><option value="call">Calls</option><option value="task">Tasks</option><option value="email">Email activities</option></select></label>
   <label>Project status<select value={lifecycle} onChange={e=>setLifecycle(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label>
  </div>
  <div className="fu-coverage"><span>{dueView==='current'?'Today first, then the previous 14 days and next 7 days. Chicago time.':dueView==='backlog'?'Tasks overdue by more than 14 days. Review whether they are still relevant.':dueView==='later'?'Tasks due beyond the next 7 days, plus tasks without a date.':'All observed open tasks for these filters.'}</span><span>Activity sync: {coverage?.status||'unknown'} · Checked {when(coverage?.checkedAt)}{coverage?.status==='partial'?' · Some activities may be missing.':''}</span></div>
  {loading&&!items&&<p role="status" className="fu-state">Loading follow-ups…</p>}
  {error&&<div role="alert" className="fu-state fu-warning">Could not load follow-ups. {error}<button type="button" onClick={()=>void load()} className="fu-button">Retry</button></div>}
  {!loading&&!error&&unavailable&&<p role="alert" className="fu-state fu-warning">{crmFollowupUnavailableMessage(unavailable)}</p>}
  {!loading&&!error&&!unavailable&&items?.length===0&&<div className="fu-state"><strong>No open tasks in this view.</strong><p>Try another period or owner.{coverage?.status==='partial'?' Some activities may be missing.':''}</p><button type="button" className="fu-button" onClick={()=>{setDueView('all');setOwner('all');setActivityType('all');setLifecycle('active');}}>View all active tasks</button></div>}
  {!error&&!unavailable&&groups.length>0&&<><p className="fu-count">{groups.length} projects · {groups.reduce((total,group)=>total+group.tasks.length,0)} tasks loaded{nextCursor?' · More available':''}</p><div className="fu-projects">{groups.map(({leadId,project,tasks})=><article className="fu-project" key={leadId}>
   <header className="fu-project-heading"><h2><button type="button" onClick={()=>onOpenLead(leadId)}>{project.leadTitle||'Untitled project'}<ArrowRight size={17} aria-hidden="true"/></button></h2><span className="fu-lead-owner">Lead owner: <strong>{ownerName(project.leadOwnerId,project.leadOwnerName)}</strong></span>{Boolean(project.restrictions?.length)&&<span className="fu-held"><ShieldAlert size={15} aria-hidden="true"/>App outreach hold</span>}</header>
   {followupNextAction(project)&&<div className="fu-next"><strong>Next step</strong><span>{followupNextAction(project)}</span></div>}
   {project.restrictions?.map(hold=><p key={hold.id} className="fu-restriction">{crmPlainText(hold.reason)} <span>{stopText(hold.providerStopStatus)}</span></p>)}
   {project.lastReply&&<div className="fu-reply">Human reply recorded {when(project.lastReply.receivedAt)}{project.lastReply.intent?` · ${project.lastReply.intent.replaceAll('_',' ')}`:''}<span>{project.lastReply.staffResponseAt?`Team response recorded ${when(project.lastReply.staffResponseAt)}`:'Team response not yet recorded'}</span></div>}
   <ul className="fu-tasks">{tasks.map(task=>{const due=task.dueLocalDate??task.dueDate;return <li key={task.id} className={due&&due<today?'is-overdue':due===today?'is-today':''}><div className="fu-due"><CalendarClock size={16} aria-hidden="true"/><strong>{followupDue(due)}</strong><span>{due||'No date'}{task.dueLocalTime?` · ${task.dueLocalTime} CT`:''}</span></div><div className="fu-task"><strong>{task.subject||'Untitled activity'}</strong><div>{task.type==='email'?'Email activity · not a send receipt':task.type||'Activity'} · Task owner: {ownerName(task.ownerId,task.ownerName)}</div><details><summary>Notes and source</summary>{task.note&&<p>{crmPlainText(task.note)}</p>}<span className="fu-task-source">Task {task.id} · Snapshot {when(task.observedAt)}</span><span className="fu-task-source">Original CRM date: {task.dueDate||'No date'}{task.dueTime?` · ${task.dueTime} UTC`:''}</span></details></div></li>;})}</ul>
   <details className="fu-project-context"><summary>Contact and context</summary><p>{project.contactName||'Contact unverified'}{project.contactEmail?` · ${project.contactEmail}`:''}</p><p>Quote delivery: {project.quoteStatus==='unverified'?'Unverified':'Not recorded'}. Check the email thread before referring to a sent quote.</p>{project.leadLifecycle!=='active'&&<p>Project: {project.leadLifecycle||'Unknown'}</p>}{sourceLink(project.sourceUrl)&&<a className="fu-source" href={sourceLink(project.sourceUrl)!} target="_blank" rel="noreferrer">Pipedrive (new tab)<ExternalLink size={14} aria-hidden="true"/></a>}</details>
  </article>)}</div></>}
  {pageError&&<div role="alert" className="fu-state fu-warning">Could not load more tasks. Already loaded tasks remain visible.<button type="button" disabled={loading} onClick={()=>void load(pageError.cursor)} className="fu-button">Retry more tasks</button></div>}
  {!error&&!unavailable&&!pageError&&nextCursor&&<button type="button" onClick={()=>void load(nextCursor)} disabled={loading} className="fu-button">{loading?'Loading…':'Load more tasks'}</button>}
 </section>;
}
