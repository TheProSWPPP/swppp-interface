import {linkedinHash} from './sdrLinkedinStore.js';
import {planLinkedinNextAction,renderLinkedinStep,validateLinkedinCampaign} from './sdrLinkedinPolicy.js';
const state=code=>({state:code});
const safeReceipt=result=>({outcome:result.outcome,providerId:result.providerId||null,chatId:result.chatId||null,reason:result.reason||null,status:result.status||null});
export async function queueLinkedinAction({pool,candidateId,campaignId,now=new Date()}){
 const candidate=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1 AND campaign_id=$2',[candidateId,campaignId])).rows[0];
 const row=(await pool.query('SELECT * FROM sdr_linkedin_campaigns WHERE id=$1',[campaignId])).rows[0];
 if(!candidate||!row||!candidate.person_id||!candidate.owner_id||!candidate.pipedrive_owner_id||!candidate.organization_id||!candidate.email_sequence_complete_at||candidate.email_unanswered!==true)return {state:'held',reason:'candidate_unverified'};
 const campaign={companyId:row.company_id,accountId:row.account_id,revision:row.revision,status:row.status,approvalDigest:row.approval_digest,cohortDigest:row.cohort_digest,approvedBy:row.approved_by,approvedAt:row.approved_at,expiresAt:row.expires_at,config:row.config};
 const approval=validateLinkedinCampaign(campaign);if(!approval.allowed||approval.digest!==row.approval_digest||!row.config.sources.includes(candidate.source)||!row.config.candidateSourceIds.includes(candidate.source_id)||!row.config.ownerIds.includes(candidate.owner_id))return {state:'held',reason:'approval_unverified'};
 const actions=(await pool.query('SELECT * FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3',[candidate.company_id,candidate.account_id,candidate.person_id])).rows;
 const events=(await pool.query('SELECT * FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND person_id=$3',[candidate.company_id,candidate.account_id,candidate.person_id])).rows;
 const invite=actions.find(a=>a.step==='invite'),dm1=actions.find(a=>a.step==='dm1'),followup1=actions.find(a=>a.step==='followup1'),followup2=actions.find(a=>a.step==='followup2');
 const existingDue=actions.find(a=>a.state==='pending'||a.state==='reserved'||a.state==='network_started'||a.state==='uncertain_provider_result');if(existingDue)return existingDue;
 const relation=events.find(e=>e.kind==='new_relation'&&['event','poll'].includes(e.coverage));
 const observations={pendingInvite:invite&&invite.state!=='rejected'&&!relation,relationVerified:Boolean(relation),relationObservedAt:relation?.observed_at,acceptanceAt:relation?.source_at,acceptanceDayUnknown:!relation?.source_at,dm1Confirmed:dm1?.state==='confirmed',dm1ConfirmedAt:dm1?.confirmed_at,followup1Confirmed:followup1?.state==='confirmed',followup2Confirmed:followup2?.state==='confirmed',inbound:events.some(e=>e.kind==='message_received'&&e.direction!=='out'),staffOutbound:events.some(e=>e.kind==='message_received'&&e.direction==='out'&&!actions.some(a=>a.provider_id&&a.provider_id===e.source_message_id))};
 const plan=planLinkedinNextAction({candidate,campaign,observations,now});if(!plan.step||plan.held)return {state:'held',reason:plan.reasons?.[0]||'sequence_held'};
 const prior={invite,dm1,followup1,followup2}[plan.step];if(prior)return prior;
 let body=null;if(plan.step!=='invite'){try{body=renderLinkedinStep({campaign,identity:{firstName:candidate.source_context?.firstName,firstNameVerified:candidate.source_context?.firstNameVerified===true},facts:candidate.source_context?.facts||{},step:plan.step})}catch{return {state:'held',reason:'copy_facts_unverified'}}}
 const contextHash=linkedinHash({candidateId,campaignId,revision:row.revision,ownerId:candidate.owner_id,profileUrl:candidate.profile_url,body});
 const chatId=dm1?.provider_chat_id||null;
 const {rows}=await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,body,provider_chat_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(company_id,account_id,person_id,step) DO NOTHING RETURNING *`,[candidate.company_id,candidate.account_id,candidate.id,candidate.person_id,campaignId,row.revision,plan.step,linkedinHash({companyId:candidate.company_id,accountId:candidate.account_id,personId:candidate.person_id,step:plan.step}),plan.dueAt,contextHash,body,chatId]);
 return rows[0]||(await pool.query('SELECT * FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND step=$4',[candidate.company_id,candidate.account_id,candidate.person_id,plan.step])).rows[0];
}
export async function dispatchLinkedinAction({pool,client,actionId,readFreshContext,now=new Date(),mode='disabled'}){
 if(mode!=='live')return state('disabled');
 const db=await pool.connect();let locked=false,lockKey;try{
  // A session person lock remains held across the network boundary; row locks never do.
  const initial=(await db.query('SELECT company_id,account_id,person_id FROM sdr_linkedin_actions WHERE id=$1',[actionId])).rows[0];if(!initial)return state('unavailable');
  lockKey=`linkedin:${initial.company_id}:${initial.account_id}:${initial.person_id}`;
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lockKey]);locked=true;
  await db.query('BEGIN');
  const action=(await db.query('SELECT * FROM sdr_linkedin_actions WHERE id=$1 FOR UPDATE',[actionId])).rows[0];
  if(action.state!=='pending'&&action.state!=='reserved'){await db.query('COMMIT');return state(action.state)}
  const candidate=(await db.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1',[action.candidate_id])).rows[0];
  const campaign=(await db.query('SELECT * FROM sdr_linkedin_campaigns WHERE id=$1',[action.campaign_id])).rows[0];
  const account=(await db.query('SELECT * FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2 FOR UPDATE',[action.company_id,action.account_id])).rows[0];
  const approval=campaign&&validateLinkedinCampaign({companyId:campaign.company_id,accountId:campaign.account_id,revision:campaign.revision,status:campaign.status,approvalDigest:campaign.approval_digest,cohortDigest:campaign.cohort_digest,approvedBy:campaign.approved_by,approvedAt:campaign.approved_at,expiresAt:campaign.expires_at,config:campaign.config});
  const approved=approval?.allowed&&approval.digest===campaign.approval_digest&&campaign.revision===action.campaign_revision&&candidate?.company_id===action.company_id&&candidate?.account_id===action.account_id&&candidate?.campaign_id===campaign.id&&campaign.company_id===action.company_id&&campaign.account_id===action.account_id&&campaign.config.sources.includes(candidate.source)&&campaign.config.candidateSourceIds.includes(candidate.source_id)&&campaign.config.ownerIds.includes(candidate.owner_id);
  if(!approved||account?.mode!=='live'||account?.status!=='healthy'||candidate?.person_id!==action.person_id||candidate?.state==='held'||candidate?.state==='replied'||candidate?.state==='staff_takeover'||new Date(action.due_at)>now){await db.query("UPDATE sdr_linkedin_actions SET state='held' WHERE id=$1",[actionId]);await db.query('COMMIT');return state('held')}
  const budget=action.step==='invite'?campaign.config?.budgets?.invite:campaign.config?.budgets?.dm;
  const budgetSteps=action.step==='invite'?['invite']:['dm1','followup1','followup2'];
  const count=(await db.query(`SELECT COUNT(*)::int AS count FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND step=ANY($3::text[]) AND id<>$4 AND (reserved_at AT TIME ZONE $6)::date=($5::timestamptz AT TIME ZONE $6)::date AND state IN ('reserved','network_started','confirmed','uncertain_provider_result')`,[action.company_id,action.account_id,budgetSteps,actionId,now,campaign.config.timezone||'America/Chicago'])).rows[0].count;
  if(!Number.isInteger(budget)||budget<=count){await db.query('COMMIT');return state('budget_exhausted')}
  await db.query("UPDATE sdr_linkedin_actions SET state='reserved',reserved_at=$2,fence=fence+1 WHERE id=$1",[actionId,now]);await db.query('COMMIT');
  // A fresh context read is required immediately before the irreversible boundary.
  const fresh=await readFreshContext({action,candidate,campaign,account,now});
  if(!fresh?.allowed||fresh.contextHash!==action.context_hash){await db.query("UPDATE sdr_linkedin_actions SET state='held' WHERE id=$1 AND state='reserved'",[actionId]);return state('held')}
  const request={providerId:candidate.provider_id,text:action.body,chatId:action.provider_chat_id};const requestHash=linkedinHash({accountId:action.account_id,operationKey:action.operation_key,request});
  await db.query("UPDATE sdr_linkedin_actions SET state='network_started',network_started_at=$2,request_hash=$3 WHERE id=$1 AND state='reserved'",[actionId,now,requestHash]);
  let result;try{result=action.step==='invite'?await client.invite({providerId:request.providerId}):action.step==='dm1'?await client.sendFirst({providerId:request.providerId,text:request.text}):await client.sendInChat({chatId:request.chatId,text:request.text})}catch{result={outcome:'unknown',reason:'transport_exception'}}
  const next=result?.outcome==='confirmed'?'confirmed':result?.outcome==='rejected'?'rejected':'uncertain_provider_result';
  await db.query(`UPDATE sdr_linkedin_actions SET state=$2,provider_id=$3,provider_chat_id=COALESCE($4,provider_chat_id),provider_receipt=$5,confirmed_at=CASE WHEN $2='confirmed' THEN $6 ELSE confirmed_at END WHERE id=$1`,[actionId,next,result?.providerId||null,result?.chatId||null,JSON.stringify(safeReceipt(result||{outcome:'unknown'})),now]);
  if(result?.status===429||result?.status===401||result?.status===403)await db.query("UPDATE sdr_linkedin_accounts SET status='restricted',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2",[action.company_id,action.account_id,now]);
  return state(next);
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]).catch(()=>{});db.release()}
}
export async function reconcileLinkedinAction({pool,client,actionId}){const action=(await pool.query('SELECT * FROM sdr_linkedin_actions WHERE id=$1',[actionId])).rows[0];if(!action)return state('unavailable');if(!['network_started','uncertain_provider_result'].includes(action.state))return state(action.state);if(!action.provider_id)return state('uncertain_provider_result');let result;try{result=action.step==='invite'?await client.listSentInvites({maxPages:2}):await client.listMessages({chatId:action.provider_chat_id,maxPages:2})}catch{return state('uncertain_provider_result')}if(!result.complete)return state('uncertain_provider_result');const matching=result.items.filter(item=>item.id===action.provider_id);if(matching.length!==1)return state('uncertain_provider_result');await pool.query("UPDATE sdr_linkedin_actions SET state='confirmed',confirmed_at=now() WHERE id=$1 AND state IN ('network_started','uncertain_provider_result')",[actionId]);return state('confirmed')}
