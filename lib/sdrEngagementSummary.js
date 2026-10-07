// A project appears once, for its current sent draft and current CRM recipient.
// Lead-only engagement is deliberately excluded: it cannot identify a recipient.
export async function buildEngagementSummary(pool, { user, companyId }) {
  if (!user?.sub) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!companyId) throw Object.assign(new Error('CRM company not configured'), { status: 503 });
  const { rows: leads } = await pool.query(`
    WITH current_draft AS (
      SELECT DISTINCT ON (pipedrive_lead_id) * FROM sdr_drafts WHERE status='sent'
      ORDER BY pipedrive_lead_id, created_at DESC NULLS LAST, sent_at DESC NULLS LAST, id DESC
    )
    SELECT d.id AS draft_id, d.pipedrive_lead_id, d.trigger_type, d.assigned_user_id,
      d.contact_email_snapshot, ls.lead_title, d.sent_at, snd.status AS send_status,
      u.username, u.display_name, ev.opens, ev.clicks, ev.replies, ev.last_event_at, ev.last_intent_at,
      (ev.opens + 5 * ev.clicks)::float AS score,
      COALESCE(snd.status IN ('enrolled','sent') AND NOT blocked.held AND NOT blocked.provider_unresolved AND NOT replied.found, false) AS priority_eligible,
      CASE WHEN blocked.held THEN 'outreach_held' WHEN blocked.provider_unresolved THEN 'provider_unresolved' WHEN replied.found THEN 'reply_recorded'
        WHEN snd.status IS NULL OR snd.status NOT IN ('enrolled','sent') THEN 'send_inactive' END AS priority_exclusion
    FROM current_draft d
    JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=d.pipedrive_lead_id AND ls.crm_company_id=$1
      AND ls.crm_status='active' AND lower(trim(ls.person_email))=lower(trim(d.contact_email_snapshot))
    JOIN sdr_crm_snapshots crm ON crm.company_id=$1 AND crm.entity='lead' AND crm.entity_id=d.pipedrive_lead_id
      AND crm.lifecycle='active' AND crm.access_status='accessible' AND NOT crm.is_test
    LEFT JOIN sdr_users u ON u.id=d.assigned_user_id
    LEFT JOIN LATERAL (SELECT s.status, s.apollo_sequence_id, s.sent_at, m.email AS mailbox_email
      FROM sdr_sends s LEFT JOIN sdr_mailboxes m ON m.id=s.mailbox_id WHERE s.draft_id=d.id
      AND s.pipedrive_lead_id=d.pipedrive_lead_id ORDER BY s.sent_at DESC, s.id DESC LIMIT 1) snd ON TRUE
    CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM sdr_outreach_controls c WHERE c.company_id=$1
      AND c.status='active' AND (c.lead_id IS NULL OR c.lead_id=d.pipedrive_lead_id)
      AND (c.channel IS NULL OR c.channel='email') AND (
        c.scope_kind='lead' AND c.scope_id=d.pipedrive_lead_id OR
        c.scope_kind='draft' AND c.scope_id=d.id::text OR
        c.scope_kind='recipient' AND lower(c.scope_id)=lower(trim(d.contact_email_snapshot)) OR
        c.scope_kind='channel' AND c.scope_id='email' OR c.scope_kind='service')) AS held,
      EXISTS(SELECT 1 FROM sdr_provider_operations op WHERE op.lead_id=d.pipedrive_lead_id
        AND op.state IN ('reserved','unresolved','protected_external_state')) AS provider_unresolved) blocked
    CROSS JOIN LATERAL (SELECT EXISTS(
      SELECT 1 FROM sdr_reply_messages r WHERE r.pipedrive_lead_id=d.pipedrive_lead_id
        AND r.reply_kind='human' AND r.link_status='verified' AND r.received_at<=now()
      UNION ALL SELECT 1 FROM sdr_engagement_events e WHERE e.pipedrive_lead_id=d.pipedrive_lead_id
        AND e.event_type IN ('email_replied','reply_received','email_unsubscribed','email_bounced') AND e.occurred_at<=now()
    ) AS found) replied
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER(WHERE e.event_type='email_opened')::int AS opens,
        count(*) FILTER(WHERE e.event_type IN ('email_clicked','link_clicked'))::int AS clicks,
        count(*) FILTER(WHERE e.event_type IN ('email_replied','reply_received'))::int AS replies,
        max(e.occurred_at) AS last_event_at,
        max(e.occurred_at) FILTER(WHERE e.event_type IN ('email_opened','email_clicked','link_clicked')) AS last_intent_at
      FROM sdr_engagement_events e
      WHERE e.pipedrive_lead_id=d.pipedrive_lead_id AND e.source='apollo'
        AND e.occurred_at BETWEEN now()-interval '96 hours' AND now() AND e.occurred_at>=d.sent_at
        AND e.apollo_emailer_message_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM sdr_message_facts f WHERE f.provider='apollo'
          AND f.provider_message_id=e.apollo_emailer_message_id AND
          (f.is_test OR f.link_status!='verified' OR f.pipedrive_lead_id IS DISTINCT FROM d.pipedrive_lead_id
            OR lower(f.prospect_email) IS DISTINCT FROM lower(trim(d.contact_email_snapshot))))
        AND (EXISTS(SELECT 1 FROM sdr_sends s JOIN sdr_mailboxes m ON m.id=s.mailbox_id
          WHERE s.draft_id=d.id AND s.pipedrive_lead_id=d.pipedrive_lead_id
            AND s.apollo_emailer_message_id=e.apollo_emailer_message_id
            AND (e.mailbox_email IS NULL OR lower(e.mailbox_email)=lower(m.email)))
          OR EXISTS(SELECT 1 FROM sdr_message_facts f WHERE f.provider='apollo'
            AND f.provider_message_id=e.apollo_emailer_message_id AND f.direction='out'
            AND f.link_status='verified' AND NOT f.is_test AND f.pipedrive_lead_id=d.pipedrive_lead_id
            AND lower(f.prospect_email)=lower(trim(d.contact_email_snapshot)) AND f.occurred_at>=GREATEST(d.sent_at,snd.sent_at)
            AND f.campaign_id=snd.apollo_sequence_id AND lower(f.mailbox_email)=lower(snd.mailbox_email)
            AND (e.mailbox_email IS NULL OR lower(e.mailbox_email)=lower(f.mailbox_email))))
    ) ev
    WHERE d.status='sent' AND ($2::boolean OR d.assigned_user_id::text=$3)
    ORDER BY score DESC, ev.last_event_at DESC NULLS LAST, d.sent_at DESC`,
  [String(companyId), user.role === 'admin', String(user.sub)]);
  const trigger = new Map(), sender = new Map();
  for (const lead of leads) {
    for (const [map,key,identity] of [[trigger,lead.trigger_type,{trigger_type:lead.trigger_type}],
      [sender,lead.assigned_user_id,{username:lead.username,display_name:lead.display_name}]]) {
      if (!key) continue;
      const rate=map.get(key)||{...identity,sent:0,opened:0,clicked:0,replied:0};
      rate.sent++; rate.opened+=Number(lead.opens>0); rate.clicked+=Number(lead.clicks>0); rate.replied+=Number(lead.replies>0);
      map.set(key,rate);
    }
  }
  return {leads,by_trigger:[...trigger.values()],by_sender:[...sender.values()],window_hours:96};
}
