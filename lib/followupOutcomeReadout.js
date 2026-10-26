// Weekly outcomes of the tasks the quiet-conversation and bid follow-up clocks create. Read-only.
// A figure the stored data can't support comes back null (shown as unavailable), never estimated.
const TABLES = ["quiet_followup_marks", "bid_followup_marks", "sdr_lead_state", "sdr_conversation_events", "sdr_conversation_coverage",
  "sdr_conversation_messages", "sdr_reply_messages", "sdr_deal_facts", "sdr_job_runs"];

const MARK_TABLES = new Set(["quiet_followup_marks", "bid_followup_marks"]);

// Adds the task status columns to a follow-up marks table.
export async function ensureTaskStateColumns(pool, table) {
  if (!MARK_TABLES.has(table)) throw new Error(`unknown marks table ${table}`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS task_state TEXT, ADD COLUMN IF NOT EXISTS task_checked_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS task_done_at TIMESTAMPTZ`);
}

/**
 * Records whether each task a follow-up job made is still open: one all-users activity read
 * per lead with an open task. A task marked done, or gone from the lead's complete activity
 * list, counts as done. Read-only toward Pipedrive.
 * pd = { listActivitiesPage }; call wraps each provider call (timeouts).
 */
export async function refreshFollowupTaskStates(pool, { pd, table, call = (p) => p, limit = 200, days = 90 } = {}) {
  await ensureTaskStateColumns(pool, table);
  if (!pd?.listActivitiesPage) return { checked: 0, done: 0 };
  const { rows } = await pool.query(
    `SELECT pipedrive_lead_id, activity_id FROM ${table}
      WHERE outcome = 'created' AND activity_id IS NOT NULL AND coalesce(task_state, 'open') = 'open'
        AND created_at > NOW() - make_interval(days => $1)
      ORDER BY task_checked_at NULLS FIRST, created_at DESC LIMIT $2`,
    [days, limit],
  );
  const byLead = new Map();
  for (const r of rows) byLead.set(r.pipedrive_lead_id, [...(byLead.get(r.pipedrive_lead_id) || []), r.activity_id]);
  const out = { checked: 0, done: 0 };
  for (const [leadId, ids] of byLead) {
    let page;
    try {
      page = await call(pd.listActivitiesPage({ leadId, limit: 100 }), "activity list");
    } catch (e) {
      console.warn("[followup-status] activity read failed", leadId, e.message);
      continue;
    }
    const list = page?.data || [];
    // A missing task only counts as gone when the list is complete.
    const complete = !page?.pagination?.more_items_in_collection;
    for (const id of ids) {
      const a = list.find((x) => String(x.id) === String(id));
      if (!a && !complete) continue;
      const done = !a || Boolean(a.done);
      const doneAt = a?.marked_as_done_time ? new Date(`${String(a.marked_as_done_time).replace(" ", "T")}Z`) : null;
      await pool.query(
        `UPDATE ${table} SET task_state=$3, task_checked_at=NOW(),
                task_done_at = CASE WHEN $3 = 'done' THEN coalesce(task_done_at, $4::timestamptz, NOW()) END
          WHERE pipedrive_lead_id=$1 AND activity_id=$2`,
        [leadId, String(id), done ? "done" : "open", doneAt && Number.isFinite(+doneAt) ? doneAt : null],
      );
      out.checked++;
      if (done) out.done++;
    }
  }
  return out;
}

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
  // Columns present: the jobs add task_state as they check their own tasks; the lead sync
  // carries the Pipedrive person's last outgoing mail.
  const { rows: cols } = await pool.query(
    `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
      WHERE table_schema = current_schema() AND (table_name, column_name) IN
        (('quiet_followup_marks','task_state'),('bid_followup_marks','task_state'),('sdr_lead_state','last_outgoing_mail_time'))`,
  );
  const col = new Set(cols.map((r) => r.c));
  const state = (t) => (col.has(`${t}.task_state`) ? "task_state" : "NULL::text");
  const sources = [
    has.quiet_followup_marks && `SELECT 'quiet' AS kind, pipedrive_lead_id, activity_id, created_at, ${state("quiet_followup_marks")} AS task_state FROM quiet_followup_marks WHERE outcome = 'created'`,
    has.bid_followup_marks && `SELECT 'bid', pipedrive_lead_id, activity_id, created_at, ${state("bid_followup_marks")} FROM bid_followup_marks WHERE outcome = 'created'`,
  ].filter(Boolean);
  if (!sources.length) return { ...meta, rows: [] };
  const email = has.sdr_lead_state ? "nullif(lower(btrim(s.person_email)), '')" : "NULL::text";
  const lastOut = col.has("sdr_lead_state.last_outgoing_mail_time") ? "s.last_outgoing_mail_time" : "NULL::timestamptz";
  // Status the job saw on the task itself first, else the collected activity events.
  const tracked = col.has("quiet_followup_marks.task_state") || col.has("bid_followup_marks.task_state");
  const eventStatus = activitiesAt
    ? `(SELECT CASE WHEN bool_or(e.status = 'completed') THEN 'completed' WHEN bool_or(e.status = 'pending') THEN 'pending' END
         FROM sdr_conversation_events e WHERE e.provider = 'pipedrive' AND e.provider_event_id = t.activity_id)`
    : "NULL";
  const status = `coalesce(CASE t.task_state WHEN 'done' THEN 'completed' WHEN 'open' THEN 'pending' END, ${eventStatus})`;
  const statusKnown = Boolean(activitiesAt) || tracked;
  const collected = has.sdr_conversation_messages;
  // Our email after the task: a collected message to the buyer, or the Pipedrive person's last
  // outgoing mail (a rep's own mailbox synced to Pipedrive).
  const emailedAfter = collected
    ? `(coalesce(t.last_out > t.created_at, false) OR EXISTS (SELECT 1 FROM sdr_conversation_messages c WHERE c.direction = 'out' AND c.occurred_at > t.created_at AND t.email IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.to_addresses || c.cc_addresses) a WHERE position(t.email IN lower(a)) > 0)))`
    : `CASE WHEN t.last_out > t.created_at THEN true END`;
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
       SELECT x.kind, x.pipedrive_lead_id, x.activity_id, x.created_at, x.task_state, ${email} AS email, ${has.sdr_lead_state ? lastOut : "NULL::timestamptz"} AS last_out,
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
      kind: r.kind, week: r.week, created: r.created, done: statusKnown ? r.done : null, open: statusKnown ? r.open : null,
      statusUnknown: statusKnown ? r.status_unknown : null, emailedAfter: r.emailed_after, replyAfter: r.reply_after,
      quoteAfter: r.quote_after, wonAfter: r.won_after,
    })),
  };
}
