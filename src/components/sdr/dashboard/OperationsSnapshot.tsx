import DeliveryEvidence from './DeliveryEvidence';
import {useEffect,useState} from 'react';
import {getToken,getUser} from '../../../lib/sdrApi';
import {runLatestRead} from '../../../lib/sdrReadRequest';
import {getOperationsSnapshot,type OperationsSnapshotData} from '../../../lib/sdrOperationsSnapshotApi';
import './ReplyActionBacklog.css';
const stamp=(value:string|null)=>value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago'})+' CT':'Not recorded';
const contacts:Record<string,string>={missing:'No current email',email_bad:'Recorded email_bad flag',unverified:'Verification evidence missing or unrecognized',address_changed:'Verification belongs to another address',future:'Verification timestamp in the future',stale:'Verification older than 90 days',valid:'Current valid verdict',soft:'Current soft / unknown verdict',hard_failure:'Current hard-failure verdict'};
const jobs:Record<string,string>={apollo_messages:'Apollo message history',gmail_messages:'Gmail message history',gmail_watch:'Connected inbox check',apollo_poll:'Apollo activity check',enrollment:'Outreach replenishment'};
type Props={status:'loading'|'ready'|'error';data:OperationsSnapshotData|null;onRefresh:()=>void;refreshKey?:number};
export function OperationsSnapshotView({status,data,onRefresh,refreshKey=0}:Props){
 return <section className="sdr-reply-backlog" aria-label="Collected operations snapshot"><header><h3>Collected operations</h3><button type="button" disabled={status==='loading'} onClick={onRefresh}>Refresh snapshot</button></header>
 {status==='loading'?<p role="status">Loading collected operations…</p>:status==='error'||!data?<p role="alert">Operations snapshot unavailable. Counts are unknown.</p>:<>
 <p className="sdr-reply-backlog-meta">Checked {stamp(data.checkedAt)} · Collected records; coverage is partial.</p>
 <p><strong>Recorded lead inventory: {data.inventory.total}</strong> · {data.crm.activeSnapshots} active accessible CRM snapshots · {data.contacts.denominator} projects in both with active local status.</p>
 <p><strong>{data.enrollments.rows} enrollment records</strong> across {data.enrollments.projects} projects · <strong>{data.completedMessages.total} completed Apollo messages</strong> observed in the last {data.completedMessages.windowDays} days.</p>
 <details><summary>Project and contact diagnostics</summary><p>Inventory by stored outreach status: {data.inventory.byOutreachStatus.map(g=>`${g.status}: ${g.count}`).join(' · ')||'No records'}. Recorded clear status is not an eligibility decision.</p>
 <strong>Current contact verification · {data.contacts.denominator} projects</strong><dl>{Object.entries(data.contacts.buckets).map(([key,count])=><div key={key}><dt>{contacts[key]||'Unknown evidence'}</dt><dd>{count}</dd></div>)}</dl><p className="sdr-reply-backlog-meta">One category per project, using its current recorded email. A valid address does not establish buyer identity.</p>
 <p>Projects with lead or current-recipient email holds: {data.projectContext.leadOrRecipientHold} · Email-channel holds: {data.projectContext.emailChannelHold} · Stored human replies: {data.projectContext.storedHumanReply} · Open drafts: {data.projectContext.openDraft} · Local enrollment records: {data.projectContext.localEnrollment}.</p><p className="sdr-reply-backlog-meta">Counts overlap within the active project intersection. They cannot be subtracted to calculate eligible supply.</p>
 <p>Active controls by scope: {Object.entries(data.controls).map(([key,count])=>`${key}: ${count}`).join(' · ')}.</p></details>
 <details><summary>Enrollment and delivery evidence</summary><p>Enrollment records by stored status: {data.enrollments.byStatus.map(g=>`${g.status}: ${g.count}`).join(' · ')||'No records'}. Enrollment timestamps do not prove completed sends. Accessible archived projects remain in this delivery history.</p><p>Completed messages: {data.completedMessages.verifiedProjectLinked} with verified project links · {data.completedMessages.unlinkedObservations} unlinked observations.</p><p>Evidence-backed sales classification: {data.completedMessages.sales} · Other evidenced classification: {data.completedMessages.otherClassification} · Classification unknown: {data.completedMessages.unknownClassification}.</p></details>
 <details><summary>Coverage and missing evidence</summary><p>Eligible supply: unknown. Full historical refusal coverage is unavailable. Enrollment-to-message reconciliation is available only for unique direct message receipts in delivery records; broader history is unavailable. These diagnostics do not establish fresh supply, buyer interest or full provider history.</p><p>{data.coverage.visibleMailboxes} connected inboxes in scope. Known tests, foreign identities and conflicting project links are excluded; unlinked observations may still include tests.</p>
 <p><strong>Runtime checks</strong></p>{data.coverage.runtimeJobs?.map(job=><p key={`${job.job}:${job.scope}`}>{jobs[job.job]||job.job} · {job.scope} · {job.status==='missing'?'Missing collection':job.status}<br/>Last attempt {stamp(job.lastAttemptAt)} · Last finished {stamp(job.lastFinishedAt)} · Last complete {stamp(job.lastCompleteAt)}</p>)}
 <p><strong>Historical message collection</strong></p>{data.coverage.jobs.map(job=><p key={`${job.job}:${job.scope}`}>{jobs[job.job]||job.job} · {job.scope} · {job.status==='missing'?'Missing collection':job.status}<br/>Last attempt {stamp(job.lastAttemptAt)} · Last finished {stamp(job.lastFinishedAt)} · Last complete {stamp(job.lastCompleteAt)}</p>)}
 <p><strong>CRM collection</strong></p>{data.coverage.crmScopes.length?data.coverage.crmScopes.map(scope=><p key={scope.scope}>{scope.scope}: {scope.status} · Checked {stamp(scope.checkedAt)} · Complete through {stamp(scope.completedThrough)}{scope.errorCategory?` · ${scope.errorCategory.replaceAll('_',' ')}`:''}</p>):<p>No CRM collection coverage recorded.</p>}</details>
 </>}
 <DeliveryEvidence refreshKey={refreshKey}/>
 </section>;
}
function sessionKey(){if(typeof window==='undefined')return '';const user=getUser();return user?.role==='admin'&&getToken()?`${user.id}:${getToken()}`:'';}
export default function OperationsSnapshot({refreshKey=0}:{refreshKey?:number}){
 const [session,setSession]=useState(sessionKey),[retry,setRetry]=useState(0),[result,setResult]=useState<{key:string;status:'ready'|'error';data:OperationsSnapshotData|null}|null>(null);
 const key=`${session}:${refreshKey}:${retry}`;
 useEffect(()=>{const update=()=>setSession(sessionKey());window.addEventListener('storage',update);window.addEventListener('sdr-session-changed',update);window.addEventListener('sdr-session-expired',update);return()=>{window.removeEventListener('storage',update);window.removeEventListener('sdr-session-changed',update);window.removeEventListener('sdr-session-expired',update);};},[]);
 useEffect(()=>{if(!session)return;return runLatestRead(signal=>getOperationsSnapshot(signal),{success:data=>{if(sessionKey()===session)setResult({key,status:'ready',data});},error:()=>{if(sessionKey()===session)setResult({key,status:'error',data:null});},settled:()=>{}});},[session,key]);
 if(!session||session!==sessionKey())return null;
 return <OperationsSnapshotView refreshKey={refreshKey+retry} status={result?.key===key?result.status:'loading'} data={result?.key===key?result.data:null} onRefresh={()=>setRetry(n=>n+1)}/>;
}
