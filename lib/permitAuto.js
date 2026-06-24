// Permit auto-outreach — the daily email sender, driven by the master switch
// (permit_engine_settings.active). When ON: send the MSGP renewal email to email-able
// operators we haven't contacted, via the Apollo MSGP sequence, enrolling from each
// permit-enabled mailbox.
//
// Mailbox priority: permits may use at most PERMIT_SHARE (20%) of each mailbox's daily
// limit so the Pipedrive / SDR construction outreach keeps the other 80%. Every send is
// also gated inside sendPermitToOperator (per-operator dedup + the mailbox's SHARED total
// cap), so the loop can never blast or double-send.
import { sendPermitToOperator, looksLikeBadMatch } from "./permitDrafts.js";

const SEND_DELAY_MS = 500;
const PERMIT_SHARE = 0.2; // permits get 20% of each mailbox/day; Pipedrive/SDR has the rest

async function loadSettings(pool) {
  const { rows } = await pool.query(`SELECT * FROM permit_engine_settings WHERE id = 1`);
  return rows[0] || {};
}

async function permitSentTodayByMailbox(pool, mailboxId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM permit_sends
      WHERE mailbox_id = $1
        AND (sent_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date`,
    [mailboxId],
  );
  return rows[0].n;
}

// Email-able operators not yet contacted/skipped, hottest first, with render fields.
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
    `SELECT id, email, apollo_mailbox_id, permit_signature, warmup_started_at, daily_send_limit
       FROM sdr_mailboxes WHERE permit_enabled = TRUE AND apollo_mailbox_id IS NOT NULL ORDER BY email`,
  );
  return rows;
}

export async function runPermitAutoOutreach(pool) {
  const s = await loadSettings(pool);
  if (!s.active) return { skipped: "off" };

  const mailboxes = await enabledMailboxes(pool);
  if (!mailboxes.length) return { skipped: "no_mailbox" };

  const tpl = (await pool.query(
    `SELECT subject, body_html, apollo_sequence_id FROM permit_msgp_template WHERE id = 1`,
  )).rows[0];
  if (!tpl?.apollo_sequence_id || !tpl.subject || !tpl.body_html) return { skipped: "no_template" };

  // Per-mailbox permit budget = 20% of its daily limit minus permits already sent today.
  let totalBudget = 0;
  for (const mb of mailboxes) {
    const share = Math.max(1, Math.ceil((mb.daily_send_limit || 25) * PERMIT_SHARE));
    const used = await permitSentTodayByMailbox(pool, mb.id);
    mb._left = Math.max(0, share - used);
    totalBudget += mb._left;
  }
  if (totalBudget <= 0) return { skipped: "daily_share_used" };

  const candidates = await eligibleToSend(pool, totalBudget + 20);

  let sent = 0, skippedBad = 0, mi = 0;
  const errors = [];
  for (const op of candidates) {
    if (sent >= totalBudget) break;
    if (looksLikeBadMatch(op.email, op.operator_name, op.domain)) {
      await pool.query(
        `INSERT INTO permit_outreach (operator_key, channel, status, note) VALUES ($1,'email','skipped',$2)`,
        [op.operator_key, `auto: skipped likely-wrong match (${op.email})`],
      );
      skippedBad++;
      continue;
    }
    // next mailbox with permit budget left (round-robin)
    let mb = null;
    for (let k = 0; k < mailboxes.length; k++) {
      const cand = mailboxes[(mi + k) % mailboxes.length];
      if (cand._left > 0) { mb = cand; mi = (mi + k + 1) % mailboxes.length; break; }
    }
    if (!mb) break;
    try {
      await sendPermitToOperator(pool, op, mb, tpl);
      mb._left--; sent++;
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    } catch (e) {
      if (e.code === "daily_cap_reached") mb._left = 0; // mailbox's shared total cap hit
      else if (e.code !== "already_contacted") errors.push({ op: op.operator_key, code: e.code || null, msg: e.message });
    }
  }
  return { sent, skippedBad, candidates: candidates.length, errors: errors.slice(0, 5) };
}
