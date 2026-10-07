// App runtime receipts, distinct from historical coverage receipts used by conversion metrics.
export const APP_JOBS = [
 {job:'crm',label:'Pipedrive lead sync',intervalMs:6*60*60*1000},
 {job:'apollo_poll',label:'Email activity sync',intervalMs:15*60*1000},
 {job:'gmail_watch',label:'Connected inbox checks',intervalMs:5*60*1000},
 {job:'enrollment',label:'Outreach replenishment',intervalMs:60*60*1000,businessHours:true},
 {job:'reply_actions',label:'Reply follow-up actions',intervalMs:5*60*1000},
 {job:'conversation_sync',label:'Recent email history',intervalMs:15*60*1000},
 {job:'conversation_backfill',label:'Older email history',intervalMs:60*60*1000},
];
export function safeErrorCategory(error) {
 const status=Number(error?.status||error?.statusCode||error?.response?.status);
 if(status===429) return 'rate_limit';
 if(status===401||status===403) return 'authentication';
 if(status>=500) return 'provider_error';
 if(['ETIMEDOUT','ECONNRESET','ENOTFOUND','ECONNREFUSED'].includes(error?.code)) return 'network';
 if(['42P01','42703'].includes(error?.code)) return 'missing_schema';
 return 'unexpected';
}
const SAFE_RESULT_ERRORS = new Set(['cursor_unavailable','cursor_persistence_failed','watermark_persistence_failed','crm_person_read_failed','crm_person_page_invalid','crm_person_cursor_invalid','crm_person_page_cap','crm_lead_page_cap','crm_person_lookup_failed','crm_lead_status_invalid','crm_lead_read_failed','crm_lead_page_invalid','crm_lead_cursor_invalid','ordering_unverified','pagination_invalid','pagination_frozen','page_invalid','permission','unavailable','rate_limit','network','provider_error','authentication']);
function cleanObject(value,depth=0) {
 if(!value||typeof value!=='object'||Array.isArray(value)||depth>2) return {};
 const out={};
 for(const [key,v] of Object.entries(value).slice(0,64)) {
  if(!/^[a-zA-Z_][a-zA-Z_0-9-]{0,63}$/.test(key)||/token|secret|body|header|email|password|authorization/i.test(key)) continue;
  if(typeof v==='number'&&Number.isFinite(v)) out[key]=v;
  else if(typeof v==='boolean') out[key]=v;
  else if(typeof v==='string'&&(/^\d{4}-\d{2}-\d{2}(T[0-9:.+Z-]+)?$/.test(v)||['outside_hours','disabled','concurrent_run','provider_budget','no-pipedrive','no-apollo'].includes(v))) out[key]=v;
  else if(v&&typeof v==='object'&&!Array.isArray(v)) out[key]=cleanObject(v,depth+1);
 }
 return out;
}
export function chicagoBusinessHours(now=new Date()) {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'short',hour:'numeric',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 return !['Sat','Sun'].includes(parts.weekday)&&Number(parts.hour)>=8&&Number(parts.hour)<17;
}
export async function withJobRun(pool,{job,scope},work) {
 if(!APP_JOBS.some(j=>j.job===job)||typeof scope!=='string'||!scope||scope.length>254) throw new Error('invalid_job_scope');
 const client=await pool.connect();let locked=false,id;
 try {
  const key=`sdr-runtime:${job}:${scope}`;
  locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0]?.locked===true;
  if(!locked) {
   await client.query("INSERT INTO sdr_job_runs(job,scope,status,finished_at,counts) VALUES($1,$2,'skipped',NOW(),$3)",[job,scope,JSON.stringify({concurrent_run:1})]);
   return {skipped:'concurrent_run'};
  }
  // A session lock cannot survive process death. Any unfinished receipt without it is interrupted.
  await client.query("UPDATE sdr_job_runs SET status='failed',finished_at=NOW(),error_category='interrupted' WHERE job=$1 AND scope=$2 AND status='running'",[job,scope]);
  id=(await client.query("INSERT INTO sdr_job_runs(job,scope,status) VALUES($1,$2,'running') RETURNING id",[job,scope])).rows[0].id;
  const result=await work();
  const status=result?.skipped?'skipped':result?.coverage==='complete'?'complete':'partial';
  const next=result?.nextRetryAt||result?.next_retry_at;
  const retry=next&&Number.isFinite(new Date(next).getTime())?new Date(next):null;
  await client.query('UPDATE sdr_job_runs SET status=$2,finished_at=NOW(),counts=$3,cursor=$4,next_retry_at=$5,error_category=$6 WHERE id=$1',
   [id,status,JSON.stringify(cleanObject(result?.counts)),JSON.stringify(cleanObject(result?.cursor)),retry,SAFE_RESULT_ERRORS.has(result?.errorCategory)?result.errorCategory:null]);
  return result;
 } catch(error) {
  if(id) await client.query("UPDATE sdr_job_runs SET status='failed',finished_at=NOW(),error_category=$2 WHERE id=$1",[id,safeErrorCategory(error)]).catch(()=>{});
  throw error;
 } finally {
  if(locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`sdr-runtime:${job}:${scope}`]).catch(()=>{});
  client.release();
 }
}
export async function readJobHealth(pool,{visibleMailboxes=[],admin=false,now=new Date()}={}) {
 let rows;
 try {
  rows=(await pool.query(`SELECT DISTINCT ON (job,scope) job,scope,status,started_at,finished_at,counts,cursor,error_category,next_retry_at,
    MAX(finished_at) FILTER (WHERE status='complete') OVER (PARTITION BY job,scope) AS last_complete
    FROM sdr_job_runs WHERE job=ANY($1::text[]) AND (scope='account' OR scope=ANY($2::text[]) OR ($3::boolean AND job IN ('conversation_sync','conversation_backfill')))
    AND NOT (status='skipped' AND counts @> '{"concurrent_run":1}'::jsonb)
    ORDER BY job,scope,started_at DESC`,[APP_JOBS.map(j=>j.job),visibleMailboxes.map(v=>v.toLowerCase()),admin])).rows;
 } catch(error) {
  if(['42P01','42703'].includes(error.code)) return {state:'unavailable',jobs:APP_JOBS.map(j=>({...j,state:'not_connected'}))};
  throw error;
 }
 const jobs=APP_JOBS.flatMap(def=>{
  const matching=rows.filter(r=>r.job===def.job);
  return (matching.length?matching:[{job:def.job,scope:'account'}]).map(row=>{
   const latest=row.finished_at||row.started_at;
   const late=latest&&now.getTime()-new Date(latest).getTime()>def.intervalMs*2;
   const state=!row.status?'not_connected':row.status==='failed'?'failed':def.businessHours&&!chicagoBusinessHours(now)?'outside_hours':late?'late':row.status==='partial'?'partial':row.status==='running'?'running':row.status==='skipped'?'skipped':'current';
   return {job:def.job,label:def.label,scope:row.scope,state,intervalMs:def.intervalMs,status:row.status||null,
    lastAttempt:row.started_at||null,lastFinished:row.finished_at||null,lastComplete:row.last_complete||null,errorCategory:row.error_category||null,nextRetryAt:row.next_retry_at||null,
    ...(admin?{counts:cleanObject(row.counts),cursor:cleanObject(row.cursor)}:{})};
  });
 });
 return {state:'available',jobs};
}
