import {useState} from 'react';
import {sdrApi,type SdrDraft,type DraftReplacementContext} from '../../lib/sdrApi';

const messages:Record<string,string>={outreach_held:'Outreach is held. Review and resolve the hold separately before creating replacement copy.',existing_outreach_requires_review:'Another draft or enrollment already exists. Review it before creating replacement copy.',draft_stale:'The original draft changed. Close this form, reload the draft and review it again.',draft_context_changed:'The current contact or outreach context changed. Close this form and review the current context again.',generated_context_changed:'The generated draft used a different contact or sender context. Close this form and review the current context again.',crm_unavailable:'The current CRM context is unavailable. Refresh the CRM observations before trying again.',replacement_context_incomplete:'The current CRM contact or project context is incomplete.'};
function errorMessage(error:unknown) {const e=error as Error & {data?:{code?:string}};return messages[e.data?.code||'']||e.message||'Could not create replacement copy.';}

export function DraftReplacementReview({draft,disabled,onCreated}:{draft:SdrDraft;disabled:boolean;onCreated?:()=>void|Promise<void>}) {
  const [review,setReview]=useState<DraftReplacementContext|null>(null);
  const [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [created,setCreated]=useState(false);
  async function open() {
    setBusy(true);setError(null);
    try {
      const result=await sdrApi.replacementContext(draft.id);
      if(result.draft.revision!==draft.revision||result.draft.contextHash!==draft.contextHash)throw Error('The original draft changed. Reload it and review again.');
      setReview(result);
    } catch(e) {setError(errorMessage(e));} finally {setBusy(false);}
  }
  async function create() {
    if(!review||!reason.trim()||disabled)return;
    setBusy(true);setError(null);
    try {await sdrApi.createReplacementDraft(draft,review.context.contextHash,reason.trim());setCreated(true);setReview(null);await onCreated?.();}
    catch(e) {setError(errorMessage(e));}finally{setBusy(false);}
  }
  return <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3 text-sm">
    {created ? <p role="status">Replacement created in Open drafts for review. Nothing was sent.</p> : <>
      <p>Creates a separate draft for review. It does not send, restart a sequence or release holds. The original draft and its history stay unchanged.</p>
      {!review ? <button type="button" onClick={open} disabled={busy||disabled} className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-semibold disabled:opacity-50">{busy?'Loading context…':'Create replacement for review'}</button> : <>
        <dl className="grid gap-1 break-words text-slate-700">
          <div><dt className="inline font-medium">Current recipient: </dt><dd className="inline">{review.context.recipientEmail} (person {review.context.personId})</dd></div>
          <div><dt className="inline font-medium">Current organization: </dt><dd className="inline">{review.context.organizationId}</dd></div>
          <div><dt className="inline font-medium">Project stage / trigger: </dt><dd className="inline">{review.context.stage} / {review.context.trigger}</dd></div>
          <div><dt className="inline font-medium">Cadence: </dt><dd className="inline">{draft.metadata?.cadence==='award_only'?'Award only':review.context.cadence}</dd></div>
          {review.context.scheduledFor&&<div><dt className="inline font-medium">Existing schedule: </dt><dd className="inline">{new Date(review.context.scheduledFor).toLocaleString()}</dd></div>}
        </dl>
        <label className="block font-medium">Reason for replacement<textarea value={reason} onChange={e=>setReason(e.target.value)} disabled={busy} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 font-normal" /></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={()=>{setReview(null);setError(null);}} disabled={busy} className="rounded-lg border border-slate-300 bg-white px-3 py-2">Cancel</button>
          <button type="button" onClick={create} disabled={busy||disabled||!reason.trim()} className="rounded-lg bg-slate-900 px-3 py-2 font-semibold text-white disabled:opacity-50">{busy?'Creating review draft…':'Confirm review draft'}</button>
        </div>
      </>}
    </>}
    {error&&<p role="alert" className="text-rose-700">{error}</p>}
  </div>;
}
