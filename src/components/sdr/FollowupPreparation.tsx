import {useEffect,useRef,useState} from 'react';
import type {FollowupDraftResponse} from '../../lib/sdrFollowupDraftApi';
import {salesLoopApi,type PreparedProposal,type PreparationSourceRef,type SalesLoopView} from '../../lib/sdrSalesLoopApi';
import {canApplyProposal,type PreparationRequest} from './followupPreparationState';

export default function FollowupPreparation({leadId,current,blocked,getSnapshot,onApply,api=salesLoopApi}:{leadId:string;current:FollowupDraftResponse;blocked:boolean;getSnapshot:()=>PreparationRequest;onApply:(proposal:PreparedProposal)=>void;api?:typeof salesLoopApi}){
 const [view,setView]=useState<SalesLoopView|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState(''),[pending,setPending]=useState(false),[retry,setRetry]=useState(0);
 const [proposal,setProposal]=useState<{value:PreparedProposal;request:PreparationRequest}|null>(null);
 const active=useRef(true),latest=useRef(getSnapshot);latest.current=getSnapshot;
 const notes=current.context.records.filter(record=>record.entity==='note'&&record.text);
 useEffect(()=>{active.current=true;let cancelled=false;setLoading(true);setError('');setView(null);setProposal(null);
  void api.read(leadId).then(result=>{if(!cancelled)setView(result);}).catch(()=>{if(!cancelled)setError('Could not load preparation status.');}).finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;active.current=false;};
 },[api,leadId,retry]);
 const selectedId=notes.some(note=>note.id===selected)?selected:notes[0]?.id||'';
 const prepare=async()=>{
  if(!selectedId||blocked||pending||view?.preparation.status!=='available')return;
  const request=latest.current(),sourceRef:PreparationSourceRef={kind:'crm_note',id:selectedId};
  setPending(true);setError('');setProposal(null);
  try{const value=await api.prepare(leadId,sourceRef,request.editorVersion);
   if(!active.current)return;
   if(!canApplyProposal(request,latest.current())||value.contextToken!==request.contextToken||value.revision!==request.revision||value.editorRequestVersion!==request.editorVersion){setError('The draft or source changed. Review it and prepare again.');return;}
   setProposal({value,request});
  }catch(cause){if(active.current)setError((cause as Error&{status?:number}).status===503?'Preparation is unavailable. Your draft is unchanged.':'Could not prepare a proposal. Your draft is unchanged.');}
  finally{if(active.current)setPending(false);}
 };
 const apply=()=>{if(!proposal||blocked||!canApplyProposal(proposal.request,latest.current())){setError('The draft changed. Prepare again before applying.');setProposal(null);return;}onApply(proposal.value);setProposal(null);};
 return <section className="fu-draft-context" aria-label="Optional response preparation" aria-busy={loading||pending}>
  <h3>Prepare from project evidence</h3>
  {loading?<p role="status">Checking preparation…</p>:error?<div><p role="alert" className="fu-warning">{error} Your private text is unchanged. Continue writing or retry the status check.</p>{!view&&<button className="fu-button" type="button" onClick={()=>setRetry(value=>value+1)}>Retry status</button>}</div>:null}
  {view&&<p>Original task: {view.nextAction?`${view.nextAction.taskId} · owner ${view.nextAction.ownerId||'unknown'} · due ${view.nextAction.dueDate||'unknown'}`:'No direct open task verified'} · Quote and order: unverified.</p>}
  {view&&(notes.length?<label>Source note <select style={{minHeight:44,maxWidth:'100%',marginLeft:8}} value={selectedId} disabled={blocked||pending} onChange={event=>{setSelected(event.target.value);setProposal(null);}}>{notes.map(note=><option key={note.id} value={note.id}>{note.id} · {note.subject||note.text.slice(0,55)}</option>)}</select></label>:<p>No exact direct note source is available for preparation.</p>)}
  {view?.preparation.status==='unavailable'&&<p role="status">AI preparation is unavailable. You can still write, save and preview a private draft.</p>}
  {notes.length>0&&view?.preparation.status==='available'&&<button className="fu-button" type="button" disabled={blocked||pending} onClick={()=>void prepare()}>{pending?'Preparing…':'Prepare proposal'}</button>}
  {proposal&&<div><p>Source: {proposal.value.source.provenance.kind} {proposal.value.source.provenance.id||''}. Review the original record before applying.</p><p>Missing facts: {proposal.value.missingFacts.join('; ')||'None identified; verify independently.'}</p><p><strong>{proposal.value.subject}</strong></p><pre>{proposal.value.body}</pre><button className="fu-button" type="button" disabled={blocked} onClick={apply}>Apply to private draft</button></div>}
 </section>;
}
