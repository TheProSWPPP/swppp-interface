// One note on the lead when Apollo refuses to send the first email (invalid MX, likely to
// bounce). The lead already carries the enrollment note and the Sequence Started marker, so
// without this the rep reads it as emailed. Keyed on the send id: written once per send.
import {publishOutreachEvent} from './sdrNotePublisher.js';

export async function reportRefusedSend(pool,{send}={}, {publish=publishOutreachEvent}={}) {
 if(!send?.id||!send.pipedrive_lead_id)return {status:'skipped'};
 let recipient=null;
 if(send.draft_id){
  const {rows}=await pool.query('SELECT contact_email_snapshot FROM sdr_drafts WHERE id=$1',[send.draft_id]);
  recipient=rows[0]?.contact_email_snapshot||null;
 }
 return publish(pool,{leadId:send.pipedrive_lead_id,event:{type:'not_sent',recipient,
  source:{kind:'apollo',eventId:`refused:${send.id}`},
  result:{status:'refused',summary:'Apollo would not send this email. It flagged the address as invalid or likely to bounce. No email went out to this contact.'},
  nextAction:'Check the address, then email them by hand or pick another contact.'}});
}
