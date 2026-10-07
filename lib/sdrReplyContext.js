// Reply identity is anchored to an independently linked outbound message. A person
// participating in a thread can work on several projects, even when only one is mirrored.
const subjectKey = value => String(value || '').replace(/^(?:(?:re|fw|fwd):\s*)+/i,'').trim().toLowerCase();
const rfcIds = value => String(value || '').match(/<[^\s<>]+@[^\s<>]+>/g) || [];
const unique = values => [...new Set(values.filter(Boolean))];
async function tableAvailable(pool,name) {
  return Boolean(pool && (await pool.query('SELECT to_regclass($1) AS name',[name])).rows[0]?.name);
}
const addr = value => String(value || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0];
async function conversationEvidence(pool,mailbox,messages) {
  if(!(await tableAvailable(pool,'sdr_conversation_messages'))) return [];
  const ids=messages.flatMap(m=>rfcIds(m.messageId));
  if(!ids.length) return [];
  const rows=(await pool.query('SELECT * FROM sdr_conversation_messages WHERE internet_message_id=ANY($1::text[])',[ids])).rows;
  return rows.filter(row=>messages.some(m=>m.messageId===row.internet_message_id && addr(m.from)===addr(row.from_address)
    && (m.lastOutbound ? row.direction==='out' && addr(row.from_address)===mailbox.toLowerCase()
      : row.direction==='in' && [...row.to_addresses,...row.cc_addresses].some(a=>addr(a)===mailbox.toLowerCase()))));
}
export async function resolveReplyProject(pool,{mailbox,thread,message,candidates=[]}) {
  const ids = candidates.map(c=>c.pipedrive_lead_id);
  const pending = (extra=[],reason='independent_message_link_missing') => ({status:unique([...ids,...extra]).length?'ambiguous':'unlinked',candidates:unique([...ids,...extra]),evidence:reason});
  const crm=(await conversationEvidence(pool,mailbox,[message,...(thread.messages || []).filter(m=>m.lastOutbound && +new Date(m.receivedAt)<+new Date(message.receivedAt))]))
    .filter(row=>row.provider==='pipedrive' && row.pipedrive_lead_id && /^pipedrive:(?:explicit-thread-or-message-id|lead_id)$/.test(row.link_evidence || ''));
  const crmLeads=unique(crm.map(row=>row.pipedrive_lead_id));
  const refs = unique([...rfcIds(message.inReplyTo),...rfcIds(message.references)]);
  const outbound = (thread.messages || []).filter(m=>m.lastOutbound && m.id && m.receivedAt && +new Date(m.receivedAt)<+new Date(message.receivedAt));
  if (!outbound.length && !crmLeads.length) return pending();
  // Gmail IDs are mailbox-local; an RFC ID may connect a provider's outbound record
  // to the actual Gmail message. A shared thread ID alone is insufficient.
  const anchors=(await tableAvailable(pool,'sdr_message_facts') ? (await pool.query(`SELECT provider,provider_message_id,pipedrive_lead_id,link_evidence FROM sdr_message_facts
    WHERE direction='out' AND lower(mailbox_email)=lower($1) AND link_status='verified' AND pipedrive_lead_id IS NOT NULL
      AND link_evidence IS NOT NULL AND NOT is_test
      AND ((provider='gmail' AND provider_message_id=ANY($2::text[])) OR provider_message_id=ANY($3::text[]))`,
    [mailbox,outbound.map(m=>m.id),outbound.flatMap(m=>[m.messageId, m.messageId ? `rfc822:${m.messageId}` : null]).filter(Boolean)])).rows : [])
    .filter(f=>!/(?:participant|unique.email|email.match|heuristic)/i.test(f.link_evidence));
  const supported=anchors.filter(a=>outbound.some(m=>(a.provider==='gmail' && a.provider_message_id===m.id || [m.messageId,`rfc822:${m.messageId}`].includes(a.provider_message_id))
    && (!refs.length || refs.includes(m.messageId))));
  const leads=unique([...supported.map(a=>a.pipedrive_lead_id),...crmLeads]);
  if(leads.length!==1) return pending(leads,leads.length?'conflicting_outbound_projects':'independent_message_link_missing');
  const matching=outbound.filter(m=>crm.some(row=>row.internet_message_id===m.messageId) || supported.some(a=>a.provider==='gmail' && a.provider_message_id===m.id || [m.messageId,`rfc822:${m.messageId}`].includes(a.provider_message_id)));
  const subject=subjectKey(message.subject);
  if(!subject || matching.some(m=>!subjectKey(m.subject) || subjectKey(m.subject)!==subject)) return pending(leads,'project_subject_conflict');
  return {status:'verified',leadId:leads[0],evidence:matching.length ? `gmail-thread:${thread.id}:outbound-message:${matching.map(m=>m.id).sort().join(',')}` : `pipedrive:exact-rfc-message:${message.messageId}`};
}

