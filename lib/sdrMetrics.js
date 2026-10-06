const unknown = (reason) => ({ value: null, state: 'unavailable', reason });
const count = (value, complete = true) => ({ value: Number(value || 0), state: complete ? 'available' : 'partial', ...(complete ? {} : { reason: 'incomplete_coverage' }) });
export function rate(numerator, denominator, complete) {
  if (!complete) return unknown('incomplete_coverage');
  return { value: denominator ? numerator / denominator : null, numerator, denominator, state: 'available',
    ...(denominator ? {} : { reason: 'no_denominator' }) };
}
const unavailableKeys = ['messages_completed','contacts_reached','first_touches','followups_completed','human_replies_received',
  'human_reply_rate','positive_reply_rate','followup_completion_rate','duplicate_rate','quote_close_rate','contact_to_win_rate',
  'won_booked_value','average_won_deal_value','company_won_booked_value','company_average_won_deal_value','won_deals',
  'collected_value','eligible_supply','bounce_rate','unresolved_quotes','company_won_deals','open_rate','spam_rate','bounce_events','spam_blocked_events'];
function emptyResponse(window, reason) {
  return { window, observation_cutoff: null, freshness: { last_complete_at: null, state: 'unknown' },
    coverage: { provider_messages: unknown(reason), project_links: unknown(reason), deal_links: unknown(reason) },
    metrics: Object.fromEntries(unavailableKeys.map(key => [key, unknown(reason)])), senders: [], sources: [], sequences: [], activity: [],
    attention: reason === 'no_visible_mailboxes' ? [] : [{ kind: reason, count: 1, oldest_at: null, target: 'reporting' }] };
}
// All dynamic filters are values. Local date boundaries are interpreted by Postgres, including DST.
const bounds = `($1::date::timestamp AT TIME ZONE $3)`;
const end = `($2::date::timestamp AT TIME ZONE $3)`;
const scope = `$6::timestamptz IS NOT NULL AND mailbox_email=ANY($4::text[]) AND (
  (($5::text IS NULL OR source_key=$5) AND ($7::text IS NULL OR campaign_id=$7))
  OR (direction='in' AND ($5::text IS NOT NULL OR $7::text IS NOT NULL) AND EXISTS (
    SELECT 1 FROM sdr_reporting_messages o WHERE o.direction='out' AND o.provider_status='completed'
    AND o.mailbox_email=sdr_reporting_messages.mailbox_email AND o.prospect_email=sdr_reporting_messages.prospect_email
    AND o.occurred_at<=sdr_reporting_messages.occurred_at
    AND ($5::text IS NULL OR o.source_key=$5) AND ($7::text IS NULL OR o.campaign_id=$7)
    AND (sdr_reporting_messages.link_status<>'verified' OR (o.link_status='verified' AND o.pipedrive_lead_id=sdr_reporting_messages.pipedrive_lead_id))
    AND (sdr_reporting_messages.reply_to_id=o.provider_message_id OR (sdr_reporting_messages.reply_to_id IS NULL
      AND sdr_reporting_messages.thread_id IS NOT NULL AND sdr_reporting_messages.thread_id=o.thread_id
      AND NOT EXISTS (SELECT 1 FROM sdr_reporting_messages conflicting WHERE conflicting.direction='out'
        AND conflicting.provider_status='completed' AND conflicting.mailbox_email=o.mailbox_email
        AND conflicting.prospect_email=o.prospect_email AND conflicting.thread_id=o.thread_id
        AND conflicting.occurred_at<=sdr_reporting_messages.occurred_at
        AND (($7::text IS NOT NULL AND conflicting.campaign_id IS DISTINCT FROM o.campaign_id)
          OR ($5::text IS NOT NULL AND conflicting.source_key IS DISTINCT FROM o.source_key))))))))`;

const threadConflict = `NOT EXISTS (SELECT 1 FROM sdr_reporting_messages conflicting WHERE conflicting.direction='out'
  AND conflicting.provider_status='completed' AND conflicting.mailbox_email=o.mailbox_email
  AND conflicting.prospect_email=o.prospect_email AND conflicting.thread_id=o.thread_id
  AND conflicting.occurred_at<=r.occurred_at
  AND (($7::text IS NOT NULL AND conflicting.campaign_id IS DISTINCT FROM o.campaign_id)
    OR ($5::text IS NOT NULL AND conflicting.source_key IS DISTINCT FROM o.source_key)))`;
