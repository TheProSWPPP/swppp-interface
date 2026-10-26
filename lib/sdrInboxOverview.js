import { leadVisibilityScope } from './sdrAccess.js';

const QUOTA_REASONS=new Set(['rateLimitExceeded','userRateLimitExceeded','quotaExceeded','dailyLimitExceeded']);
// Google answers an over-quota read with 429, or 403 + a rate/quota reason ("Units per minute per user").
export function isGmailQuotaError(error) {
  if(!error)return false;
  if(error.status===429)return true;
  return error.status===403&&(QUOTA_REASONS.has(error.reason)||/quota exceeded|rate limit/i.test(String(error.message||'')));
}

class BoundedMap extends Map {
  constructor(limit){super();this.limit=limit;}
  set(key,value){if(this.has(key))this.delete(key);super.set(key,value);while(this.size>this.limit)this.delete(this.keys().next().value);return this;}
}

// One cache per server process, shared by every open tab and user. Per mailbox it keeps:
//  - thread metadata keyed by Gmail historyId (unchanged threads cost no threads.get),
//  - the last complete read for `freshMs` (the 60s bell poll from several tabs shares one read),
//  - the in-flight read (concurrent requests wait for it instead of starting their own),
//  - a backoff after Google's per-user rate limit, during which the last good copy is served
//    and marked stale instead of reading again and making the limit worse.
export function createInboxReadCache({now=()=>Date.now(),freshMs=30_000,baseBackoffMs=60_000,maxBackoffMs=10*60_000,metadataLimit=600,concurrency=5}={}) {
  const boxes=new Map();
  const box=mailbox=>{
    const key=String(mailbox).toLowerCase();
    if(!boxes.has(key))boxes.set(key,{metadata:new BoundedMap(metadataLimit),last:null,partial:[],inflight:null,backoffUntil:0,failures:0,issue:null,attemptAt:null});
    return boxes.get(key);
  };
  return {now,freshMs,baseBackoffMs,maxBackoffMs,concurrency,box,clear(){boxes.clear();},
    peek(mailbox){return boxes.get(String(mailbox).toLowerCase())||null;}};
}

export const sharedInboxReadCache=createInboxReadCache();
export function resetInboxReadCache(){sharedInboxReadCache.clear();}
// Drop the short-lived copy after we write to a mailbox so the next read shows the change.
export function invalidateInboxMailbox(mailbox,cache=sharedInboxReadCache){const s=cache.peek(mailbox);if(s)s.last=s.last&&{...s.last,at:0};}

const iso=ms=>ms?new Date(ms).toISOString():null;
function snapshot(mailbox,s) {
  const retryAt=s.backoffUntil>0?iso(s.backoffUntil):null;
  if(s.issue&&s.last)return {threads:s.last.threads,coverage:{mailbox,status:'stale',checkedAt:iso(s.last.readAt),issue:s.issue,retryAt}};
  if(s.issue)return {threads:s.partial,coverage:{mailbox,status:'error',checkedAt:null,issue:s.issue,retryAt}};
  return {threads:s.last.threads,coverage:{mailbox,status:s.last.status,checkedAt:iso(s.last.readAt)}};
}

export async function readInboxMailbox(mailbox,{accessTokenForMailbox,gmailInbox},{cache=sharedInboxReadCache,force=false}={}) {
  const s=cache.box(mailbox);
  if(s.inflight)return s.inflight;
  const t=cache.now();
  if(s.backoffUntil>t&&(s.last||s.issue))return snapshot(mailbox,s);
  if(!force&&s.last&&!s.issue&&t-s.last.at<cache.freshMs)return snapshot(mailbox,s);
  s.inflight=(async()=>{
    const threads=new Map();
    let pageToken=null;
    s.attemptAt=cache.now();
    try {
      const token=await accessTokenForMailbox(mailbox);
      for (let page=0; page<4; page++) {
        const result=await gmailInbox.listThreadPage(token,{query:'in:inbox',maxResults:25,pageToken,metadataCache:s.metadata,concurrency:cache.concurrency});
        for (const thread of result.threads) threads.set(thread.id, {...thread,mailbox});
        pageToken=result.nextPageToken;
        if (!pageToken) break;
      }
      const at=cache.now();
      s.last={threads:[...threads.values()],status:pageToken?'limited':'complete',at,readAt:at};
      s.partial=[];s.issue=null;s.failures=0;s.backoffUntil=0;
    } catch (error) {
      const quota=isGmailQuotaError(error);
      s.issue=quota?'google_limit':'read_failed';
      s.partial=[...threads.values()];
      if(quota){s.failures++;s.backoffUntil=cache.now()+Math.min(cache.maxBackoffMs,cache.baseBackoffMs*2**(s.failures-1));}
      else s.backoffUntil=0;
    }
    return snapshot(mailbox,s);
  })().finally(()=>{s.inflight=null;});
  return s.inflight;
}

// Bounded provider reads: never present a partial page or failed mailbox as complete.
export async function readInboxPages(boxes, deps, options={}) {
  const results = await Promise.all(boxes.map(mailbox=>readInboxMailbox(mailbox,deps,options)));
  return {threads:results.flatMap(r=>r.threads),coverage:{complete:results.every(r=>r.coverage.status==='complete'),mailboxes:results.map(r=>r.coverage)}};
}

// The live inbox-read state, shared with System checks so both screens tell the same story.
export function inboxReadHealth(mailboxes,cache=sharedInboxReadCache) {
  return mailboxes.map(mailbox=>{
    const s=cache.peek(mailbox);
    if(!s||(!s.last&&!s.issue))return {mailbox,status:'not_checked',checkedAt:null,issue:null,retryAt:null};
    const {coverage}=snapshot(mailbox,s);
    return {mailbox,status:coverage.status==='stale'||coverage.status==='error'?coverage.status:'current',checkedAt:coverage.checkedAt,issue:coverage.issue||null,retryAt:coverage.retryAt||null};
  });
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
