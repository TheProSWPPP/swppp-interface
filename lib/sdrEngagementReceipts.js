import {upsertOutreach} from './outreachSync.js';
const email=value=>String(value||'').trim().toLowerCase();
const iso=value=>value&&Number.isFinite(+new Date(value))?new Date(value).toISOString():null;

// The persisted event is immutable on replay. Caller-provided fallback timestamps are
// deliberately ignored; enrollment, opens and reply observations are not send receipts.
export async function recordCompletedOutreach(db,{eventId,sendRow,sendMatch}) {
 const skipped={recorded:false};
 if(!eventId||!sendRow?.pipedrive_lead_id)return skipped;
 const stored=(await db.query('SELECT event_type,apollo_emailer_message_id,payload FROM sdr_engagement_events WHERE apollo_event_id=$1',[eventId])).rows[0];
 const event=stored?.payload;
 const messageId=stored?.apollo_emailer_message_id;
 if(stored?.event_type!=='email_sent'||!messageId||!event)return skipped;
 let sentAt=iso(event.completed_at||event.created_at||event.timestamp);
 let sender=email(event.email_account?.email||event.from_email);
 const recipient=email(event.email||event.contact?.email);
 const campaign=event.sequence_id||event.emailer_campaign_id;
 if((campaign&&String(campaign)!==String(sendRow.apollo_sequence_id))||(recipient&&recipient!==email(sendRow.contact_email_snapshot)))return skipped;
 if(sendMatch!=='message_id') {
  const fact=(await db.query(`SELECT * FROM sdr_message_facts WHERE provider='apollo' AND provider_message_id=$1
    AND provider_status='completed' AND link_status='verified' AND pipedrive_lead_id=$2`,[String(messageId),String(sendRow.pipedrive_lead_id)])).rows[0];
  if(!fact||String(fact.campaign_id)!==String(sendRow.apollo_sequence_id)||email(fact.prospect_email)!==email(sendRow.contact_email_snapshot))return skipped;
  sentAt=iso(fact.occurred_at);sender=email(fact.mailbox_email);
 }
 if(!sentAt)return skipped;
 await upsertOutreach(db,{pipedrive_lead_id:sendRow.pipedrive_lead_id,source:'interface',sent_at:sentAt,
  sender_email:sender||null,subject:event.subject||null,external_ref:`apollo:${messageId}`});
 return {recorded:true,sentAt,receipt:{messageId:String(messageId)}};
}

// Existing-field proposals must not abort independent append-only reply/bounce handling.
export async function attemptSequenceMarkerProposal(pipedrive,leadId,field) {
 try {await pipedrive.updateLead(leadId,{[field]:''});return {status:'submitted'};}
 catch(error){return {status:error?.code==='crm_change_requires_review'?'proposal_pending':'unresolved'};}
}

const escape=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function openActivityAlert({leadTitle,recipient,opens,link,pdLink}) {
 const text=`${opens} opens recorded for outreach to ${recipient||'the recipient'}. Opens do not confirm interest or identify who opened the message. Review the conversation and existing restrictions before following up.`;
 return {subject:`Open activity: ${leadTitle||recipient||'Outreach'}`,bodyText:`${text}\n\nOpen the lead: ${link}\nPipedrive: ${pdLink}`,
  bodyHtml:`<p>${escape(text)}</p><p><a href="${escape(link)}">Open the lead</a> · <a href="${escape(pdLink)}">Open in Pipedrive</a></p>`};
}
