import FollowupProjectContext from './FollowupProjectContext';
import FollowupPreparation from './FollowupPreparation';
import FollowupHandoff from './FollowupHandoff';
import type {HandoffInput} from '../../lib/sdrFollowupHandoffApi';
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {followupDraftApi,type FollowupDraftResponse} from '../../lib/sdrFollowupDraftApi';
import {getToken} from '../../lib/sdrApi';
import {applyConflict,isUnsaved,type DraftText} from './followupDraftState';
const empty={subject:'',body:''};
const timestamp=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT':'Unknown';

export default function FollowupDraftEditor({leadId}:{leadId:string}){
 const [open,setOpen]=useState(false),[session,setSession]=useState(0);
 const identity=useRef(typeof window==='undefined'?null:getToken());
 useEffect(()=>{const reset=()=>{const next=getToken();if(next===identity.current)return;identity.current=next;setOpen(false);setSession(s=>s+1);};window.addEventListener('sdr-session-changed',reset);window.addEventListener('sdr-session-expired',reset);window.addEventListener('storage',reset);return()=>{window.removeEventListener('sdr-session-changed',reset);window.removeEventListener('sdr-session-expired',reset);window.removeEventListener('storage',reset);};},[]);
 return <div className="fu-draft-entry"><button type="button" className="fu-button" onClick={()=>setOpen(true)}>Write private draft</button>{open&&<DraftWorkspace key={`${leadId}:${session}`} leadId={leadId} onClose={()=>setOpen(false)}/>}</div>;
}

