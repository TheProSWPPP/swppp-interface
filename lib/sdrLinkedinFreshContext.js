import {checkLinkedinEligibility,validateLinkedinCampaign} from './sdrLinkedinPolicy.js';
import {linkedinHash,canonicalProfile} from './sdrLinkedinStore.js';
import {hasRecentReply} from './recentReply.js';
import {bidInviteLeadFor} from './bidInviteGuard.js';
const hold=reason=>({allowed:false,reasons:[reason]});
const id=value=>value==null?null:String(value?.value??value?.id??value);
const items=result=>Array.isArray(result?.items)&&result.complete===true?result.items:null;
export function createLinkedinFreshContext({pool,client,crm,apollo,customerLookup}){
 return async ({action,candidate,campaign,account,now=new Date()})=>{
  if(!pool||!client||!crm||!apollo||!customerLookup||!action||!candidate||!campaign||!account)return hold('source_unavailable');
  try{
   if(account.read_budget<=0||account.read_timezone!==campaign.config?.timezone)return hold('read_budget_unapproved');
   const row=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1 AND company_id=$2 AND account_id=$3',[candidate.id,action.company_id,action.account_id])).rows[0];
   if(!row||row.person_id!==action.person_id||row.owner_id!==candidate.owner_id||!row.pipedrive_owner_id||row.state==='held'||row.state==='replied'||row.state==='staff_takeover'||row.email_unanswered!==true||!row.email_sequence_complete_at)return hold('candidate_changed');
   const ownerRoutes=(await pool.query('SELECT DISTINCT pipedrive_sender_id::text AS id FROM sdr_mailboxes WHERE owner_user_id::text=$1 AND active IS TRUE AND pipedrive_sender_id IS NOT NULL',[row.owner_id])).rows;
   if(ownerRoutes.length!==1||ownerRoutes[0].id!==row.pipedrive_owner_id)return hold('owner_route_changed');
   const links=(await pool.query(`SELECT * FROM sdr_linkedin_links WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND status='verified'`,[action.company_id,action.account_id,action.person_id])).rows;
   const link=links.find(l=>l.candidate_id===row.id&&l.lead_id&&l.verified_email&&l.apollo_contact_id&&l.evidence?.source&&l.evidence?.personId===row.person_id&&l.evidence?.leadId===l.lead_id);if(!link)return hold('link_unverified');
   // Bid-sheet contacts (the linked lead, or this person on an open Bid Invite lead) stay out of LinkedIn outreach.
   const bidInvite=Boolean(await bidInviteLeadFor(pool,{leadId:link.lead_id,personId:row.person_id,emails:[link.verified_email]}));if(bidInvite)return hold('bid_invite_contact');
   const controls=(await pool.query(`SELECT 1 FROM sdr_outreach_controls WHERE company_id=$1 AND status='active' AND (lead_id IS NULL OR lead_id=$2) LIMIT 1`,[action.company_id,link.lead_id])).rows;
   if(controls.length||await hasRecentReply(pool,link.verified_email))return hold('conversation_or_hold');
   const [person,organization,lead,customer,contact,providerAccount,self,profile,chats]=await Promise.all([
    crm.getPerson(row.person_id),crm.getOrganization(row.organization_id),crm.getLead(link.lead_id),customerLookup(link.lead_id),apollo.getContact(link.apollo_contact_id),client.getAccount(),client.getSelf(),client.getProfile({identifier:row.provider_id}),client.findChats({attendeeId:row.provider_id,maxPages:1})]);
   const emails=(Array.isArray(person?.email)?person.email:[person?.email]).map(value=>String((value?.value??value)||'').trim().toLowerCase()).filter(Boolean);
   if(id(person?.id)!==row.person_id||id(person?.org_id)!==row.organization_id||id(person?.owner_id)!==row.pipedrive_owner_id||!emails.includes(link.verified_email)||id(organization?.id)!==row.organization_id||id(lead?.id)!==link.lead_id||id(lead?.person_id)!==row.person_id||id(lead?.organization_id??lead?.org_id)!==row.organization_id||id(lead?.owner_id)!==row.pipedrive_owner_id||lead?.is_archived!==false||customer!==false)return hold('crm_unverified');
   if(id(contact?.id)!==link.apollo_contact_id||String(contact?.email||'').trim().toLowerCase()!==link.verified_email||!Array.isArray(contact.contact_campaign_statuses))return hold('apollo_unverified');
   const membership=contact.contact_campaign_statuses.some(m=>!m?.status||m.status==='active')?'active':'none';
   const healthy=providerAccount?.id===row.account_id&&providerAccount.type==='LINKEDIN'&&Array.isArray(providerAccount.sources)&&providerAccount.sources.length>0&&providerAccount.sources.every(source=>source.status==='OK');
   const profileUrl=profile?.profile_url||profile?.public_identifier&&`https://www.linkedin.com/in/${profile.public_identifier}/`;
   if(!healthy||id(self?.provider_id)!==account.sender_provider_id||!/^ACo/.test(id(self?.provider_id)||'')||id(profile?.provider_id)!==row.provider_id||canonicalProfile(profileUrl)!==row.profile_url)return hold('provider_identity_unverified');
   // The person's own profile states the relationship and any pending invite, whatever
   // the size of the sender's connection and invitation lists.
   const chatList=items(chats);if(!chatList||chatList.length>5||typeof profile?.is_relationship!=='boolean')return hold('provider_history_partial');
   const relation=profile.is_relationship===true,invited=profile.invitation?.status==='PENDING';
   if(action.step==='invite'&&(relation||invited)||action.step!=='invite'&&!relation)return hold('relationship_changed');
   let messageHistory=[];const verifiedChatIds=new Set();for(const chat of chatList){
    const attendee=Array.isArray(chat.attendees_ids)?chat.attendees_ids.includes(row.provider_id):id(chat.attendee_provider_id)===row.provider_id;
    if(!chat.id||chat.account_id!==row.account_id||!attendee)return hold('chat_identity_unverified');
    verifiedChatIds.add(chat.id);
    const messages=items(await client.listMessages({chatId:chat.id,maxPages:1}));if(!messages)return hold('message_history_partial');
    if(messages.some(message=>!message?.id||typeof message.is_sender!=='boolean'||message.chat_id&&message.chat_id!==chat.id||message.account_id&&message.account_id!==row.account_id))return hold('message_identity_unverified');
    messageHistory.push(...messages);
   }
   if(['followup1','followup2'].includes(action.step)&&!verifiedChatIds.has(action.provider_chat_id))return hold('continuation_chat_unverified');
   const knownReceipts=(await pool.query("SELECT provider_id FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='confirmed'",[action.company_id,action.account_id,action.person_id])).rows.map(r=>r.provider_id);
   if(messageHistory.some(m=>m.is_sender!==true||!knownReceipts.includes(m.id)))return hold('conversation_changed');
   const campaignView={companyId:campaign.company_id,accountId:campaign.account_id,revision:campaign.revision,status:campaign.status,approvalDigest:campaign.approval_digest,cohortDigest:campaign.cohort_digest,approvedBy:campaign.approved_by,approvedAt:campaign.approved_at,expiresAt:campaign.expires_at,config:campaign.config};
   const approval=validateLinkedinCampaign(campaignView);if(!approval.allowed||approval.digest!==campaign.approval_digest)return hold('approval_changed');
   const decision=checkLinkedinEligibility({identity:{companyId:row.company_id,accountId:row.account_id,personId:row.person_id,organizationId:row.organization_id,ownerId:row.owner_id,providerId:row.provider_id,product:row.product,profileUrl:row.profile_url,segment:row.segment,territory:row.territory,revision:row.revision},campaign:campaignView,crm:{ownerId:row.owner_id,customer,apolloMembership:membership,bidInvite},controls:{held:false},replies:{inbound:false,staffOutbound:false},history:{complete:true,observedAt:now},account:{status:'healthy',product:'classic'},now});if(!decision.allowed)return decision;
   return {allowed:true,reasons:[],contextHash:linkedinHash({candidateId:row.id,campaignId:campaign.id,revision:campaign.revision,ownerId:row.owner_id,profileUrl:row.profile_url,body:action.body})};
  }catch(error){return hold(error?.code==='read_budget_exhausted'?'read_budget_exhausted':'fresh_context_unavailable')}
 }
}
