import { buildDraftFromLead } from './sdrDraftGenerator.js';

// Refresh automatic copy only after proving the recipient/project context is unchanged.
// A human edit or changed buyer requires review instead of silently substituting recipients.
export async function refreshRetryDraft(pool, draftId, { build = buildDraftFromLead } = {}) {
  const draft=(await pool.query('SELECT *,updated_at::text AS refresh_version FROM sdr_drafts WHERE id=$1',[draftId])).rows[0];
  if (!draft || !['pending','approved'].includes(draft.status) || draft.sent_at) return {allowed:false,code:'draft_stale'};
  const current=await build({pipedriveLeadId:draft.pipedrive_lead_id,pool,
    assignedUserId:draft.assigned_user_id,apolloSequenceId:draft.apollo_sequence_id});
  const same=(a,b)=>String(a??'').toLowerCase()===String(b??'').toLowerCase();
  if (!same(current.contact_id_snapshot,draft.contact_id_snapshot) ||
      !same(current.contact_email_snapshot,draft.contact_email_snapshot) ||
      !same(current.org_id_snapshot,draft.org_id_snapshot)) return {allowed:false,code:'contact_changed'};
  if (!same(current.trigger_type,draft.trigger_type) ||
      !same(current.metadata?.project_stage,draft.metadata?.project_stage) ||
      !same(current.assigned_mailbox_id,draft.assigned_mailbox_id)) return {allowed:false,code:'draft_stale'};
  const updated=await pool.query(`UPDATE sdr_drafts SET subject=$2,body=$3,metadata=$4,updated_at=NOW()
    WHERE id=$1 AND status IN ('pending','approved') AND sent_at IS NULL AND updated_at=$5::timestamptz
    AND NOT EXISTS(SELECT 1 FROM sdr_sends s WHERE s.draft_id=sdr_drafts.id) RETURNING id`,
    [draftId,current.subject,current.body,current.metadata,draft.refresh_version]);
  return updated.rowCount ? {allowed:true} : {allowed:false,code:'draft_stale'};
}