function DraftWorkspace({leadId,onClose}:{leadId:string;onClose:()=>void}){
 const id=useId(),root=useRef<HTMLDivElement>(null),generation=useRef(0),busy=useRef(false);
 const editorVersion=useRef(0);
 const [current,setCurrent]=useState<FollowupDraftResponse|null>(null),[text,setText]=useState<DraftText>(empty),[saved,setSaved]=useState<DraftText>(empty);
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [conflict,setConflict]=useState<'context'|'revision'|null>(null),[acknowledged,setAcknowledged]=useState(false);
 const [handoff,setHandoff]=useState<HandoffInput|null>(null),[handoffPending,setHandoffPending]=useState(false),[handoffUnresolved,setHandoffUnresolved]=useState(false);
 const handoffBusy=useRef(false);
 const handoffStatus=useCallback((pending:boolean,unresolved:boolean)=>{handoffBusy.current=pending;setHandoffPending(pending);setHandoffUnresolved(unresolved);},[]);
 const dirty=isUnsaved(text,saved);
 const preparationBlocked=dirty||saving||handoffPending||handoffUnresolved||Boolean(handoff)||Boolean(conflict);
 const preparationSnapshot=()=>({leadId,session:getToken(),editorVersion:editorVersion.current,revision:current?.draft?.revision||0,contextToken:current?.contextToken||'',handoffUnresolved:handoffUnresolved||handoffPending||Boolean(handoff)});
 const token=useRef(getToken());
 useEffect(()=>{
  const requests=generation,attempt=++requests.current;
  void followupDraftApi.read(leadId).then(result=>{
   if(attempt!==generation.current||getToken()!==token.current)return;
   setCurrent(result);const initial=result.draft?{subject:result.draft.subject,body:result.draft.body}:empty;setText(initial);setSaved(initial);
   if(result.contextChanged)setConflict('context');
  }).catch(()=>{if(attempt===generation.current)setError('Could not load your draft. Close and try again.');}).finally(()=>{if(attempt===generation.current)setLoading(false);});
  return()=>{requests.current++;};
 },[leadId]);
 useEffect(()=>{
  const leave=(event:BeforeUnloadEvent)=>{if(dirty||busy.current||handoffBusy.current){event.preventDefault();event.returnValue='';}};
  const click=(event:MouseEvent)=>{
   if(!dirty&&!busy.current&&!handoffBusy.current)return;
   const target=event.target as Element;
   if(root.current?.contains(target)||!target.closest?.('a,button,input,select'))return;
   if(busy.current||handoffBusy.current||!window.confirm('Leave this draft? Unsaved text will be lost.')){event.preventDefault();event.stopImmediatePropagation();}
  };
  window.addEventListener('beforeunload',leave);document.addEventListener('click',click,true);
  return()=>{window.removeEventListener('beforeunload',leave);document.removeEventListener('click',click,true);};
 },[dirty]);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.focus();return()=>previous?.focus();},[]);
 useEffect(()=>{
  const openedUrl=window.location.href,openedState=window.history.state;
  const navigate=(event:Event)=>{
   if(!dirty&&!busy.current&&!handoffBusy.current)return;
   if(window.location.href===openedUrl){event.stopImmediatePropagation();return;}
   if(busy.current||handoffBusy.current||!window.confirm('Leave this draft? Unsaved text will be lost.')){
    event.stopImmediatePropagation();window.history.pushState(openedState,'',openedUrl);
   }
  };
  window.addEventListener('popstate',navigate,true);window.addEventListener('hashchange',navigate,true);
  return()=>{window.removeEventListener('popstate',navigate,true);window.removeEventListener('hashchange',navigate,true);};
 },[dirty]);
 const close=()=>{if(!busy.current&&!handoffBusy.current&&(!dirty||window.confirm('Close this draft? Unsaved text will be lost.')))onClose();};
 const save=async()=>{
  if(!current||busy.current||handoffBusy.current||handoffUnresolved)return;
  setHandoff(null);
  busy.current=true;setSaving(true);setError('');setNotice('');const attempt=++generation.current;
  try{
   const result=await followupDraftApi.save(leadId,{...text,expectedRevision:current.draft?.revision||0,contextToken:current.contextToken,acknowledgeContext:acknowledged});
   if(attempt!==generation.current||getToken()!==token.current)return;
   setCurrent(result);setSaved(text);setConflict(null);setAcknowledged(false);setNotice('Saved privately.');return result;
  }catch(cause){
   if(attempt!==generation.current||getToken()!==token.current)return;
   const failure=cause as Error&{status?:number;data?:{error?:string;current?:FollowupDraftResponse}};
   if(failure.status===409){
    try{
     const latest=failure.data?.current||await followupDraftApi.read(leadId);
     if(attempt!==generation.current||getToken()!==token.current)return;
     const retained=applyConflict(text,latest);setCurrent(retained.current);setText({subject:retained.subject,body:retained.body});setAcknowledged(false);
     setConflict(failure.data?.error==='revision_conflict'?'revision':'context');
     setError('Your text is still here. Review the current CRM context and saved version before saving again.');
    }catch{setError('Could not check the latest saved version. Your text is still here. Close only after copying anything you need.');}
   }else setError(failure.status===403||failure.status===404?'Your access to this draft has changed. Saving is unavailable.':'Save failed or its result is unknown. Your text is still here. Retry checks the saved revision before writing.');
  }finally{busy.current=false;if(attempt===generation.current)setSaving(false);}
 };
 const previewHandoff=async()=>{
  if(!current||busy.current||handoffBusy.current||handoffUnresolved)return;
  const prepared=dirty||!current.draft||conflict?await save():current;
  if(!prepared?.draft||getToken()!==token.current)return;
  handoffBusy.current=true;setHandoffPending(true);setNotice('');
  setHandoff({expectedRevision:prepared.draft.revision,contextToken:prepared.contextToken});
 };
 const copy=async()=>{setNotice('');try{await navigator.clipboard.writeText(text.subject?`Subject: ${text.subject}\n\n${text.body}`:text.body);setNotice('Copied. Review the recipient and conversation before sending manually.');}catch{setError('Copy failed. Select the text and copy it manually.');}};
 return <div className="fu-draft-overlay"><div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="fu-draft-workspace" onKeyDown={event=>{
   if(event.key==='Escape'){event.stopPropagation();close();}
   if(event.key==='Tab'){
    const elements=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],summary')||[]).filter(element=>element.getClientRects().length>0);
    const first=elements[0],last=elements[elements.length-1];
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===root.current)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===root.current)){event.preventDefault();first?.focus();}
   }
  }}>
  <header><div><h2 id={`${id}-title`}>Private follow-up draft</h2><p>Save privately or add a note to Pipedrive.</p></div><button className="fu-button" type="button" disabled={saving||handoffPending} onClick={close}>Close</button></header>
  {loading&&<p role="status">Loading your draft…</p>}
  {error&&<p role="alert" className="fu-warning">{error}</p>}
  {current&&<>
   <section className="fu-draft-context" aria-label="Current CRM context"><h3>{current.context.lead.title||'Project'}</h3><p>Lead owner: {current.context.lead.ownerId||'Unassigned'} · Contact: {current.context.lead.contactName||'Unverified'}{current.context.lead.personId?` (CRM ${current.context.lead.personId})`:''}</p>
    {current.context.holds.map(hold=><p className="fu-warning" key={hold.id}>{hold.reason} · Provider stop: {hold.providerStopStatus}. Queued mail may still send.</p>)}
    <details open={Boolean(conflict)}><summary>Current CRM record previews</summary>
     <p>Direct project links only. History is partial{current.context.limited?'; showing the latest 20 records':''}. Records linked through deals are excluded.</p>
     {current.context.records.length===0&&<p>No direct CRM record previews available.</p>}
     {current.context.records.map(record=><div key={`${record.entity}:${record.id}`}><strong>{record.subject||`${record.entity} ${record.id}`}</strong><p>{record.type||record.entity} · {record.entity==='activity'?`CRM marked ${record.done?'done':'open'} · Due ${record.dueDate||'undated'} · Owner ${record.ownerId||'unassigned'} · `:''}Record updated: {timestamp(record.sourceUpdatedAt)}</p><p>{record.text}{record.textTruncated?'… Preview truncated.':''}</p></div>)}
     <p>An activity marked done does not establish an email send or completed conversation.</p>
    </details>
   </section>
   <section className="fu-draft-context" aria-label="Draft preparation"><p>Review the original task, latest conversation and any order evidence before using your draft.</p><FollowupProjectContext key={leadId} leadId={leadId}/></section>
   <FollowupPreparation leadId={leadId} current={current} blocked={preparationBlocked} getSnapshot={preparationSnapshot} onApply={proposal=>{if(preparationBlocked||proposal.contextToken!==current.contextToken||proposal.revision!==(current.draft?.revision||0))return;editorVersion.current++;setHandoff(null);setText({subject:proposal.subject,body:proposal.body});setNotice('Proposal applied to your private draft. Review and save it deliberately.');}}/>
   <label htmlFor={`${id}-subject`}>Subject</label><input id={`${id}-subject`} maxLength={500} value={text.subject} disabled={saving||handoffPending||handoffUnresolved} onChange={event=>{editorVersion.current++;setHandoff(null);setText({...text,subject:event.target.value});setNotice('');}}/>
   <label htmlFor={`${id}-body`}>Message</label><textarea id={`${id}-body`} rows={9} maxLength={20000} value={text.body} disabled={saving||handoffPending||handoffUnresolved} onChange={event=>{editorVersion.current++;setHandoff(null);setText({...text,body:event.target.value});setNotice('');}}/>
   <p className="fu-draft-boundary">Check the latest email conversation before using this draft. Email history and website orders are not verified here. Available inventory matches are candidates until checked against source evidence.</p>
   {conflict&&<div className="fu-warning"><strong>{conflict==='revision'?'A newer saved version exists.':'CRM context changed since this draft was saved or opened.'}</strong>{conflict==='revision'&&current.draft&&<details><summary>Compare with saved version</summary><p>{current.draft.subject}</p><pre>{current.draft.body}</pre></details>}<label><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/>I reviewed the current CRM context{conflict==='revision'?' and saved version':''}. Save my text with this context.</label></div>}
   <footer><span>{dirty?'Unsaved changes':current.draft?`Saved privately · ${timestamp(current.draft.updatedAt)}`:'New private draft'}</span><button type="button" className="fu-button" disabled={saving||handoffPending||handoffUnresolved||!text.body.trim()||Boolean(conflict&&!acknowledged)} onClick={()=>void save()}>{saving?'Saving…':'Save draft'}</button><button type="button" className="fu-button" disabled={saving||!text.body.trim()} onClick={()=>void copy()}>Copy draft</button><button type="button" className="fu-button" disabled={Boolean(handoff)||saving||handoffPending||handoffUnresolved||!text.body.trim()||Boolean(conflict&&!acknowledged)} onClick={()=>void previewHandoff()}>Preview Pipedrive note</button><a className="fu-source" href={`https://proswpppllc.pipedrive.com/leads/inbox/${encodeURIComponent(leadId)}`} target="_blank" rel="noopener noreferrer">Open project in Pipedrive</a></footer>
   {handoff&&<FollowupHandoff key={`${handoff.expectedRevision}:${handoff.contextToken}`} leadId={leadId} {...handoff} onStatus={handoffStatus}/>}
   {notice&&<p role="status">{notice}</p>}
  </>}
 </div></div>;
}