const messageSql = `SELECT mailbox_email, GROUPING(mailbox_email) AS total,
  COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed') AS messages_completed,
  COUNT(DISTINCT prospect_email) FILTER (WHERE direction='out' AND provider_status='completed') AS contacts_reached,
  COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND sequence_step=1) AS first_touches,
  COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND sequence_step>1) AS followups_completed,
  COUNT(*) FILTER (WHERE direction='in' AND human_reply=true AND NOT bounce AND NOT spam_blocked) AS human_replies_received,
  COUNT(*) FILTER (WHERE direction='in' AND human_reply=true AND NOT bounce AND NOT spam_blocked
    AND NOT EXISTS (SELECT 1 FROM sdr_reporting_messages o WHERE o.direction='out' AND o.provider_status='completed'
      AND o.mailbox_email=sdr_reporting_messages.mailbox_email AND o.prospect_email=sdr_reporting_messages.prospect_email
      AND o.occurred_at<=sdr_reporting_messages.occurred_at AND ($5::text IS NULL OR o.source_key=$5) AND ($7::text IS NULL OR o.campaign_id=$7)
      AND (sdr_reporting_messages.link_status<>'verified' OR
        (o.link_status='verified' AND o.pipedrive_lead_id=sdr_reporting_messages.pipedrive_lead_id))
      AND (sdr_reporting_messages.reply_to_id=o.provider_message_id OR
        (sdr_reporting_messages.reply_to_id IS NULL AND sdr_reporting_messages.thread_id IS NOT NULL AND sdr_reporting_messages.thread_id=o.thread_id)))) AS unlinked_replies,
  COUNT(*) FILTER (WHERE direction='out') AS attempts,
  COUNT(*) FILTER (WHERE direction='out' AND bounce) AS bounces,
  COUNT(*) FILTER (WHERE direction='out' AND spam_blocked) AS spam_blocks,
  COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND link_status='verified') AS linked,
  COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND source_key='unknown') AS unknown_source
  ,COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND outreach_classification='unknown') AS unknown_classification
  FROM sdr_reporting_messages WHERE ${scope} AND occurred_at >= ${bounds} AND occurred_at < ${end}
  GROUP BY GROUPING SETS ((mailbox_email),())`;
