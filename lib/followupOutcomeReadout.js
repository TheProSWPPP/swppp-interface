// Weekly outcomes of the tasks the quiet-conversation and bid follow-up clocks create. Read-only.
// A figure the stored data can't support comes back null (shown as unavailable), never estimated.
const TABLES = ["quiet_followup_marks", "bid_followup_marks", "sdr_lead_state", "sdr_conversation_events", "sdr_conversation_coverage",
  "sdr_conversation_messages", "sdr_reply_messages", "sdr_deal_facts", "sdr_job_runs"];

export async function readFollowupOutcomes(pool, { weeks = 8, now = new Date() } = {}) {
  const span = Math.min(Math.max(Number.parseInt(weeks, 10) || 8, 1), 26);
  const { rows: present } = await pool.query(`SELECT t, to_regclass(t) IS NOT NULL AS ok FROM unnest($1::text[]) t`, [TABLES]);
  const has = Object.fromEntries(present.map((r) => [r.t, r.ok]));
  // Monday of the oldest week shown, Chicago time.
  const { rows: [{ since }] } = await pool.query(
    `SELECT (date_trunc('week', $1::timestamptz AT TIME ZONE 'America/Chicago') - make_interval(weeks => $2 - 1)) AT TIME ZONE 'America/Chicago' AS since`,
    [now, span],
  );
  const salesAt = has.sdr_deal_facts && has.sdr_job_runs
    ? (await pool.query(`SELECT max(finished_at) AS at FROM sdr_job_runs WHERE job='pipedrive_deals' AND scope='company' AND status='complete' AND finished_at <= $1`, [now])).rows[0]?.at || null
    : null;
  const activitiesAt = has.sdr_conversation_events && has.sdr_conversation_coverage
    ? (await pool.query(`SELECT max(checked_at) AS at FROM sdr_conversation_coverage WHERE provider='pipedrive' AND scope='activities:all-users'`)).rows[0]?.at || null
    : null;
  const meta = { since: since.toISOString(), weeks: span, salesCheckedAt: salesAt, activitiesCheckedAt: activitiesAt, orders: "unavailable" };
  const sources = [
    has.quiet_followup_marks && `SELECT 'quiet' AS kind, pipedrive_lead_id, activity_id, created_at FROM quiet_followup_marks WHERE outcome = 'created'`,
    has.bid_followup_marks && `SELECT 'bid', pipedrive_lead_id, activity_id, created_at FROM bid_followup_marks WHERE outcome = 'created'`,
  ].filter(Boolean);
  if (!sources.length) return { ...meta, rows: [] };
  const email = has.sdr_lead_state ? "nullif(lower(btrim(s.person_email)), '')" : "NULL::text";
  const status = activitiesAt
    ? `(SELECT CASE WHEN bool_or(e.status = 'completed') THEN 'completed' WHEN bool_or(e.status = 'pending') THEN 'pending' END
         FROM sdr_conversation_events e WHERE e.provider = 'pipedrive' AND e.provider_event_id = t.activity_id)`
    : "NULL";
  const collected = has.sdr_conversation_messages;
  const emailedAfter = collected
    ? `EXISTS (SELECT 1 FROM sdr_conversation_messages c WHERE c.direction = 'out' AND c.occurred_at > t.created_at AND t.email IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.to_addresses || c.cc_addresses) a WHERE position(t.email IN lower(a)) > 0))`
    : "NULL::boolean";
  const autoReply = has.sdr_reply_messages
    ? `AND NOT EXISTS (SELECT 1 FROM sdr_reply_messages r WHERE r.reply_kind IN ('auto','bounce')
         AND (r.provider_message_id = 'rfc822:' || c.internet_message_id OR (c.provider = 'gmail' AND r.mailbox_email = c.account_key AND r.source_message_id = c.provider_message_id)))`
    : "";
  const replyChecks = [
    has.sdr_reply_messages && `EXISTS (SELECT 1 FROM sdr_reply_messages r WHERE r.pipedrive_lead_id = t.pipedrive_lead_id AND r.link_status = 'verified'
         AND r.reply_kind = 'human' AND r.received_at > t.created_at)`,
    collected && `EXISTS (SELECT 1 FROM sdr_conversation_messages c WHERE c.direction = 'in' AND c.occurred_at > t.created_at AND t.email IS NOT NULL
         AND position(t.email IN lower(coalesce(c.from_address, ''))) > 0 ${autoReply})`,
  ].filter(Boolean);
  const replyAfter = replyChecks.length ? `(${replyChecks.join(" OR ")})` : "NULL::boolean";
  // Only deals linked to the lead by verified attribution, as observed by the last complete deal sync.
  const deal = (cond) => salesAt
    ? `EXISTS (SELECT 1 FROM sdr_deal_facts d WHERE d.link_status = 'verified' AND d.pipedrive_lead_id = t.pipedrive_lead_id AND NOT d.is_test AND ${cond})`
    : "NULL::boolean";
  const { rows } = await pool.query(
    `WITH t AS (
       SELECT x.kind, x.pipedrive_lead_id, x.activity_id, x.created_at, ${email} AS email,
              to_char(date_trunc('week', x.created_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM-DD') AS week
         FROM (${sources.join(" UNION ALL ")}) x
         ${has.sdr_lead_state ? "LEFT JOIN sdr_lead_state s ON s.pipedrive_lead_id = x.pipedrive_lead_id" : ""}
        WHERE x.created_at >= $1 AND x.created_at <= $2
     ), o AS (
       SELECT t.kind, t.week, ${status} AS status, ${emailedAfter} AS emailed, ${replyAfter} AS replied,
              ${deal("d.qualified_quote IS TRUE AND d.quote_evidence IS NOT NULL AND d.quote_created_at > t.created_at")} AS quoted,
              ${deal("d.status = 'won' AND d.won_at > t.created_at")} AS won
         FROM t
     )
     SELECT kind, week, COUNT(*)::int AS created,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS done,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS open,
            COUNT(*) FILTER (WHERE status IS NULL)::int AS status_unknown,
            CASE WHEN bool_and(emailed IS NOT NULL) THEN COUNT(*) FILTER (WHERE emailed) END::int AS emailed_after,
            CASE WHEN bool_and(replied IS NOT NULL) THEN COUNT(*) FILTER (WHERE replied) END::int AS reply_after,
            CASE WHEN bool_and(quoted IS NOT NULL) THEN COUNT(*) FILTER (WHERE quoted) END::int AS quote_after,
            CASE WHEN bool_and(won IS NOT NULL) THEN COUNT(*) FILTER (WHERE won) END::int AS won_after
       FROM o GROUP BY kind, week ORDER BY week DESC, kind DESC`,
    [since, now],
  );
  return {
    ...meta,
    rows: rows.map((r) => ({
      kind: r.kind, week: r.week, created: r.created, done: activitiesAt ? r.done : null, open: activitiesAt ? r.open : null,
      statusUnknown: activitiesAt ? r.status_unknown : null, emailedAfter: r.emailed_after, replyAfter: r.reply_after,
      quoteAfter: r.quote_after, wonAfter: r.won_after,
    })),
  };
}
