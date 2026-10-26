import { randomUUID } from 'node:crypto';
import { acquireLeadLock } from './sdrAccess.js';

export const replyActionsEnabled = () => process.env.SDR_REPLY_ACTIONS_ENABLED === 'true';
const RETRY_MINUTES = [1, 5, 30, 120];

function completed(action, receipt, now) {
  return { ...action, status: 'completed', externalId: String(receipt.id), externalAssigneeId:receipt.assigneeId || null, receiptAt: now, retryAt: null, requiresReview: false, safeError: null };
}

export async function runReplyAction(action, { execute, reconcile, now = new Date() }) {
  if (['completed','skipped'].includes(action.status)) return action;
  if (action.retryAt && new Date(action.retryAt) > now) return action;
  if (action.requiresReview) {
    // provider_stop_review is re-read (at most daily, see drainReplyActions): Apollo may
    // since have finished the membership, or the stop may now be provably ours.
    if (!['completion_uncertain','rate_limit',...(action.kind==='stop_sequence' ? ['provider_stop_review'] : [])].includes(action.safeError) || !reconcile) return action;
    let found;
    try { found = await reconcile(action); } catch { return action; }
    if (found?.state === 'completed' && found.receipt?.id) return completed(action, found.receipt, now);
    if (found?.state === 'deferred' && ['rate_limit','completion_uncertain'].includes(found.safeError)
      && Number.isFinite(+new Date(found.retryAt)) && +new Date(found.retryAt)>+now)
      return {...action,status:'failed',requiresReview:true,safeError:found.safeError,retryAt:new Date(found.retryAt)};
    if (found?.state === 'review' && found.safeError==='provider_stop_review')
      return {...action,status:'failed',requiresReview:true,safeError:found.safeError,retryAt:null};
    if (found?.state !== 'not_applied') return action;
    action = { ...action, requiresReview: false };
  }
  if (action.retryAt && new Date(action.retryAt) > now) return action;
  if (action.attempts >= 5) return { ...action,status:'failed',requiresReview:true,safeError:'attempts_exhausted',retryAt:null };
  const attempted = { ...action, attempts: action.attempts + 1 };
  try {
    const receipt = await execute(attempted);
    if (receipt?.skipped === true && ['staff_replied','reply_observed','stale_open','test_contact','no_action','duplicate'].includes(receipt.reason)) return {...attempted,status:'skipped',externalId:null,receiptAt:null,retryAt:null,requiresReview:false,safeError:receipt.reason};
    if (!receipt?.id) throw Object.assign(new Error('missing_receipt'), { uncertain: true });
    return completed(attempted, receipt, now);
  } catch (error) {
    if (error?.deferred) return { ...action,status:'pending',requiresReview:false,safeError:'dependencies_pending',retryAt:new Date(+now+60000) };
    const status = Number(error?.status);
    const permanent = [400,401,403,404,422].includes(status) || error?.permanent === true;
    const definite = error?.definiteFailure === true || status === 429;
    const exhausted = attempted.attempts >= 5;
    const requiresReview = permanent || !definite || exhausted;
    const contextReason=['later_outbound_unverified','reply_context_unavailable','project_context_unverified'].includes(error?.replyContextReason) ? error.replyContextReason : error?.providerReviewReason==='provider_stop_review' ? 'provider_stop_review' : null;
    const safeError = contextReason || ([401,403].includes(status) ? 'authentication' : permanent ? 'configuration'
      : !definite ? 'completion_uncertain' : status === 429 ? 'rate_limit' : exhausted ? 'attempts_exhausted' : 'definite_failure');
    const retryMs = Number(error?.retryAfterMs || (error?.retryAfterSec ? error.retryAfterSec * 1000 : null));
    const delay = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : RETRY_MINUTES[attempted.attempts - 1] * 60000;
    const absoluteRetry=error?.retryAt&&Number.isFinite(+new Date(error.retryAt))&&+new Date(error.retryAt)>+now ? new Date(error.retryAt) : new Date(+now+delay);
    return { ...attempted, status: 'failed', requiresReview, safeError, retryAt: requiresReview && status!==429 ? null : absoluteRetry };
  }
}

