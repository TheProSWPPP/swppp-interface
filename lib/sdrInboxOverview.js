import { leadVisibilityScope } from './sdrAccess.js';

// Bounded provider reads: never present a partial page or failed mailbox as complete.
export async function readInboxPages(boxes, { accessTokenForMailbox, gmailInbox }) {
  const results = await Promise.all(boxes.map(async mailbox => {
    const threads = new Map();
    let pageToken = null;
    try {
      const token = await accessTokenForMailbox(mailbox);
      for (let page=0; page<4; page++) {
        const result = await gmailInbox.listThreadPage(token, {query:'in:inbox',maxResults:25,pageToken});
        for (const thread of result.threads) threads.set(thread.id, {...thread,mailbox});
        pageToken=result.nextPageToken;
        if (!pageToken) break;
      }
      return {threads:[...threads.values()],coverage:{mailbox,status:pageToken?'limited':'complete'}};
    } catch {
      return {threads:[...threads.values()],coverage:{mailbox,status:'error'}};
    }
  }));
  return {threads:results.flatMap(r=>r.threads),coverage:{complete:results.every(r=>r.coverage.status==='complete'),mailboxes:results.map(r=>r.coverage)}};
}

export async function inboxLeadEvidence(pool, threads, user, companyId) {
  if (!companyId || !threads.length || !user?.sub) return new Map();
  const visibility=leadVisibilityScope(user,'s');
  const {rows}=await pool.query(`WITH evidence AS (
    SELECT thread_id,mailbox_email,pipedrive_lead_id FROM sdr_reply_messages WHERE link_status='verified'
    UNION SELECT thread_id,mailbox_email,pipedrive_lead_id FROM sdr_message_facts
      WHERE provider='gmail' AND link_status='verified' AND NOT is_test
    ) SELECT e.thread_id,lower(e.mailbox_email) AS mailbox,s.pipedrive_lead_id,s.lead_title,
      EXISTS(SELECT 1 FROM evidence conflict WHERE conflict.thread_id=e.thread_id
        AND lower(conflict.mailbox_email)=lower(e.mailbox_email)
        AND conflict.pipedrive_lead_id IS DISTINCT FROM e.pipedrive_lead_id) AS ambiguous
    FROM evidence e JOIN sdr_lead_state s ON s.pipedrive_lead_id=e.pipedrive_lead_id AND s.crm_company_id=$1
    JOIN sdr_crm_snapshots crm ON crm.company_id=$1 AND crm.entity='lead' AND crm.entity_id=s.pipedrive_lead_id
      AND crm.access_status='accessible' AND crm.lifecycle!='unresolved' AND NOT crm.is_test
    WHERE e.thread_id=ANY($2) AND lower(e.mailbox_email)=ANY($3) AND ${visibility.requires ? visibility.sql('$4') : '$4::text IS NULL'}`,
  [String(companyId),threads.map(t=>t.id),[...new Set(threads.map(t=>t.mailbox.toLowerCase()))],visibility.value]);
  const matches=new Map(), ambiguous=new Set();
  for (const row of rows) {
    const key=`${row.mailbox}:${row.thread_id}`;
    if (row.ambiguous) ambiguous.add(key);
    const leads=matches.get(key)||new Map();leads.set(row.pipedrive_lead_id,row);matches.set(key,leads);
  }
  return new Map([...matches].map(([key,leads])=>[key,leads.size===1&&!ambiguous.has(key)?[...leads.values()][0]:null]));
}

export function applyInboxHandled(threads, handledRows, classifyInbound) {
  const watermarks=new Map(handledRows.map(r=>[`${String(r.mailbox_email||'').toLowerCase()}:${r.thread_id}`,new Date(r.handled_at).getTime()]));
  for (const thread of threads) {
    const inbound=(thread.messages||[]).filter(m=>!m.lastOutbound&&!classifyInbound(m.from,m.subject,m.snippet));
    const newest=Math.max(0,...inbound.map(m=>Date.parse(m.receivedAt)||0),
      !thread.lastOutbound&&!classifyInbound(thread.from,thread.subject,thread.snippet)?Date.parse(thread.receivedAt)||0:0);
    const handledAt=watermarks.get(`${thread.mailbox.toLowerCase()}:${thread.id}`);
    thread.handled=!!(newest && handledAt && newest<=handledAt);
  }
}
