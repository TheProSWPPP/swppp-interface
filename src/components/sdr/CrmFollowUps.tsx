import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,CalendarClock,ExternalLink,RefreshCw,ShieldAlert} from 'lucide-react';
import {crmPlainText,crmFollowupUnavailableMessage} from './crmViewState';
import {sdrCrmApi,type CrmFollowUp,type CrmHealth,type CrmRecentRecord} from '../../lib/sdrCrmApi';
import {groupFollowups,followupNextAction,followupDue,chicagoDay} from './followupView';
import FollowupReview from './FollowupReview';
import {leadInboxHref,parentCrmUrl} from './followupNavigation';
import './followups.css';

const when=(value:string|null|undefined)=>value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Unknown';
const whenWithYear=(value:string|null|undefined)=>value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Unknown';
const views=[['current','Current work'],['later','Later / undated'],['backlog','Older tasks'],['all','All tasks']] as const;
const stopText=(status:string)=>status==='confirmed'?'Provider stop confirmed':`Provider stop ${['unresolved','unverified','requested'].includes(status)?status:'status unknown'}. Queued mail may still send.`;

function RecentRecord({record,kind}:{record:CrmRecentRecord;kind:'note'|'call'}){
 const url=parentCrmUrl(record.sourceUrl);
 return <div>
   <p><strong>{kind==='note'?'CRM note':'CRM call marked complete'}</strong> · source record updated {whenWithYear(record.sourceUpdatedAt)} · origin unverified</p>
   <p>{kind==='note'?`Recorded creation time ${whenWithYear(record.eventAt)}.`:'Completion time not established.'}</p>
   {record.subject&&<p>Subject: {crmPlainText(record.subject)}{record.subjectTruncated?' Preview truncated.':''}</p>}
   {record.text&&<p>{crmPlainText(record.text)}{record.textTruncated?' Preview truncated.':''}</p>}
   <p>Source {record.entity} {record.id} · Snapshot observed {whenWithYear(record.observedAt)} · Source read started {whenWithYear(record.sourceReadStartedAt)}</p>
   {url&&<a className="fu-source" href={url} target="_blank" rel="noopener noreferrer">Open verified parent CRM record<ExternalLink size={14} aria-hidden="true"/></a>}
 </div>
}

