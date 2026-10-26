import {canonicalProfile,linkedinHash,stageCandidate,resolveIdentity} from './sdrLinkedinStore.js';
import {validateLinkedinCampaign} from './sdrLinkedinPolicy.js';
import {previewLinkedinCampaign,assignLinkedinCampaign} from './sdrLinkedinOfflineReview.js';
import {classifyLinkedinProviderId} from './sdrLinkedinIdentity.js';
import {bidInviteLeadFor,notOnOpenBidInviteLead} from './bidInviteGuard.js';
import {hasRecentReply} from './recentReply.js';
const fail=(code,detail)=>Object.assign(new Error(code),{code,...(detail?{detail}:{})});
const id=value=>value==null?null:String(value?.value??value?.id??value);
const validTimezone=value=>{try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format();return typeof value==='string'}catch{return false}};
// Derek's real personal profile: low daily ceilings regardless of what a campaign asks for.
export const LINKEDIN_BUDGET_CAP={invite:5,dm:5},LINKEDIN_READ_BUDGET_CAP=100;
export const LINKEDIN_STAGE_SETTLE_DAYS=3;
const MODES=['disabled','observe','dry_run','live'];

export async function auditLinkedinAdmin(db,{companyId,accountId,actor,action,targetId=null,detail={}}){
 await db.query('INSERT INTO sdr_linkedin_admin_audit(company_id,account_id,actor,action,target_id,detail) VALUES($1,$2,$3,$4,$5,$6)',[companyId,accountId,actor,action,targetId,JSON.stringify(detail)]);
}

