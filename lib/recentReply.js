// A person who has written back to an SDR mailbox belongs to staff for a while: the
// automation does not start new cold outreach to them on any project. Before this, the
// guards were per project, so someone who asked for a quote on one job got a generic cold
// sequence about another (2026-10-15: 8 queued drafts, some to unanswered quote requests).
// Staff can still send any draft by hand.
export const RECENT_REPLY_DAYS = 180;

async function tableAvailable(db, name) {
  return Boolean((await db.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name);
}

async function columnAvailable(db, table, column) {
  return (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name=$1 AND column_name=$2`, [table, column])).rows.length > 0;
}

// Human replies only: the legacy log marks bounces and auto-replies with a "[...]" prefix,
// and message facts carry an explicit human_reply flag. `email` narrows to one address.
async function replyQuery(db, { days = RECENT_REPLY_DAYS, email = null } = {}) {
  const parts = [];
  if (await tableAvailable(db, 'sdr_inbox_reply_log')) {
    parts.push(`SELECT lower(trim(coalesce(substring(from_addr from '<([^>]+)>'),from_addr))) AS email
      FROM sdr_inbox_reply_log WHERE from_addr NOT LIKE '[%' AND created_at > NOW() - make_interval(days => $1::int)`);
  }
  if (await tableAvailable(db, 'sdr_message_facts')) {
    parts.push(`SELECT lower(trim(prospect_email)) AS email
      FROM sdr_message_facts WHERE direction='in' AND human_reply IS TRUE AND occurred_at > NOW() - make_interval(days => $1::int)`);
  }
  // The current reply pipeline (lib/sdrReplyActions.js) records every reply here, Gmail and
  // Pipedrive-copied alike, even when reporting ingest is off. The sender column exists once
  // migrations/2026-11-03-sdr-reply-exit.sql is applied. Exit triggers recorded outside the
  // inbox (lib/replyExit.js enqueueExitOnly) count too, except an Apollo-only one, which
  // carries no classification: it counts once its exit actually ran live.
  if (await columnAvailable(db, 'sdr_reply_messages', 'from_email')) {
    parts.push(`SELECT lower(trim(m.from_email)) AS email
      FROM sdr_reply_messages m WHERE m.from_email IS NOT NULL AND m.received_at > NOW() - make_interval(days => $1::int)
        AND (m.reply_kind='human' OR (m.reply_kind='exit_signal' AND (m.source<>'apollo' OR EXISTS (SELECT 1 FROM sdr_reply_actions a
          WHERE a.provider_message_id=m.provider_message_id AND a.kind='exit_person' AND a.status='completed' AND a.external_id LIKE 'reply-exit:%'))))`);
  }
  if (await tableAvailable(db, 'sdr_linkedin_links') && await tableAvailable(db, 'sdr_linkedin_events')) {
    parts.push(`SELECT lower(trim(l.verified_email)) AS email
      FROM sdr_linkedin_links l JOIN sdr_linkedin_events e
        ON e.company_id=l.company_id AND e.account_id=l.account_id AND e.person_id=l.person_id
      WHERE l.status='verified' AND l.verified_email IS NOT NULL
        AND e.kind='message_received' AND e.direction IN ('in','unknown')
        AND e.observed_at > NOW() - make_interval(days => $1::int)`);
  }
  if (!parts.length) return [];
  const sql = email ? `SELECT email FROM (${parts.join(' UNION ')}) r WHERE email = $2 LIMIT 1` : parts.join(' UNION ');
  return (await db.query(sql, email ? [days, email] : [days])).rows;
}

export const normalEmail = (email) => String(email || '').trim().toLowerCase();

export async function recentReplyEmails(db, options) {
  return new Set((await replyQuery(db, options)).map((r) => r.email).filter(Boolean));
}

export async function hasRecentReply(db, email, options) {
  const target = normalEmail(email);
  return Boolean(target) && (await replyQuery(db, { ...options, email: target })).length > 0;
}
