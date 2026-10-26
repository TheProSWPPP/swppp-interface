import {withJobRun,safeErrorCategory} from './sdrJobRuns.js';
import {processLinkedinEvents,reconcileLinkedinAccount} from './sdrLinkedinSync.js';
import {dispatchLinkedinAction,queueLinkedinAction,completeLinkedinSequences} from './sdrLinkedinOperations.js';
import {previewLinkedinActions} from './sdrLinkedinOfflineReview.js';
const running=new Set();
const requiredTables=['sdr_linkedin_accounts','sdr_linkedin_campaigns','sdr_linkedin_candidates','sdr_linkedin_links','sdr_linkedin_events','sdr_linkedin_actions','sdr_linkedin_drafts','sdr_job_runs'];
export function startLinkedinRuntime({pool,client,companyId,accountId,mode='disabled',scheduler=globalThis,now=()=>new Date(),work,readFreshContext,onInbound}={}){
 if(!['observe','dry_run','live'].includes(mode)||!pool||!client||!companyId||!accountId)return {state:'disabled',ready:Promise.resolve(false),tick:async()=>({skipped:'disabled'}),stop(){}};
 const key=`${companyId}:${accountId}`;
 if(running.has(key))return {state:'duplicate',ready:Promise.resolve(false),tick:async()=>({skipped:'concurrent_run'}),stop(){}};
 running.add(key);
 let busy=false,stopped=false,timer=null,status='starting',lastResult=null,failures=0,nextRetryAt=0;
 const available=async()=>{
  if(work)return true; // Explicit injected work is the isolated scheduler test seam.
  const tables=(await pool.query('SELECT name,to_regclass(name) AS relation FROM unnest($1::text[]) AS name',[requiredTables])).rows;
  if(tables.length!==requiredTables.length||tables.some(row=>!row.relation)){lastResult={coverage:'partial',errorCategory:'missing_schema'};return false}
  const account=(await pool.query('SELECT mode FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,accountId])).rows[0];
  if(!account||account.mode!==mode){lastResult={coverage:'partial',errorCategory:'unavailable'};return false}
  return true;
 };
 const run=async()=>withJobRun(pool,{job:'linkedin',scope:key},async()=>{
  const events=await processLinkedinEvents({pool,companyId,accountId,limit:20,onInbound});
  if(stopped)return {skipped:'disabled',coverage:'partial'};
  if(mode==='dry_run'){
   const campaigns=(await pool.query('SELECT id FROM sdr_linkedin_campaigns WHERE company_id=$1 AND account_id=$2 ORDER BY created_at LIMIT 20',[companyId,accountId])).rows;
   const previews=[];
   for(const campaign of campaigns){if(stopped)break;previews.push(await previewLinkedinActions({pool,companyId,accountId,campaignId:campaign.id,now:now()}))}
   return {coverage:'partial',counts:{processed:events.processed,previewed:previews.length},previews};
  }
  const recovery=await reconcileLinkedinAccount({pool,client,companyId,accountId,now:now()});
  const completed=await completeLinkedinSequences({pool,companyId,accountId,now:now()});
  if(mode!=='live'||stopped)return {coverage:events.coverage,counts:{processed:events.processed,recovered:recovery.acceptedCount||0,completed:completed.inviteExpired+completed.sequenceFinished}};
  if(!readFreshContext)return {coverage:'partial',errorCategory:'unavailable'};
  const candidates=(await pool.query(`SELECT id,campaign_id FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND campaign_id IS NOT NULL AND state IN ('reviewed','invite_sent','relation_observed','dm1_sent','followup_due') ORDER BY created_at LIMIT 20`,[companyId,accountId])).rows;
  for(const candidate of candidates){if(stopped)break;await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:candidate.campaign_id,now:now()})}
  const due=(await pool.query(`SELECT id FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND state='pending' AND due_at<=$3 ORDER BY CASE WHEN step='dm1' THEN 0 ELSE 1 END,due_at LIMIT 10`,[companyId,accountId,now()])).rows;
  for(const row of due){if(stopped)break;await dispatchLinkedinAction({pool,client,actionId:row.id,readFreshContext,now:now(),mode})}
  return {coverage:events.coverage,counts:{processed:events.processed,recovered:recovery.acceptedCount||0,considered:due.length}};
 });
 let ready;
 const tick=async()=>{
  if(stopped||busy)return {skipped:'concurrent_run'};
  if(!await ready)return lastResult||{coverage:'partial',errorCategory:'unavailable'};
  if(stopped||busy)return {skipped:'concurrent_run'};
  if(now().getTime()<nextRetryAt)return {skipped:'backoff',...lastResult};
  busy=true;
  try{lastResult=await(work?work():run());failures=0;nextRetryAt=0;return lastResult}
  catch(error){failures++;nextRetryAt=now().getTime()+Math.min(15*60_000,60_000*2**Math.min(failures-1,4));lastResult={coverage:'partial',errorCategory:safeErrorCategory(error),nextRetryAt:new Date(nextRetryAt).toISOString()};return lastResult}
  finally{busy=false}
 };
 ready=available().then(ok=>{
  if(stopped)return false;
  if(!ok){status='unavailable';running.delete(key);return false}
  status=mode;timer=scheduler.setInterval(tick,60_000);return true;
 }).catch(error=>{lastResult={coverage:'partial',errorCategory:safeErrorCategory(error)};if(!stopped)status='unavailable';running.delete(key);return false});
 return {get state(){return status},ready,get lastResult(){return lastResult},tick,stop(){if(stopped)return;stopped=true;status='stopped';if(timer!==null)scheduler.clearInterval(timer);running.delete(key)}};
}
