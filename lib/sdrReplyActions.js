import { randomUUID } from 'node:crypto';
import { acquireLeadLock } from './sdrAccess.js';

export const replyActionsEnabled = () => process.env.SDR_REPLY_ACTIONS_ENABLED === 'true';
const RETRY_MINUTES = [1, 5, 30, 120];

function completed(action, receipt, now) {
  return { ...action, status: 'completed', externalId: String(receipt.id), externalAssigneeId:receipt.assigneeId || null, receiptAt: now, retryAt: null, requiresReview: false, safeError: null };
}

export async function runReplyAction(action, { execute, reconcile, now = new Date() }) {
  if (['completed','skipped'].includes(action.status)) return action;
  if (action.requiresReview) {
    if (action.safeError !== 'completion_uncertain' || !reconcile) return action;
    let found;
    try { found = await reconcile(action); } catch { return action; }
    if (found?.state === 'completed' && found.receipt?.id) return completed(action, found.receipt, now);
    if (found?.state !== 'not_applied') return action;
    action = { ...action, requiresReview: false };
  }
  if (action.retryAt && new Date(action.retryAt) > now) return action;
  if (action.attempts >= 5) return { ...action,status:'failed',requiresReview:true,safeError:'attempts_exhausted',retryAt:null };
  const attempted = { ...action, attempts: action.attempts + 1 };
  try {
    const receipt = await execute(attempted);
    if (!receipt?.id) throw Object.assign(new Error('missing_receipt'), { uncertain: true });
    return completed(attempted, receipt, now);
  } catch (error) {
    if (error?.deferred) return { ...action,status:'pending',requiresReview:false,safeError:'dependencies_pending',retryAt:new Date(+now+60000) };
    const status = Number(error?.status);
    const permanent = [400,401,403,404,422].includes(status) || error?.permanent === true;
    const definite = error?.definiteFailure === true || status === 429;
    const exhausted = attempted.attempts >= 5;
    const requiresReview = permanent || !definite || exhausted;
    const safeError = [401,403].includes(status) ? 'authentication' : permanent ? 'configuration'
      : !definite ? 'completion_uncertain' : exhausted ? 'attempts_exhausted' : status === 429 ? 'rate_limit' : 'definite_failure';
    const retryMs = Number(error?.retryAfterMs || (error?.retryAfterSec ? error.retryAfterSec * 1000 : null));
    const delay = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : RETRY_MINUTES[attempted.attempts - 1] * 60000;
    return { ...attempted, status: 'failed', requiresReview, safeError, retryAt: requiresReview ? null : new Date(+now + delay) };
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
    let enqueued = 0;
    const base = { leadId, threadId: event.threadId, sourceMessageId: event.sourceMessageId, intent: event.intent.label || 'unknown', mailbox };
    const add = async (kind, target, payload, review = null) => {
      const r = await client.query(`INSERT INTO sdr_reply_actions(id,provider_message_id,mailbox_email,kind,target_key,payload,status,requires_review,safe_error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(provider_message_id,kind,target_key) DO NOTHING`,
      [randomUUID(),event.messageId,mailbox,kind,target,JSON.stringify({ ...base,...payload }),review ? 'failed' : 'pending',!!review,review]);
      enqueued += r.rowCount || 0;
    };
    if (!leadId) {
      await add('match_lead', mailbox, { candidates: link.candidates || [] }, `lead_${link.status}`);
    } else {
      const sends = await client.query(`SELECT id,apollo_sequence_id,apollo_contact_id FROM sdr_sends
        WHERE pipedrive_lead_id=$1 AND status IN ('enrolled','sent')
        AND apollo_sequence_id IS NOT NULL AND apollo_contact_id IS NOT NULL`, [leadId]);
      for (const send of sends.rows) await add('stop_sequence', `${send.apollo_sequence_id}:${send.apollo_contact_id}`, { sendId:send.id,sequenceId: send.apollo_sequence_id,contactId: send.apollo_contact_id });
      const marker = (await client.query('SELECT sequence_started FROM sdr_lead_state WHERE pipedrive_lead_id=$1',[leadId])).rows[0]?.sequence_started;
      await add('clear_sequence_flag',leadId,{
        expectedFlag:marker ?? null,
        stopTargets:[...new Set(sends.rows.map(s=>`${s.apollo_sequence_id}:${s.apollo_contact_id}`))],
        stopSends:sends.rows.map(s=>({sendId:s.id,sequenceId:s.apollo_sequence_id,contactId:s.apollo_contact_id})),
      },sends.rows.length ? null : 'sequence_context_unverified');
      await client.query(`UPDATE sdr_sends SET status=$2,last_status_at=$3,updated_at=NOW()
        WHERE pipedrive_lead_id=$1 AND status IN ('enrolled','sent')`, [leadId,event.intent.kind === 'bounce' ? 'bounced' : 'replied',receivedAt]);
      await add('create_note', leadId, {});
      if (event.intent.kind === 'human' && event.intent.label === 'unknown') await add('match_lead', `${leadId}:intent`, {}, 'classification_unverified');
      else if (event.intent.kind === 'human' && event.intent.worth && !event.staffResponseAt) {
        const route = (await client.query('SELECT forward_to,pipedrive_user_id FROM sdr_reply_routes WHERE mailbox_email=$1 AND active AND verified_at IS NOT NULL',[mailbox])).rows[0];
        const valid = route && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(route.forward_to) && Number(route.pipedrive_user_id) > 0;
        const review = valid ? null : 'routing_unverified';
        await add('forward', mailbox, { forwardTo: valid ? route.forward_to : null }, review);
        await add('create_task', `${leadId}:${mailbox}`, { userId: valid ? route.pipedrive_user_id : null }, review);
      }
    }
    await client.query('COMMIT');
    return { detected: 1, enqueued };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

const actionFromRow = row => ({ ...row, retryAt: row.retry_at, externalId: row.external_id, externalAssigneeId:row.external_assignee_id, receiptAt: row.receipt_at, safeError: row.safe_error, requiresReview: row.requires_review });

export async function drainReplyActions(pool, { clients = {}, now = new Date(), limit = 25, featureEnabled = replyActionsEnabled() } = {}) {
  if (!featureEnabled) return { skipped: 'disabled' };
  const interrupted = await pool.query(`UPDATE sdr_reply_actions SET status='failed',requires_review=true,safe_error='completion_uncertain',
    lease_token=NULL,lease_until=NULL,retry_at=NULL,updated_at=$1 WHERE status='running' AND lease_until <= $1`, [now]);
  const counts = { attempted: 0, completed: 0, failed: 0, interrupted: interrupted.rowCount || 0 };
  const kinds = Object.keys(clients).filter(kind => typeof clients[kind] === 'function' || typeof clients[kind]?.execute === 'function');
  const reconcilable = kinds.filter(kind=>typeof clients[kind]?.reconcile === 'function');
  for (let i = 0; i < Math.min(100,Math.max(0,limit)); i++) {
    const token = randomUUID();
    const { rows } = await pool.query(`WITH due AS (
      SELECT id FROM sdr_reply_actions candidate WHERE kind=ANY($1::text[]) AND (
        (status IN ('pending','failed') AND NOT requires_review AND (retry_at IS NULL OR retry_at <= $2))
        OR (status='failed' AND requires_review AND safe_error='completion_uncertain' AND kind=ANY($4::text[]) AND updated_at < $2)
      ) AND (kind<>'clear_sequence_flag' OR (
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
    if (result.status === 'completed') counts.completed++; else counts.failed++;
  }
  const pending = (await pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE status NOT IN ('completed','skipped')")).rows[0].n;
  return { coverage: pending ? 'partial' : 'complete', counts: { ...counts, unresolved: pending } };
}
