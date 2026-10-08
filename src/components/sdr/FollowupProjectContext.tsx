import {useEffect,useRef,useState} from 'react';
import {sdrCrmApi,type FollowupProjectContextData,type CrmRecentRecord} from '../../lib/sdrCrmApi';
import {getToken} from '../../lib/sdrApi';
import {parentCrmUrl} from './followupNavigation';
const when=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT':'Unknown';
function SourceLink({url,children}:{url:string|null;children:React.ReactNode}){const safe=parentCrmUrl(url);return safe?<a className="fu-source" href={safe} target="_blank" rel="noopener noreferrer">{children}</a>:null;}
function Recent({record,label}:{record:CrmRecentRecord;label:string}){return <div><strong>{label} · origin unverified</strong>{record.subject&&<p>{record.subject}{record.subjectTruncated?' (preview truncated)':''}</p>}<p>{record.text}{record.textTruncated?' (preview truncated)':''}</p><p className="fu-task-source">{record.entity} {record.id} · Source updated {when(record.sourceUpdatedAt)} · Observed {when(record.observedAt)} · Read started {when(record.sourceReadStartedAt)}</p><p className="fu-task-source">{record.entity==='note'?`Recorded creation ${when(record.eventAt)}`:'Completion time not established'}</p><SourceLink url={record.sourceUrl}>Open parent CRM record</SourceLink></div>;}
export function ProjectContextDetails({data}:{data:FollowupProjectContextData}){
 return <div className="fu-context-details"><p><strong>{data.lead.title||'Untitled project'}</strong> · Lead owner: {data.lead.ownerName||data.lead.ownerId||'Unassigned'}</p><p>{data.lead.contactName||'Contact unverified'}{data.lead.contactEmail?` · ${data.lead.contactEmail}`:''}</p>
 <p className="fu-task-source">Project {data.lead.id} · Source updated {when(data.lead.sourceUpdatedAt)} · Observed {when(data.lead.observedAt)}</p><SourceLink url={data.lead.sourceUrl}>Open project in Pipedrive</SourceLink>
 {data.holds.map(hold=><p className="fu-restriction" key={hold.id}>App outreach hold: {hold.reason} <span>Provider stop {hold.providerStopStatus==='confirmed'?'confirmed':`${hold.providerStopStatus}; queued mail may still send`}.</span></p>)}
 <p><strong>{data.openTaskCount} observed open {data.openTaskCount===1?'task':'tasks'}</strong> · All dates and owners{data.tasksLimited?` · Showing ${data.tasks.length}; more in Pipedrive`:''}</p>
 {!data.tasks.length&&<p>No open task in the available collected records.</p>}
 {data.tasks.map(task=><details key={task.id}><summary>{task.subject||'Untitled activity'} · {task.dueDate||'No date'}</summary><p>Task {task.id} · Owner: {task.ownerName||task.ownerId||'Unassigned'} · {task.type||'Activity'}</p><p>Original CRM date: {task.dueDate||'No date'}{task.dueTime?` · ${task.dueTime} (CRM time)`:''}</p>{task.subjectTruncated&&<p>Subject preview truncated.</p>}<p>{task.note}{task.noteTruncated?' (preview truncated)':''}</p><p className="fu-task-source">Source updated {when(task.sourceUpdatedAt)} · Observed {when(task.observedAt)}</p><SourceLink url={task.sourceUrl}>Open parent CRM record</SourceLink><p>Complete or reschedule the original task in Pipedrive.</p></details>)}
 {data.recentRecords.note&&<Recent record={data.recentRecords.note} label="Recent CRM note"/>}{data.recentRecords.completedCall&&<Recent record={data.recentRecords.completedCall} label="CRM call marked complete"/>}
 {!data.recentRecords.note&&!data.recentRecords.completedCall&&<p>No recent note or completed call in the available collected records.</p>}
 <details><summary>Context coverage</summary><p>Current collected CRM records, checked {when(data.coverage.asOf)}. History is partial; this read does not refresh Pipedrive. Open tasks use direct, unambiguous project links; recent notes and calls cover 90 days.</p><p>Quote delivery and website order status are unknown. Exact project-linked email evidence is unavailable here.</p>{data.coverage.scopes.map(scope=><p key={scope.scope}>{scope.scope}: {scope.status} · Checked {when(scope.checkedAt)}{scope.errorCategory?' · Collection has gaps':''}</p>)}</details>
 </div>;
}
export default function FollowupProjectContext({leadId}:{leadId:string}){
 const [open,setOpen]=useState(false),[data,setData]=useState<{leadId:string;token:string|null;value:FollowupProjectContextData}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null);
 const generation=useRef(0),identity=useRef(typeof window==='undefined'?null:getToken());
 useEffect(()=>{const requests=generation,transport=request;return()=>{requests.current++;transport.current?.abort();};},[leadId]);
 useEffect(()=>{const reset=()=>{const next=getToken();if(next===identity.current)return;identity.current=next;generation.current++;request.current?.abort();setOpen(false);setData(null);setError('');setLoading(false);};window.addEventListener('sdr-session-changed',reset);window.addEventListener('sdr-session-expired',reset);window.addEventListener('storage',reset);return()=>{window.removeEventListener('sdr-session-changed',reset);window.removeEventListener('sdr-session-expired',reset);window.removeEventListener('storage',reset);};},[]);
 const current=data?.leadId===leadId&&data.token===(typeof window==='undefined'?null:getToken())?data.value:null;
 const load=async()=>{const attempt=++generation.current,token=getToken();request.current?.abort();const controller=new AbortController();request.current=controller;setOpen(true);setLoading(true);setError('');setData(null);
  try{const value=await sdrCrmApi.followupContext(leadId,controller.signal);if(attempt===generation.current&&token===getToken())setData({leadId,token,value});}
  catch{if(attempt===generation.current&&token===getToken())setError('Project context unavailable. Check access or try again.');}
  finally{if(attempt===generation.current&&token===getToken())setLoading(false);}
 };
 return <div className="fu-project-context"><button className="fu-button" type="button" aria-expanded={open} onClick={()=>{if(open){generation.current++;request.current?.abort();setLoading(false);setOpen(false);setData(null);setError('');}else void load();}}>{open?'Hide project context':'Load project context'}</button>
 {open&&<div>{loading&&<p role="status">Loading project context…</p>}{error&&<p role="alert">{error}</p>}{current&&<ProjectContextDetails data={current}/>}<button className="fu-button" type="button" disabled={loading} onClick={()=>void load()}>{error?'Retry context':'Refresh collected context'}</button></div>}</div>;
}
