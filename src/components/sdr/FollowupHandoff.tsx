import {useEffect,useRef,useState,type RefObject} from 'react';
import {getToken} from '../../lib/sdrApi';
import {followupHandoffApi,type HandoffInput} from '../../lib/sdrFollowupHandoffApi';
import {parentCrmUrl} from './followupNavigation';
import {createHandoffSession,notePreviewText,restoreHandoffFocus,handoffConfirmed,handoffPending,handoffUnresolved,type HandoffState} from './followupHandoffState';
const when=(date:string)=>new Date(date).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT';
const initial:HandoffState={phase:'loading',preview:null,receipt:null,attempted:false,error:''};
export function HandoffView({state,reviewed,onReviewed,onPublish,onCheck,onRetry,onNewPreview,currentRevision,focusRef}:{currentRevision:number;focusRef?:RefObject<HTMLElement|null>;onNewPreview:()=>void;state:HandoffState;reviewed:boolean;onReviewed:(value:boolean)=>void;onPublish:()=>void;onCheck:()=>void;onRetry:()=>void}){
 const pending=handoffPending(state),confirmed=handoffConfirmed(state.receipt),preview=state.preview;
 const notAttempted=state.receipt?.status==='not_attempted';
 const earlier=Boolean(state.receipt&&state.receipt.revision!==currentRevision);
 const projectUrl=parentCrmUrl(state.receipt?.projectUrl);
 return <section ref={focusRef} tabIndex={-1} className="fu-handoff" aria-label="Pipedrive note handoff" aria-busy={pending}>
  <h3>Pipedrive lead note</h3><p>Visible to people with access to this lead.</p>
  {pending&&<p role="status">{state.phase==='publishing'?'Adding note…':state.phase==='checking'?'Checking publication status…':'Preparing saved draft preview…'}</p>}
  {state.error&&<p className="fu-warning" role="alert">{state.error}</p>}
  {preview&&!state.attempted&&<>
   <div className="fu-handoff-context"><p><strong>Lead owner:</strong> {preview.owner.name||preview.owner.id||'Unassigned'}</p><p><strong>Contact:</strong> {preview.contact.name||'Unverified'}{preview.contact.email?` · ${preview.contact.email}`:''}</p><p>Checked {when(preview.checkedAt)}</p></div>
   <div className="fu-handoff-preview" tabIndex={0} aria-label="Full Pipedrive note preview"><pre>{notePreviewText(preview.noteHtml)}</pre></div>
   <p className="fu-warning">Latest reply history is unverified.</p>
   <label className="fu-handoff-review"><input type="checkbox" checked={reviewed} disabled={pending} onChange={event=>onReviewed(event.target.checked)}/>I checked the latest conversation in Pipedrive</label>
   <button type="button" className="fu-button fu-handoff-confirm" disabled={!reviewed||pending} onClick={onPublish}>Add draft to Pipedrive</button>
  </>}
  {state.attempted&&<div className="fu-handoff-receipt" role="status">
   <strong>{confirmed?earlier?'Earlier revision published':'Note added to Pipedrive':notAttempted?'Note was not added':earlier?'Earlier revision unconfirmed':'Publication unconfirmed'}</strong>
   {earlier&&<p>Revision {state.receipt?.revision}. Current revision {currentRevision} remains private.</p>}
   {confirmed?<p>Note {state.receipt?.noteId} · Readback verified {state.receipt&&when(state.receipt.checkedAt)}</p>:notAttempted?<p>Preview expired before publication. Save a new revision to preview again.</p>:<p>Check status to verify the existing attempt.</p>}
   {!confirmed&&!notAttempted&&<button type="button" className="fu-button" disabled={pending} onClick={onCheck}>Check status</button>}
   {confirmed&&earlier&&<button type="button" className="fu-button" onClick={onNewPreview}>Preview current revision</button>}
   {projectUrl&&<a className="fu-source" href={projectUrl} target="_blank" rel="noopener noreferrer">Open project in Pipedrive</a>}
  </div>}
  {state.phase==='error'&&!state.attempted&&state.retryable!==false&&<button type="button" className="fu-button" onClick={onRetry}>Retry preview</button>}
 </section>;
}
export default function FollowupHandoff({leadId,expectedRevision,contextToken,onStatus}:{leadId:string;onStatus:(pending:boolean,unresolved:boolean)=>void}&HandoffInput){
 const [state,setState]=useState<HandoffState>(initial),[reviewed,setReviewed]=useState(false);
 const [cycle,setCycle]=useState(0);
 const focusRef=useRef<HTMLElement>(null);
 useEffect(()=>{restoreHandoffFocus(focusRef.current);},[state.phase]);
 const session=useRef<ReturnType<typeof createHandoffSession>|null>(null);
 useEffect(()=>{
  focusRef.current?.focus();
  const token=getToken();
  const current=createHandoffSession({leadId,expectedRevision,contextToken},followupHandoffApi,()=>getToken()===token,next=>{setState(next);onStatus(handoffPending(next),handoffUnresolved(next));});
  session.current=current;void current.load();
  return()=>{current.dispose();session.current=null;onStatus(false,false);};
 },[leadId,expectedRevision,contextToken,onStatus,cycle]);
 return <HandoffView focusRef={focusRef} currentRevision={expectedRevision} onNewPreview={()=>{setReviewed(false);setState(initial);setCycle(value=>value+1);}} state={state} reviewed={reviewed} onReviewed={setReviewed} onPublish={()=>void session.current?.publish(reviewed)} onCheck={()=>void session.current?.check()} onRetry={()=>{setReviewed(false);void session.current?.load();}}/>;
}
