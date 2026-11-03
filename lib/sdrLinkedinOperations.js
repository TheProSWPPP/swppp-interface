import {linkedinHash} from './sdrLinkedinStore.js';
import {planLinkedinNextAction,renderLinkedinStep,validateLinkedinCampaign,linkedinWindowOpen,sameLinkedinLocalDay,linkedinDm1Deadline} from './sdrLinkedinPolicy.js';
import {isProspect,prospectSkipReason,defaultCustomerCheck} from './sdrLinkedinProspect.js';
import {rampInviteBudget,effectiveInviteBudget,nextInviteAllowedAt,nextLocalDayStart,LINKEDIN_OUTSTANDING_INVITE_CAP,LINKEDIN_WEEKLY_INVITE_CAP} from './sdrLinkedinRamp.js';
import {hasRecentReply,normalEmail,RECENT_REPLY_DAYS} from './recentReply.js';
const state=code=>({state:code});
const holdReasons=new Set(['read_budget_exhausted','read_budget_unapproved','source_unavailable','candidate_changed','owner_route_changed','link_unverified','conversation_or_hold','crm_unverified','apollo_unverified','provider_identity_unverified','provider_history_partial','chat_identity_unverified','message_history_partial','message_identity_unverified','continuation_chat_unverified','relationship_changed','conversation_changed','approval_changed','fresh_context_unavailable','history_stale','cohort_mismatch','config_incomplete','account_unhealthy','identity_unverified','withdraw_not_pending']);
const envOn=name=>process.env[name]==='true';
const DM_STEPS=['dm1','followup1','followup2'];
// A refreshed InMail balance: the first finite count in the provider's answer (verify the shape at go-live).
const inmailCount=data=>{for(const value of [data?.sales_navigator,data?.balance,data?.credits,data?.remaining,data?.inmail_credits,data?.sales_navigator?.balance]){const n=Number(value);if(value!==null&&value!==undefined&&value!==''&&Number.isFinite(n))return Math.trunc(n)}return null};
const held=reason=>({state:'held',reason});
const safeReceipt=result=>({outcome:result.outcome,providerId:result.providerId||null,chatId:result.chatId||null,reason:result.reason||null,status:result.status||null});
export async function queueLinkedinAction({pool,candidateId,campaignId,now=new Date(),inmailEnabled=envOn('SDR_LINKEDIN_INMAIL_ENABLED'),withdrawEnabled=envOn('SDR_LINKEDIN_WITHDRAW_ENABLED')}){
 const candidate=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1 AND campaign_id=$2',[candidateId,campaignId])).rows[0];
 const row=(await pool.query('SELECT * FROM sdr_linkedin_campaigns WHERE id=$1',[campaignId])).rows[0];
 const prospect=isProspect(candidate);
 // Prospects have no Pipedrive owner, organization or email sequence; the retired path keeps its gate.
 if(!candidate||!row||(prospect?!candidate.person_id||!candidate.owner_id||!candidate.provider_id||!candidate.lane:!candidate.person_id||!candidate.owner_id||!candidate.pipedrive_owner_id||!candidate.organization_id||!candidate.email_sequence_complete_at||candidate.email_unanswered!==true))return {state:'held',reason:'candidate_unverified'};
 const campaign={companyId:row.company_id,accountId:row.account_id,revision:row.revision,status:row.status,approvalDigest:row.approval_digest,cohortDigest:row.cohort_digest,approvedBy:row.approved_by,approvedAt:row.approved_at,expiresAt:row.expires_at,config:row.config};
 const approval=validateLinkedinCampaign(campaign);if(!approval.allowed||approval.digest!==row.approval_digest||!row.config.sources.includes(candidate.source)||!row.config.candidateSourceIds.includes(candidate.source_id)||!row.config.ownerIds.includes(candidate.owner_id)||prospect&&candidate.lane!==row.config.lane)return {state:'held',reason:'approval_unverified'};
 const actions=(await pool.query('SELECT * FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3',[candidate.company_id,candidate.account_id,candidate.person_id])).rows;
 const events=(await pool.query('SELECT * FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND person_id=$3',[candidate.company_id,candidate.account_id,candidate.person_id])).rows;
 const invite=actions.find(a=>a.step==='invite'),dm1=actions.find(a=>a.step==='dm1'),followup1=actions.find(a=>a.step==='followup1'),followup2=actions.find(a=>a.step==='followup2'),inmail=actions.find(a=>a.step==='inmail'),withdraw=actions.find(a=>a.step==='withdraw');
 const existingDue=actions.find(a=>a.state==='pending'||a.state==='reserved'||a.state==='network_started'||a.state==='uncertain_provider_result');if(existingDue)return existingDue;
 const relation=events.find(e=>e.kind==='new_relation'&&['event','poll'].includes(e.coverage));
 const observations={pendingInvite:invite&&invite.state!=='rejected'&&!relation,relationVerified:Boolean(relation),relationObservedAt:relation?.observed_at,acceptanceAt:relation?.source_at,acceptanceDayUnknown:!relation?.source_at,dm1Confirmed:dm1?.state==='confirmed',dm1ConfirmedAt:dm1?.confirmed_at,followup1Confirmed:followup1?.state==='confirmed',followup2Confirmed:followup2?.state==='confirmed',inviteConfirmedAt:invite?.confirmed_at||invite?.network_started_at||null,invitationId:invite?.provider_id||null,inmailConfirmed:inmail?.state==='confirmed',inmailDone:Boolean(inmail),inmailEnabled,withdrawEnabled,withdrawConfirmed:withdraw?.state==='confirmed',withdrawDone:Boolean(withdraw),inbound:events.some(e=>e.kind==='message_received'&&e.direction!=='out'),staffOutbound:events.some(e=>e.kind==='message_received'&&e.direction==='out'&&!actions.some(a=>a.provider_id&&a.provider_id===e.source_message_id))};
 const plan=planLinkedinNextAction({candidate,campaign,observations,now});if(!plan.step||plan.held)return {state:'held',reason:plan.reasons?.[0]||'sequence_held'};
 const prior={invite,dm1,followup1,followup2,inmail,withdraw}[plan.step];if(prior)return prior;
 let body=null;if(plan.step!=='invite'&&plan.step!=='withdraw'){try{body=renderLinkedinStep({campaign,identity:{firstName:candidate.source_context?.firstName,firstNameVerified:candidate.source_context?.firstNameVerified===true},facts:candidate.source_context?.facts||{},step:plan.step})}catch{return {state:'held',reason:'copy_facts_unverified'}}}
 const contextHash=linkedinHash({candidateId,campaignId,revision:row.revision,ownerId:candidate.owner_id,profileUrl:candidate.profile_url,body});
 const chatId=dm1?.provider_chat_id||null;
 const {rows}=await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,body,provider_chat_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(company_id,account_id,person_id,step) DO NOTHING RETURNING *`,[candidate.company_id,candidate.account_id,candidate.id,candidate.person_id,campaignId,row.revision,plan.step,linkedinHash({companyId:candidate.company_id,accountId:candidate.account_id,personId:candidate.person_id,step:plan.step}),plan.dueAt,contextHash,body,chatId]);
 return rows[0]||(await pool.query('SELECT * FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND step=$4',[candidate.company_id,candidate.account_id,candidate.person_id,plan.step])).rows[0];
}
export async function dispatchLinkedinAction({pool,client,actionId,readFreshContext,now=new Date(),mode='disabled',clock=()=>performance.now(),customerCheck=defaultCustomerCheck}){
 if(mode!=='live')return state('disabled');
 const startedAt=clock(),boundaryTime=()=>new Date(now.getTime()+Math.max(0,clock()-startedAt));
 const db=await pool.connect();let locked=false,lockKey;try{
  // A session person lock remains held across the network boundary; row locks never do.
  const initial=(await db.query('SELECT company_id,account_id,person_id,step FROM sdr_linkedin_actions WHERE id=$1',[actionId])).rows[0];if(!initial)return state('unavailable');
  lockKey=`linkedin:${initial.company_id}:${initial.account_id}:${initial.person_id}`;
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lockKey]);locked=true;
  // InMail credits are Derek's money: the balance is refreshed at most hourly before an InMail.
  if(initial.step==='inmail'){const seen=(await db.query('SELECT inmail_balance_observed_at FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[initial.company_id,initial.account_id])).rows[0];if(seen&&(!seen.inmail_balance_observed_at||now-new Date(seen.inmail_balance_observed_at)>60*60_000)){let balance=null;try{balance=inmailCount(await client.getInmailBalance())}catch{balance=null}if(balance!==null)await db.query('UPDATE sdr_linkedin_accounts SET inmail_balance=$3,inmail_balance_observed_at=$4 WHERE company_id=$1 AND account_id=$2',[initial.company_id,initial.account_id,balance,now])}}
  await db.query('BEGIN');
  const action=(await db.query('SELECT * FROM sdr_linkedin_actions WHERE id=$1 FOR UPDATE',[actionId])).rows[0];
  if(action.state!=='pending'&&action.state!=='reserved'){await db.query('COMMIT');return state(action.state)}
  const candidate=(await db.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1',[action.candidate_id])).rows[0];
  const campaign=(await db.query('SELECT * FROM sdr_linkedin_campaigns WHERE id=$1',[action.campaign_id])).rows[0];
  const account=(await db.query('SELECT * FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2 FOR UPDATE',[action.company_id,action.account_id])).rows[0];
  const approval=campaign&&validateLinkedinCampaign({companyId:campaign.company_id,accountId:campaign.account_id,revision:campaign.revision,status:campaign.status,approvalDigest:campaign.approval_digest,cohortDigest:campaign.cohort_digest,approvedBy:campaign.approved_by,approvedAt:campaign.approved_at,expiresAt:campaign.expires_at,config:campaign.config});
  const approved=approval?.allowed&&approval.digest===campaign.approval_digest&&campaign.revision===action.campaign_revision&&candidate?.company_id===action.company_id&&candidate?.account_id===action.account_id&&candidate?.campaign_id===campaign.id&&campaign.company_id===action.company_id&&campaign.account_id===action.account_id&&campaign.config.sources.includes(candidate.source)&&campaign.config.candidateSourceIds.includes(candidate.source_id)&&campaign.config.ownerIds.includes(candidate.owner_id)&&(!isProspect(candidate)||candidate.lane===campaign.config.lane);
  if(!approved||account?.mode!=='live'||account?.status!=='healthy'||account.read_budget<=0||account.read_timezone!==campaign.config.timezone||account.sender_provider_id!==campaign.config.senderProviderId||candidate?.person_id!==action.person_id||['held','replied','staff_takeover','archived','opted_out','completed_no_reply'].includes(candidate?.state)){await db.query("UPDATE sdr_linkedin_actions SET state='held',hold_reason='local_gate_failed' WHERE id=$1",[actionId]);await db.query('COMMIT');return held('local_gate_failed')}
  if(new Date(action.due_at)>now){await db.query('COMMIT');return state('not_due')}
  if(!linkedinWindowOpen(now,campaign.config)){await db.query("UPDATE sdr_linkedin_actions SET hold_reason='window_closed' WHERE id=$1",[actionId]);await db.query('COMMIT');return state('window_closed')}
  const tz=campaign.config.timezone||'America/Chicago',budgets=campaign.config?.budgets||{};
  const budgetSteps={invite:['invite'],inmail:['inmail'],withdraw:['withdraw']}[action.step]||DM_STEPS;
  const campaignBudget={invite:budgets.invite,inmail:budgets.inmail,withdraw:budgets.withdraw}[action.step]??budgets.dm;
  // Invites follow the ramp from the first live day: 5 a day in week 1, 10 in week 2, then 15.
  const budget=action.step==='invite'?effectiveInviteBudget(campaignBudget,rampInviteBudget({rampStartedOn:account.ramp_started_on,now,tz})):campaignBudget;
  const count=(await db.query(`SELECT COUNT(*)::int AS count FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND step=ANY($3::text[]) AND id<>$4 AND (reserved_at AT TIME ZONE $6)::date=($5::timestamptz AT TIME ZONE $6)::date AND state IN ('reserved','network_started','confirmed','uncertain_provider_result')`,[action.company_id,action.account_id,budgetSteps,actionId,now,tz])).rows[0].count;
  if(!Number.isInteger(budget)||budget<=count){await db.query("UPDATE sdr_linkedin_actions SET hold_reason='budget_exhausted' WHERE id=$1",[actionId]);await db.query('COMMIT');return state('budget_exhausted')}
  const wait=async reason=>{await db.query('UPDATE sdr_linkedin_actions SET hold_reason=$2 WHERE id=$1',[actionId,reason]);await db.query('COMMIT');return state(reason)};
  let invitationId=null;
  if(action.step==='invite'){
   if(account.coverage?.invitesPausedUntil&&new Date(account.coverage.invitesPausedUntil)>now)return wait('invite_usage_paused');
   // Outstanding = our invites not yet accepted, withdrawn or closed. Its own cap, separate from DMs.
   const outstanding=(await db.query(`SELECT COUNT(DISTINCT a.person_id)::int AS count FROM sdr_linkedin_actions a JOIN sdr_linkedin_candidates c ON c.id=a.candidate_id WHERE a.company_id=$1 AND a.account_id=$2 AND a.step='invite' AND a.id<>$3 AND a.state IN ('reserved','network_started','confirmed','uncertain_provider_result') AND c.state NOT IN ('held','replied','staff_takeover','opted_out','archived','completed_no_reply')
    AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=a.company_id AND e.account_id=a.account_id AND e.person_id=a.person_id AND e.kind='new_relation')
    AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions w WHERE w.company_id=a.company_id AND w.account_id=a.account_id AND w.person_id=a.person_id AND w.step='withdraw' AND w.state='confirmed')`,[action.company_id,action.account_id,actionId])).rows[0].count;
   if(outstanding>=LINKEDIN_OUTSTANDING_INVITE_CAP)return wait('outstanding_invites_capped');
   const weekly=(await db.query(`SELECT COUNT(*)::int AS count FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND step='invite' AND id<>$3 AND state IN ('reserved','network_started','confirmed','uncertain_provider_result') AND reserved_at>$4::timestamptz-interval '7 days'`,[action.company_id,action.account_id,actionId,now])).rows[0].count;
   if(weekly>=LINKEDIN_WEEKLY_INVITE_CAP)return wait('weekly_invites_capped');
   // Spread across the window: no burst of invites at 08:00.
   const last=(await db.query(`SELECT id,reserved_at FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND step='invite' AND id<>$3 AND reserved_at IS NOT NULL AND state IN ('reserved','network_started','confirmed','uncertain_provider_result') ORDER BY reserved_at DESC LIMIT 1`,[action.company_id,action.account_id,actionId])).rows[0];
   const nextAt=last?nextInviteAllowedAt({lastInviteAt:last.reserved_at,budget,seed:`${action.account_id}:${last.id}`}):null;
   if(nextAt&&nextAt>now)return wait('invite_spacing');
  }
  if(action.step==='inmail'){
   if(account.coverage?.snSyncStale)return wait('sn_sync_stale');
   if(!Number.isInteger(account.inmail_balance))return wait('inmail_balance_unavailable');
   if(account.inmail_balance<=0)return wait('inmail_credits_exhausted');
  }
  if(action.step==='withdraw'){
   // Only an invite with a real invitation id is withdrawn; an old uncertain receipt never is.
   const invite=(await db.query(`SELECT provider_id FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND step='invite' AND state='confirmed'`,[action.company_id,action.account_id,action.person_id])).rows[0];
   invitationId=invite?.provider_id||null;
   if(!invitationId){await db.query("UPDATE sdr_linkedin_actions SET state='held',hold_reason='invitation_id_unknown' WHERE id=$1",[actionId]);await db.query('COMMIT');return held('invitation_id_unknown')}
  }
  await db.query("UPDATE sdr_linkedin_actions SET state='reserved',reserved_at=$2,fence=fence+1 WHERE id=$1",[actionId,now]);await db.query('COMMIT');
  // A fresh context read is required immediately before the irreversible boundary.
  let fresh;try{fresh=await readFreshContext({action,candidate,campaign,account,now})}catch{fresh={allowed:false,reasons:['fresh_context_unavailable']}}
  if(!fresh?.allowed||fresh.contextHash!==action.context_hash){const reason=holdReasons.has(fresh?.reasons?.[0])?fresh.reasons[0]:'context_changed';
   // A withdraw whose invite is no longer pending (accepted or already gone) has nothing to do.
   if(reason==='withdraw_not_pending'){await db.query("UPDATE sdr_linkedin_actions SET state='cancelled',hold_reason=$2 WHERE id=$1 AND state='reserved'",[actionId,reason]);return state('cancelled')}
   await db.query("UPDATE sdr_linkedin_actions SET state='held',hold_reason=$2 WHERE id=$1 AND state='reserved'",[actionId,reason]);return held(reason)}
  let boundaryNow=boundaryTime();
  let inmailCopy=null;if(action.step==='inmail'){try{inmailCopy=JSON.parse(action.body)}catch{inmailCopy=null}}
  const request={providerId:candidate.provider_id,text:inmailCopy?inmailCopy.body:action.body,...(inmailCopy?{subject:inmailCopy.subject}:{}),chatId:action.provider_chat_id,...(action.step==='withdraw'?{invitationId}:{})};const requestHash=linkedinHash({accountId:action.account_id,operationKey:action.operation_key,request});
  // Provider/CRM reads above can take seconds. Claim the irreversible boundary
  // only after re-reading every local source that may have changed meanwhile.
  await db.query('BEGIN');
  const finalAction=(await db.query('SELECT * FROM sdr_linkedin_actions WHERE id=$1 FOR UPDATE',[actionId])).rows[0];
  const finalCandidate=(await db.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1 FOR UPDATE',[action.candidate_id])).rows[0];
  const finalCampaign=(await db.query('SELECT * FROM sdr_linkedin_campaigns WHERE id=$1 FOR UPDATE',[action.campaign_id])).rows[0];
  const finalAccount=(await db.query('SELECT * FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2 FOR UPDATE',[action.company_id,action.account_id])).rows[0];
  const finalApproval=finalCampaign&&validateLinkedinCampaign({companyId:finalCampaign.company_id,accountId:finalCampaign.account_id,revision:finalCampaign.revision,status:finalCampaign.status,approvalDigest:finalCampaign.approval_digest,cohortDigest:finalCampaign.cohort_digest,approvedBy:finalCampaign.approved_by,approvedAt:finalCampaign.approved_at,expiresAt:finalCampaign.expires_at,config:finalCampaign.config});
  const prospect=isProspect(candidate);
  let routes=[],link=null,controls=[],recent=true,prospectSkip='not_checked';
  if(prospect){
   // The local skip rules again, inside the boundary transaction (AGC/LBA, bid invites, sequences, recent email, replies, customers).
   try{prospectSkip=await prospectSkipReason(db,{companyId:action.company_id,person:{personId:finalCandidate?.person_id,providerId:finalCandidate?.provider_id,profileUrl:finalCandidate?.profile_url,email:finalCandidate?.resolved_email,fullName:finalCandidate?.source_context?.fullName,company:finalCandidate?.firm},lane:finalCandidate?.lane,now,excludeCandidateId:candidate.id,customerCheck})}catch{prospectSkip='source_unavailable'}
  }else{
   routes=(await db.query('SELECT DISTINCT pipedrive_sender_id::text AS id FROM sdr_mailboxes WHERE owner_user_id::text=$1 AND active IS TRUE AND pipedrive_sender_id IS NOT NULL',[candidate.owner_id])).rows;
   const links=(await db.query(`SELECT * FROM sdr_linkedin_links WHERE company_id=$1 AND account_id=$2 AND candidate_id=$3 AND person_id=$4 AND status='verified'`,[action.company_id,action.account_id,candidate.id,candidate.person_id])).rows;
   link=links.length===1&&links[0].lead_id&&links[0].verified_email&&links[0].apollo_contact_id?links[0]:null;
   controls=link?(await db.query(`SELECT 1 FROM sdr_outreach_controls WHERE company_id=$1 AND status='active' AND (lead_id IS NULL OR lead_id=$2) LIMIT 1`,[action.company_id,link.lead_id])).rows:[];
   recent=link?await hasRecentReply(db,link.verified_email):true;
  }
  const conflictingOutbound=(await db.query(`SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=$1 AND e.account_id=$2 AND e.person_id=$3 AND e.kind='message_received' AND e.direction='out' AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions a WHERE a.company_id=e.company_id AND a.account_id=e.account_id AND a.person_id=e.person_id AND a.state='confirmed' AND a.provider_id=e.source_message_id) LIMIT 1`,[action.company_id,action.account_id,action.person_id])).rows.length>0;
  const acceptance=action.step==='dm1'?(await db.query(`SELECT source_at,observed_at FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND kind='new_relation' AND coverage IN ('event','poll')`,[action.company_id,action.account_id,action.person_id])).rows:null;
  boundaryNow=boundaryTime();
  const timelyAcceptance=!acceptance||(finalCampaign?.config?.lateAcceptancePolicy==='hold'?acceptance.length===1&&acceptance[0].source_at&&sameLinkedinLocalDay(acceptance[0].source_at,boundaryNow,finalCampaign.config.timezone):acceptance.length>0&&boundaryNow<=linkedinDm1Deadline(acceptance.map(row=>row.observed_at).sort((a,b)=>new Date(a)-new Date(b))[0],finalCampaign.config));
  const common=boundaryNow.getTime()-now.getTime()<=5*60_000&&finalAction?.state==='reserved'&&finalAction.fence===action.fence+1&&finalCandidate?.revision===candidate.revision&&finalCandidate.owner_id===candidate.owner_id&&finalCandidate.state===candidate.state&&!['held','replied','staff_takeover','archived','opted_out','copy_review'].includes(finalCandidate.state)&&finalCandidate.company_id===action.company_id&&finalCandidate.account_id===action.account_id&&finalCandidate.person_id===action.person_id&&finalCandidate.provider_id===candidate.provider_id&&finalCandidate.profile_url===candidate.profile_url&&finalCandidate.organization_id===candidate.organization_id&&finalCandidate.product==='classic'&&finalCandidate.source===candidate.source&&finalCandidate.source_id===candidate.source_id&&finalCandidate.segment===candidate.segment&&finalCandidate.territory===candidate.territory&&finalCampaign?.company_id===action.company_id&&finalCampaign.account_id===action.account_id&&finalCampaign.revision===action.campaign_revision&&finalApproval?.allowed&&finalApproval.digest===finalCampaign.approval_digest&&finalCampaign.config.sources.includes(finalCandidate.source)&&finalCampaign.config.candidateSourceIds.includes(finalCandidate.source_id)&&finalCampaign.config.ownerIds.includes(finalCandidate.owner_id)&&finalCampaign.config.segments.includes(finalCandidate.segment)&&finalCampaign.config.territories.includes(finalCandidate.territory)&&finalAccount?.mode==='live'&&finalAccount.status==='healthy'&&finalAccount.read_budget>0&&finalAccount.read_timezone===finalCampaign.config.timezone&&finalAccount.sender_provider_id===finalCampaign.config.senderProviderId&&!conflictingOutbound&&timelyAcceptance&&linkedinWindowOpen(boundaryNow,finalCampaign.config);
  // Retired Pipedrive path: every Pipedrive and email-sequence term stays here.
  const pipedriveGate=()=>finalCandidate.pipedrive_owner_id===candidate.pipedrive_owner_id&&finalCandidate.email_unanswered===true&&finalCandidate.email_sequence_complete_at&&new Date(finalCandidate.email_sequence_complete_at).getTime()===new Date(candidate.email_sequence_complete_at).getTime()&&routes.length===1&&routes[0].id===candidate.pipedrive_owner_id&&link&&controls.length===0&&!recent;
  const prospectGate=()=>prospectSkip===null&&finalCandidate.lane===candidate.lane&&finalCandidate.lane===finalCampaign.config.lane&&(finalCandidate.resolved_email||null)===(candidate.resolved_email||null);
  const finalAllowed=Boolean(common&&(prospect?prospectGate():pipedriveGate()));
  if(!finalAllowed){const reason=!timelyAcceptance?'late_acceptance_review':!linkedinWindowOpen(boundaryNow,finalCampaign?.config)?'window_closed':'local_fence_changed';await db.query("UPDATE sdr_linkedin_actions SET state='held',hold_reason=$2 WHERE id=$1 AND state='reserved'",[actionId,reason]);await db.query('COMMIT');return held(reason)}
  // This conditional statement is the local authorization boundary. Captures
  // committed after the earlier SELECTs must still prevent a provider POST.
  const replyTables=(await db.query("SELECT to_regclass('sdr_message_facts') AS facts,to_regclass('sdr_inbox_reply_log') AS legacy")).rows[0];
  const emailFences=[];
  const fenceEmail=prospect?normalEmail(candidate.resolved_email):normalEmail(link?.verified_email);
  if(replyTables.facts&&fenceEmail)emailFences.push("AND NOT EXISTS (SELECT 1 FROM sdr_message_facts WHERE direction='in' AND human_reply IS TRUE AND occurred_at > NOW() - make_interval(days => $10::int) AND lower(trim(prospect_email))=$9)");
  if(replyTables.legacy&&fenceEmail)emailFences.push("AND NOT EXISTS (SELECT 1 FROM sdr_inbox_reply_log WHERE from_addr NOT LIKE '[%' AND created_at > NOW() - make_interval(days => $10::int) AND lower(trim(coalesce(substring(from_addr from '<([^>]+)>'),from_addr)))=$9)");
  const claimed=await db.query(`UPDATE sdr_linkedin_actions SET state='network_started',network_started_at=$2,request_hash=$3
   WHERE id=$1 AND state='reserved' AND fence=$4
   AND NOT EXISTS (SELECT 1 FROM sdr_outreach_controls c WHERE c.company_id=$5 AND c.status='active' AND (c.lead_id IS NULL OR c.lead_id=$8))
   AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=$5 AND e.account_id=$6 AND e.person_id=$7 AND e.kind='message_received'
    AND (e.direction IS DISTINCT FROM 'out' OR NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions own WHERE own.company_id=e.company_id AND own.account_id=e.account_id AND own.person_id=e.person_id AND own.state='confirmed' AND own.provider_id=e.source_message_id)))
   AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=$5 AND e.account_id=$6 AND e.kind='account_status' AND e.processed_at IS NULL AND upper(coalesce(e.safe_payload->>'status','')) NOT IN ('OK','SYNC_SUCCESS','RECONNECTED','CREATION_SUCCESS'))
   ${emailFences.join('\n   ')}
   RETURNING id`,[actionId,boundaryNow,requestHash,action.fence+1,action.company_id,action.account_id,action.person_id,prospect?null:link.lead_id,...(emailFences.length?[fenceEmail,RECENT_REPLY_DAYS]:[])]);
  if(claimed.rowCount!==1){await db.query("UPDATE sdr_linkedin_actions SET state='held',hold_reason='local_fence_changed' WHERE id=$1 AND state='reserved'",[actionId]);await db.query('COMMIT');return held('local_fence_changed')}
  await db.query('COMMIT');
  let result;try{result=action.step==='invite'?await client.invite({providerId:request.providerId}):action.step==='dm1'?await client.sendFirst({providerId:request.providerId,text:request.text}):action.step==='inmail'?await client.sendInmail({providerId:request.providerId,text:request.text,subject:request.subject}):action.step==='withdraw'?await client.withdrawInvite({invitationId:request.invitationId}):await client.sendInChat({chatId:request.chatId,text:request.text})}catch{result={outcome:'unknown',reason:'transport_exception'}}
  const next=result?.outcome==='confirmed'?'confirmed':result?.outcome==='rejected'?'rejected':'uncertain_provider_result';
  await db.query(`UPDATE sdr_linkedin_actions SET state=$2,provider_id=$3,provider_chat_id=COALESCE($4,provider_chat_id),provider_receipt=$5,confirmed_at=CASE WHEN $2='confirmed' THEN $6 ELSE confirmed_at END WHERE id=$1`,[actionId,next,result?.providerId||null,result?.chatId||null,JSON.stringify(safeReceipt(result||{outcome:'unknown'})),now]);
  // 429, and a refused write with 401/403, restrict the account: nothing else goes out until it is re-registered.
  if(result?.status===429||result?.status===401||result?.status===403)await db.query("UPDATE sdr_linkedin_accounts SET status='restricted',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2",[action.company_id,action.account_id,now]);
  // LinkedIn reports weekly invite usage on the receipt; at 90% invites pause to the next local day.
  if(action.step==='invite'&&Number(result?.usage)>=90)await db.query('UPDATE sdr_linkedin_accounts SET coverage=coverage||$3::jsonb WHERE company_id=$1 AND account_id=$2',[action.company_id,action.account_id,JSON.stringify({invitesPausedUntil:nextLocalDayStart(now,campaign.config.timezone||'America/Chicago').toISOString(),inviteUsage:Number(result.usage)})]);
  return state(next);
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]).catch(()=>{});db.release()}
}
export async function reconcileLinkedinAction({pool,client,actionId}){const action=(await pool.query('SELECT * FROM sdr_linkedin_actions WHERE id=$1',[actionId])).rows[0];if(!action)return state('unavailable');if(!['network_started','uncertain_provider_result'].includes(action.state))return state(action.state);if(!action.provider_id)return state('uncertain_provider_result');let result;try{result=action.step==='invite'||action.step==='withdraw'?await client.listSentInvites({maxPages:2}):await client.listMessages({chatId:action.provider_chat_id,maxPages:2})}catch{return state('uncertain_provider_result')}if(!result.complete)return state('uncertain_provider_result');const matching=result.items.filter(item=>item.id===action.provider_id);if(action.step==='withdraw'?matching.length!==0:matching.length!==1)return state('uncertain_provider_result');await pool.query("UPDATE sdr_linkedin_actions SET state='confirmed',confirmed_at=now() WHERE id=$1 AND state IN ('network_started','uncertain_provider_result')",[actionId]);return state('confirmed')}
// A sequence that can no longer progress stops counting: an invite still unaccepted after
// LINKEDIN_INVITE_EXPIRY_DAYS, an InMail unanswered after LINKEDIN_FINAL_REPLY_DAYS, or the
// candidate's last follow-up (followup1 for lanes B and C, followup2 otherwise) unanswered after
// LINKEDIN_FINAL_REPLY_DAYS. With withdraw on, an invite that has a real invitation id waits for
// its withdraw (up to LINKEDIN_WITHDRAW_GRACE_DAYS) before it completes. completed_no_reply
// frees the outstanding-invite capacity.
export const LINKEDIN_INVITE_EXPIRY_DAYS=21,LINKEDIN_FINAL_REPLY_DAYS=7,LINKEDIN_WITHDRAW_GRACE_DAYS=28;
export async function completeLinkedinSequences({pool,companyId,accountId,now=new Date(),withdrawEnabled=process.env.SDR_LINKEDIN_WITHDRAW_ENABLED==='true'}){
 const active="c.state NOT IN ('held','replied','staff_takeover','opted_out','archived','completed_no_reply')";
 const noInbound="NOT EXISTS (SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=c.company_id AND e.account_id=c.account_id AND e.person_id=c.person_id AND e.kind='message_received' AND e.direction IS DISTINCT FROM 'out')";
 const noOpen="NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions o WHERE o.company_id=c.company_id AND o.account_id=c.account_id AND o.person_id=c.person_id AND o.state IN ('reserved','network_started'))";
 const sentAt="COALESCE(a.confirmed_at,a.network_started_at,a.reserved_at,a.created_at)";
 const withdrawWait=`($5::boolean IS NOT TRUE OR a.provider_id IS NULL OR ${sentAt} < $3::timestamptz - make_interval(days => $6::int)
   OR EXISTS (SELECT 1 FROM sdr_linkedin_actions w WHERE w.company_id=c.company_id AND w.account_id=c.account_id AND w.person_id=c.person_id AND w.step='withdraw' AND w.state IN ('confirmed','rejected','held','cancelled')))`;
 const expired=await pool.query(`UPDATE sdr_linkedin_candidates c SET state='completed_no_reply',hold_reason=CASE WHEN EXISTS (SELECT 1 FROM sdr_linkedin_actions w WHERE w.candidate_id=c.id AND w.step='withdraw' AND w.state='confirmed') THEN 'invite_withdrawn' ELSE 'invite_not_accepted' END,revision=revision+1
  FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id AND a.company_id=c.company_id AND a.account_id=c.account_id AND a.person_id=c.person_id AND a.step='invite' AND a.state IN ('confirmed','uncertain_provider_result')
  AND ${sentAt} < $3::timestamptz - make_interval(days => $4::int)
  AND c.company_id=$1 AND c.account_id=$2 AND ${active} AND ${noInbound} AND ${noOpen} AND ${withdrawWait}
  AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_events r WHERE r.company_id=c.company_id AND r.account_id=c.account_id AND r.person_id=c.person_id AND r.kind='new_relation')
  AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions dm WHERE dm.company_id=c.company_id AND dm.account_id=c.account_id AND dm.person_id=c.person_id AND dm.step NOT IN ('invite','inmail','withdraw') AND dm.state NOT IN ('pending','held','cancelled','rejected'))
  AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions im WHERE im.company_id=c.company_id AND im.account_id=c.account_id AND im.person_id=c.person_id AND im.step='inmail' AND im.state='confirmed' AND im.confirmed_at >= $3::timestamptz - make_interval(days => $7::int))
  RETURNING c.id,c.person_id`,[companyId,accountId,now,LINKEDIN_INVITE_EXPIRY_DAYS,withdrawEnabled,LINKEDIN_WITHDRAW_GRACE_DAYS,LINKEDIN_FINAL_REPLY_DAYS]);
 const lastStep="COALESCE((SELECT CASE WHEN jsonb_array_length(k.config->'followupDays')=1 THEN 'followup1' END FROM sdr_linkedin_campaigns k WHERE k.id=c.campaign_id),'followup2')";
 const finished=await pool.query(`UPDATE sdr_linkedin_candidates c SET state='completed_no_reply',hold_reason='sequence_finished',revision=revision+1
  FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id AND a.company_id=c.company_id AND a.account_id=c.account_id AND a.person_id=c.person_id AND a.step=${lastStep} AND a.state='confirmed'
  AND a.confirmed_at < $3::timestamptz - make_interval(days => $4::int)
  AND c.company_id=$1 AND c.account_id=$2 AND ${active} AND ${noInbound} AND ${noOpen}
  RETURNING c.id,c.person_id`,[companyId,accountId,now,LINKEDIN_FINAL_REPLY_DAYS]);
 // An InMail with no reply after 7 days (and no accept) closes the person.
 const inmailDone=await pool.query(`UPDATE sdr_linkedin_candidates c SET state='completed_no_reply',hold_reason='sequence_finished',revision=revision+1
  FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id AND a.company_id=c.company_id AND a.account_id=c.account_id AND a.person_id=c.person_id AND a.step='inmail' AND a.state='confirmed'
  AND a.confirmed_at < $3::timestamptz - make_interval(days => $4::int)
  AND c.company_id=$1 AND c.account_id=$2 AND ${active} AND ${noInbound} AND ${noOpen}
  AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_events r WHERE r.company_id=c.company_id AND r.account_id=c.account_id AND r.person_id=c.person_id AND r.kind='new_relation')
  AND EXISTS (SELECT 1 FROM sdr_linkedin_actions i WHERE i.company_id=c.company_id AND i.account_id=c.account_id AND i.person_id=c.person_id AND i.step='invite' AND ($5::boolean IS NOT TRUE OR i.provider_id IS NULL OR COALESCE(i.confirmed_at,i.network_started_at,i.reserved_at,i.created_at) < $3::timestamptz - make_interval(days => $6::int)
   OR EXISTS (SELECT 1 FROM sdr_linkedin_actions w WHERE w.company_id=c.company_id AND w.account_id=c.account_id AND w.person_id=c.person_id AND w.step='withdraw' AND w.state IN ('confirmed','rejected','held','cancelled'))))
  RETURNING c.id,c.person_id`,[companyId,accountId,now,LINKEDIN_FINAL_REPLY_DAYS,withdrawEnabled,LINKEDIN_WITHDRAW_GRACE_DAYS]);
 const people=[...expired.rows,...finished.rows,...inmailDone.rows].map(row=>row.person_id);
 if(people.length)await pool.query(`UPDATE sdr_linkedin_actions SET state='cancelled' WHERE company_id=$1 AND account_id=$2 AND person_id=ANY($3::text[]) AND state='pending'`,[companyId,accountId,people]);
 return {inviteExpired:expired.rowCount,sequenceFinished:finished.rowCount+inmailDone.rowCount};
}