export function FollowupProjectCard({leadId,project,tasks,today,ownerName,onOpenLead}:{leadId:string;project:CrmFollowUp;tasks:CrmFollowUp[];today:string;ownerName:(id:string|null|undefined,name:string|null|undefined)=>string;onOpenLead:(id:string)=>void}){
 return <article className="fu-project" key={leadId}>
   <header className="fu-project-heading"><h2><button type="button" onClick={()=>onOpenLead(leadId)}>{project.leadTitle||'Untitled project'}<ArrowRight size={17} aria-hidden="true"/></button></h2><span className="fu-lead-owner">Lead owner: <strong>{ownerName(project.leadOwnerId,project.leadOwnerName)}</strong></span>{Boolean(project.restrictions?.length)&&<span className="fu-held"><ShieldAlert size={15} aria-hidden="true"/>App outreach hold</span>}</header>
   <div className="fu-nav"><a className="fu-source" href={leadInboxHref(leadId)} target="_blank" rel="noopener noreferrer">Find a conversation for this project<ExternalLink size={14} aria-hidden="true"/></a><p>Searches conversations for this project's current contact. Other threads may exist; check the task and project history.</p></div>
   {project.restrictions?.map(hold=><p key={hold.id} className="fu-restriction">{crmPlainText(hold.reason)} <span>{stopText(hold.providerStopStatus)}</span></p>)}
   {followupNextAction(project)&&<div className="fu-next"><strong>Next step</strong><span>{followupNextAction(project)}</span></div>}
   {project.attention&&<div className="fu-reply">Recent reply · received {when(project.attention.receivedAt)}<span>{project.lastReply?.staffResponseAt?`Response recorded ${when(project.lastReply.staffResponseAt)}. Other follow-up may be missing.`:'Response status unknown.'}</span><details><summary>Reply evidence</summary><p>Linked to this project · Classification: {project.lastReply?.intent?.replaceAll('_',' ')||'unknown'} · Mailbox: {project.attention.mailbox}</p><p>Message {project.attention.providerMessageId} · Gmail source {project.attention.sourceMessageId} · Verification: {project.attention.linkEvidence}</p><p>Detected {when(project.attention.detectedAt)} · Fact observed {when(project.attention.factObservedAt)}. Connected inbox history is partial.</p><p>Displayed CRM task updated at source {when(project.sourceUpdatedAt)} · Snapshot observed {when(project.observedAt)}. These times do not prove a staff response.</p></details></div>}
   {project.recentRecords&&<details className="fu-project-context fu-recent"><summary>Recent CRM records</summary>
    {project.recentRecords.status==='unavailable'?<p>CRM record context unavailable for this project. Check the source and collection coverage.</p>:<>
     {!project.recentRecords.note&&!project.recentRecords.completedCall&&<p>No recent CRM record in available observations; coverage may be partial.</p>}
     {project.recentRecords.note&&<RecentRecord record={project.recentRecords.note} kind="note"/>}
     {project.recentRecords.completedCall&&<RecentRecord record={project.recentRecords.completedCall} kind="call"/>}
    </>}
    <p>Project-linked email context unavailable in this read. This does not establish whether staff emailed the buyer.</p>
    <p>Notes collection: {project.recentRecords.coverage.notes.status} · Checked {whenWithYear(project.recentRecords.coverage.notes.checkedAt)}. Activities collection: {project.recentRecords.coverage.activities.status} · Checked {whenWithYear(project.recentRecords.coverage.activities.checkedAt)}. Context checked {whenWithYear(project.recentRecords.asOf)}; history may be partial.</p>
   </details>}
   <ul className="fu-tasks">{tasks.map(task=>{const due=task.dueLocalDate??task.dueDate;return <li key={task.id} className={due&&due<today?'is-overdue':due===today?'is-today':''}><div className="fu-due"><CalendarClock size={16} aria-hidden="true"/><strong>{followupDue(due)}</strong><span>{due||'No date'}{task.dueLocalTime?` · ${task.dueLocalTime} CT`:''}</span></div><div className="fu-task"><strong>{task.subject||'Untitled activity'}</strong><div>{task.type==='email'?'Email activity · not a send receipt':task.type||'Activity'} · Task owner: {ownerName(task.ownerId,task.ownerName)}</div><details><summary>Notes and source</summary>{task.note&&<p>{crmPlainText(task.note)}</p>}<p>Complete or reschedule the original task in Pipedrive. Logging a new activity here does not close this task.</p>{parentCrmUrl(task.sourceUrl)&&<a className="fu-source" href={parentCrmUrl(task.sourceUrl)!} target="_blank" rel="noopener noreferrer">Open parent CRM record · task {task.id}<ExternalLink size={14}/></a>}<span className="fu-task-source">Task {task.id} · Source updated {when(task.sourceUpdatedAt)} · Snapshot observed {when(task.observedAt)}</span><span className="fu-task-source">Original CRM date: {task.dueDate||'No date'}{task.dueTime?` · ${task.dueTime} UTC`:''}</span></details></div></li>;})}</ul>
   <details className="fu-project-context"><summary>Contact and context</summary><p>{project.contactName||'Contact unverified'}{project.contactEmail?` · ${project.contactEmail}`:''}</p><p>Quote delivery: {project.quoteStatus==='unverified'?'Unverified':'Not recorded'}. Check the email thread before referring to a sent quote.</p>{project.leadLifecycle!=='active'&&<p>Project: {project.leadLifecycle||'Unknown'}</p>}{parentCrmUrl(project.sourceUrl)&&<a className="fu-source" href={parentCrmUrl(project.sourceUrl)!} target="_blank" rel="noopener noreferrer">Open project in Pipedrive<ExternalLink size={14} aria-hidden="true"/></a>}</details>
  </article>
}