// The account row is written only after the provider confirms the connected account and its
// own ACo sender. A re-registration never changes the sender and always restarts in observe.
export async function registerLinkedinAccount({pool,client,companyId,accountId,actor,readBudget,timezone='America/Chicago',now=new Date()}){
 if(!pool||!client||!companyId||!accountId||!actor)throw fail('linkedin_unconfigured');
 if(!Number.isInteger(readBudget)||readBudget<1||readBudget>LINKEDIN_READ_BUDGET_CAP||!validTimezone(timezone))throw fail('invalid_account_settings');
 const before=(await pool.query('SELECT sender_provider_id FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,accountId])).rows[0];
 // The two verification reads are charged to this budget, so it is stored first.
 await pool.query(`INSERT INTO sdr_linkedin_accounts(company_id,account_id,read_budget,read_timezone) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,account_id) DO UPDATE SET read_budget=EXCLUDED.read_budget,read_timezone=EXCLUDED.read_timezone`,[companyId,accountId,readBudget,timezone]);
 const account=await client.getAccount(),self=await client.getSelf();
 const sender=id(self?.provider_id);
 if(account?.id!==accountId||account.type!=='LINKEDIN'||!Array.isArray(account.sources)||!account.sources.length||!account.sources.every(source=>source.status==='OK')||classifyLinkedinProviderId(sender)!=='classic')throw fail('connected_identity_unverified');
 if(before?.sender_provider_id&&before.sender_provider_id!==sender)throw fail('sender_changed');
 const profileUrl=self.public_identifier?`https://www.linkedin.com/in/${self.public_identifier}/`:null;
 const db=await pool.connect();try{await db.query('BEGIN');
  const row=(await db.query(`UPDATE sdr_linkedin_accounts SET sender_provider_id=$3,sender_profile_url=$4,status='healthy',status_observed_at=$5,mode='observe' WHERE company_id=$1 AND account_id=$2 RETURNING company_id,account_id,sender_provider_id,sender_profile_url,status,mode,read_budget,read_timezone`,[companyId,accountId,sender,profileUrl,now])).rows[0];
  await auditLinkedinAdmin(db,{companyId,accountId,actor,action:'account.register',targetId:accountId,detail:{senderProviderId:sender,readBudget,timezone,previousSender:before?.sender_provider_id||null}});
  await db.query('COMMIT');return row;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
}

// The runtime starts only when this mode equals SDR_LINKEDIN_MODE, read once at boot.
export async function setLinkedinAccountMode({pool,companyId,accountId,actor,mode}){
 if(!MODES.includes(mode))throw fail('invalid_mode');
 const db=await pool.connect();try{await db.query('BEGIN');
  const account=(await db.query('SELECT * FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2 FOR UPDATE',[companyId,accountId])).rows[0];
  if(!account)throw fail('account_unregistered');
  if(mode!=='disabled'&&(account.status!=='healthy'||classifyLinkedinProviderId(account.sender_provider_id)!=='classic'||!account.read_timezone||account.read_budget<1))throw fail('account_unverified');
  const row=(await db.query('UPDATE sdr_linkedin_accounts SET mode=$3 WHERE company_id=$1 AND account_id=$2 RETURNING company_id,account_id,status,mode',[companyId,accountId,mode])).rows[0];
  await auditLinkedinAdmin(db,{companyId,accountId,actor,action:'account.mode',targetId:accountId,detail:{from:account.mode,to:mode}});
  await db.query('COMMIT');return row;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
}

// Create or revise a campaign. Any revision leaves it unapproved. candidateIds, when given,
// becomes the exact cohort: those reviewed candidates are assigned and the rest unassigned.
export async function saveLinkedinCampaign({pool,companyId,accountId,actor,campaignId=null,expectedRevision=null,config={},expiresAt,candidateIds,now=new Date()}){
 if(!config||typeof config!=='object'||Array.isArray(config))throw fail('campaign_config_incomplete');
 const account=(await pool.query('SELECT sender_provider_id,read_timezone FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,accountId])).rows[0];
 if(!account?.sender_provider_id||!account.read_timezone)throw fail('account_unregistered');
 if(config.senderProviderId&&config.senderProviderId!==account.sender_provider_id)throw fail('sender_mismatch');
 const previous=campaignId?(await pool.query('SELECT * FROM sdr_linkedin_campaigns WHERE company_id=$1 AND account_id=$2 AND id=$3',[companyId,accountId,campaignId])).rows[0]:null;
 if(campaignId&&!previous)throw fail('campaign_unavailable');
 const budgets=config.budgets||previous?.config?.budgets||{invite:0,dm:0};
 if(!Number.isInteger(budgets.invite)||!Number.isInteger(budgets.dm)||budgets.invite>LINKEDIN_BUDGET_CAP.invite||budgets.dm>LINKEDIN_BUDGET_CAP.dm)throw fail('budget_above_cap');
 const expiry=new Date(expiresAt??previous?.expires_at);if(!Number.isFinite(expiry.getTime())||expiry<=now||expiry-now>90*86_400_000)throw fail('invalid_expiry');
 let cohort=null;
 if(candidateIds!==undefined){
  if(!Array.isArray(candidateIds)||!candidateIds.length||candidateIds.length>50||new Set(candidateIds).size!==candidateIds.length)throw fail('invalid_cohort');
  cohort=(await pool.query(`SELECT * FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND id::text=ANY($3::text[])`,[companyId,accountId,candidateIds])).rows;
  if(cohort.length!==candidateIds.length||cohort.some(c=>c.campaign_id&&c.campaign_id!==campaignId||c.state!=='reviewed'&&c.campaign_id!==campaignId||!c.person_id||c.email_unanswered!==true||!c.email_sequence_complete_at))throw fail('cohort_unverified');
 }
 const unique=key=>[...new Set(cohort.map(c=>c[key]))];
 // A revision starts from the previous configuration; a new campaign from safe defaults.
 const full={sendWindow:{weekdays:[1,2,3,4,5],start:'08:00',end:'17:00'},lateAcceptancePolicy:'send_on_verified_observation',stopPolicy:'any_inbound',...(previous?.config||{}),
  senderProviderId:account.sender_provider_id,timezone:account.read_timezone,
  ...(cohort?{sources:unique('source'),ownerIds:unique('owner_id'),segments:unique('segment'),territories:unique('territory')}:{}),
  ...config,...(cohort?{candidateSourceIds:cohort.map(c=>c.source_id)}:{}),budgets};
 const row=await previewLinkedinCampaign({pool,companyId,accountId,config:full,expiresAt:expiry.toISOString(),reviewer:actor,now,campaignId,expectedRevision});
 if(cohort){
  await pool.query(`UPDATE sdr_linkedin_candidates c SET campaign_id=NULL,revision=revision+1 WHERE company_id=$1 AND account_id=$2 AND campaign_id=$3 AND NOT (id::text=ANY($4::text[])) AND state='reviewed' AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id)`,[companyId,accountId,row.id,candidateIds]);
  for(const candidate of cohort)if(candidate.campaign_id!==row.id)await assignLinkedinCampaign({pool,companyId,accountId,candidateId:candidate.id,campaignId:row.id,expectedRevision:candidate.revision,reviewer:actor});
 }
 await auditLinkedinAdmin(pool,{companyId,accountId,actor,action:campaignId?'campaign.update':'campaign.create',targetId:row.id,detail:{revision:row.revision,budgets,expiresAt:row.expires_at,cohortSize:row.config.candidateSourceIds?.length||0}});
 return row;
}

// Approval binds the exact assigned cohort and configuration. The digest is the one
// queueing and dispatch recompute through validateLinkedinCampaign.
export async function approveLinkedinCampaign({pool,companyId,accountId,actor,campaignId,expectedRevision,now=new Date()}){
 if(!Number.isInteger(expectedRevision))throw fail('invalid_revision');
 const db=await pool.connect();try{await db.query('BEGIN');
  const campaign=(await db.query('SELECT * FROM sdr_linkedin_campaigns WHERE company_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE',[companyId,accountId,campaignId])).rows[0];
  if(!campaign)throw fail('campaign_unavailable');
  if(campaign.revision!==expectedRevision)throw fail('campaign_revision_conflict');
  if(campaign.status!=='unapproved')throw fail('campaign_already_approved');
  const account=(await db.query('SELECT sender_provider_id,read_timezone FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,accountId])).rows[0];
  if(!account||account.sender_provider_id!==campaign.config?.senderProviderId||account.read_timezone!==campaign.config?.timezone)throw fail('account_mismatch');
  const assigned=(await db.query(`SELECT id,source,source_id,person_id,provider_id,owner_id,segment,territory,state FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND campaign_id=$3 ORDER BY id`,[companyId,accountId,campaignId])).rows;
  const wanted=[...(campaign.config?.candidateSourceIds||[])].sort(),have=assigned.map(c=>c.source_id).sort();
  if(!wanted.length||wanted.join('\n')!==have.join('\n')||assigned.some(c=>!c.person_id||!c.provider_id||!campaign.config.sources.includes(c.source)||!campaign.config.ownerIds.includes(c.owner_id)||!campaign.config.segments.includes(c.segment)||!campaign.config.territories.includes(c.territory)))throw fail('cohort_mismatch');
  const cohortDigest=linkedinHash({campaignId,revision:campaign.revision,candidates:assigned.map(c=>({id:c.id,sourceId:c.source_id,personId:c.person_id,providerId:c.provider_id}))});
  const approvedAt=new Date(now);
  const view={companyId,accountId,revision:campaign.revision,status:'approved',approvalDigest:'pending',cohortDigest,approvedBy:actor,approvedAt,expiresAt:campaign.expires_at,config:campaign.config};
  const approval=validateLinkedinCampaign(view);
  if(!approval.allowed)throw fail('campaign_not_approvable',approval.reasons);
  const row=(await db.query(`UPDATE sdr_linkedin_campaigns SET status='approved',cohort_digest=$4,approval_digest=$5,approved_by=$6,approved_at=$7 WHERE company_id=$1 AND account_id=$2 AND id=$3 AND revision=$8 RETURNING *`,[companyId,accountId,campaignId,cohortDigest,approval.digest,actor,approvedAt,campaign.revision])).rows[0];
  await auditLinkedinAdmin(db,{companyId,accountId,actor,action:'campaign.approve',targetId:campaignId,detail:{revision:campaign.revision,approvalDigest:approval.digest,cohortDigest,candidates:assigned.length,budgets:campaign.config.budgets}});
  await db.query('COMMIT');return row;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
}

// AGC/LBA leads whose Apollo sequence completed every step with no reply, bounce or
// unsubscribe. Customers, Bid Invite contacts, held leads and existing LinkedIn
// conversations are skipped. Each staged person costs one LinkedIn profile read.
export async function findLinkedinStageLeads(pool,{companyId,accountId,now=new Date(),limit=20}){
 const tables=(await pool.query("SELECT to_regclass('sdr_reply_messages') AS replies,to_regclass('sdr_outreach_controls') AS controls")).rows[0];
 return (await pool.query(`SELECT * FROM (SELECT DISTINCT ON (s.pipedrive_lead_id) s.id::text AS send_id,s.pipedrive_lead_id AS lead_id,s.apollo_contact_id,s.apollo_sequence_id,d.trigger_type AS segment,
   lower(btrim(d.contact_email_snapshot)) AS email,ls.pipedrive_person_id AS person_id,
   COALESCE((SELECT max(e.occurred_at) FROM sdr_engagement_events e WHERE e.pipedrive_lead_id=s.pipedrive_lead_id AND e.event_type='email_sent' AND e.apollo_sequence_id=s.apollo_sequence_id),s.updated_at) AS completed_at
  FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=s.pipedrive_lead_id
  WHERE d.trigger_type IN ('AGC','LBA') AND s.status='sent' AND s.step_status='completed' AND s.total_steps>=1 AND s.current_step>=s.total_steps
   AND s.apollo_contact_id IS NOT NULL AND ls.pipedrive_person_id IS NOT NULL AND nullif(btrim(d.contact_email_snapshot),'') IS NOT NULL
   AND coalesce(ls.crm_status,'unknown') NOT IN ('archived','missing')
   AND lower(btrim(coalesce(ls.lead_origin,''))) NOT LIKE 'bid invite%' AND ${notOnOpenBidInviteLead('ls')}
   AND NOT EXISTS (SELECT 1 FROM sdr_sends o WHERE o.pipedrive_lead_id=s.pipedrive_lead_id AND o.status IN ('enrolled','replied','bounced','unsubscribed'))
   AND NOT EXISTS (SELECT 1 FROM sdr_engagement_events r WHERE r.pipedrive_lead_id=s.pipedrive_lead_id AND r.event_type IN ('email_replied','reply_received','email_bounced','email_unsubscribed'))
   ${tables.replies?"AND NOT EXISTS (SELECT 1 FROM sdr_reply_messages m WHERE m.pipedrive_lead_id=s.pipedrive_lead_id AND m.reply_kind IN ('human','bounce'))":''}
   ${tables.controls?"AND NOT EXISTS (SELECT 1 FROM sdr_outreach_controls oc WHERE oc.company_id=$1 AND oc.status='active' AND (oc.lead_id IS NULL OR oc.lead_id=s.pipedrive_lead_id))":''}
   AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_candidates c WHERE c.company_id=$1 AND c.account_id=$2 AND ((c.source='pipedrive' AND c.source_id=s.pipedrive_lead_id) OR c.person_id=ls.pipedrive_person_id))
  ORDER BY s.pipedrive_lead_id,s.updated_at DESC) eligible
  WHERE completed_at <= $3::timestamptz - make_interval(days => $4::int) ORDER BY completed_at DESC LIMIT $5`,[companyId,accountId,now,LINKEDIN_STAGE_SETTLE_DAYS,limit])).rows;
}

export async function stageLinkedinCandidatesFromLeads({pool,client,crm,apollo,customerLookup,companyId,accountId,actor,limit=5,now=new Date()}){
 if(!pool||!client||!crm||!apollo||!customerLookup||!actor)throw fail('linkedin_unconfigured');
 if(!Number.isInteger(limit)||limit<1||limit>10)throw fail('invalid_limit');
 const rows=await findLinkedinStageLeads(pool,{companyId,accountId,now,limit:limit*4});
 const staged=[],skipped=[];let stopped=null;
 const skip=(row,reason)=>skipped.push({leadId:row.lead_id,reason});
 for(const row of rows){
  if(staged.length>=limit)break;
  try{
   if(await hasRecentReply(pool,row.email)){skip(row,'recent_reply');continue}
   if(await bidInviteLeadFor(pool,{leadId:row.lead_id,personId:row.person_id,emails:[row.email]})){skip(row,'bid_invite_contact');continue}
   const lead=await crm.getLead(row.lead_id);
   const ownerPipedrive=id(lead?.owner_id),organizationId=id(lead?.organization_id??lead?.org_id);
   if(!lead||lead.is_archived!==false||id(lead.person_id)!==String(row.person_id)||!ownerPipedrive||!organizationId){skip(row,'crm_unverified');continue}
   if(await customerLookup(row.lead_id)!==false){skip(row,'customer');continue}
   const [person,organization,contact]=await Promise.all([crm.getPerson(row.person_id),crm.getOrganization(organizationId),apollo.getContact(row.apollo_contact_id)]);
   const emails=(Array.isArray(person?.email)?person.email:[person?.email]).map(value=>String((value?.value??value)||'').trim().toLowerCase()).filter(Boolean);
   if(id(person?.id)!==String(row.person_id)||id(person?.owner_id)!==ownerPipedrive||id(person?.org_id)!==organizationId||!emails.includes(row.email)||!organization?.name){skip(row,'crm_unverified');continue}
   const owners=(await pool.query('SELECT DISTINCT owner_user_id::text AS id FROM sdr_mailboxes WHERE pipedrive_sender_id::text=$1 AND active IS TRUE AND owner_user_id IS NOT NULL',[ownerPipedrive])).rows;
   if(owners.length!==1){skip(row,'owner_route_unverified');continue}
   if(id(contact?.id)!==row.apollo_contact_id||String(contact?.email||'').trim().toLowerCase()!==row.email||!Array.isArray(contact.contact_campaign_statuses)||contact.contact_campaign_statuses.some(m=>!m?.status||m.status==='active')){skip(row,'apollo_unverified');continue}
   let apolloProfile;try{apolloProfile=canonicalProfile(contact.linkedin_url)}catch{skip(row,'no_linkedin_profile');continue}
   let profile;try{profile=await client.getProfile({identifier:decodeURIComponent(apolloProfile.split('/')[4])})}catch(error){if(error?.code==='read_budget_exhausted'){stopped='read_budget_exhausted';break}skip(row,'linkedin_profile_unavailable');continue}
   const providerId=id(profile?.provider_id);
   let profileUrl;try{profileUrl=canonicalProfile(profile?.profile_url||(profile?.public_identifier&&`https://www.linkedin.com/in/${profile.public_identifier}/`))}catch{profileUrl=null}
   if(classifyLinkedinProviderId(providerId)!=='classic'||!profileUrl){skip(row,'linkedin_identity_unverified');continue}
   if(profile.is_relationship===true){skip(row,'already_connected');continue}
   if(profile.invitation?.status==='PENDING'){skip(row,'pending_invite');continue}
   if((await pool.query(`SELECT 1 FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND kind='message_received' AND provider_id=$3 LIMIT 1`,[companyId,accountId,providerId])).rows.length){skip(row,'linkedin_conversation');continue}
   const observedAt=new Date(now).toISOString();
   const db=await pool.connect();let candidate;
   try{await db.query('BEGIN');
    const sourceRow={source:'pipedrive',sourceId:row.lead_id,observedAt,profileUrl,segment:row.segment,territory:'all',firm:organization.name,role:person.job_title||null,emailSequenceCompleteAt:row.completed_at,emailUnanswered:true,
     context:{evidence:'auto_stage',sendId:row.send_id,emailSequenceId:row.apollo_sequence_id,firstName:person.first_name||null,firstNameVerified:Boolean(person.first_name),facts:{company:{value:organization.name,verified:true,evidenceRef:`pipedrive:organization:${organizationId}`,observedAt}},stagedBy:actor,stagedAt:observedAt}};
    const stagedRow=await stageCandidate(db,{companyId,accountId,sourceRow,actor});
    candidate=await resolveIdentity(db,{candidateId:stagedRow.id,expectedRevision:stagedRow.revision,actor,transactional:true,evidence:{personId:String(row.person_id),organizationId,ownerId:owners[0].id,pipedriveOwnerId:ownerPipedrive,providerId,product:'classic',profileUrl,
     links:[{leadId:row.lead_id,verifiedEmail:row.email,apolloContactId:row.apollo_contact_id,evidence:{source:'auto_stage',personId:String(row.person_id),leadId:row.lead_id,sendId:row.send_id,observedAt}}]}});
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK').catch(()=>{});if(error?.code==='23505'){skip(row,'person_already_candidate');continue}throw error}finally{db.release()}
   staged.push({candidateId:candidate.id,leadId:row.lead_id,segment:row.segment,revision:candidate.revision});
  }catch(error){if(error?.code==='read_budget_exhausted'){stopped='read_budget_exhausted';break}skip(row,error?.code||'source_unavailable')}
 }
 await auditLinkedinAdmin(pool,{companyId,accountId,actor,action:'candidates.stage',detail:{considered:rows.length,staged:staged.map(s=>s.candidateId),skipped,stopped}});
 return {considered:rows.length,staged,skipped,stopped};
}
