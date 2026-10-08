import {useEffect,useState} from 'react';
import {getToken,getUser} from '../../../lib/sdrApi';
import {runLatestRead} from '../../../lib/sdrReadRequest';
import {getReplyActionBacklog,type ReplyActionBacklogData} from '../../../lib/sdrReplyActionBacklogApi';
import './ReplyActionBacklog.css';
const kinds:Record<string,string>={stop_sequence:'Sequence stop',forward:'Reply forwarding',create_task:'CRM task',create_note:'CRM note',match_lead:'Project matching',clear_sequence_flag:'Sequence status',other:'Other action'};
const reasons:Record<string,string>={lead_unlinked:'Project link missing',lead_ambiguous:'Project link ambiguous',routing_unverified:'Owner routing unverified',sequence_context_unverified:'Sequence context unverified',classification_unverified:'Reply classification unverified',dependencies_pending:'Waiting for another action',later_outbound_unverified:'Later outbound context unverified',reply_context_unavailable:'Reply context unavailable',project_context_unverified:'Project context unverified',authentication:'Account authentication issue',configuration:'Configuration issue',completion_uncertain:'Completion not confirmed',attempts_exhausted:'Attempt limit reached',rate_limit:'Provider rate limit',definite_failure:'Recorded failure',unclassified:'Reason unavailable'};
const stamp=(value:string|null)=>value&&Number.isFinite(+new Date(value))?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Not recorded';
type ViewProps={status:'loading'|'error'|'ready';data:ReplyActionBacklogData|null;onRefresh:()=>void};
export function ReplyActionBacklogView({status,data,onRefresh}:ViewProps){
 return <section className="sdr-reply-backlog" aria-label="Reply handling checks"><header><h3>Reply handling</h3><button type="button" disabled={status==='loading'} onClick={onRefresh}>Refresh actions</button></header>
 <p>Outstanding technical actions in connected inboxes you can access. One reply may have several actions.</p>
 {status==='loading'?<p role="status">Checking reply actions…</p>:status==='error'||!data?<p role="alert">Reply actions could not be loaded. The outstanding count is unknown.</p>:<>
 <div className="sdr-reply-backlog-counts"><strong>{data.total} outstanding</strong><span>{data.failed} failed</span><span>{data.requiresReview} flagged for review</span></div>
 <p className="sdr-reply-backlog-meta">Checked {stamp(data.checkedAt)} · All recorded dates{data.oldestCreatedAt?` · Oldest ${stamp(data.oldestCreatedAt)}`:''}</p>
 {data.total===0?<p>No outstanding actions found within this scope.</p>:<><p>{data.groups.map(g=>`${kinds[g.kind]||'Other action'}: ${g.count}`).join(' · ')}</p><details><summary>View {data.items.length} oldest actions{data.total>data.items.length?` of ${data.total}`:''}</summary><ol>{data.items.map(item=><li key={item.id}><div><strong>{kinds[item.kind]||'Other action'}</strong><span className="sdr-reply-backlog-status">{item.status==='failed'?'Failed':item.status==='running'?'Recorded as running':'Pending'}</span></div><p>{item.requiresReview?'Technical review required':'No review flag recorded'} · {item.reason?(reasons[item.reason]||'Reason unavailable'):'No reason recorded'}</p><dl><div><dt>Created</dt><dd>{stamp(item.createdAt)}</dd></div><div><dt>Updated</dt><dd>{stamp(item.updatedAt)}</dd></div><div><dt>Recorded retry time</dt><dd>{stamp(item.retryAt)}</dd></div><div><dt>Attempts</dt><dd>{item.attempts}</dd></div></dl><p className="sdr-reply-backlog-meta">{item.projectStatus==='verified'?'Project scope verified':'Project unverified'} · Action {item.id}</p></li>)}</ol></details></>}
 <p className="sdr-reply-backlog-meta">{data.unverified} actions have no verified project. Known tests and records with conflicting or incomplete linked-project access are excluded. Unlinked records may include tests. Coverage is incomplete.</p>
 <p className="sdr-reply-backlog-meta">Recorded retry times do not confirm a future run. This view does not retry actions or establish whether a sequence stopped, a reply was forwarded or staff followed up.</p>
 </>}
 </section>;
}
function sessionKey(){if(typeof window==='undefined')return '';const user=getUser();return user?.role==='admin'&&getToken()?`${user.id}:${getToken()}`:'';}
export default function ReplyActionBacklog({refreshKey=0}:{refreshKey?:number}){
 const [session,setSession]=useState(sessionKey),[retry,setRetry]=useState(0);
 const key=`${session}:${refreshKey}:${retry}`;
 const [result,setResult]=useState<{key:string;status:'ready'|'error';data:ReplyActionBacklogData|null}|null>(null);
 useEffect(()=>{const update=()=>setSession(sessionKey());window.addEventListener('storage',update);window.addEventListener('sdr-session-changed',update);return()=>{window.removeEventListener('storage',update);window.removeEventListener('sdr-session-changed',update);};},[]);
 useEffect(()=>{
  if(!session)return;
  return runLatestRead(signal=>getReplyActionBacklog(signal),{success:data=>{if(sessionKey()===session)setResult({key,status:'ready',data});},error:()=>{if(sessionKey()===session)setResult({key,status:'error',data:null});},settled:()=>{}});
 },[session,key]);
 if(!session||session!==sessionKey())return null;
 return <ReplyActionBacklogView status={result?.key===key?result.status:'loading'} data={result?.key===key?result.data:null} onRefresh={()=>setRetry(v=>v+1)}/>;
}
