// These writers accept observations, never fetch or perform sales actions.
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const timestamp = (value) => {
  if (value == null || value === '') return null;
  const utcValue=typeof value==='string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? value.replace(' ','T')+'Z' : value;
  const date = new Date(utcValue);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_timestamp');
  return date.toISOString();
};
function linkFields(link) {
  const verified = link?.status === 'verified' && link.leadId && link.evidence;
  return [verified ? String(link.leadId) : null,
    verified ? 'verified' : link?.status === 'ambiguous' ? 'ambiguous' : 'unmatched',
    link?.evidence || null, verified ? link.sourceKey || 'unknown' : 'unknown'];
}
function outreachFields(direction, options) {
  if (direction !== 'out') return ['unknown', null];
  const classification=options.outreachClassification;
  const evidence=typeof options.classificationEvidence==='string' ? options.classificationEvidence.trim() : '';
  return evidence && ['sales_outreach','warmup','automatic','unrelated'].includes(classification)
    ? [classification,evidence] : ['unknown',null];
}
function acceptedQuoteEvidence(deal, evidence) {
  if (!evidence || evidence.accepted !== true || String(evidence.dealId) !== String(deal.id)
    || !['crm_quote','pipedrive_mail','gmail_mail'].includes(evidence.source)
    || !String(evidence.sourceId || '').trim() || !evidence.occurredAt) return null;
  const occurredAt=timestamp(evidence.occurredAt);
  return { source:evidence.source,sourceId:String(evidence.sourceId),dealId:String(deal.id),occurredAt,accepted:true };
}
function testFields(record, field, options, provider) {
  const review=options.testReview;
  if(review) {
    if(String(review.recordId)!==String(record.id) || typeof review.isTest!=='boolean' || !String(review.evidence||'').trim()) throw new Error('invalid_test_review');
    return [review.isTest,`review:${provider}:${record.id}:${String(review.evidence).trim()}`,true];
  }
  const text=typeof record[field]==='string' && field==='subject'?record[field].replace(/^(?:(?:re|fw|fwd):\s*)+/i,''):record[field];
  const marked=typeof text==='string' && /^(?:\[TEST\]\s*|TEST\s*[-:]\s*)/i.test(text.trim());
  return [marked,typeof text==='string'?`${provider}:${record.id}:${field}_${marked?'test_prefix':'checked'}`:null,false];
}
async function writeMessage(pool, message, fields, options) {
  const mailbox = normalizeEmail(fields.mailbox);
  const prospect = normalizeEmail(fields.prospect);
  if (!message.id || !mailbox.includes('@') || !prospect.includes('@')) throw new Error('invalid_message');
  const [lead, status, evidence, source] = linkFields(options.leadLink);
  const [classification,classificationEvidence]=outreachFields(fields.direction,options);
  const params = [fields.provider, String(message.id), fields.direction, mailbox, prospect,
    message.emailer_campaign_id || message.campaign_id || null, message.provider_thread_id || message.thread_id || message.threadId || null,
    message.reply_to_id || null, source, fields.step, fields.occurredAt, fields.status,
    fields.human, fields.intent, fields.bounce, Boolean(message.spam_blocked), lead, status, evidence,
    timestamp(options.observedAt || new Date()),classification,classificationEvidence,...testFields(message,'subject',options,fields.provider)];
  const { rows } = await pool.query(`INSERT INTO sdr_message_facts
    (provider,provider_message_id,direction,mailbox_email,prospect_email,campaign_id,thread_id,reply_to_id,
     source_key,sequence_step,occurred_at,provider_status,human_reply,reply_intent,bounce,spam_blocked,
     pipedrive_lead_id,link_status,link_evidence,observed_at,outreach_classification,classification_evidence,is_test,test_evidence)
    VALUES (${params.slice(0,24).map((_, i) => `$${i + 1}`).join(',')})
    ON CONFLICT (provider,provider_message_id) DO UPDATE SET
      provider_status=EXCLUDED.provider_status, occurred_at=COALESCE(EXCLUDED.occurred_at,sdr_message_facts.occurred_at),
      human_reply=COALESCE(EXCLUDED.human_reply,sdr_message_facts.human_reply),
      reply_intent=COALESCE(EXCLUDED.reply_intent,sdr_message_facts.reply_intent),
      bounce=EXCLUDED.bounce,spam_blocked=EXCLUDED.spam_blocked,
      thread_id=COALESCE(EXCLUDED.thread_id,sdr_message_facts.thread_id),
      reply_to_id=COALESCE(EXCLUDED.reply_to_id,sdr_message_facts.reply_to_id),
      pipedrive_lead_id=CASE WHEN sdr_message_facts.link_status='verified' THEN sdr_message_facts.pipedrive_lead_id ELSE EXCLUDED.pipedrive_lead_id END,
      link_status=CASE WHEN sdr_message_facts.link_status='verified' THEN 'verified' ELSE EXCLUDED.link_status END,
      link_evidence=CASE WHEN sdr_message_facts.link_status='verified' THEN sdr_message_facts.link_evidence ELSE EXCLUDED.link_evidence END,
      source_key=CASE WHEN sdr_message_facts.link_status='verified'
        AND NOT (sdr_message_facts.source_key='unknown' AND EXCLUDED.link_status='verified' AND sdr_message_facts.pipedrive_lead_id=EXCLUDED.pipedrive_lead_id)
        THEN sdr_message_facts.source_key ELSE EXCLUDED.source_key END,
      outreach_classification=CASE WHEN EXCLUDED.outreach_classification='unknown' THEN sdr_message_facts.outreach_classification ELSE EXCLUDED.outreach_classification END,
      classification_evidence=COALESCE(EXCLUDED.classification_evidence,sdr_message_facts.classification_evidence),
      is_test=CASE WHEN $25::boolean THEN EXCLUDED.is_test WHEN sdr_message_facts.test_evidence LIKE 'review:%' THEN sdr_message_facts.is_test ELSE sdr_message_facts.is_test OR EXCLUDED.is_test END,
      test_evidence=CASE WHEN sdr_message_facts.test_evidence LIKE 'review:%' AND NOT $25::boolean THEN sdr_message_facts.test_evidence WHEN $25::boolean OR NOT sdr_message_facts.is_test THEN COALESCE(EXCLUDED.test_evidence,sdr_message_facts.test_evidence) ELSE sdr_message_facts.test_evidence END,
      observed_at=EXCLUDED.observed_at
    RETURNING (xmax = 0) AS inserted`, params);
  return { inserted: rows[0]?.inserted ? 1 : 0, updated: rows[0]?.inserted ? 0 : 1 };
}
export function observeOutbound(pool, message, options = {}) {
  const position = Number(message.campaign_position ?? message.sequence_step);
  return writeMessage(pool, message, { provider: 'apollo', direction: 'out', mailbox: message.from_email,
    prospect: message.to_email, step: Number.isInteger(position) && position > 0 ? position : null,
    occurredAt: timestamp(message.completed_at), status: message.status || null, human: null, intent: null,
    bounce: Boolean(message.bounced || message.bounce) }, options);
}
export function observeInbound(pool, message, options = {}) {
  const intent = options.intent || null;
  const automatic = ['automatic', 'out_of_office', 'bounce', 'spam'].includes(intent);
  const received = message.received_at ?? (message.internalDate != null ? Number(message.internalDate) : null);
  return writeMessage(pool, message, { provider: message.provider || 'gmail', direction: 'in', mailbox: options.mailbox,
    prospect: message.from_email, step: null, occurredAt: timestamp(received), status: 'received',
    human: intent == null ? null : !automatic, intent, bounce: intent === 'bounce' }, options);
}
export async function syncDealFacts(pool, deals, { quoteEvidenceByDealId = {}, testReviewByDealId = {} } = {}) {
  const result = { inserted: 0, updated: 0 };
  for (const deal of deals) {
    if (!deal.id || !deal.currency || !deal.status) throw new Error('invalid_deal');
    const [lead, status, evidence, source] = linkFields(deal.leadLink);
    const quote=acceptedQuoteEvidence(deal,quoteEvidenceByDealId[String(deal.id)]);
    const value = deal.value == null || deal.value === '' ? null : Number(deal.value);
    if (value != null && !Number.isFinite(value)) throw new Error('invalid_deal');
    const { rows } = await pool.query(`INSERT INTO sdr_deal_facts
      (pipedrive_deal_id,pipedrive_lead_id,link_status,link_evidence,source,currency,value,status,
       qualified_quote,quote_created_at,won_at,lost_at,quote_evidence,is_test,test_evidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (pipedrive_deal_id) DO UPDATE SET
        is_test=CASE WHEN $16::boolean THEN EXCLUDED.is_test WHEN sdr_deal_facts.test_evidence LIKE 'review:%' THEN sdr_deal_facts.is_test ELSE sdr_deal_facts.is_test OR EXCLUDED.is_test END,
        test_evidence=CASE WHEN sdr_deal_facts.test_evidence LIKE 'review:%' AND NOT $16::boolean THEN sdr_deal_facts.test_evidence WHEN $16::boolean OR NOT sdr_deal_facts.is_test THEN COALESCE(EXCLUDED.test_evidence,sdr_deal_facts.test_evidence) ELSE sdr_deal_facts.test_evidence END,
        value=EXCLUDED.value,currency=EXCLUDED.currency,status=EXCLUDED.status,
        qualified_quote=CASE WHEN sdr_deal_facts.quote_evidence IS NOT NULL OR EXCLUDED.quote_evidence IS NOT NULL THEN true ELSE NULL END,
        quote_created_at=CASE WHEN sdr_deal_facts.quote_evidence IS NULL THEN EXCLUDED.quote_created_at
          WHEN EXCLUDED.quote_evidence IS NULL THEN sdr_deal_facts.quote_created_at
          ELSE LEAST(sdr_deal_facts.quote_created_at,EXCLUDED.quote_created_at) END,
        quote_evidence=CASE WHEN sdr_deal_facts.quote_evidence IS NULL OR
          (EXCLUDED.quote_evidence IS NOT NULL AND EXCLUDED.quote_created_at<sdr_deal_facts.quote_created_at)
          THEN EXCLUDED.quote_evidence ELSE sdr_deal_facts.quote_evidence END,
        won_at=EXCLUDED.won_at,lost_at=EXCLUDED.lost_at,observed_at=now(),
        pipedrive_lead_id=CASE WHEN sdr_deal_facts.link_status='verified' THEN sdr_deal_facts.pipedrive_lead_id ELSE EXCLUDED.pipedrive_lead_id END,
        link_status=CASE WHEN sdr_deal_facts.link_status='verified' THEN 'verified' ELSE EXCLUDED.link_status END,
        link_evidence=CASE WHEN sdr_deal_facts.link_status='verified' THEN sdr_deal_facts.link_evidence ELSE EXCLUDED.link_evidence END,
        source=CASE WHEN sdr_deal_facts.link_status='verified'
          AND NOT (COALESCE(sdr_deal_facts.source,'unknown')='unknown' AND EXCLUDED.link_status='verified' AND sdr_deal_facts.pipedrive_lead_id=EXCLUDED.pipedrive_lead_id)
          THEN sdr_deal_facts.source ELSE EXCLUDED.source END
      RETURNING (xmax = 0) AS inserted`,
    [String(deal.id), lead, status, evidence, source, String(deal.currency).toUpperCase(), value,
      deal.status, quote ? true : null,
      quote?.occurredAt || null, timestamp(deal.won_time || deal.won_at), timestamp(deal.lost_time || deal.lost_at),quote,...testFields(deal,'title',{testReview:testReviewByDealId[String(deal.id)]},'pipedrive')]);
    result[rows[0]?.inserted ? 'inserted' : 'updated']++;
  }
  return result;
}