export default function CrmFollowUps({onOpenLead,isAdmin=false}:{onOpenLead:(leadId:string)=>void;isAdmin?:boolean}) {
 const [pane,setPane]=useState<'tasks'|'review'>('tasks');
 const requestGeneration=useRef(0);
 const authorization=useRef<string|null>(null),loaded=useRef<CrmFollowUp[]>([]);
 const [items,setItems]=useState<CrmFollowUp[]|null>(null);
 const [health,setHealth]=useState<CrmHealth|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [pageError,setPageError]=useState<{message:string;cursor:string}|null>(null);
 const [unavailable,setUnavailable]=useState<string|null>(null);
 const [loading,setLoading]=useState(true);
 const [dueView,setDueView]=useState('current');
 const [lifecycle,setLifecycle]=useState('active');
 const [owner,setOwner]=useState('all');
 const [activityType,setActivityType]=useState('non_linkedin');
 const [userNames,setUserNames]=useState<Record<string,string>>({});
 const [ownerOptions,setOwnerOptions]=useState<Array<{id:string;name:string|null}>>([]);
 const [nextCursor,setNextCursor]=useState<string|null>(null);
 const [replyCoverage,setReplyCoverage]=useState<'partial'|'unknown'>('unknown');
 const [lastCollectedAt,setLastCollectedAt]=useState<string|null>(null);
 const load=useCallback(async(cursor:string|null=null)=>{
  const generation=++requestGeneration.current;
  setLoading(true);setError(null);setPageError(null);
  if(!cursor){loaded.current=[];authorization.current=null;setItems(null);setNextCursor(null);setUnavailable(null);setOwnerOptions([]);setHealth(null);setReplyCoverage('unknown');setLastCollectedAt(null);}
  try {
   const params=new URLSearchParams({dueView,context:'1'});
   if(lifecycle!=='all')params.set('lifecycle',lifecycle);
   if(owner!=='all')params.set('ownerId',owner);
   if(activityType!=='all')params.set('activityType',activityType);
   if(cursor)params.set('cursor',cursor);
   const data=await sdrCrmApi.followups(`?${params}`);
   if(generation!==requestGeneration.current)return;
   if(cursor&&(authorization.current!==data.authorization||data.items.some(item=>loaded.current.some(existing=>existing.leadId===item.leadId&&existing.attention?.providerMessageId!==item.attention?.providerMessageId)))){
    loaded.current=[];authorization.current=null;setItems(null);setHealth(null);setOwnerOptions([]);setNextCursor(null);setReplyCoverage('unknown');setLastCollectedAt(null);void load();return;
   }
   authorization.current=data.authorization||null;
   if(cursor){
    const touched=new Map(data.items.map(item=>[item.leadId,item.recentRecords]));
    loaded.current=[...loaded.current.map(item=>touched.has(item.leadId)?{...item,recentRecords:touched.get(item.leadId)}:item),...data.items];
   }else loaded.current=data.items;
   setUnavailable(data.unavailable||null);
   setItems(data.unavailable?[]:loaded.current);
   setHealth(data.freshness);setNextCursor(data.nextCursor);
   setReplyCoverage(data.replyCoverage?.status||'unknown');
   setLastCollectedAt(data.replyCoverage?.lastCollectedAt||null);
   if(data.owners?.length||owner==='all')setOwnerOptions(data.owners||[]);
  }catch(cause){
   if(generation!==requestGeneration.current)return;
   const failure=cause as Error&{status?:number};
   if(cursor&&(failure.status===409||failure.status===400||failure.status===401||failure.status===403)){loaded.current=[];authorization.current=null;setItems(null);setHealth(null);setOwnerOptions([]);setNextCursor(null);setReplyCoverage('unknown');setLastCollectedAt(null);void load();return;}
   if(cursor&&failure.status!==401&&failure.status!==403)setPageError({message:failure.message,cursor});
   else{loaded.current=[];authorization.current=null;setItems(null);setHealth(null);setOwnerOptions([]);setNextCursor(null);setReplyCoverage('unknown');setLastCollectedAt(null);setError(failure.message);}
  }finally{if(generation===requestGeneration.current)setLoading(false);}
 },[dueView,lifecycle,owner,activityType]);
 useEffect(()=>{const generation=requestGeneration;if(pane==='tasks')void load();else{generation.current++;loaded.current=[];authorization.current=null;setItems(null);setNextCursor(null);setLoading(false);}return ()=>{generation.current++;};},[load,pane]);
 useEffect(()=>{if(isAdmin)sdrCrmApi.users().then(data=>setUserNames(Object.fromEntries(data.users.map(user=>[user.id,user.name])))).catch(()=>{});},[isAdmin]);
 const coverage=health?.scopes?.find(scope=>scope.scope==='activities');
 const ownerName=(id:string|null|undefined,name:string|null|undefined)=>name||userNames[id||'']||(id?`Owner ${id}`:'Unassigned');
 const groups=groupFollowups(items||[]),today=chicagoDay();
 return <section className="crm-followups" aria-label="CRM follow-ups">
  <header className="fu-heading"><div><h1>Follow-ups</h1><p>Calls, tasks and recent sales context.</p></div>{pane==='tasks'&&<button type="button" onClick={()=>void load()} disabled={loading} className="fu-button"><RefreshCw size={16} aria-hidden="true"/>Refresh</button>}</header>
  <div className="fu-views" role="group" aria-label="Follow-up view"><button type="button" aria-pressed={pane==='tasks'} onClick={()=>setPane('tasks')}>Open tasks</button><button type="button" aria-pressed={pane==='review'} onClick={()=>setPane('review')}>Review next steps</button></div>
  {pane==='review'?<FollowupReview onOpenLead={onOpenLead}/>:<>
  <div className="fu-views" role="group" aria-label="Follow-up period">{views.map(([value,label])=><button type="button" key={value} aria-pressed={dueView===value} onClick={()=>setDueView(value)}>{label}</button>)}</div>
  <div className="fu-filters">
   <label>Task owner<select value={owner} onChange={e=>setOwner(e.target.value)}><option value="all">All owners</option>{ownerOptions.map(({id,name})=><option key={id} value={id}>{ownerName(id,name)}</option>)}</select></label>
   <label>Activity<select value={activityType} onChange={e=>setActivityType(e.target.value)}><option value="non_linkedin">Calls & tasks (no LinkedIn)</option><option value="linkedin_reminder">LinkedIn reminders</option><option value="all">All types</option><option value="call">Calls</option><option value="task">Tasks</option><option value="email">Email activities</option></select></label>
   <label>Project status<select value={lifecycle} onChange={e=>setLifecycle(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label>
  </div>
  <div className="fu-coverage"><span>{dueView==='current'?'Recent replies may bring older dated tasks here. Otherwise: today, previous 14 days and next 7 days. Chicago time.':dueView==='backlog'?'Tasks overdue by more than 14 days. A recent reply may also bring one into Current.':dueView==='later'?'Tasks due beyond the next 7 days, plus tasks without a date.':'All observed open tasks for these filters.'}</span><span>Activity sync: {coverage?.status||'unknown'} · Checked {when(coverage?.checkedAt)}{coverage?.status==='partial'?' · Some activities may be missing.':''} · Reply coverage {replyCoverage}{lastCollectedAt?` · Oldest eligible inbox collection ${when(lastCollectedAt)}; history may be incomplete.`:''}</span></div>
  {activityType==='linkedin_reminder'&&<p className="fu-state">CRM reminders only. This view does not send LinkedIn invitations or messages.</p>}
  {health?.scopes.some(s=>s.errorCategory)&&<p className="fu-coverage">CRM collection has gaps. Check the source before treating absent records as missing work.</p>}
  {loading&&!items&&<p role="status" className="fu-state">Loading follow-ups…</p>}
  {error&&<div role="alert" className="fu-state fu-warning">Could not load follow-ups. {error}<button type="button" onClick={()=>void load()} className="fu-button">Retry</button></div>}
  {!loading&&!error&&unavailable&&<p role="alert" className="fu-state fu-warning">{crmFollowupUnavailableMessage(unavailable)}</p>}
  {!loading&&!error&&!unavailable&&items?.length===0&&<div className="fu-state"><strong>No open tasks in this view.</strong><p>Try another period or owner.{coverage?.status==='partial'?' Some activities may be missing.':''}</p><button type="button" className="fu-button" onClick={()=>{setDueView('all');setOwner('all');setActivityType('non_linkedin');setLifecycle('active');}}>View all active tasks</button></div>}
  {!error&&!unavailable&&groups.length>0&&<><p className="fu-count">{groups.length} projects · {groups.reduce((total,group)=>total+group.tasks.length,0)} tasks loaded{nextCursor?' · More available':''}</p><div className="fu-projects">{groups.map(({leadId,project,tasks})=><FollowupProjectCard key={leadId} leadId={leadId} project={project} tasks={tasks} today={today} ownerName={ownerName} onOpenLead={onOpenLead}/>)}</div></>}
  {pageError&&<div role="alert" className="fu-state fu-warning">Could not load more tasks. Already loaded tasks remain visible.<button type="button" disabled={loading} onClick={()=>void load(pageError.cursor)} className="fu-button">Retry more tasks</button></div>}
  {!error&&!unavailable&&!pageError&&nextCursor&&<button type="button" onClick={()=>void load(nextCursor)} disabled={loading} className="fu-button">{loading?'Loading…':'Load more tasks'}</button>}
 </>}
 </section>;
}