const cohortSql = `WITH first_touch AS (
  SELECT DISTINCT ON (prospect_email,CASE WHEN link_status='verified' THEN pipedrive_lead_id ELSE '' END) * FROM sdr_reporting_messages
  WHERE mailbox_email=ANY($4::text[]) AND direction='out' AND provider_status='completed' AND sequence_step=1
    AND outreach_classification='sales_outreach' AND classification_evidence IS NOT NULL AND occurred_at <= $6
  ORDER BY prospect_email,CASE WHEN link_status='verified' THEN pipedrive_lead_id ELSE '' END,occurred_at,provider,provider_message_id
), cohort AS (
  SELECT * FROM first_touch WHERE occurred_at >= ${bounds} AND occurred_at < ${end} AND ($5::text IS NULL OR source_key=$5) AND ($7::text IS NULL OR campaign_id=$7)
), outcome AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM sdr_reporting_messages r WHERE r.direction='in' AND r.human_reply=true
      AND NOT r.bounce AND NOT r.spam_blocked AND r.mailbox_email=c.mailbox_email AND r.prospect_email=c.prospect_email
      AND r.occurred_at >= c.occurred_at AND r.occurred_at < c.occurred_at+interval '30 days' AND r.occurred_at <= $6
      AND EXISTS (SELECT 1 FROM sdr_reporting_messages o WHERE o.direction='out' AND o.provider_status='completed'
        AND o.mailbox_email=c.mailbox_email AND o.prospect_email=c.prospect_email
        AND ($5::text IS NULL OR o.source_key=c.source_key) AND ($7::text IS NULL OR o.campaign_id=c.campaign_id)
        AND ((c.link_status='verified' AND o.link_status='verified' AND o.pipedrive_lead_id=c.pipedrive_lead_id)
          OR (c.link_status<>'verified' AND (o.provider_message_id=c.provider_message_id
            OR (c.thread_id IS NOT NULL AND o.thread_id=c.thread_id))))
        AND (r.link_status<>'verified' OR (o.link_status='verified' AND r.pipedrive_lead_id=o.pipedrive_lead_id))
        AND o.occurred_at >= c.occurred_at AND o.occurred_at <= r.occurred_at
        AND (r.reply_to_id=o.provider_message_id OR (r.reply_to_id IS NULL AND r.thread_id IS NOT NULL AND r.thread_id=o.thread_id AND ${threadConflict})))) AS replied,
    EXISTS (SELECT 1 FROM sdr_reporting_messages r WHERE r.direction='in' AND r.human_reply=true
      AND NOT r.bounce AND NOT r.spam_blocked AND r.reply_intent IN ('interested','pricing','question','qualified_referral')
      AND r.mailbox_email=c.mailbox_email AND r.prospect_email=c.prospect_email
      AND r.occurred_at >= c.occurred_at AND r.occurred_at < c.occurred_at+interval '30 days' AND r.occurred_at <= $6
      AND EXISTS (SELECT 1 FROM sdr_reporting_messages o WHERE o.direction='out' AND o.provider_status='completed'
        AND o.mailbox_email=c.mailbox_email AND o.prospect_email=c.prospect_email
        AND ($5::text IS NULL OR o.source_key=c.source_key) AND ($7::text IS NULL OR o.campaign_id=c.campaign_id)
        AND ((c.link_status='verified' AND o.link_status='verified' AND o.pipedrive_lead_id=c.pipedrive_lead_id)
          OR (c.link_status<>'verified' AND (o.provider_message_id=c.provider_message_id
            OR (c.thread_id IS NOT NULL AND o.thread_id=c.thread_id))))
        AND (r.link_status<>'verified' OR (o.link_status='verified' AND r.pipedrive_lead_id=o.pipedrive_lead_id))
        AND o.occurred_at >= c.occurred_at AND o.occurred_at <= r.occurred_at
        AND (r.reply_to_id=o.provider_message_id OR (r.reply_to_id IS NULL AND r.thread_id IS NOT NULL AND r.thread_id=o.thread_id AND ${threadConflict})))) AS positive,
    EXISTS (SELECT 1 FROM sdr_reporting_deals d WHERE d.link_status='verified' AND d.source IS NOT NULL AND d.source<>'unknown'
      AND c.link_status='verified' AND d.pipedrive_lead_id=c.pipedrive_lead_id AND d.status='won'
      AND d.won_at >= c.occurred_at AND d.won_at < c.occurred_at+interval '60 days' AND d.won_at <= $6) AS won
  FROM cohort c
)
SELECT mailbox_email,GROUPING(mailbox_email) AS total,COUNT(DISTINCT prospect_email) AS contacted,
  ARRAY_AGG(DISTINCT provider||':'||provider_message_id) AS first_touch_ids,
  COUNT(*) FILTER (WHERE link_status<>'verified') AS unverified_identities,
  COUNT(DISTINCT prospect_email) FILTER (WHERE replied) AS replied,COUNT(DISTINCT prospect_email) FILTER (WHERE positive) AS positive,
  COUNT(*) FILTER (WHERE occurred_at+interval '30 days'>$6) AS immature_reply,
  COUNT(*) FILTER (WHERE occurred_at+interval '60 days'>$6) AS immature_sales,
  COUNT(DISTINCT pipedrive_lead_id) FILTER (WHERE link_status='verified') AS projects,
  COUNT(DISTINCT pipedrive_lead_id) FILTER (WHERE won AND link_status='verified') AS won_projects
FROM outcome GROUP BY GROUPING SETS ((mailbox_email),())`;
const dealSql = `WITH visible AS (
  SELECT d.* FROM sdr_reporting_deals d WHERE d.link_status='verified'
    AND ($5::text IS NULL OR d.source=$5)
    AND EXISTS (SELECT 1 FROM sdr_reporting_messages m WHERE m.direction='out' AND m.provider_status='completed'
      AND m.link_status='verified' AND m.pipedrive_lead_id=d.pipedrive_lead_id
      AND m.mailbox_email=ANY($4::text[]) AND ($5::text IS NULL OR m.source_key=$5) AND ($7::text IS NULL OR m.campaign_id=$7)
      AND m.occurred_at <= COALESCE(d.won_at,d.quote_created_at,$6))
), selected AS (
  SELECT * FROM visible WHERE source IS NOT NULL AND source<>'unknown'
)
SELECT COUNT(*) FILTER (WHERE status='won' AND won_at >= ${bounds} AND won_at < ${end}) AS wins,
  COUNT(*) FILTER (WHERE status='won' AND currency='USD' AND value IS NOT NULL AND won_at >= ${bounds} AND won_at < ${end}) AS valued_wins,
  COALESCE(SUM(value) FILTER (WHERE status='won' AND currency='USD' AND won_at >= ${bounds} AND won_at < ${end}),0) AS won_value,
  ARRAY_AGG(pipedrive_deal_id) FILTER (WHERE qualified_quote AND quote_evidence IS NOT NULL AND quote_created_at >= ${bounds} AND quote_created_at < ${end}) AS quote_ids,
  COUNT(*) FILTER (WHERE qualified_quote AND quote_evidence IS NOT NULL AND quote_created_at >= ${bounds} AND quote_created_at < ${end}) AS quotes,
  COUNT(*) FILTER (WHERE qualified_quote AND quote_evidence IS NOT NULL AND status='won' AND quote_created_at >= ${bounds} AND quote_created_at < ${end}) AS quote_wins,
  COUNT(*) FILTER (WHERE qualified_quote AND quote_evidence IS NOT NULL AND status IN ('won','lost') AND quote_created_at >= ${bounds} AND quote_created_at < ${end}) AS resolved,
  COUNT(*) FILTER (WHERE qualified_quote AND quote_evidence IS NOT NULL AND status NOT IN ('won','lost') AND quote_created_at >= ${bounds} AND quote_created_at < ${end}) AS unresolved
FROM selected`;
function covers(runs, job, mailbox, window, now, history = false) {
  return runs.some(run => run.job === job && run.scope === mailbox && run.status === 'complete'
    && run.finished_at && new Date(run.finished_at) <= now
    && (job !== 'apollo_messages' || run.counts?.all_sequences === true)
    && run.counts?.from <= window.from && run.counts?.to >= window.to && (!history || run.counts?.history_complete === true));
}
function idsAccepted(actual, accepted, excluded = []) {
  if (!Array.isArray(accepted)) return false;
  const tests=new Set(excluded);
  const expected=accepted.filter(id=>!tests.has(id)).sort();
  if(actual.length!==expected.length) return false;
  return [...actual].sort().every((id,index)=>id===expected[index]);
}
function messageMetrics(row = {}, cohort = {}, complete, inboundComplete, inboxEventComplete) {
  const n = key => Number(row[key] || 0);
  const metric = key => complete || n('attempts') || n('human_replies_received') ? count(row[key], complete) : unknown('incomplete_coverage');
  const metrics = Object.fromEntries(['messages_completed','contacts_reached','first_touches','followups_completed'].map(key => [key, metric(key)]));
  metrics.human_replies_received=inboxEventComplete || n('human_replies_received') ? count(row.human_replies_received,inboxEventComplete) : unknown('inbox_coverage_incomplete');
  for (const [key, field] of [['human_reply_rate','replied'], ['positive_reply_rate','positive']]) {
    metrics[key] = rate(Number(cohort[field] || 0), Number(cohort.contacted || 0), complete && inboundComplete);
    if (metrics[key].state === 'available' && Number(cohort.immature_reply)) {
      metrics[key].state = 'partial'; metrics[key].reason = 'cohort_maturing_30_days';
    }
    if (metrics[key].state !== 'unavailable' && n('unlinked_replies')) {
      metrics[key].state='partial'; metrics[key].reason='reply_links_missing';
    }
  }
  metrics.bounce_rate = rate(n('bounces'), n('attempts'), complete);
  metrics.bounce_events = metric('bounces');
  metrics.spam_blocked_events = metric('spam_blocks');
  metrics.open_rate = unknown('open_tracking_unverified');
  metrics.spam_rate = unknown('spam_placement_unverified');
  metrics.followup_completion_rate = unknown('due_step_receipts_missing');
  metrics.duplicate_rate = unknown('duplicate_review_missing');
  metrics.collected_value = unknown('accounting_not_connected');
  metrics.eligible_supply = unknown('crm_reconciliation_needed');
  metrics.contact_to_win_rate = unknown('deal_links_missing');
  return metrics;
}
export async function buildMetrics(pool, { window, visibleMailboxes, source = null, sequence = null, now = new Date(), includeCompanySales = false }) {
  if (!Array.isArray(visibleMailboxes) || !visibleMailboxes.length) return emptyResponse(window, 'no_visible_mailboxes');
  const mailboxes = [...new Set(visibleMailboxes.map(value => value.toLowerCase()))];
  const params = [window.from,window.to,window.timezone,mailboxes,source,now,sequence];
  try {
    const [messageRows, cohortRows, dealRows, jobRows, sourceRows, sequenceRows, activityRows, ambiguityRows, firstTouchIdRows, quoteIdRows, historicalUnknownRows] = await Promise.all([
      pool.query(messageSql, params), pool.query(cohortSql,params), pool.query(dealSql,params),
      pool.query(`SELECT DISTINCT ON (job,scope,status) job,scope,status,finished_at,counts FROM sdr_job_runs
        WHERE scope=ANY($1::text[]) OR (scope='company' AND job='pipedrive_deals')
        ORDER BY job,scope,status,finished_at DESC NULLS LAST`, [mailboxes]),
      pool.query(`SELECT DISTINCT source_key FROM sdr_reporting_messages WHERE mailbox_email=ANY($1::text[]) ORDER BY source_key`, [mailboxes]),
      pool.query(`SELECT campaign_id, COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed') messages_completed,
        COUNT(DISTINCT prospect_email) FILTER (WHERE direction='out' AND provider_status='completed') contacts_reached,
        COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND sequence_step=1) first_touches,
        COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND sequence_step>1) followups_completed,
        COUNT(*) FILTER (WHERE direction='out') attempts, COUNT(*) FILTER (WHERE direction='out' AND bounce) bounces,
        COUNT(*) FILTER (WHERE direction='out' AND spam_blocked) spam_blocks
        FROM sdr_reporting_messages WHERE mailbox_email=ANY($4::text[]) AND ($5::text IS NULL OR source_key=$5)
        AND occurred_at >= ${bounds} AND occurred_at < ${end} AND campaign_id IS NOT NULL
        GROUP BY campaign_id ORDER BY campaign_id`,params.slice(0,5)),
      pool.query(`WITH days AS (SELECT generate_series($1::date,$2::date-1,interval '1 day')::date date),
        emails AS (SELECT (occurred_at AT TIME ZONE $3)::date date,
        COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed') messages_completed,
        COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND sequence_step=1) first_touches,
        COUNT(*) FILTER (WHERE direction='out' AND provider_status='completed' AND sequence_step>1) followups_completed,
        COUNT(*) FILTER (WHERE direction='in' AND human_reply AND NOT bounce AND NOT spam_blocked) human_replies_received
        FROM sdr_reporting_messages WHERE ${scope} AND occurred_at >= ${bounds} AND occurred_at < ${end} GROUP BY 1)
        SELECT to_char(days.date,'YYYY-MM-DD') date,COALESCE(messages_completed,0)::int messages_completed,
          COALESCE(first_touches,0)::int first_touches,COALESCE(followups_completed,0)::int followups_completed,
          COALESCE(human_replies_received,0)::int human_replies_received FROM days LEFT JOIN emails USING(date) ORDER BY days.date`,params),
      pool.query(`SELECT r.mailbox_email,COUNT(*)::int count FROM sdr_reporting_messages r
        WHERE $6::timestamptz IS NOT NULL AND r.mailbox_email=ANY($4::text[]) AND r.direction='in'
        AND r.human_reply AND NOT r.bounce AND NOT r.spam_blocked
        AND r.occurred_at >= ${bounds} AND r.occurred_at < ${end}
        AND r.reply_to_id IS NULL AND r.thread_id IS NOT NULL AND ($5::text IS NOT NULL OR $7::text IS NOT NULL)
        AND EXISTS (SELECT 1 FROM sdr_reporting_messages o WHERE o.direction='out' AND o.provider_status='completed'
          AND o.mailbox_email=r.mailbox_email AND o.prospect_email=r.prospect_email AND o.thread_id=r.thread_id
          AND o.occurred_at<=r.occurred_at AND ($5::text IS NULL OR o.source_key=$5) AND ($7::text IS NULL OR o.campaign_id=$7)
          AND NOT (${threadConflict})) GROUP BY r.mailbox_email`,params),
      pool.query(`SELECT mailbox_email,provider||':'||provider_message_id AS id,is_test FROM sdr_message_facts
        WHERE mailbox_email=ANY($1::text[]) AND direction='out' AND provider_status='completed'
        AND sequence_step=1 AND outreach_classification='sales_outreach' AND classification_evidence IS NOT NULL`,[mailboxes]),
      pool.query(`SELECT pipedrive_deal_id AS id,is_test FROM sdr_deal_facts WHERE quote_evidence IS NOT NULL AND qualified_quote IS TRUE`),
      pool.query(`SELECT mailbox_email,COUNT(*)::int AS n FROM sdr_reporting_messages WHERE mailbox_email=ANY($1::text[])
        AND direction='out' AND provider_status='completed' AND sequence_step=1
        AND outreach_classification='unknown' AND occurred_at<=$2::timestamptz GROUP BY mailbox_email`,[mailboxes,now]),
    ]);
    const runs = jobRows.rows;
    const total = messageRows.rows.find(row => Number(row.total) === 1) || {};
    const cohort = cohortRows.rows.find(row => Number(row.total) === 1) || {};
    const replyEnd = new Date(new Date(`${window.to}T00:00:00Z`).getTime()+30*86400000).toISOString().slice(0,10);
    const todayParts = new Intl.DateTimeFormat('en-CA',{ timeZone:window.timezone,year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(now);
    const p = Object.fromEntries(todayParts.map(part => [part.type,part.value]));
    const today = `${p.year}-${p.month}-${p.day}`;
    const replyWindow = { ...window, to: replyEnd < today ? replyEnd : today };
    const salesEnd=new Date(new Date(`${window.to}T00:00:00Z`).getTime()+60*86400000).toISOString().slice(0,10);
    const salesWindow={...window,to:salesEnd<today?salesEnd:today};
    const completeFor = mailbox => covers(runs,'apollo_messages',mailbox,window,now,true);
    const cohortAcceptedFor=mailbox=>{
      const run=runs.find(row=>row.job==='apollo_messages'&&row.scope===mailbox&&row.status==='complete');
      const identities=firstTouchIdRows.rows.filter(value=>value.mailbox_email===mailbox);
      const ids=identities.filter(value=>!value.is_test).map(value=>value.id);
      const excluded=identities.filter(value=>value.is_test).map(value=>value.id);
      return run?.counts?.cohort_reconciled===true && idsAccepted(ids,run.counts.accepted_first_touch_ids,excluded);
    };
    const inboundFor = mailbox => covers(runs,'gmail_messages',mailbox,replyWindow,now);
    const inboxEventFor=mailbox=>covers(runs,'gmail_messages',mailbox,window,now);
    const complete = mailboxes.every(completeFor);
    const inboundComplete = mailboxes.every(inboundFor);
    const metrics = messageMetrics(total,cohort,complete,inboundComplete,mailboxes.every(inboxEventFor));
    const unknownClassification=Number(total.unknown_classification||0)+historicalUnknownRows.rows.reduce((sum,row)=>sum+row.n,0);
    const identitiesUnknown=Number(cohort.unverified_identities||0);
    const ambiguousIdentityRows=await pool.query(`SELECT prospect_email FROM sdr_reporting_messages WHERE $6::timestamptz IS NOT NULL AND mailbox_email=ANY($4::text[])
      AND direction='out' AND provider_status='completed' AND outreach_classification='sales_outreach' AND sequence_step=1
      AND occurred_at >= ${bounds} AND occurred_at < ${end} AND ($5::text IS NULL OR source_key=$5)
      AND ($7::text IS NULL OR campaign_id=$7) GROUP BY prospect_email HAVING COUNT(DISTINCT pipedrive_lead_id)>1 LIMIT 1`,params);
    const conversionReason=unknownClassification ? 'outreach_classification_incomplete'
      : identitiesUnknown || ambiguousIdentityRows.rows.length ? 'identity_reconciliation_missing'
      : mailboxes.every(cohortAcceptedFor) ? null : 'cohort_reconciliation_missing';
    if(conversionReason) {
      metrics.human_reply_rate=unknown(conversionReason);
      metrics.positive_reply_rate=unknown(conversionReason);
    }
    const d = dealRows.rows[0];
    const dealComplete = covers(runs,'pipedrive_deals','company',window,now);
    const salesComplete=covers(runs,'pipedrive_deals','company',salesWindow,now);
    const linked = Number(d.wins || 0);
    const valued = Number(d.valued_wins || 0);
    metrics.won_deals = linked || dealComplete ? count(linked,dealComplete) : unknown('deal_links_missing');
    metrics.won_booked_value = valued ? count(d.won_value,dealComplete && linked===valued) : unknown('deal_links_missing');
    metrics.average_won_deal_value = valued ? { ...count(Number(d.won_value)/valued,dealComplete && linked===valued), numerator:Number(d.won_value),denominator:valued } : unknown('deal_links_missing');
    const dealRun=runs.find(run=>run.job==='pipedrive_deals'&&run.scope==='company'&&run.status==='complete');
    const quoteAccepted=dealRun?.counts?.quote_evidence_reconciled===true && idsAccepted(quoteIdRows.rows.filter(row=>!row.is_test).map(row=>row.id),dealRun.counts.accepted_quote_ids,quoteIdRows.rows.filter(row=>row.is_test).map(row=>row.id));
    metrics.quote_close_rate = Number(d.quotes) && quoteAccepted ? rate(Number(d.quote_wins),Number(d.resolved),dealComplete) : unknown('qualified_quote_mapping_missing');
    metrics.unresolved_quotes = Number(d.quotes) ? count(d.unresolved,dealComplete&&quoteAccepted) : unknown('qualified_quote_mapping_missing');
    if (Number(cohort.projects) && complete && salesComplete && !conversionReason) {
      metrics.contact_to_win_rate = rate(Number(cohort.won_projects),Number(cohort.projects),true);
      if (Number(cohort.immature_sales)) Object.assign(metrics.contact_to_win_rate,{ state:'partial',reason:'cohort_maturing_60_days' });
    } else if(conversionReason) metrics.contact_to_win_rate=unknown(conversionReason);
    metrics.company_won_deals = unknown('company_sales_admin_only');
    metrics.company_won_booked_value = unknown('company_sales_admin_only');
    metrics.company_average_won_deal_value = unknown('company_sales_admin_only');
    const companyRun=includeCompanySales ? runs.find(run=>run.job==='pipedrive_deals'&&run.scope==='company'&&run.status==='complete'
      && run.counts?.history_complete===true&&run.counts?.company_scope_accepted===true&&run.counts?.includes_archived===true
      && run.finished_at&&new Date(run.finished_at)<=now) : null;
    const companyParams=[...params.slice(0,3),JSON.stringify(companyRun?.counts?.date_adjustments||[]),JSON.stringify(companyRun?.counts?.date_reviews||[])];
    const companyFrom=`(SELECT d.*,COALESCE(a.sales_at,d.won_at) AS company_sales_at,EXISTS(SELECT 1 FROM jsonb_to_recordset($5::jsonb) AS hold(id text,provider_won_at timestamptz) WHERE hold.id=d.pipedrive_deal_id AND hold.provider_won_at=d.won_at) AS date_held FROM sdr_reporting_deals d
      LEFT JOIN jsonb_to_recordset($4::jsonb) AS a(id text,sales_at timestamptz,provider_won_at timestamptz) ON a.id=d.pipedrive_deal_id AND a.provider_won_at=d.won_at) company`;
    const dateWarnings=(companyRun?.counts?.date_warnings||[]).filter(row=>row.month>=window.from.slice(0,7)&&row.month<window.to.slice(0,7)+(window.to.endsWith('-01')?'':'~'));
    if (includeCompanySales) {
      const { rows } = await pool.query(`SELECT COUNT(*) AS wins,
        COUNT(*) FILTER (WHERE currency='USD' AND value IS NOT NULL) AS valued_wins,
        COALESCE(SUM(value) FILTER (WHERE currency='USD'),0) AS value FROM ${companyFrom}
        WHERE status='won' AND NOT date_held AND company_sales_at >= ${bounds} AND company_sales_at < ${end}`, companyParams);
      const company = rows[0]; const known = Number(company.valued_wins);
      metrics.company_won_deals = Number(company.wins)||dealComplete ? count(company.wins,dealComplete) : unknown('deal_sync_missing');
      metrics.company_won_booked_value = known || dealComplete ? count(company.value,dealComplete && known===Number(company.wins)) : unknown('deal_sync_missing');
      metrics.company_average_won_deal_value = known ? { ...count(Number(company.value)/known,dealComplete && known===Number(company.wins)),numerator:Number(company.value),denominator:known } : unknown('no_valued_wins');
    }
    const activity=activityRows.rows.map(row=>({...row,company_won_deals:null,company_won_booked_value:null,company_valued_wins:null}));
    if(includeCompanySales) {
      const {rows}=await pool.query(`SELECT to_char(company_sales_at AT TIME ZONE $3,'YYYY-MM-DD') date,COUNT(*)::int wins,COUNT(*) FILTER (WHERE currency='USD' AND value IS NOT NULL)::int valued_wins,
        COALESCE(SUM(value) FILTER (WHERE currency='USD'),0)::float8 value FROM ${companyFrom}
        WHERE status='won' AND NOT date_held AND company_sales_at >= ${bounds} AND company_sales_at < ${end} GROUP BY 1`,companyParams);
      const sales=new Map(rows.map(row=>[row.date,row]));
      for(const day of activity) {day.company_valued_wins=metrics.company_won_booked_value.state==='unavailable'?null:sales.get(day.date)?.valued_wins||0;day.company_won_deals=metrics.company_won_deals.state==='unavailable'?null:sales.get(day.date)?.wins||0;day.company_won_booked_value=metrics.company_won_booked_value.state==='unavailable'?null:sales.get(day.date)?.value||0;}
    }
    const sequences=sequenceRows.rows.map(row=>({id:row.campaign_id,name:`Sequence ${row.campaign_id.slice(-6)}`,
      metrics:messageMetrics(row,{},complete,false,false)}));
    // Inbox/deal completeness is independent of provider message completeness.
    const completedRuns = [...mailboxes.flatMap(mailbox => ['apollo_messages','gmail_messages'].map(job => runs.find(run => run.job===job && run.scope===mailbox && run.status==='complete' && (job!=='apollo_messages'||run.counts?.all_sequences===true) && run.finished_at && new Date(run.finished_at)<=now))),
      runs.find(run=>run.job==='pipedrive_deals' && run.scope==='company' && run.status==='complete' && run.finished_at && new Date(run.finished_at)<=now)];
    const dates = completedRuns.filter(Boolean).map(run => new Date(run.finished_at));
    const oldest = completedRuns.every(Boolean) ? new Date(Math.min(...dates.map(date => date.getTime()))) : null;
    const freshness = { last_complete_at:oldest?.toISOString() || null,state:oldest ? now-oldest>24*3600000 ? 'stale' : 'fresh' : 'unknown' };
    const senders = mailboxes.map(mailbox => { const values=messageMetrics(messageRows.rows.find(row => row.mailbox_email===mailbox),cohortRows.rows.find(row => row.mailbox_email===mailbox),completeFor(mailbox),inboundFor(mailbox),inboxEventFor(mailbox));
      if(conversionReason || !cohortAcceptedFor(mailbox)) { values.human_reply_rate=unknown(conversionReason||'cohort_reconciliation_missing');values.positive_reply_rate=unknown(conversionReason||'cohort_reconciliation_missing'); }
      return {mailbox,display_name:mailbox,metrics:values}; });
    if(ambiguityRows.rows.length){
      const uncertain=[metrics,...senders.filter(sender=>ambiguityRows.rows.some(row=>row.mailbox_email===sender.mailbox)).map(sender=>sender.metrics)];
      for(const values of uncertain){
        values.human_replies_received={...values.human_replies_received,state:'partial',reason:'reply_links_missing'};
        values.human_reply_rate=unknown('reply_links_missing');values.positive_reply_rate=unknown('reply_links_missing');
      }
    }
    const attention = [];
    if (!complete || !inboundComplete) attention.push({ kind:'reporting_coverage_incomplete',count:mailboxes.filter(m => !completeFor(m)||!inboundFor(m)).length,oldest_at:freshness.last_complete_at,target:'reporting' });
    if (freshness.state==='stale') attention.push({ kind:'reporting_stale',count:1,oldest_at:freshness.last_complete_at,target:'reporting' });
    if (!dealComplete || !salesComplete) attention.push({kind:'deal_coverage_incomplete',count:1,oldest_at:completedRuns.at(-1)?.finished_at?.toISOString()||null,target:'reporting'});
    const unknownSources = Number(total.unknown_source || 0);
    if (unknownSources) attention.push({ kind:'source_links_missing',count:unknownSources,oldest_at:null,target:'reporting' });
    const testMessages=(await pool.query(`SELECT COUNT(*) FILTER (WHERE is_test)::int excluded,
      COUNT(*) FILTER (WHERE NOT is_test AND (test_evidence IS NULL OR test_evidence NOT LIKE 'review:%'))::int unreviewed FROM sdr_message_facts
      WHERE mailbox_email=ANY($1::text[]) AND occurred_at >= ($2::date::timestamp AT TIME ZONE $4) AND occurred_at < ($3::date::timestamp AT TIME ZONE $4)
      AND ($5::text IS NULL OR source_key=$5) AND ($6::text IS NULL OR campaign_id=$6)`,[mailboxes,window.from,window.to,window.timezone,source,sequence])).rows[0];
    const testDeals=includeCompanySales?(await pool.query(`SELECT COUNT(*) FILTER (WHERE is_test)::int excluded,
      COUNT(*) FILTER (WHERE NOT is_test AND (test_evidence IS NULL OR test_evidence NOT LIKE 'review:%'))::int unreviewed FROM ${companyFrom.replace('sdr_reporting_deals','sdr_deal_facts')}
      WHERE status='won' AND company_sales_at >= ${bounds} AND company_sales_at < ${end}`,companyParams)).rows[0]:null;
    const test_data={excluded_messages:testMessages.excluded,excluded_deals:testDeals?.excluded??null,
      unreviewed_messages:testMessages.unreviewed,unreviewed_deals:testDeals?.unreviewed??null};

    const dateReview=includeCompanySales?(await pool.query(`SELECT COUNT(*)::int count,COALESCE(SUM(value) FILTER (WHERE currency='USD'),0)::float8 value FROM ${companyFrom} WHERE status='won' AND date_held AND company_sales_at >= ${bounds} AND company_sales_at < ${end}`,companyParams)).rows[0]:null;
    const companyChecked=companyRun ? new Date(companyRun.finished_at) : null;
    const company_sales=includeCompanySales ? {date_warnings:dateWarnings,date_review:dateReview,reconstructed_dates:companyRun?.counts?.date_adjustments?.length||0,history_from:companyRun?.counts?.from||null,history_to:companyRun?.counts?.to||null,
      freshness:{last_complete_at:companyChecked?.toISOString()||null,state:companyChecked ? now-companyChecked>24*3600000?'stale':'fresh':'unknown'}} : undefined;
    if(dateWarnings.length)for(const key of ['company_won_deals','company_won_booked_value','company_average_won_deal_value'])if(metrics[key].state==='available')metrics[key]={...metrics[key],state:'partial',reason:'crm_sales_dates_need_review'};
    return { ...(company_sales?{company_sales}:{}),test_data,window,observation_cutoff:now.toISOString(),freshness,metrics,senders,sequences,activity,sources:sourceRows.rows.map(row => row.source_key),attention,
      coverage:{ provider_messages:complete ? {value:1,state:'available',numerator:mailboxes.length,denominator:mailboxes.length} : unknown('incomplete_coverage'),
        project_links:rate(Number(total.linked||0),Number(total.messages_completed||0),true),
        reply_links:rate(Number(total.human_replies_received||0)-Number(total.unlinked_replies||0),Number(total.human_replies_received||0),true),
        deal_links:metrics.won_booked_value.state==='unavailable' ? unknown('deal_links_missing') : rate(valued,linked,true) } };
  } catch (error) {
    if (error.code === '42P01' || error.code === '42703') return emptyResponse(window,'reporting_not_initialized');
    throw error;
  }
}
