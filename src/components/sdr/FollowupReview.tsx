import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,ExternalLink,RefreshCw} from 'lucide-react';
import {sdrCrmApi,type FollowupReviewProject,type CrmHealth} from '../../lib/sdrCrmApi';
import {crmPlainText,crmFollowupUnavailableMessage} from './crmViewState';

const when=(date:string|null|undefined)=>date?new Date(date).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Unknown';
const safeSource=(url:string|null)=>url&&/^https:\/\/(?:[a-z0-9-]+\.)*pipedrive\.com\//i.test(url)?url:null;
export default function FollowupReview({onOpenLead}:{onOpenLead:(id:string)=>void}) {
 const [items,setItems]=useState<FollowupReviewProject[]>([]),[health,setHealth]=useState<CrmHealth|null>(null);
 const [next,setNext]=useState<string|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null),[unavailable,setUnavailable]=useState<string|null>(null);
 const [retryCursor,setRetryCursor]=useState<string|null>(null);
 const generation=useRef(0);
 const load=useCallback(async(cursor:string|null=null)=>{
  const attempt=++generation.current;setLoading(true);setError(null);setRetryCursor(null);
  if(!cursor){setItems([]);setNext(null);setUnavailable(null);setHealth(null);}
  try{
   const result=await sdrCrmApi.followupReview(cursor?`?cursor=${encodeURIComponent(cursor)}`:'');
   if(attempt!==generation.current)return;
   setItems(previous=>result.unavailable?[]:cursor?[...previous,...result.items]:result.items);
   setNext(result.nextCursor);setHealth(result.freshness);setUnavailable(result.unavailable||null);
  }catch(cause){
   if(attempt!==generation.current)return;
   const failure=cause as Error&{status?:number};
   if(failure.status===401||failure.status===403){setItems([]);setNext(null);}
   setError(failure.message);setRetryCursor(cursor);
  }finally{if(attempt===generation.current)setLoading(false);}
 },[]);
 useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
 return <div className="fu-review">
  <div className="fu-review-intro"><div><h2>Review next steps</h2><p>Recent notes and completed calls on active projects with no open task in the collected CRM records.</p></div><button type="button" className="fu-button" disabled={loading} onClick={()=>void load()}><RefreshCw size={16}/>Refresh</button></div>
  <p className="fu-state fu-warning">Review candidates from partial CRM history. Check the latest conversation, promised timing, contact and holds before acting.</p>
  <details className="fu-review-help"><summary>Review checklist and source coverage</summary><p className="fu-review-guidance">Decide whether to reply, confirm a quote or documents, call, wait for a promised date, coordinate with the PM, review the contact, or close the opportunity. Record the decision on the existing Pipedrive project.</p>
  <div className="fu-coverage"><span>Last 90 days by CRM record update · Up to 5 recent notes/calls per project · Known [Auto] notes excluded</span><span>{['notes','activities','leads'].map(name=>`${name}: ${health?.scopes.find(s=>s.scope===name)?.status||'unknown'} · checked ${when(health?.scopes.find(s=>s.scope===name)?.checkedAt)}`).join(' · ')}</span></div></details>
  {unavailable&&<p className="fu-state fu-warning" role="alert">{crmFollowupUnavailableMessage(unavailable)}</p>}
  {error&&<div className="fu-state fu-warning" role="alert">Could not load review context. {error}<button className="fu-button" type="button" disabled={loading} onClick={()=>void load(retryCursor)}>Retry</button></div>}
  {!unavailable&&items.map(project=><article className="fu-project fu-review-project" key={project.leadId}>
   <header className="fu-project-heading"><h2><button type="button" onClick={()=>onOpenLead(project.leadId)}>{project.title||'Untitled project'}<ArrowRight size={16}/></button></h2><span className="fu-lead-owner">Lead owner: {project.ownerName||(project.ownerId?`Owner ${project.ownerId}`:'Unassigned')}</span></header>
   <ol className="fu-evidence">{project.evidence.map((e,index)=><li key={`${e.entity}:${e.id}`}><details open={index===0}><summary>{e.entity==='note'?'CRM note':'Completed call'} · Record updated {when(e.sourceUpdatedAt)}</summary><p>{crmPlainText(e.text)}</p><span className="fu-task-source">{e.entity} {e.id} · Observed {when(e.observedAt)}</span></details></li>)}</ol>
   {safeSource(project.sourceUrl)&&<footer><a className="fu-source" href={safeSource(project.sourceUrl)!} target="_blank" rel="noreferrer">Check conversation in Pipedrive<ExternalLink size={14}/></a></footer>}
  </article>)}
  {!loading&&!error&&!unavailable&&!items.length&&<p className="fu-state">No review candidates in the available records. This does not confirm every project has a next step.</p>}
  {loading&&<p role="status" className="fu-count">Loading review context…</p>}
  {!error&&!unavailable&&next&&<button type="button" className="fu-button" disabled={loading} onClick={()=>void load(next)}>Load more projects</button>}
 </div>;
}
