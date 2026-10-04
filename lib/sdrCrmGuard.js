import * as pd from './pipedriveClient.js';

export function crmLifecycleEnabled() {
  return process.env.SDR_CRM_LIFECYCLE_ENABLED === 'true';
}

export function checkCrmLead(lead) {
  if (!lead) return { allowed: false, reason: 'crm_missing' };
  if (lead.is_archived === true) return { allowed: false, reason: 'crm_archived' };
  if (lead.is_archived !== false) return { allowed: false, reason: 'crm_unverified' };
  return { allowed: true, reason: null };
}

// Always read through the authorised client immediately before enrollment, after
// any old-draft refresh. A mirror row alone is not send-time evidence.
export async function verifyCrmLead(leadId, { pool, getLead = pd.getLead, lifecycleEnabled = crmLifecycleEnabled() } = {}) {
  let lead = null;
  let result;
  try {
    lead = await getLead(leadId);
    result = lead && String(lead.id) !== String(leadId)
      ? { allowed: false, reason: 'crm_unverified' }
      : checkCrmLead(lead);
  } catch (error) {
    result = { allowed: false, reason: error.status === 404 ? 'crm_missing' : 'crm_unverified' };
  }
  if (result.reason === 'crm_unverified') lead = null;
  if (pool && lifecycleEnabled) {
    const status = result.allowed ? 'active' : { crm_archived: 'archived', crm_missing: 'missing' }[result.reason] || 'unknown';
    try {
      await pool.query(
        `UPDATE sdr_lead_state SET crm_status=$2, crm_status_checked_at=NOW(),
          crm_last_seen_at=CASE WHEN $2 IN ('active','archived') THEN NOW() ELSE crm_last_seen_at END
         WHERE pipedrive_lead_id=$1`, [String(leadId), status]);
    } catch {
      return { allowed: false, reason: 'crm_unverified', retryable: true, lead: null };
    }
  }
  return { ...result, retryable: result.reason === 'crm_unverified', lead };
}
