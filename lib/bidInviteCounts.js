// Bid invite emails sent today (Chicago day) from one mailbox. Kept apart from
// lib/bidInviteEngine.js so the cold engines can count them without importing the engine.
// They add to the shared per-mailbox cap (server.js mailboxSentToday, permit mailboxSentTodayShared).
// Zero until migrations/2026-11-03-bid-invite-sequence.sql is applied.
export async function bidInviteSentToday(db, mailboxId) {
  if (!mailboxId) return 0;
  if (!(await db.query("SELECT to_regclass('bid_invite_sends') AS t")).rows[0]?.t) return 0;
  // Claimed and uncertain sends may have gone out, so they count too (from their claim time).
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM bid_invite_sends WHERE mailbox_id=$1 AND status IN ('sent','uncertain','claimed')
    AND (coalesce(sent_at, claimed_at) AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date`, [mailboxId]);
  return rows[0]?.n || 0;
}
