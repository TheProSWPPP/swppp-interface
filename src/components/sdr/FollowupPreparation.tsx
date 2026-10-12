import {useEffect,useRef,useState} from 'react';
import type {FollowupDraftResponse} from '../../lib/sdrFollowupDraftApi';
import {salesLoopApi,type PreparedProposal,type PreparationSourceRef,type SalesLoopView,type PreparationAction} from '../../lib/sdrSalesLoopApi';
import {canApplyProposal,isConversationReviewCurrent,type ConversationReview,type PreparationRequest} from './followupPreparationState';

export default function FollowupPreparation({leadId,current,blocked,getSnapshot,onApply,api=salesLoopApi}:{leadId:string;current:FollowupDraftResponse;blocked:boolean;getSnapshot:()=>PreparationRequest;onApply:(proposal:PreparedProposal&{subject:string;body:string})=>void;api?:typeof salesLoopApi}){
 const [view,setView]=useState<SalesLoopView|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState(''),[pending,setPending]=useState(false),[retry,setRetry]=useState(0);
 const [proposal,setProposal]=useState<{value:PreparedProposal;request:PreparationRequest}|null>(null);
 const [action,setAction]=useState<PreparationAction|''>(''),[reviewed,setReviewed]=useState<ConversationReview|null>(null);
 const active=useRef(true),latest=useRef(getSnapshot);latest.current=getSnapshot;
 const notes=current.context.records.filter(record=>record.entity==='note'&&record.text);
 useEffect(()=>{active.current=true;let cancelled=false;setLoading(true);setError('');setView(null);setProposal(null);setAction('');setReviewed(null);
  void api.read(leadId).then(result=>{if(!cancelled)setView(result);}).catch(()=>{if(!cancelled)setError('Could not load preparation status.');}).finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;active.current=false;};
 },[api,leadId,retry]);
 const selectedId=notes.some(note=>note.id===selected)?selected:notes[0]?.id||'';
 const reviewContext={leadId,contextToken:current.contextToken,revision:current.draft?.revision||0,sourceId:selectedId,action};
 const conversationReviewed=isConversationReviewCurrent(reviewed,reviewContext);
 const prepare=async()=>{
  if(!selectedId||!action||action==='reply'&&!conversationReviewed||blocked||pending||view?.preparation.status!=='available')return;
  const request=latest.current(),sourceRef:PreparationSourceRef={kind:'crm_note',id:selectedId};
  setPending(true);setError('');setProposal(null);
  try{const value=await api.prepare(leadId,sourceRef,request.editorVersion,action,conversationReviewed);
   if(!active.current)return;
   if(!canApplyProposal(request,latest.current())||value.contextToken!==request.contextToken||value.revision!==request.revision||value.editorRequestVersion!==request.editorVersion){setError('The draft or source changed. Review it and prepare again.');return;}
   setProposal({value,request});
  }catch(cause){if(active.current)setError((cause as Error&{status?:number}).status===503?'Preparation is unavailable. Your draft is unchanged.':'Could not prepare a proposal. Your draft is unchanged.');}
  finally{if(active.current)setPending(false);}
 };
 const apply=()=>{if(!proposal||proposal.value.action!==action||proposal.value.action!=='reply'||proposal.value.subject===null||proposal.value.body===null||!conversationReviewed||blocked||!canApplyProposal(proposal.request,latest.current())){setError('The draft changed. Prepare again before applying.');setProposal(null);return;}onApply({...proposal.value,subject:proposal.value.subject,body:proposal.value.body});setProposal(null);};
 return <section className="fu-draft-context" aria-label="Optional response preparation" aria-busy={loading||pending}>
  <h3>Review next action</h3>
  {loading?<p role="status">Checking preparation…</p>:error?<div><p role="alert" className="fu-warning">{error} Your private text is unchanged. Continue writing or retry the status check.</p>{!view&&<button className="fu-button" type="button" onClick={()=>setRetry(value=>value+1)}>Retry status</button>}</div>:null}
  {view&&<div>
   <p>Current CRM owner: {view.owner.name||view.owner.id||'unverified'}</p>
   {(view.activities||[]).length>0&&<details><summary>CRM activities ({view.activities!.length})</summary>{view.activities!.map(item=><p key={item.id}><strong>{item.subject||item.type||'Activity'}</strong><br/>{item.status==='recorded_complete'?'Recorded complete':item.status==='open'?'Open':'Status unknown'} · owner {item.ownerId||'unknown'}{item.dueDate?` · due ${item.dueDate}`:''}<br/>{item.note}{item.textTruncated?'…':''}</p>)}<p>Completion is the CRM status. Actual performance and connection to this handoff are unverified.</p></details>}
   {view.evidence&&<details><summary>Context and coverage</summary>{view.evidence.records.map(item=><p key={`${item.entity}:${item.id}`}>{item.text}{item.textTruncated?'…':''}<br/><small>{item.entity} {item.id}{item.sourceUpdatedAt?` · updated ${String(item.sourceUpdatedAt).slice(0,10)}`:''}</small></p>)}<p>{view.evidence.messages.length} exact-linked message records. Message bodies have not been read for this review. Pipedrive email coverage: {view.evidence.coverage.pipedriveMail}.</p>{(view.evidence.coverage.recordsLimited||view.evidence.coverage.activitiesLimited||view.evidence.coverage.messagesLimited)&&<p>Additional records fall outside this bounded view.</p>}</details>}
  </div>}
  {view&&(notes.length?<label>Source note <select style={{minHeight:44,maxWidth:'100%',marginLeft:8}} value={selectedId} disabled={blocked||pending} onChange={event=>{setSelected(event.target.value);setProposal(null);setReviewed(null);}}>{notes.map(note=><option key={note.id} value={note.id}>{note.id} · {note.subject||note.text.slice(0,55)}</option>)}</select></label>:<p>No exact direct note source is available for preparation.</p>)}
  {view&&<label>Reviewed action <select style={{minHeight:44,maxWidth:'100%',marginLeft:8}} value={action} disabled={blocked||pending} onChange={event=>{setAction(event.target.value as PreparationAction|'');setReviewed(null);setProposal(null);}}><option value="">Choose after reviewing the records</option><option value="reply">Customer reply</option><option value="call">Call</option><option value="wait">Wait for milestone</option><option value="quote_lookup">Locate or verify quote</option><option value="operations">Operations follow-up</option><option value="identity_resolution">Resolve project or contact</option><option value="no_action">No new action</option></select></label>}
  {action==='reply'&&<label style={{display:'block',marginTop:8}}><input type="checkbox" checked={conversationReviewed} disabled={blocked||pending} onChange={event=>{setReviewed(event.target.checked?reviewContext:null);setProposal(null);}}/> I checked the latest buyer conversation and staff response, including available .com correspondence.</label>}
  {view?.preparation.status==='unavailable'&&<p role="status">Automatic preparation is off. Review the records and continue with your existing Pipedrive task.</p>}
  {notes.length>0&&view?.preparation.status==='available'&&<button className="fu-button" type="button" disabled={blocked||pending||!action||action==='reply'&&!conversationReviewed} onClick={()=>void prepare()}>{pending?'Preparing…':'Prepare selected action'}</button>}
  {proposal&&<div><p><strong>Internal review</strong><br/>{proposal.value.reason}</p><p>Source: {proposal.value.source.provenance.kind} {proposal.value.source.provenance.id||''}.</p><p>Unresolved: {proposal.value.missingFacts.join('; ')||'Review source coverage before acting.'}</p>{proposal.value.action==='reply'&&proposal.value.subject!==null&&proposal.value.body!==null?<><p><strong>{proposal.value.subject}</strong></p><pre>{proposal.value.body}</pre><button className="fu-button" type="button" disabled={blocked||!conversationReviewed} onClick={apply}>Apply customer text to private draft</button></>:<p>No customer draft prepared. Existing tasks and private text are unchanged.</p>}</div>}
 </section>;
}
