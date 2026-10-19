import {createHash} from 'node:crypto';
import {stageCandidate,resolveIdentity,canonicalProfile} from './sdrLinkedinStore.js';
import {planLinkedinNextAction} from './sdrLinkedinPolicy.js';
const fail=code=>Object.assign(new Error(code),{code});
const date=(value,now)=>{const d=new Date(value);if(!value||!Number.isFinite(d.getTime())||d>now)throw fail('evidence_unverified');return d};
const ref=value=>typeof value==='string'&&value.trim().length>3;
const exactly=(a,b)=>a&&b&&String(a)===String(b);
function verifyPacket(packet,now){
 const {source:s,identity:i,email:e,links=[]}=packet||{};
 if(!s||!i||!e||!Array.isArray(links)||!links.length||!ref(s.evidenceRef)||!s.sourceId||!['pipedrive','authorized_export','cold_review'].includes(s.source)||!['AGC','LBA','cold'].includes(s.segment)||!s.territory||!s.firm||!s.role)throw fail('evidence_unverified');
 date(s.observedAt,now);date(i.personEvidence?.observedAt,now);date(i.profileEvidence?.observedAt,now);const completed=date(e.completedAt,now),unanswered=date(e.unansweredThrough,now),replyReviewed=date(e.replyEvidenceObservedAt,now);
 if(unanswered<completed||replyReviewed<completed||+replyReviewed!==+unanswered||e.replyEvidenceSource!=='mailbox_reply_review'||!ref(e.replyEvidenceRef)||e.completed!==true||e.unanswered!==true||!e.sequenceId||e.source!=='apollo_sequence_export'||!ref(e.sourceRef)||!exactly(e.personId,i.personId))throw fail('evidence_unverified');
 if(i.personEvidence?.source!=='pipedrive_person_export'||!exactly(i.personEvidence.personId,i.personId)||!exactly(i.personEvidence.organizationId,i.organizationId)||i.profileEvidence?.source!=='linkedin_profile_review'||!exactly(i.profileEvidence.providerId,i.providerId)||i.product!=='classic'||!/^ACo[A-Za-z0-9_-]+$/.test(i.providerId||'')||!i.ownerId||!i.pipedriveOwnerId)throw fail('evidence_unverified');
 try{if(canonicalProfile(s.profileUrl)!==canonicalProfile(i.profileUrl)||canonicalProfile(i.profileEvidence.profileUrl)!==canonicalProfile(i.profileUrl))throw fail('evidence_unverified')}catch{throw fail('evidence_unverified')}
 const refs=[s.evidenceRef,i.personEvidence.sourceRef,i.profileEvidence.sourceRef,e.sourceRef,e.replyEvidenceRef];
 if(refs.some(x=>!ref(x))||new Set(refs).size!==refs.length)throw fail('evidence_unverified');
 for(const link of links){date(link.evidence?.observedAt,now);if(link.evidence?.source!=='pipedrive_project_export'||!ref(link.evidence.sourceRef)||refs.includes(link.evidence.sourceRef)||!exactly(link.evidence.personId,i.personId)||!exactly(link.evidence.leadId,link.leadId)||!link.verifiedEmail||!link.apolloContactId)throw fail('evidence_unverified');refs.push(link.evidence.sourceRef)}
}
export async function reviewLinkedinCandidate({pool,companyId,accountId,packet,reviewer,now=new Date()}={}){
 if(!pool||!companyId||!accountId||!reviewer)throw fail('review_scope_required');
 verifyPacket(packet,new Date(now));
 const {source,identity,email,links}=packet;
 const candidate=await stageCandidate(pool,{companyId,accountId,actor:reviewer,sourceRow:{...source,emailSequenceCompleteAt:email.completedAt,emailUnanswered:true,context:{sourceEvidenceRef:source.evidenceRef,personEvidenceRef:identity.personEvidence.sourceRef,profileEvidenceRef:identity.profileEvidence.sourceRef,emailEvidenceRef:email.sourceRef,replyEvidenceRef:email.replyEvidenceRef,emailSequenceId:email.sequenceId,sourceObservedAt:source.observedAt,personObservedAt:identity.personEvidence.observedAt,profileObservedAt:identity.profileEvidence.observedAt,unansweredThrough:email.unansweredThrough,reviewedAt:new Date(now).toISOString(),reviewer}}});
 return resolveIdentity(pool,{candidateId:candidate.id,expectedRevision:candidate.revision,actor:reviewer,evidence:{...identity,links}});
}
function verifyConfig(config,expiresAt,now){
 const arrays=['segments','territories','sources','candidateSourceIds','ownerIds'];
 if(!config||!/^ACo[A-Za-z0-9_-]+$/.test(config.senderProviderId||'')||!config.timezone||!['hold','send_on_verified_observation'].includes(config.lateAcceptancePolicy)||!Array.isArray(config.followupDays)||config.followupDays.length!==2||config.followupDays.some((v,index)=>!Number.isInteger(v)||v<=0||index&&v<=config.followupDays[index-1])||arrays.some(key=>!Array.isArray(config[key])||!config[key].length)||!config.copy?.dm1||!config.copy?.followup1||!config.copy?.followup2||config.stopPolicy!=='any_inbound'||!Number.isInteger(config.budgets?.invite)||!Number.isInteger(config.budgets?.dm)||config.budgets.invite<0||config.budgets.dm<0||!Array.isArray(config.sendWindow?.weekdays)||config.sendWindow.weekdays.join(',')!=='1,2,3,4,5'||config.sendWindow.start!=='08:00'||config.sendWindow.end!=='17:00'||date(expiresAt,new Date('9999-01-01'))<=now)throw fail('campaign_config_incomplete');
}
export async function previewLinkedinCampaign({pool,companyId,accountId,config,expiresAt,reviewer,now=new Date(),campaignId=null,expectedRevision=null}={}){
 if(!pool||!companyId||!accountId||!reviewer)throw fail('review_scope_required');
 config={...config,budgets:config?.budgets??{invite:0,dm:0}};verifyConfig(config,expiresAt,new Date(now));
 const params=[companyId,accountId,JSON.stringify(config),expiresAt];
 const result=campaignId?await pool.query(`UPDATE sdr_linkedin_campaigns SET revision=revision+1,status='unapproved',approval_digest=NULL,cohort_digest=NULL,approved_by=NULL,approved_at=NULL,config=$3,expires_at=$4 WHERE company_id=$1 AND account_id=$2 AND id=$5 AND revision=$6 RETURNING *`,[...params,campaignId,expectedRevision]):await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id,config,expires_at) VALUES($1,$2,$3,$4) RETURNING *`,params);
 if(!result.rows[0])throw fail('campaign_revision_conflict');return result.rows[0];
}
export async function assignLinkedinCampaign({pool,companyId,accountId,candidateId,campaignId,expectedRevision,reviewer}={}){
 if(!pool||!companyId||!accountId||!candidateId||!campaignId||!Number.isInteger(expectedRevision)||!reviewer)throw fail('review_scope_required');
 const campaign=(await pool.query(`SELECT * FROM sdr_linkedin_campaigns WHERE company_id=$1 AND account_id=$2 AND id=$3`,[companyId,accountId,campaignId])).rows[0];
 if(!campaign||campaign.status!=='unapproved')throw fail('campaign_unavailable');
 const result=await pool.query(`UPDATE sdr_linkedin_candidates SET campaign_id=$4,revision=revision+1 WHERE company_id=$1 AND account_id=$2 AND id=$3 AND revision=$5 AND state='reviewed' AND email_unanswered IS TRUE AND email_sequence_complete_at IS NOT NULL AND source=ANY($6::text[]) AND source_id=ANY($7::text[]) AND segment=ANY($8::text[]) AND territory=ANY($9::text[]) AND owner_id=ANY($10::text[]) RETURNING *`,[companyId,accountId,candidateId,campaignId,expectedRevision,campaign.config.sources,campaign.config.candidateSourceIds,campaign.config.segments,campaign.config.territories,campaign.config.ownerIds]);
 if(!result.rows[0])throw fail('assignment_unverified');return result.rows[0];
}
export async function previewLinkedinActions({pool,companyId,accountId,campaignId,now=new Date(),providerSnapshot=null}={}){
 if(!pool||!companyId||!accountId||!campaignId)throw fail('review_scope_required');
 if(providerSnapshot&&providerSnapshot.kind!=='synthetic_fixture')throw fail('snapshot_untrusted');
 const campaign=(await pool.query(`SELECT * FROM sdr_linkedin_campaigns WHERE company_id=$1 AND account_id=$2 AND id=$3`,[companyId,accountId,campaignId])).rows[0];if(!campaign)throw fail('campaign_unavailable');
 const rows=(await pool.query(`SELECT * FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND campaign_id=$3 ORDER BY created_at LIMIT 100`,[companyId,accountId,campaignId])).rows;
 const decisions=rows.map(candidate=>{const observations=providerSnapshot?.byPerson?.[candidate.person_id]||{};const plan=planLinkedinNextAction({candidate,campaign,observations,now:new Date(now)});const reasons=[...new Set([...(plan.reasons||[]),'campaign_unapproved','fresh_connected_evidence_unavailable'])];return {candidateId:candidate.id,step:plan.step,dueAt:plan.dueAt||null,held:true,reasons,evidence:'reviewed_offline_packet',providerSnapshot:providerSnapshot?'synthetic_fixture':'unavailable'}});
 return {campaignId,revision:campaign.revision,approvalStatus:campaign.status,providerWrites:0,decisions};
}
export async function recordLinkedinOutcomeAttribution({pool,companyId,accountId,candidateId,dealId,leadId,occurredAt,evidenceRef,channelActionId,reviewer,now=new Date()}={}){
 if(!pool||!companyId||!accountId||!candidateId||!dealId||!leadId||!ref(evidenceRef)||!channelActionId||!reviewer)throw fail('attribution_unverified');
 const at=date(occurredAt,new Date(now));
 const linked=(await pool.query(`SELECT c.person_id,c.source_context,l.evidence FROM sdr_linkedin_candidates c JOIN sdr_linkedin_links l ON l.company_id=c.company_id AND l.account_id=c.account_id AND l.candidate_id=c.id AND l.person_id=c.person_id WHERE c.company_id=$1 AND c.account_id=$2 AND c.id=$3 AND l.lead_id=$4 AND l.status='verified'`,[companyId,accountId,candidateId,leadId])).rows[0];
 const action=(await pool.query(`SELECT id FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND candidate_id=$3 AND id::text=$4 AND state='confirmed' AND confirmed_at<=$5`,[companyId,accountId,candidateId,channelActionId,at])).rows[0];
 if(!linked||!action||[linked.source_context?.sourceEvidenceRef,linked.source_context?.emailEvidenceRef,linked.evidence?.sourceRef].includes(evidenceRef))throw fail('attribution_unverified');
 const payload={channel:'linkedin',dealId,leadId,evidenceRef,channelActionId,reviewer};const hash=createHash('sha256').update(JSON.stringify([companyId,accountId,candidateId,dealId,evidenceRef,channelActionId])).digest('hex');
 return (await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,source_at,coverage,payload_hash,safe_payload) VALUES($1,$2,$3,$4,'outcome_attribution','reviewed_crm',$5,'reviewed',$6,$7) ON CONFLICT(company_id,account_id,payload_hash) DO UPDATE SET payload_hash=EXCLUDED.payload_hash RETURNING *`,[companyId,accountId,candidateId,linked.person_id,at,hash,JSON.stringify(payload)])).rows[0];
}
