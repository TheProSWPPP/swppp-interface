import {withJobRun,safeErrorCategory} from './sdrJobRuns.js';
import {processLinkedinEvents,reconcileLinkedinAccount} from './sdrLinkedinSync.js';
import {dispatchLinkedinAction,queueLinkedinAction,completeLinkedinSequences,rebindLinkedinActions} from './sdrLinkedinOperations.js';
import {previewLinkedinActions} from './sdrLinkedinOfflineReview.js';
import {previewProspectDay,defaultCustomerCheck} from './sdrLinkedinProspect.js';
import {drainReplyAlerts} from './sdrLinkedinReplyAlerts.js';
import {localDayString} from './sdrLinkedinRamp.js';
import {auditLinkedinAdmin} from './sdrLinkedinAdmin.js';
const running=new Set();
const requiredTables=['sdr_linkedin_accounts','sdr_linkedin_campaigns','sdr_linkedin_candidates','sdr_linkedin_links','sdr_linkedin_events','sdr_linkedin_actions','sdr_linkedin_drafts','sdr_job_runs','sdr_linkedin_reply_alerts','sdr_linkedin_search_runs'];
// Sales Navigator inbox sync can freeze silently: InMail replies would never arrive. Once a day
// (only while InMail is on) one chat-list read compares the newest Sales Navigator chat with the
// newest classic chat; a lag over 24 hours marks snSyncStale, which holds every InMail.
const SN_FOLDER=/SALES_NAVIGATOR|SALESNAV/i;
export async function checkSalesNavSync({pool,client,companyId,accountId,now=new Date()}){
 const account=(await pool.query('SELECT coverage FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,accountId])).rows[0];
 const last=account?.coverage?.snSyncCheckedAt;if(!account||last&&now-new Date(last)<24*60*60_000||!client?.listChats)return {skipped:true};
 let items;try{items=(await client.listChats({limit:50}))?.items}catch{return {skipped:true}}if(!Array.isArray(items))return {skipped:true};
 const newest=list=>Math.max(0,...list.map(c=>new Date(c.timestamp||c.updated_at||0).getTime()).filter(Number.isFinite));
 const folders=c=>(Array.isArray(c.folder)?c.folder:[c.folder]).join(' ');
 const sn=items.filter(c=>SN_FOLDER.test(folders(c))),classic=items.filter(c=>!SN_FOLDER.test(folders(c)));
 const stale=sn.length>0&&classic.length>0&&newest(classic)-newest(sn)>24*60*60_000;
 await pool.query('UPDATE sdr_linkedin_accounts SET coverage=coverage||$3::jsonb WHERE company_id=$1 AND account_id=$2',[companyId,accountId,JSON.stringify({snSyncCheckedAt:new Date(now).toISOString(),snSyncStale:stale})]);
 return {stale};
}
export function startLinkedinRuntime({pool,client,companyId,accountId,mode='disabled',scheduler=globalThis,now=()=>new Date(),work,readFreshContext,onInbound,gmail,getToken,customerCheck=defaultCustomerCheck,replyAlertsEnabled=process.env.SDR_LINKEDIN_REPLY_ALERTS_ENABLED==='true',inmailEnabled=process.env.SDR_LINKEDIN_INMAIL_ENABLED==='true',withdrawEnabled=process.env.SDR_LINKEDIN_WITHDRAW_ENABLED==='true'}={}){
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
  // Reply emails to Derek have their own switch; the rows are recorded either way.
  let alerts=null;if(gmail&&getToken){try{alerts=await drainReplyAlerts(pool,{gmail,getToken,now:now(),companyId,accountId,enabled:replyAlertsEnabled})}catch{alerts={failed:1}}}
  if(mode==='dry_run'){
   const campaigns=(await pool.query('SELECT id FROM sdr_linkedin_campaigns WHERE company_id=$1 AND account_id=$2 ORDER BY created_at LIMIT 20',[companyId,accountId])).rows;
   const previews=[];
   for(const campaign of campaigns){if(stopped)break;previews.push(await previewLinkedinActions({pool,companyId,accountId,campaignId:campaign.id,now:now()}))}
   // Today's prospect day, from local tables only. The full list is served by GET /admin/dry-run.
   const day=await previewProspectDay(pool,{companyId,accountId,now:now()});
   const wouldInvite=Object.values(day.lanes).reduce((n,list)=>n+list.length,0);
   return {coverage:'partial',counts:{processed:events.processed,previewed:previews.length,wouldInvite,rampBudget:day.ramp.rampBudget,wouldWithdraw:day.wouldWithdraw.length,wouldInmail:day.wouldInmail.length,awaitingCopy:day.awaitingCopy.length,alertsSent:alerts?.sent||0},previews,day};
  }
  const recovery=await reconcileLinkedinAccount({pool,client,companyId,accountId,now:now()});
  const completed=await completeLinkedinSequences({pool,companyId,accountId,now:now()});
  if(mode!=='live'||stopped)return {coverage:events.coverage,counts:{processed:events.processed,recovered:recovery.acceptedCount||0,completed:completed.inviteExpired+completed.sequenceFinished}};
  if(!readFreshContext)return {coverage:'partial',errorCategory:'unavailable'};
  // The 5/10/15 ramp counts from the first live day, stamped once and audited.
  const tz=(await pool.query('SELECT read_timezone FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,accountId])).rows[0]?.read_timezone||'America/Chicago';
  const stamped=await pool.query("UPDATE sdr_linkedin_accounts SET ramp_started_on=$3::date WHERE company_id=$1 AND account_id=$2 AND ramp_started_on IS NULL AND mode='live' RETURNING ramp_started_on",[companyId,accountId,localDayString(now(),tz)]);
  if(stamped.rowCount)await auditLinkedinAdmin(pool,{companyId,accountId,actor:'runtime',action:'account.ramp_start',targetId:accountId,detail:{rampStartedOn:localDayString(now(),tz)}});
  if(inmailEnabled)await checkSalesNavSync({pool,client,companyId,accountId,now:now()}).catch(()=>null);
  // Steps queued under an older campaign revision are re-queued under the approved one.
  await rebindLinkedinActions({pool,companyId,accountId,now:now()});
  // Two bounded passes so nobody starves. Only people whose campaign is approved and unexpired
  // count, so an unapproved cohort never fills the window.
  const active="c.company_id=$1 AND c.account_id=$2 AND c.campaign_id IS NOT NULL AND c.state IN ('reviewed','invite_sent','relation_observed','dm1_sent','followup_due') AND EXISTS (SELECT 1 FROM sdr_linkedin_campaigns k WHERE k.id=c.campaign_id AND k.status='approved' AND k.expires_at>$3)";
  // 1. People with no action yet (their invite), in lane priority order.
  const fresh=(await pool.query(`SELECT c.id,c.campaign_id FROM sdr_linkedin_candidates c WHERE ${active} AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id) ORDER BY c.priority,c.created_at LIMIT 20`,[companyId,accountId,now()])).rows;
  // 2. People in a sequence with no open action. Accepted with no M1 yet go first, whatever their
  // priority (M1 is due the day they accept). People whose invite is still pending and under 14
  // days old have nothing due (InMail is day 14, withdraw day 21), so they are left out.
  const accepted="EXISTS (SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=c.company_id AND e.account_id=c.account_id AND e.person_id=c.person_id AND e.kind='new_relation')";
  const progressing=(await pool.query(`SELECT c.id,c.campaign_id FROM sdr_linkedin_candidates c WHERE ${active} AND EXISTS (SELECT 1 FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id)
   AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions o WHERE o.candidate_id=c.id AND o.state IN ('pending','reserved','network_started','uncertain_provider_result','held'))
   AND (${accepted} OR NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions i WHERE i.candidate_id=c.id AND i.step='invite' AND i.state IN ('confirmed','uncertain_provider_result') AND COALESCE(i.confirmed_at,i.network_started_at)>$3::timestamptz-interval '14 days'))
   ORDER BY CASE WHEN ${accepted} AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions d WHERE d.candidate_id=c.id AND d.step='dm1') THEN 0 ELSE 1 END,c.priority,c.created_at LIMIT 100`,[companyId,accountId,now()])).rows;
  for(const candidate of [...fresh,...progressing]){if(stopped)break;await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:candidate.campaign_id,now:now(),inmailEnabled,withdrawEnabled})}
  // Each step class has its own slots, so steps paused for a reason that holds the whole class (no
  // InMail credits, a switch off, sync stale, invite spacing) never crowd out another class: DM1
  // (same day as the accept), follow-ups, InMail, withdraw, then invites by lane priority. Within a
  // class, steps never paused go first. A class whose switch is off is not read at all. Only
  // actions bound to their campaign's current approved revision are picked.
  const classes=[['dm1',['dm1'],4],['followup',['followup1','followup2'],3],...(inmailEnabled?[['inmail',['inmail'],2]]:[]),...(withdrawEnabled?[['withdraw',['withdraw'],2]]:[]),['invite',['invite'],3]];
  const due=[];
  for(const [,steps,slots] of classes)due.push(...(await pool.query(`SELECT a.id FROM sdr_linkedin_actions a LEFT JOIN sdr_linkedin_candidates c ON c.id=a.candidate_id JOIN sdr_linkedin_campaigns k ON k.id=a.campaign_id
   WHERE a.company_id=$1 AND a.account_id=$2 AND a.state='pending' AND a.due_at<=$3 AND a.step=ANY($4::text[]) AND k.status='approved' AND k.expires_at>$3 AND k.revision=a.campaign_revision
   ORDER BY (a.hold_reason IS NOT NULL),c.priority NULLS LAST,a.due_at LIMIT $5`,[companyId,accountId,now(),steps,slots])).rows);
  for(const row of due){if(stopped)break;await dispatchLinkedinAction({pool,client,actionId:row.id,readFreshContext,now:now(),mode,customerCheck,inmailEnabled,withdrawEnabled})}
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
