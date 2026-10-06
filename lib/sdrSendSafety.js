import {readDecisionContext} from './sdrChangeJournal.js';
import {getOutreachControls} from './sdrOutreachControls.js';
import {evaluateOutreach} from './sdrOutreachPolicy.js';
import * as pd from './pipedriveClient.js';
import {getSequenceDetail} from './apolloClient.js';
import {FIELD_KEYS,resolveTriggerType} from './pipedriveSync.js';
const id=v=>v==null?null:String(typeof v==='object'?v.id:v);
const email=v=>String(v||'').trim().toLowerCase();
const blocked=code=>Object.assign(new Error('Outreach needs current contact and cadence review'),{code,status:409,preserveDraft:true});
export async function assertSendSafety(db,draft,{companyId,readContext=readDecisionContext,readControls=getOutreachControls,getLead=pd.getLead,getPerson=pd.getPerson,
 getMailbox=async id=>(await db.query('SELECT email,apollo_mailbox_id FROM sdr_mailboxes WHERE id=$1 AND active=TRUE',[id])).rows[0],getSequence=getSequenceDetail}={}) {
 if(!companyId)throw blocked('outreach_company_unverified');
 const context=await readContext(db,draft.pipedrive_lead_id,{companyId,draftId:draft.id});
 const controls=await readControls(db,{...context,draftId:draft.id,channel:'email',serviceId:draft.metadata?.service_id});
 let sequenceCadence='standard';
 if(context.cadence==='award_only'){
  let sequence;try{sequence=await getSequence(context.sequenceId);}catch{throw blocked('sequence_cadence_unverified');}
  sequenceCadence=Array.isArray(sequence?.emailer_steps)&&sequence.emailer_steps.length===1&&sequence.emailer_steps[0].type==='auto_email'?'award_only':'unverified';
 }
 const decision=evaluateOutreach({context:{...context,sequenceCadence},controls,affiliationEvidence:context.reviewEvidence});
 if(decision.outcome!=='allow')throw blocked(decision.reasonCodes[0]);
 if(draft.metadata?.reviewed_outreach_context_hash!==decision.contextHash)throw blocked('draft_review_context_changed');
 const mailbox=await getMailbox(draft.assigned_mailbox_id);
 if(!mailbox?.email||!mailbox.apollo_mailbox_id||email(mailbox.email)!==email(draft.metadata?.sender_email)
  ||id(mailbox.apollo_mailbox_id)!==id(draft.metadata?.sender_provider_id))throw blocked('sender_context_changed');
 if(id(draft.contact_id_snapshot)!==context.personId||id(draft.org_id_snapshot)!==context.organizationId||email(draft.contact_email_snapshot)!==email(context.recipientEmail)
   ||id(draft.assigned_mailbox_id)!==context.mailboxId||id(draft.apollo_sequence_id)!==context.sequenceId||draft.trigger_type!==context.trigger)throw blocked('draft_recipient_context_changed');
 let lead,person;
 try{lead=await getLead(context.leadId);person=await getPerson(context.personId);}catch{throw blocked('crm_unverified');}
 const currentEmail=Array.isArray(person?.email)?(person.email.find(e=>e.primary)||person.email[0])?.value:person?.primary_email;
 if(id(lead?.id)!==context.leadId||lead.is_archived!==false||id(lead.person_id)!==context.personId||id(lead.organization_id)!==context.organizationId
   ||id(person?.id)!==context.personId||email(currentEmail)!==email(context.recipientEmail)||String(lead[FIELD_KEYS.STAGE]||'')!==context.stage)throw blocked('crm_context_changed');
 if(!context.overrideDecisionId&&resolveTriggerType(lead,lead[FIELD_KEYS.STAGE])!==context.trigger)throw blocked('crm_trigger_changed');
 return {...context,draftId:draft.id,channel:'email',serviceId:draft.metadata?.service_id};
}
