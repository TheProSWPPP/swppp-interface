// A person who has written back to an SDR mailbox belongs to staff for a while: the
// automation does not start new cold outreach to them on any project. Before this, the
// guards were per project, so someone who asked for a quote on one job got a generic cold
// sequence about another (2026-10-15: 8 queued drafts, some to unanswered quote requests).
// Staff can still send any draft by hand.
export const RECENT_REPLY_DAYS = 180;

async function tableAvailable(db, name) {
  return Boolean((await db.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name);
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
