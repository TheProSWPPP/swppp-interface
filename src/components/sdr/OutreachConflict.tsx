import {useCallback,useEffect,useRef,useState} from 'react';
import {sdrApi,type OutreachControlsResponse,type OutreachDecision,type OutreachControl} from '../../lib/sdrApi';

const button='rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50';
export function OutreachConflictPanel({data,userId,isAdmin,evidence,onEvidence,onDecision,busy}:{data:OutreachControlsResponse;userId:string;isAdmin:boolean;evidence:string;onEvidence:(value:string)=>void;onDecision:(control:OutreachControl,decision:OutreachDecision)=>void;busy:boolean}) {
 const [acknowledged,setAcknowledged]=useState<string[]>([]);
 const canDecide=(control:OutreachControl)=>control.canResolveOnProject===true&&(isAdmin||userId===control.owner_id);
 const providerLabel=data.providerStopStatus==='confirmed'?'Provider stop confirmed':data.providerStopStatus==='unresolved'?'Provider stop unresolved':'Provider status unverified';
 return <>
  <div className="flex flex-wrap gap-2 text-xs font-semibold"><span>{data.applicationActionsBlocked?'Application actions held':'No applicable application hold'}</span><span>· {providerLabel}</span></div>
  {data.providerStopStatus!=='confirmed'&&<p className="text-xs text-amber-800">Scheduled provider emails may still run. Verify the current enrollment with the operator responsible for it.</p>}
  {!data.context.complete&&<p className="text-xs text-amber-800">Source context needs review before outreach.</p>}
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-600"><dt>Selected contact</dt><dd>{data.context.recipientEmail||'Not verified'} · person {data.context.personId||'unknown'}</dd><dt>Selected company</dt><dd>{data.context.organizationId||'Not verified'}</dd><dt>Proposed contractor</dt><dd>{data.proposedContractor||'No verified proposal available'}</dd><dt>{data.provider?.source==='historical_enrollment'?'Last recorded provider recipient':'Provider recipient'}</dt><dd>{data.provider?.recipientEmail||'Not verified'}</dd><dt>Provider membership</dt><dd>{data.provider?.membershipState||'Not verified'}</dd></dl>
  {data.provider?.recipientEmail&&data.context.recipientEmail&&data.provider.recipientEmail.toLowerCase()!==data.context.recipientEmail.toLowerCase()&&<p role="alert" className="text-sm font-semibold text-amber-800">The selected contact differs from the recorded provider recipient. Verify current membership before changing outreach.</p>}
  {data.controls.length>0&&<>{data.controls.some(canDecide)&&<label className="block text-xs font-semibold text-slate-600">Decision evidence<textarea value={evidence} onChange={event=>onEvidence(event.target.value)} rows={2} className="mt-1 block w-full rounded border border-slate-300 bg-white p-2 font-normal" placeholder="What was verified, where, and by whom?"/></label>}<ul className="space-y-3">{data.controls.map(control=>{
   const owns=canDecide(control);const readOnly=control.canResolveOnProject!==true;const stale=control.context_hash!==data.context.contextHash;const acknowledgementKey=`${control.id}:${control.version}:${data.context.contextHash}`;const reviewed=acknowledged.includes(acknowledgementKey);
   return <li key={control.id} className="rounded border border-slate-200 bg-white p-3"><p className="text-sm text-slate-800">{control.reason}</p><p className="mt-1 text-xs text-slate-500">Scope: {control.scope_kind} · {control.scope_id}{control.channel?` · ${control.channel}`:''} · Owner: {control.owner_id}</p>
    {readOnly&&<p className="mt-2 text-xs text-slate-600">Read-only here. The owner must review this restriction across projects.</p>}
    {!readOnly&&stale&&<p className="mt-2 text-xs text-amber-800">Context changed since this hold. Review the current selection and evidence before recording a revised decision.</p>}
    {owns&&stale&&<label className="mt-2 flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={reviewed} onChange={event=>setAcknowledged(previous=>event.target.checked?[...previous,acknowledgementKey]:previous.filter(key=>key!==acknowledgementKey))}/>I reviewed the current contact and context</label>}
    {owns&&<div className="mt-2 flex flex-wrap gap-2">{([['keep_held','Keep held'],['keep_contact_with_verified_role','Keep verified contact'],['review_replacement','Review replacement'],['release','Release this hold']] as const).map(([decision,label])=><button key={decision} type="button" className={button} disabled={busy||!evidence.trim()||(stale&&!reviewed)} onClick={()=>onDecision(control,decision)}>{label}</button>)}</div>}
   </li>;
  })}</ul></>}
  {Boolean(data.proposals?.length)&&<details className="text-xs text-slate-600"><summary className="cursor-pointer font-semibold">Proposed CRM changes ({data.proposals!.length})</summary><p className="mt-2">These proposals have not replaced the selected CRM fields.</p><ul className="mt-2 space-y-2">{data.proposals!.map(proposal=><li key={proposal.id} className="rounded border border-slate-200 bg-white p-2"><p>{proposal.entity} {proposal.entity_id} · {proposal.reason}</p><dl>{Object.entries(proposal.proposed_fields).map(([field,value])=><div key={field} className="mt-1 break-words"><dt className="font-semibold">{field}</dt><dd>{typeof value==='string'?value:JSON.stringify(value)}</dd></div>)}</dl></li>)}</ul></details>}
  <p className="text-xs text-slate-500">Keeping a contact or releasing one hold does not approve copy, send, or restart a cadence. Other restrictions remain active.</p>
 </>;
}

export default function OutreachConflict({leadId,userId,isAdmin,onChanged}:{leadId:string;userId:string;isAdmin:boolean;onChanged?:()=>void}) {
 const generation=useRef(0);
 const invalidate=useCallback(()=>{generation.current++;},[]);
 const [data,setData]=useState<OutreachControlsResponse|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [evidence,setEvidence]=useState('');const [reason,setReason]=useState('');
 const [role,setRole]=useState('');const [cadence,setCadence]=useState<'standard'|'award_only'>('award_only');const [reviewEvidence,setReviewEvidence]=useState('');
 const load=useCallback(async()=>{
  const request=++generation.current;setLoading(true);setError(null);
  try{const current=await sdrApi.outreachControls(leadId);if(request===generation.current){setData(current);setRole(current.context.projectRole||'');setCadence(current.context.cadence==='standard'?'standard':'award_only');}}
  catch(cause){if(request===generation.current){setData(null);setError((cause as Error).message);}}
  finally{if(request===generation.current)setLoading(false);}
 },[leadId]);
 useEffect(()=>{setData(null);setEvidence('');setReason('');setReviewEvidence('');void load();return invalidate;},[load,invalidate]);
 async function perform(action:()=>Promise<unknown>) {
  setBusy(true);setError(null);
  try{await action();setEvidence('');setReason('');setReviewEvidence('');await load();onChanged?.();}
  catch(cause){const err=cause as Error&{status?:number};setError(err.status===409?'The reviewed context or decision changed. Refresh and review again; the hold remains active.':err.message);}
  finally{setBusy(false);}
 }
 return <section aria-label="Outreach review" className="mt-5 space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
  <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">Outreach review</h3><button type="button" className={button} disabled={busy||loading} onClick={()=>void load()}>Refresh</button></div>
  {loading&&<p role="status" className="text-sm text-slate-500">Checking outreach controls…</p>}
  {error&&<p role="alert" className="text-sm text-amber-800">{error}</p>}
  {data&&!loading&&<>
   <OutreachConflictPanel data={data} userId={userId} isAdmin={isAdmin} evidence={evidence} onEvidence={setEvidence} busy={busy} onDecision={(control,decision)=>void perform(()=>sdrApi.resolveOutreachControl(leadId,control.id,{expectedVersion:control.version,decision,evidence,contextHash:data.context.contextHash}))}/>
   <details className="border-t border-amber-200 pt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-700">Review role and cadence</summary><div className="mt-3 space-y-2">
    <label className="block text-xs text-slate-600">Verified project role<input value={role} onChange={event=>setRole(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 bg-white p-2" placeholder="e.g. Estimator authorized for this project"/></label>
    <label className="block text-xs text-slate-600">Cadence<select value={cadence} onChange={event=>setCadence(event.target.value as 'standard'|'award_only')} className="ml-2 rounded border border-slate-300 bg-white p-2"><option value="award_only">Award only</option><option value="standard">Standard</option></select></label>
    <label className="block text-xs text-slate-600">Role and cadence evidence<textarea rows={2} value={reviewEvidence} onChange={event=>setReviewEvidence(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 bg-white p-2"/></label>
    <button type="button" className={button} disabled={busy||!role.trim()||!reviewEvidence.trim()} onClick={()=>void perform(()=>sdrApi.reviewOutreach(leadId,{contextHash:data.context.contextHash,projectRole:role.trim(),cadence,evidence:reviewEvidence.trim()}))}>Save review</button><p className="text-xs text-slate-500">Saving a review does not send or restart outreach.</p>
   </div></details>
   <details className="border-t border-amber-200 pt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-700">Hold this project's email outreach</summary><div className="mt-3 space-y-2"><label className="block text-xs text-slate-600">Reason<textarea rows={2} value={reason} onChange={event=>setReason(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 bg-white p-2"/></label><button type="button" className={button} disabled={busy||!reason.trim()} onClick={()=>void perform(()=>sdrApi.holdOutreach(leadId,reason,data.context.contextHash))}>Hold application actions</button><p className="text-xs text-slate-500">This hold does not cancel emails already scheduled at the provider.</p></div></details>
  </>}
 </section>;
}
