import {outgoingCandidates,resolveOutgoingReply} from './sdrOutgoingReplyEvidence.js';

const direct=row=>row?.pipedrive_lead_id&& !row.pipedrive_deal_id &&
 ['pipedrive:lead_id','pipedrive:explicit-thread-or-message-id'].includes(row.link_evidence)&&
 Array.isArray(row.source_evidence)&&row.source_evidence.some(e=>String(e?.leadId)===row.pipedrive_lead_id)&&
 !row.source_evidence.some(e=>e?.dealId||e?.leadId&&String(e.leadId)!==row.pipedrive_lead_id);

// The project context must already have passed the active-user and visible-lead checks.
// Observations are advisory; no missing row is interpreted as a completed outcome.
export async function readSalesLoopObservations(pool,{companyId,leadId,viewer,context,resolveVisibleMailboxes}){
 const handoff=(await pool.query(`SELECT status,provider_note_id,readback_verified,checked_at
  FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2
  ORDER BY created_at DESC,id DESC LIMIT 1`,[companyId,leadId])).rows[0];
 const publication=handoff?{companyId,leadId,status:handoff.status,noteId:handoff.provider_note_id,
  readbackVerified:handoff.readback_verified,checkedAt:handoff.checked_at}:null;
 const outcomes=[];
 if(typeof resolveVisibleMailboxes!=='function'||!context.lead.personId)return {publication,outcomes};
 const visible=(await resolveVisibleMailboxes(viewer)).filter(v=>typeof (v.email||v)==='string'&&(v.connected!==false)).map(v=>String(v.email||v).toLowerCase());
 if(!visible.length)return {publication,outcomes};
 const inbound=(await pool.query(`SELECT r.provider_message_id AS reply_id,r.source_message_id,r.thread_id,r.mailbox_email,
  c.* FROM sdr_reply_messages r JOIN sdr_conversation_messages c
   ON c.provider='gmail' AND c.account_key=r.mailbox_email AND c.provider_message_id=r.source_message_id
  WHERE r.pipedrive_lead_id=$1 AND r.link_status='verified' AND r.reply_kind='human'
   AND r.source='gmail' AND r.mailbox_email=ANY($2::text[]) AND c.pipedrive_lead_id=$1
   AND c.person_id=$3 AND c.direction='in' AND octet_length(c.source_evidence::text)<=8192
  ORDER BY r.received_at DESC,r.provider_message_id DESC LIMIT 100`,[leadId,visible,context.lead.personId])).rows;
 for(const row of inbound){
  if(!direct(row)||row.provider_thread_id!==row.thread_id)continue;
  outcomes.push({kind:'incoming_reply',companyId,leadId,sourceId:row.reply_id,linkage:'direct_unique',observedAt:row.observed_at});
  const reply={id:row.reply_id,source:'gmail',sourceMessageId:row.source_message_id,threadId:row.thread_id,mailbox:row.mailbox_email};
  const edges=outgoingCandidates(reply,row);
  if(!edges.length)continue;
  const candidates=(await pool.query(`SELECT * FROM sdr_conversation_messages WHERE provider='gmail' AND account_key=$1
   AND provider_message_id=ANY($2::text[]) AND octet_length(source_evidence::text)<=8192`,[row.mailbox_email,edges.map(e=>e.outboundId)])).rows;
  const exact=candidates.filter(candidate=>candidate.pipedrive_lead_id===leadId&&candidate.person_id===context.lead.personId&&direct(candidate));
  const mapped=new Map(exact.map(candidate=>[`${candidate.account_key}\0${candidate.provider_message_id}`,candidate]));
  const found=resolveOutgoingReply(reply,row,mapped);
  if(found)outcomes.push({kind:'outgoing_reply',companyId,leadId,source:'connected_gmail',linkage:'direct_unique',providerMessageId:found.providerMessageId,observedAt:found.at,authorship:'unknown'});
 }
 return {publication,outcomes};
}