// SENT proves direction, not authorship. Preserve uncertain later traffic for
// operator review. Explicit manual-origin receipts can be added independently;
// neither absence of automation headers nor a person's display name proves it.
export async function checkReplyThread({pool,mailbox,thread,sourceMessageId}) {
  const original=(thread?.messages || []).find(m=>m.id===sourceMessageId);
  if(thread?.contextUnavailable || !original || !original.receivedAt || !Number.isFinite(+new Date(original.receivedAt))) return {state:'unavailable'};
  const laterMessages=(thread.messages || []).filter(m=>m.lastOutbound && (!m.receivedAt || !Number.isFinite(+new Date(m.receivedAt)) || +new Date(m.receivedAt)>+new Date(original.receivedAt)))
    .map(m=>({id:m.id,messageId:m.messageId || null,receivedAt:m.receivedAt || null,
      origin: /^<sdr-action-/i.test(m.messageId || '') || (m.autoSubmitted && m.autoSubmitted!=='no') || m.precedence==='bulk' ? 'automation' : 'unknown'}));
  const known=await conversationEvidence(pool,mailbox,(thread.messages || []).filter(m=>laterMessages.some(l=>l.id===m.id)));
  for(const later of laterMessages) {
    const evidence=known.filter(row=>row.internet_message_id===later.messageId);
    const actual=(thread.messages || []).find(m=>m.id===later.id);
    const to=String(actual?.to || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
    if(later.origin!=='automation' && later.receivedAt && Number.isFinite(+new Date(later.receivedAt))
      && to.includes(addr(original.from)) && subjectKey(actual?.subject)===subjectKey(original.subject)
      && evidence.length && evidence.every(row=>row.origin==='Manual' && row.origin_evidence)) {
      return {state:'staff_replied',original,staffResponseAt:later.receivedAt,laterMessages};
    }
  }
  // Automated replies also warrant checking whether another owner already acted.
  // They must never be reported as a confirmed human response.
  return {state:laterMessages.length?'later_outbound_unverified':'clear',original,laterMessages};
}

export async function observeReplyThread(pool,{messageId,mailbox,thread,sourceMessageId}) {
  const context=await checkReplyThread({pool,mailbox,thread,sourceMessageId});
  if(context.state==='clear') return context;
  if(context.state==='staff_replied') {
    await pool.query('UPDATE sdr_reply_messages SET staff_response_at=COALESCE(staff_response_at,$2) WHERE provider_message_id=$1',[messageId,context.staffResponseAt]);
    await pool.query("UPDATE sdr_reply_actions SET status='skipped',requires_review=false,safe_error='staff_replied',updated_at=NOW() WHERE provider_message_id=$1 AND kind IN ('forward','create_task') AND status IN ('pending','failed') AND external_id IS NULL AND safe_error IS DISTINCT FROM 'completion_uncertain'",[messageId]);
    return context;
  }
  const evidence={state:context.state,laterMessages:context.laterMessages || []};
  await pool.query(`UPDATE sdr_reply_actions SET requires_review=true,safe_error=CASE WHEN safe_error='completion_uncertain' THEN safe_error ELSE $2 END,
    payload=payload || jsonb_build_object('replyContext',$3::jsonb),updated_at=NOW()
    WHERE provider_message_id=$1 AND kind IN ('forward','create_task') AND status IN ('pending','failed')`,[messageId,context.state==='unavailable' ? 'reply_context_unavailable' : context.state,JSON.stringify(evidence)]);
  return context;
}
