import OperationsSnapshot from './OperationsSnapshot';
import ReplyActionBacklog from './ReplyActionBacklog';
import { useEffect,useState } from 'react';
import { Activity,CheckCircle2,Clock3,AlertCircle,ChevronDown } from 'lucide-react';
import { getOutreachHealth,type OutreachHealth as Health,type OutreachJob } from '../../../lib/sdrHealthApi';
import { jobScopeLabel,jobIssueLabel,softVerdictSummary } from './systemCheckLabels';
import { liveReadIssue,liveReadSentence } from '../inboxReadStatus';
const labels:Record<OutreachJob['state'],string>={current:'Up to date',late:'Update delayed',failed:'Needs attention',partial:'Some updates missing',running:'Updating',skipped:'Last run skipped',outside_hours:'Outside working hours',not_connected:'No run recorded'};
function timestamp(value:string|null) {return value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Not recorded';}
export default function OutreachHealth({refreshKey=0}:{refreshKey?:number}) {
  const [data,setData]=useState<Health|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [retry,setRetry]=useState(0);
  const requestKey=`${refreshKey}:${retry}`;
  const [settledKey,setSettledKey]=useState<string|null>(null);
  const checking=loading||settledKey!==requestKey;
  useEffect(()=>{const controller=new AbortController();getOutreachHealth(controller.signal).then(result=>{if(!controller.signal.aborted){setData(result);setError(false);setLoading(false);setSettledKey(requestKey);}}).catch(()=>{if(!controller.signal.aborted){setError(true);setLoading(false);setSettledKey(requestKey);}});return()=>controller.abort();},[requestKey]);
  return <section className="sdr-job-health" aria-label="Outreach system health"><div className="sdr-health-heading"><Activity size={17} aria-hidden="true"/><h2>System checks</h2></div><p>Lead replenishment and email delivery need separate checks.</p>
    {checking?<p role="status">Checking the latest runs…</p>:error?<div role="alert"><p>Run history could not be loaded.</p><button onClick={()=>{setLoading(true);setRetry(v=>v+1);}}>Check again</button></div>:!data||data.state==='unavailable'?<p>Run history is not available yet. Outreach status is unknown.</p>:data.jobs.length===0?<p>No run history is connected for your account yet.</p>:<ul>{data.jobs.map(job=>{const live=job.job==='gmail_watch'?liveReadIssue(job.scope,data.inboxReads)||(job.scope==='account'?data.inboxReads?.find(read=>read.status==='stale'||read.status==='error')||null:null):null;const state=live&&job.state==='current'?'partial':job.state;const good=state==='current';const warning=['late','failed','partial'].includes(state);const Icon=good?CheckCircle2:warning?AlertCircle:Clock3;const scopeLabel=jobScopeLabel(job.scope);const issue=jobIssueLabel(job.errorCategory);return <li key={`${job.job}-${job.scope}`}><details><summary><Icon size={15} aria-hidden="true" className={good?'is-current':warning?'is-warning':'is-unknown'}/><span>{job.label}{scopeLabel&&<small className="sdr-job-mailbox">{scopeLabel}</small>}{job.job==='gmail_watch'&&job.scope==='account'&&<small>All connected inboxes</small>}<small>{labels[state]}</small></span><ChevronDown size={13} aria-hidden="true"/></summary><div className="sdr-job-details">{live&&<p>{liveReadSentence(live)}</p>}<p>Last attempt: {timestamp(job.lastAttempt)}</p><p>Last finished: {timestamp(job.lastFinished)}</p><p>Last complete: {timestamp(job.lastComplete||null)}</p>{job.nextRetryAt&&<p>Next retry: {timestamp(job.nextRetryAt)}</p>}{issue&&<p>{issue}</p>}{job.job==='enrollment'&&softVerdictSummary(job.counts)&&<p>{softVerdictSummary(job.counts)}</p>}</div></details></li>;})}</ul>}
    <OperationsSnapshot refreshKey={refreshKey}/>
    <ReplyActionBacklog refreshKey={refreshKey}/>
  </section>;
}