// The caller supplies a verified inbound identity shared across providers when
// available (RFC Message-ID); an outbound Apollo message ID is not that identity.
// Intent labels the classifier marks worth a rep's time (lib/inboxReplyWatch.js classifyIntent).
export const WORTH_LABELS = new Set(['interested','question','nurture']);
// Stored classifications that never become a rep task ("hot lead" on an in-house or
// unsubscribe reply was the 2026-10-04 failure: tasks 37220/37224/37227/37230).
export const NO_ACTION_LABELS = new Set(['in_house','not_interested','unsubscribe','no_action']);
// A person writing twice within this window (two mailboxes, or two quick messages) is one task.
export const DUPLICATE_REPLY_WINDOW_MINUTES = 30;

const normalAddress = value => {
  const raw = String(value || '').trim().toLowerCase();
  return (raw.match(/<([^<>\s]+@[^<>\s]+)>/) || raw.match(/([^\s<>"']+@[^\s<>"']+)/) || [])[1] || null;
};

// Latest stored classification for this person/project from either the reply ledger or the
// legacy inbox log. Used by every task-creating path so a stored "no action" is respected.
export async function storedReplyIntent(db, { leadId = null, email = null } = {}) {
  const address = normalAddress(email);
  if (!leadId && !address) return null;
  const parts = [], params = [leadId, address];
  if ((await db.query("SELECT to_regclass('sdr_reply_messages') AS t")).rows[0]?.t)
    parts.push(`SELECT intent, received_at AS at FROM sdr_reply_messages WHERE reply_kind='human' AND intent IS NOT NULL AND $1::text IS NOT NULL AND pipedrive_lead_id=$1`);
  if ((await db.query("SELECT to_regclass('sdr_inbox_reply_log') AS t")).rows[0]?.t)
    parts.push(`SELECT intent, created_at AS at FROM sdr_inbox_reply_log WHERE intent IS NOT NULL AND (($1::text IS NOT NULL AND pipedrive_lead_id=$1)
      OR ($2::text IS NOT NULL AND lower(coalesce(substring(from_addr from '<([^>]+)>'),from_addr))=$2))`);
  if (!parts.length) return null;
  return (await db.query(`SELECT intent FROM (${parts.join(' UNION ALL ')}) r ORDER BY at DESC LIMIT 1`, params)).rows[0]?.intent || null;
}

// A reply that asks to be removed is a permanent per-address hold, not the 180-day
// recent-reply cool-off (lib/recentReply.js). Idempotent per address.
async function holdUnsubscribedRecipient(client, { email, messageId }) {
  const address = normalAddress(email);
  const companyId = process.env.SDR_CRM_COMPANY_ID;
  if (!address || !companyId) return false;
  if (!(await client.query("SELECT to_regclass('sdr_outreach_controls') AS t")).rows[0]?.t) return false;
  const existing = await client.query(`SELECT 1 FROM sdr_outreach_controls WHERE company_id=$1 AND scope_kind='recipient'
    AND lower(trim(scope_id))=$2 AND status='active' AND lead_id IS NULL LIMIT 1`, [String(companyId), address]);
  if (existing.rowCount) return false;
  const { setOutreachControl } = await import('./sdrOutreachControls.js');
  await setOutreachControl(client, { companyId, leadId: null, scope: { kind: 'recipient', id: address }, channel: 'email',
    reason: 'Recipient asked to be removed (reply classified unsubscribe)', contextHash: `reply-unsubscribe:${messageId}`,
    actor: { source: 'service', accountId: 'reply-classifier', execution: 'automatic' } });
  return true;
}

// Same sender, same project (or same mailbox when unmatched), already given a task or a
// forward within the window: this message adds nothing a rep needs twice.
async function duplicateReply(client, { messageId, leadId, mailbox, fromEmail, receivedAt }) {
  if (!fromEmail) return false;
  return (await client.query(`SELECT 1 FROM sdr_reply_actions a JOIN sdr_reply_messages m ON m.provider_message_id=a.provider_message_id
    WHERE a.provider_message_id<>$1 AND a.kind IN ('create_task','forward') AND a.status<>'skipped'
      AND a.payload->>'fromEmail'=$2
      AND (($3::text IS NOT NULL AND (a.payload->>'leadId'=$3 OR m.pipedrive_lead_id=$3)) OR ($3::text IS NULL AND a.mailbox_email=$4))
      AND m.received_at BETWEEN $5::timestamptz - make_interval(mins => $6::int) AND $5::timestamptz + make_interval(mins => $6::int)
    LIMIT 1`, [messageId, fromEmail, leadId, mailbox, receivedAt, DUPLICATE_REPLY_WINDOW_MINUTES])).rowCount > 0;
}

async function routeFor(client, mailbox) {
  const route = (await client.query('SELECT forward_to,pipedrive_user_id FROM sdr_reply_routes WHERE mailbox_email=$1 AND active AND verified_at IS NOT NULL',[mailbox])).rows[0];
  const valid = route && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(route.forward_to) && Number(route.pipedrive_user_id) > 0;
  return valid ? route : null;
}

function actionAdder(client, messageId, base) {
  const add = async (kind, target, payload, review = null) => {
    const r = await client.query(`INSERT INTO sdr_reply_actions(id,provider_message_id,mailbox_email,kind,target_key,payload,status,requires_review,safe_error)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(provider_message_id,kind,target_key) DO NOTHING`,
    [randomUUID(),messageId,base.mailbox,kind,target,JSON.stringify({ ...base,...payload }),review ? 'failed' : 'pending',!!review,review]);
    add.enqueued += r.rowCount || 0;
  };
  add.enqueued = 0;
  return add;
}

async function addLeadActions(client, add, { leadId, mailbox, intent, staffResponseAt, receivedAt, taskHeld = false, messageId, fromEmail = null, forward = true }) {
  const sends = await client.query(`SELECT id,apollo_sequence_id,apollo_contact_id FROM sdr_sends
    WHERE pipedrive_lead_id=$1 AND status IN ('enrolled','sent')
    AND apollo_sequence_id IS NOT NULL AND apollo_contact_id IS NOT NULL`, [leadId]);
  for (const send of sends.rows) await add('stop_sequence', `${send.id}:${send.apollo_sequence_id}:${send.apollo_contact_id}`, { sendId:send.id,sequenceId: send.apollo_sequence_id,contactId: send.apollo_contact_id });
  const marker = (await client.query('SELECT sequence_started FROM sdr_lead_state WHERE pipedrive_lead_id=$1',[leadId])).rows[0]?.sequence_started;
  await add('clear_sequence_flag',leadId,{
    expectedFlag:marker ?? null,
    stopTargets:[...new Set(sends.rows.map(s=>`${s.id}:${s.apollo_sequence_id}:${s.apollo_contact_id}`))],
    stopSends:sends.rows.map(s=>({sendId:s.id,sequenceId:s.apollo_sequence_id,contactId:s.apollo_contact_id})),
  },sends.rows.length ? null : 'sequence_context_unverified');
  await client.query(`UPDATE sdr_sends SET status=$2,last_status_at=$3,updated_at=NOW()
    WHERE pipedrive_lead_id=$1 AND status IN ('enrolled','sent')`, [leadId,intent.kind === 'bounce' ? 'bounced' : 'replied',receivedAt]);
  if (intent.kind === 'human' && intent.label === 'unsubscribe') await holdUnsubscribedRecipient(client, { email: fromEmail, messageId });
  // The sequence stop above always applies; the human-facing work is not repeated.
  if (await duplicateReply(client, { messageId, leadId, mailbox, fromEmail, receivedAt })) return;
  await add('create_note', leadId, {});
  if (intent.kind === 'bounce' && intent.label === 'left_company') {
    // "No longer with the company, contact X": the address is dead but the account is not.
    if (!staffResponseAt && !taskHeld) {
      const route = await routeFor(client, mailbox);
      await add('create_task', `${leadId}:${mailbox}`, { userId: route?.pipedrive_user_id ?? null }, route ? null : 'routing_unverified');
    }
  } else if (intent.kind === 'human' && intent.label === 'unknown') {
    await add('match_lead', `${leadId}:intent`, { classifierReason: intent.reason ? String(intent.reason).slice(0, 120) : null }, 'classification_unverified');
    // Unclassified is not unimportant: the mailbox rep still gets a task to read it.
    if (!staffResponseAt && !taskHeld) {
      const route = await routeFor(client, mailbox);
      await add('create_task', `${leadId}:${mailbox}`, { userId: route?.pipedrive_user_id ?? null }, route ? null : 'routing_unverified');
    }
  } else if (intent.kind === 'human' && intent.worth && !staffResponseAt) {
    const route = await routeFor(client, mailbox);
    const review = route ? null : 'routing_unverified';
    // Mail copied from a rep's own inbox (source pipedrive) is already in that inbox.
    if (forward) await add('forward', mailbox, { forwardTo: route?.forward_to ?? null }, review);
    if (!taskHeld) await add('create_task', `${leadId}:${mailbox}`, { userId: route?.pipedrive_user_id ?? null }, review);
  }
}

// The caller supplies a verified inbound identity shared across providers when
// available (RFC Message-ID); an outbound Apollo message ID is not that identity.
export async function enqueueReplyActions(pool, event) {
  const mailbox = String(event.mailbox?.email || event.mailbox).toLowerCase();
  const receivedAt = new Date(event.receivedAt);
  if (!event.messageId || !Number.isFinite(+receivedAt) || !event.leadLink || !event.intent) throw new Error('invalid_reply_observation');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const link = event.leadLink;
    const leadId = link.status === 'verified' ? link.leadId : null;
    if (leadId) await acquireLeadLock(client,leadId);
    const inserted = await client.query(`INSERT INTO sdr_reply_messages
      (provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind,intent,staff_response_at,link_evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(provider_message_id) DO NOTHING RETURNING provider_message_id`,
    [event.messageId,event.source || 'gmail',event.sourceMessageId || event.messageId,event.threadId || null,mailbox,receivedAt,leadId,link.status,event.intent.kind,event.intent.label || null,event.staffResponseAt || null,link.evidence || null]);
    if (!inserted.rowCount || event.historical || event.intent.kind === 'auto') {
      await client.query('COMMIT');
      return { detected: inserted.rowCount || 0, enqueued: 0 };
    }
    const source = event.source || 'gmail';
    const fromEmail = normalAddress(event.fromEmail);
    const add = actionAdder(client, event.messageId, { leadId, threadId: event.threadId, sourceMessageId: event.sourceMessageId, intent: event.intent.label || 'unknown', mailbox,
      ...(source !== 'gmail' ? { source } : {}), ...(event.account ? { account: event.account } : {}), ...(fromEmail ? { fromEmail } : {}),
      ...(event.subject ? { subject: String(event.subject).slice(0, 200) } : {}), ...(event.intent.reason ? { intentReason: String(event.intent.reason).slice(0, 120) } : {}) });
    const forward = source === 'gmail';
    if (!leadId) {
      await add('match_lead', mailbox, { candidates: link.candidates || [], ...(event.intent.reason && event.intent.label === 'unknown' ? { classifierReason: String(event.intent.reason).slice(0, 120) } : {}) }, `lead_${link.status}`);
      if (event.intent.kind === 'human' && event.intent.label === 'unsubscribe') await holdUnsubscribedRecipient(client, { email: fromEmail, messageId: event.messageId });
      if (await duplicateReply(client, { messageId: event.messageId, leadId: null, mailbox, fromEmail, receivedAt })) { await client.query('COMMIT'); return { detected: 1, enqueued: add.enqueued, duplicate: true }; }
      // The mailbox owner can review a worthwhile reply while project matching
      // remains unresolved. No lead-specific CRM or provider action is licensed.
      // A task with no lead puts it on their Pipedrive list too, unclassified replies included.
      if(event.intent.kind==='human' && (event.intent.worth || event.intent.label==='unknown') && !event.staffResponseAt) {
        const route=await routeFor(client, mailbox);
        if(event.intent.label!=='unknown' && forward) await add('forward',mailbox,{forwardTo:route?.forward_to ?? null,projectReviewRequired:true},route?null:'routing_unverified');
        await add('create_task',`unmatched:${mailbox}`,{userId:route?.pipedrive_user_id ?? null},route?null:'routing_unverified');
      }
    } else {
      await addLeadActions(client, add, { leadId, mailbox, intent: event.intent, staffResponseAt: event.staffResponseAt, receivedAt, messageId: event.messageId, fromEmail, forward });
    }
    await client.query('COMMIT');
    return { detected: 1, enqueued: add.enqueued };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

// A reply held for project review that now links to exactly one project gets the
// actions it would have had on arrival. A forward already sent while it was held is
// not repeated (same mailbox target key). The held review row is closed as relinked.
export async function relinkHeldReply(pool, { messageId, link }) {
  if (!messageId || link?.status !== 'verified' || !link.leadId) throw new Error('invalid_relink');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireLeadLock(client, link.leadId);
    const message = (await client.query(`UPDATE sdr_reply_messages SET pipedrive_lead_id=$2,link_status='verified',link_evidence=$3
      WHERE provider_message_id=$1 AND pipedrive_lead_id IS NULL AND reply_kind IN ('human','bounce') RETURNING *`,[messageId,link.leadId,link.evidence])).rows[0];
    if (!message) { await client.query('ROLLBACK'); return { relinked: false, enqueued: 0 }; }
    await client.query(`UPDATE sdr_reply_actions SET status='skipped',requires_review=false,safe_error='relinked',updated_at=NOW()
      WHERE provider_message_id=$1 AND kind='match_lead' AND status='failed' AND safe_error IN ('lead_ambiguous','lead_unlinked')`,[messageId]);
    // The no-lead task for this reply is dropped if it never ran; if it may exist, no second task.
    await client.query(`UPDATE sdr_reply_actions SET status='skipped',requires_review=false,safe_error='relinked',updated_at=NOW()
      WHERE provider_message_id=$1 AND kind='create_task' AND target_key LIKE 'unmatched:%'
        AND (status='pending' OR (status='failed' AND safe_error IS DISTINCT FROM 'completion_uncertain'))`,[messageId]);
    const taskHeld = (await client.query(`SELECT 1 FROM sdr_reply_actions WHERE provider_message_id=$1 AND kind='create_task'
      AND target_key LIKE 'unmatched:%' AND status<>'skipped'`,[messageId])).rowCount > 0;
    const mailbox = String(message.mailbox_email).toLowerCase();
    const intent = { kind: message.reply_kind, label: message.intent || 'unknown', worth: WORTH_LABELS.has(message.intent) };
    const held = (await client.query(`SELECT payload FROM sdr_reply_actions WHERE provider_message_id=$1 AND kind='match_lead' ORDER BY created_at LIMIT 1`,[messageId])).rows[0]?.payload || {};
    const add = actionAdder(client, messageId, { leadId: link.leadId, threadId: message.thread_id || held.threadId, sourceMessageId: message.source_message_id || held.sourceMessageId, intent: intent.label, mailbox,
      ...(held.source ? { source: held.source } : {}), ...(held.account ? { account: held.account } : {}), ...(held.fromEmail ? { fromEmail: held.fromEmail } : {}),
      ...(held.subject ? { subject: held.subject } : {}), ...(held.intentReason ? { intentReason: held.intentReason } : {}) });
    await addLeadActions(client, add, { leadId: link.leadId, mailbox, intent, staffResponseAt: message.staff_response_at, receivedAt: message.received_at, taskHeld,
      messageId, fromEmail: held.fromEmail || null, forward: (held.source || 'gmail') === 'gmail' });
    await client.query('COMMIT');
    return { relinked: true, enqueued: add.enqueued };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

const EXPECTED_REVIEW = new Set(['provider_stop_review','lead_unlinked','lead_ambiguous','classification_unverified','routing_unverified','sequence_context_unverified','later_outbound_unverified']);
const actionFromRow = row => ({ ...row, retryAt: row.retry_at, externalId: row.external_id, externalAssigneeId:row.external_assignee_id, receiptAt: row.receipt_at, safeError: row.safe_error, requiresReview: row.requires_review });

export async function drainReplyActions(pool, { clients = {}, now = new Date(), limit = 25, featureEnabled = replyActionsEnabled() } = {}) {
  if (!featureEnabled) return { skipped: 'disabled' };
  const interrupted = await pool.query(`UPDATE sdr_reply_actions SET status='failed',requires_review=true,safe_error='completion_uncertain',
    lease_token=NULL,lease_until=NULL,retry_at=NULL,updated_at=$1 WHERE status='running' AND lease_until <= $1`, [now]);
  const counts = { attempted: 0, completed: 0, skipped: 0, failed: 0, deferred: 0, held: 0, interrupted: interrupted.rowCount || 0 };
  const kinds = Object.keys(clients).filter(kind => typeof clients[kind] === 'function' || typeof clients[kind]?.execute === 'function');
  const reconcilable = kinds.filter(kind=>typeof clients[kind]?.reconcile === 'function');
  for (let i = 0; i < Math.min(100,Math.max(0,limit)); i++) {
    const token = randomUUID();
    const { rows } = await pool.query(`WITH due AS (
      SELECT id FROM sdr_reply_actions candidate WHERE kind=ANY($1::text[]) AND (
        (status IN ('pending','failed') AND NOT requires_review AND (retry_at IS NULL OR retry_at <= $2))
        OR (status='failed' AND requires_review AND safe_error IN ('completion_uncertain','rate_limit') AND kind=ANY($4::text[]) AND updated_at < $2 AND (retry_at IS NULL OR retry_at <= $2))
        OR (status='failed' AND requires_review AND safe_error='provider_stop_review' AND kind='stop_sequence' AND kind=ANY($4::text[])
          AND updated_at < $2::timestamptz - INTERVAL '24 hours' AND (retry_at IS NULL OR retry_at <= $2))
      ) AND (kind<>'stop_sequence' OR NOT EXISTS (
        SELECT 1 FROM sdr_reply_actions quota WHERE quota.kind='stop_sequence' AND quota.safe_error='rate_limit' AND quota.retry_at > $2
      )) AND (kind<>'clear_sequence_flag' OR (
        jsonb_array_length(payload->'stopTargets') > 0 AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(candidate.payload->'stopTargets') target
          WHERE NOT EXISTS (SELECT 1 FROM sdr_reply_actions dependency
            WHERE dependency.provider_message_id=candidate.provider_message_id
              AND dependency.kind='stop_sequence' AND dependency.target_key=target
              AND dependency.status='completed' AND dependency.external_id IS NOT NULL AND dependency.receipt_at IS NOT NULL)
        )
      )) ORDER BY requires_review,CASE kind WHEN 'stop_sequence' THEN 0 WHEN 'clear_sequence_flag' THEN 1 ELSE 2 END,
        updated_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE sdr_reply_actions a SET status='running',lease_token=$3,lease_until=$2 + INTERVAL '15 minutes',updated_at=$2
      FROM due WHERE a.id=due.id RETURNING a.*`, [kinds,now,token,reconcilable]);
    if (!rows.length) break;
    const action = actionFromRow(rows[0]);
    const handler = clients[action.kind];
    const result = await runReplyAction(action, { execute: typeof handler === 'function' ? handler : handler.execute, reconcile: handler.reconcile, now });
    await pool.query(`UPDATE sdr_reply_actions SET status=$2,attempts=$3,retry_at=$4,requires_review=$5,safe_error=$6,external_id=$7,receipt_at=$8,
      lease_until=NULL,lease_token=NULL,updated_at=$9,external_assignee_id=$11 WHERE id=$1 AND lease_token=$10`,
    [action.id,result.status === 'running' ? 'failed' : result.status,result.attempts,result.retryAt,result.requiresReview,result.safeError,result.externalId,result.receiptAt,now,token,result.externalAssigneeId]);
    counts.attempted++;
    if (result.status === 'completed') counts.completed++; else if(result.status==='skipped') counts.skipped++;
    else if (result.status === 'pending' || !result.requiresReview || result.safeError === 'rate_limit') counts.deferred++;
    else if (EXPECTED_REVIEW.has(result.safeError)) counts.held++;
    else counts.failed++;
  }
  // Health: a run is partial only when work failed or was interrupted in THIS run. Items
  // waiting on staff review or on a provider retry are expected backlog, reported as counts.
  const backlog = (await pool.query(`SELECT count(*)::int AS unresolved,
      count(*) FILTER (WHERE requires_review AND safe_error IS DISTINCT FROM 'rate_limit')::int AS awaiting_review
    FROM sdr_reply_actions WHERE status NOT IN ('completed','skipped')`)).rows[0];
  return { coverage: counts.failed || counts.interrupted ? 'partial' : 'complete',
    counts: { ...counts, unresolved: backlog.unresolved, awaitingReview: backlog.awaiting_review } };
}

// One-time repair (scripts/backfill-reply-tasks.mjs): human replies that needed a rep task
// but never got one: unclassified replies and replies matching several projects from before
// those rules existed (2026-10-15..21). Queues the same create_task action arrival would
// have queued; the drain then re-checks the live thread (already answered -> skipped) before
// writing anything. Idempotent: the (message, kind, target) key makes a rerun a no-op.
export async function backfillMissingReplyTasks(pool, { days = 14, now = new Date(), dryRun = true } = {}) {
  const rows = (await pool.query(`SELECT m.*, (SELECT a.payload FROM sdr_reply_actions a WHERE a.provider_message_id=m.provider_message_id
        ORDER BY a.created_at LIMIT 1) AS base_payload,
        (SELECT lead_title FROM sdr_lead_state l WHERE l.pipedrive_lead_id=m.pipedrive_lead_id) AS lead_title,
        (SELECT string_agg(DISTINCT coalesce(l.lead_title,c.value),' / ') FROM sdr_reply_actions a CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(a.payload->'candidates','[]'::jsonb)) c(value)
          LEFT JOIN sdr_lead_state l ON l.pipedrive_lead_id=c.value WHERE a.provider_message_id=m.provider_message_id AND a.kind='match_lead') AS candidate_titles
      FROM sdr_reply_messages m
      WHERE m.reply_kind='human' AND m.staff_response_at IS NULL
        AND m.received_at > $1::timestamptz - make_interval(days => $2::int)
        AND (m.intent IS NULL OR m.intent='unknown' OR m.intent = ANY($3::text[]))
        AND NOT EXISTS (SELECT 1 FROM sdr_reply_actions a WHERE a.provider_message_id=m.provider_message_id AND a.kind='create_task')
      ORDER BY m.received_at`, [now, days, [...WORTH_LABELS]])).rows;
  const planned = [];
  for (const m of rows) {
    const mailbox = String(m.mailbox_email).toLowerCase();
    const leadId = m.link_status === 'verified' ? m.pipedrive_lead_id : null;
    const target = leadId ? `${leadId}:${mailbox}` : `unmatched:${mailbox}`;
    const route = await routeFor(pool, mailbox);
    planned.push({ messageId: m.provider_message_id, receivedAt: m.received_at, mailbox, leadId, linkStatus: m.link_status, intent: m.intent || 'unknown',
      project: leadId ? m.lead_title || null : null, candidates: leadId ? null : m.candidate_titles || null,
      target, assignee: route?.pipedrive_user_id ?? null, review: route ? null : 'routing_unverified' });
    if (dryRun) continue;
    const base = m.base_payload || {};
    const add = actionAdder(pool, m.provider_message_id, { leadId, threadId: m.thread_id || base.threadId || null, sourceMessageId: m.source_message_id || base.sourceMessageId,
      intent: m.intent || 'unknown', mailbox, ...(base.source ? { source: base.source } : {}), ...(base.account ? { account: base.account } : {}),
      ...(base.fromEmail ? { fromEmail: base.fromEmail } : {}), backfill: 'reply-tasks-2026-10-26' });
    await add('create_task', target, { userId: route?.pipedrive_user_id ?? null }, route ? null : 'routing_unverified');
    planned.at(-1).inserted = add.enqueued;
  }
  return { dryRun, count: planned.length, planned };
}
