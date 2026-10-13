import {outgoingCandidates,resolveOutgoingReply} from './sdrOutgoingReplyEvidence.js';

const direct=row=>row?.pipedrive_lead_id&& !row.pipedrive_deal_id &&
 ['pipedrive:lead_id','pipedrive:explicit-thread-or-message-id'].includes(row.link_evidence)&&
 Array.isArray(row.source_evidence)&&row.source_evidence.some(e=>String(e?.leadId)===row.pipedrive_lead_id)&&
 !row.source_evidence.some(e=>e?.dealId||e?.leadId&&String(e.leadId)!==row.pipedrive_lead_id);

const scalar=value=>value&&typeof value==='object'?String(value.id??value.value??'')||null:value==null?null:String(value);
const text=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,600);

// Caller supplies context obtained by the active-viewer and visible-project reader.
// This adds cached evidence only. No provider request or inference of human work.
export async function readSalesLoopEvidence(pool,{companyId,leadId,viewer,current,resolveVisibleMailboxes}){
 const context=current.context;
 const rows=(await pool.query(`SELECT s.entity_id,s.data,s.source_updated_at,s.observed_at
  FROM sdr_crm_snapshots s JOIN sdr_crm_links link
   ON link.company_id=s.company_id AND link.entity=s.entity AND link.entity_id=s.entity_id
  WHERE s.company_id=$1 AND s.entity='activity' AND s.lifecycle='active' AND s.access_status='accessible' AND NOT s.is_test
   AND link.link_type='lead' AND link.linked_id=$2
   AND NOT EXISTS(SELECT 1 FROM sdr_crm_links other WHERE other.company_id=s.company_id AND other.entity=s.entity AND other.entity_id=s.entity_id
    AND (other.link_type='deal' OR other.link_type='lead' AND other.linked_id<>$2))
  ORDER BY s.source_updated_at DESC NULLS LAST,s.entity_id LIMIT 41`,[companyId,leadId])).rows;
 const activities=rows.slice(0,40).map(row=>({id:row.entity_id,type:scalar(row.data?.type),subject:text(row.data?.subject),note:text(row.data?.note),
  textTruncated:String(row.data?.subject??'').length>600||String(row.data?.note??'').length>600,
  status:row.data?.done===true?'recorded_complete':row.data?.done===false?'open':'unknown',performed:'unknown',
  ownerId:scalar(row.data?.owner_id??row.data?.user_id),dueDate:row.data?.due_date||null,sourceUpdatedAt:row.source_updated_at,observedAt:row.observed_at}));
 const mailboxes=typeof resolveVisibleMailboxes==='function'?await resolveVisibleMailboxes(viewer):[];
 const visible=mailboxes.filter(v=>typeof(v.email||v)==='string'&&v.connected!==false).map(v=>String(v.email||v).toLowerCase()).sort();
 const admin=viewer.role==='admin';
 const messages=context.lead.personId&&(visible.length||admin)?(await pool.query(`SELECT provider,account_key,provider_message_id,provider_thread_id,
  person_id,pipedrive_lead_id,pipedrive_deal_id,link_evidence,source_evidence,direction,from_address,to_addresses,occurred_at,observed_at
  FROM sdr_conversation_messages WHERE pipedrive_lead_id=$1 AND person_id=$2
   AND (provider='gmail' AND account_key=ANY($3::text[]) OR provider='pipedrive' AND $4::boolean)
   AND octet_length(source_evidence::text)<=8192
  ORDER BY occurred_at DESC NULLS LAST,provider,account_key,provider_message_id LIMIT 41`,[leadId,context.lead.personId,visible,admin])).rows:[];
 return {project:context.lead,records:context.records||[],holds:context.holds||[],activities,
  messages:messages.slice(0,40).filter(direct).map(row=>({provider:row.provider,account:row.account_key,id:row.provider_message_id,threadId:row.provider_thread_id,
   direction:row.direction,from:row.from_address,to:row.to_addresses,occurredAt:row.occurred_at,observedAt:row.observed_at,customerReply:'unverified'})),
  coverage:{history:'partial',recordsLimited:context.limited===true,activitiesLimited:rows.length>40,messagesLimited:messages.length>40,
   pipedriveMail:admin?'partial':'unavailable',gmailMail:visible.length?'partial':'unavailable',messageBodies:'not_collected',visibleMailboxes:visible}};
}

// The project context must already have passed the active-user and visible-lead checks.
// Observations are advisory; no missing row is interpreted as a completed outcome.
export async function readSalesLoopObservations(pool,{companyId,leadId,viewer,context,resolveVisibleMailboxes}){
 const evidence=await readSalesLoopEvidence(pool,{companyId,leadId,viewer,current:{context:{...context,records:[context.recentRecords?.note,context.recentRecords?.completedCall].filter(Boolean)}},resolveVisibleMailboxes});
 const handoff=(await pool.query(`SELECT status,provider_note_id,readback_verified,checked_at
  FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2
  ORDER BY created_at DESC,id DESC LIMIT 1`,[companyId,leadId])).rows[0];
 const publication=handoff?{companyId,leadId,status:handoff.status,noteId:handoff.provider_note_id,
  readbackVerified:handoff.readback_verified,checkedAt:handoff.checked_at}:null;
 const outcomes=[];
 if(typeof resolveVisibleMailboxes!=='function'||!context.lead.personId)return {publication,outcomes,evidence};
 const visible=(await resolveVisibleMailboxes(viewer)).filter(v=>typeof (v.email||v)==='string'&&(v.connected!==false)).map(v=>String(v.email||v).toLowerCase());
 if(!visible.length)return {publication,outcomes,evidence};
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
 return {publication,outcomes,evidence};
}
