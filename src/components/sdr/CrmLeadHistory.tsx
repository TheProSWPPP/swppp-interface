import {useCallback,useEffect,useRef,useState} from 'react';
import {sdrCrmApi,type CrmObservations} from '../../lib/sdrCrmApi';
import {crmPlainText,crmReadableEvidence} from './crmViewState';
const when=(value:unknown)=>value?new Date(String(value)).toLocaleString():'Unknown';

export default function CrmLeadHistory({leadId}:{leadId:string}) {
  const generation=useRef(0);
  const invalidate=useCallback(()=>{generation.current++;},[]);
  const [history,setHistory]=useState<CrmObservations|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const load=useCallback(async()=>{
    const current=++generation.current;
    setLoading(true);setError(null);setHistory(null);
    try {
      const result=await sdrCrmApi.observations(leadId);
      if(current===generation.current)setHistory(result);
    }catch(cause){if(current===generation.current)setError((cause as Error).message);}
    finally{if(current===generation.current)setLoading(false);}
  },[leadId]);
  useEffect(()=>{void load();return invalidate;},[load,invalidate]);
  const evidence=crmReadableEvidence(history);
  return <section aria-label="CRM source history" className="mt-5 space-y-3 border-t border-slate-200 pt-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-800">CRM source history</h3><button type="button" onClick={()=>void load()} disabled={loading} className="text-xs font-semibold text-brand-600 disabled:opacity-50">Refresh</button></div>
    <p className="text-xs text-slate-500">Observed Pipedrive notes, activities and changes. Coverage starts when collection is enabled and may be incomplete.</p>
    {loading&&<p role="status" className="text-sm text-slate-500">Loading CRM source history…</p>}
    {error&&<p role="alert" className="text-sm text-amber-800">CRM source history unavailable: {error}</p>}
    {history?.unavailable&&<p role="alert" className="text-sm text-amber-800">{history.unavailable==='permission_denied'?'Pipedrive access is restricted. Stored history is hidden.':'CRM source history is unavailable. Check source access and coverage.'}</p>}
    {history&&!history.unavailable&&<>
      <p className="text-xs text-slate-500">Lead status: {history.lead?.lifecycle||'Not observed'} · last observed {when(history.lead?.observed_at)}</p>
      <ul className="space-y-1 text-xs text-slate-500" aria-label="CRM coverage">{history.freshness.scopes.map(scope=><li key={scope.scope}>{scope.scope.replaceAll('_',' ')}: {scope.status} · checked {when(scope.checkedAt)}{scope.errorCategory?` · ${scope.errorCategory}`:''}</li>)}</ul>
      <h4 className="text-xs font-semibold text-slate-700">Notes</h4>
      {evidence.notes.length===0?<p className="text-xs text-slate-500">No notes in the observed records.</p>:evidence.notes.map((note,index)=><div key={String(note.id||index)} className="rounded border border-slate-200 p-3"><p className="whitespace-pre-wrap text-sm text-slate-700">{crmPlainText(note.content)}</p><p className="mt-1 text-xs text-slate-500">CRM change {when(note.update_time||note.add_time)}</p></div>)}
      <h4 className="text-xs font-semibold text-slate-700">Activities</h4>
      {evidence.activities.length===0?<p className="text-xs text-slate-500">No activities in the observed records.</p>:evidence.activities.map((activity,index)=><div key={String(activity.id||index)} className="rounded border border-slate-200 p-3"><p className="text-sm font-medium text-slate-700">{crmPlainText(activity.subject)||'Untitled activity'}</p><p className="text-xs text-slate-500">{crmPlainText(activity.type)||'Activity'} · {activity.done?'Done':'Open'} · due {crmPlainText(activity.due_date)||'Unknown'}{activity.type==='email'?' · Activity record, not a send receipt':''}</p>{Boolean(activity.note)&&<p className="mt-1 text-xs text-slate-600">{crmPlainText(activity.note)}</p>}</div>)}
      <h4 className="text-xs font-semibold text-slate-700">Observed changes</h4>
      {evidence.revisions.length===0?<p className="text-xs text-slate-500">No changes have been observed yet.</p>:<ul className="space-y-2">{evidence.revisions.map((revision,index)=><li key={`${revision.entity}-${revision.entity_id}-${index}`} className="text-xs text-slate-600">{revision.entity} · {revision.action||'Observation'} · source {when(revision.source_at)} · observed {when(revision.observed_at)}{Boolean(revision.data?.content)&&<p className="mt-1 whitespace-pre-wrap">{crmPlainText(revision.data?.content)}</p>}</li>)}</ul>}
      {(history.hasMore?.items||history.hasMore?.revisions)&&<p className="text-xs text-slate-500">Showing a bounded history. Additional records are available in Pipedrive.</p>}
    </>}
  </section>;
}
