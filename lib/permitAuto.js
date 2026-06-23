// Permit auto-outreach — ONE loop driven by the master switch (permit_engine_settings.active).
// When on: top up found emails from the pool, then send them directly (no drafts), bounded by
// a single daily cap + each inbox's warmup cap, skipping obviously-wrong matches. Each send is
// fully gated inside sendPermitToOperator, so the loop can't blast or double-send.
import { findEmailsForPromoted } from "./permitEmailFind.js";
import { sendPermitToOperator, looksLikeBadMatch } from "./permitDrafts.js";

const SEND_DELAY_MS = 500;
const FIND_BATCH = 25;

async function loadSettings(pool) {
  const { rows } = await pool.query(`SELECT * FROM permit_engine_settings WHERE id = 1`);
  return rows[0] || {};
}

async function permitSentToday(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM permit_sends
      WHERE (sent_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date`,
  );
  return rows[0].n;
}

// Operators with a found email, not yet contacted/skipped, hottest first + render data.
async function eligibleToSend(pool, limit) {
  const { rows } = await pool.query(
    `SELECT e.operator_key, e.operator_name, e.email, e.contact_name, e.domain,
            (SELECT f.external_permit_nmbr FROM permit_facilities f
              WHERE f.operator_key = e.operator_key ORDER BY f.score DESC NULLS LAST LIMIT 1) AS permit,
            (SELECT to_char(MIN(f.expiration_date), 'FMMonth FMDD, YYYY') FROM permit_facilities f
              WHERE f.operator_key = e.operator_key) AS expires,
            (SELECT MAX(f.score) FROM permit_facilities f WHERE f.operator_key = e.operator_key) AS best_score
       FROM permit_operator_email e
      WHERE e.email IS NOT NULL AND e.email <> ''
        AND NOT EXISTS (SELECT 1 FROM permit_outreach o
                         WHERE o.operator_key = e.operator_key AND o.status IN ('emailed','mailed','replied','skipped'))
      ORDER BY best_score DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows;
}

async function enabledMailboxes(pool) {
  const { rows } = await pool.query(
    `SELECT id, email, apollo_mailbox_id, permit_signature, warmup_started_at
       FROM sdr_mailboxes WHERE permit_enabled = TRUE AND apollo_mailbox_id IS NOT NULL ORDER BY email`,
  );
  return rows;
}

export async function runPermitAutoOutreach(pool) {
  const s = await loadSettings(pool);
  if (!s.active) return { skipped: "off" };

  const dailyCap = s.auto_find_daily_cap ?? 50; // the single "max emails per day"
  const sentToday = await permitSentToday(pool);
  const remaining = dailyCap - sentToday;
  if (remaining <= 0) return { skipped: "daily_cap", sentToday, dailyCap };

  const mailboxes = await enabledMailboxes(pool);
  if (!mailboxes.length) return { skipped: "no_mailbox" };

  const tpl = (await pool.query(
    `SELECT subject, body_html, apollo_sequence_id FROM permit_msgp_template WHERE id = 1`,
  )).rows[0];
  if (!tpl?.apollo_sequence_id || !tpl.subject || !tpl.body_html) return { skipped: "no_template" };

  // Top up: if we have fewer found-unsent than we can send today, probe the pool for more.
  let candidates = await eligibleToSend(pool, remaining + 20);
  if (candidates.length < remaining) {
    try { await findEmailsForPromoted(pool, { cap: Math.min(FIND_BATCH, remaining - candidates.length + 5) }); }
    catch (e) { console.error("[permit-auto] find top-up failed:", e.message); }
    candidates = await eligibleToSend(pool, remaining + 20);
  }

  // Send: round-robin enabled inboxes, respect caps + the bad-match guard + remaining.
  let sent = 0, skippedBad = 0, mi = 0;
  const errors = [];
  const capped = new Set();
  for (const op of candidates) {
    if (sent >= remaining || capped.size >= mailboxes.length) break;
    if (looksLikeBadMatch(op.email, op.operator_name, op.domain)) {
      await pool.query(
        `INSERT INTO permit_outreach (operator_key, channel, status, note) VALUES ($1,'email','skipped',$2)`,
        [op.operator_key, `auto: skipped likely-wrong match (${op.email})`],
      );
      skippedBad++;
      continue;
    }
    let mb = null;
    for (let k = 0; k < mailboxes.length; k++) {
      const cand = mailboxes[(mi + k) % mailboxes.length];
      if (!capped.has(cand.id)) { mb = cand; mi = (mi + k + 1) % mailboxes.length; break; }
    }
    if (!mb) break;
    try {
      await sendPermitToOperator(pool, op, mb, tpl);
      sent++;
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    } catch (e) {
      if (e.code === "daily_cap_reached") capped.add(mb.id);
      else if (e.code !== "already_contacted") errors.push({ op: op.operator_key, code: e.code || null, msg: e.message });
    }
  }
  return { sent, skippedBad, candidates: candidates.length, errors: errors.slice(0, 5) };
}
