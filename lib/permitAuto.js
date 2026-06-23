// Permit automation loops (scheduled from server.js). Both are no-ops unless their
// toggle is on. They orchestrate the already-gated primitives — findEmailsForPromoted
// (capped Apollo reveal) and approveAndSendPermitDraft (master switch + per-inbox cap +
// per-company dedup) — so the loops themselves can't blast or double-send.
import { findEmailsForPromoted } from "./permitEmailFind.js";
import { approveAndSendPermitDraft } from "./permitDrafts.js";

const FIND_BATCH_PER_TICK = 25; // keep a single run short
const SEND_DELAY_MS = 500;

async function loadSettings(pool) {
  const { rows } = await pool.query(`SELECT * FROM permit_engine_settings WHERE id = 1`);
  return rows[0] || {};
}

// Found-but-not-sent operators = the backlog a human still has to approve/send.
async function unsentBacklog(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM permit_operator_email e
      WHERE e.email IS NOT NULL AND e.email <> ''
        AND NOT EXISTS (SELECT 1 FROM permit_outreach o
                         WHERE o.operator_key = e.operator_key
                           AND o.status IN ('emailed','mailed','replied'))`,
  );
  return rows[0].n;
}

async function probedToday(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM permit_operator_email
      WHERE (probed_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date`,
  );
  return rows[0].n;
}

// Auto-find: probe picked companies for emails up to a daily credit cap, and PAUSE when
// the unsent backlog is past backlog_max (don't spend credits piling up unworked leads).
export async function runPermitAutoFind(pool) {
  const s = await loadSettings(pool);
  if (!s.auto_find_enabled) return { skipped: "disabled" };

  const backlogMax = s.auto_find_backlog_max ?? 200;
  const backlog = await unsentBacklog(pool);
  if (backlog >= backlogMax) return { skipped: "backlog_full", backlog, backlogMax };

  const dailyCap = s.auto_find_daily_cap ?? 50;
  const done = await probedToday(pool);
  const remaining = dailyCap - done;
  if (remaining <= 0) return { skipped: "daily_cap", probedToday: done, dailyCap };

  const cap = Math.min(remaining, FIND_BATCH_PER_TICK);
  const r = await findEmailsForPromoted(pool, { cap });
  return { ...r, backlog, remainingToday: remaining - r.probed };
}

// Auto-send: drain 'approved' drafts within each inbox's daily cap. Each send is fully
// gated by approveAndSendPermitDraft; on a cap hit we stop touching that mailbox this tick.
export async function runPermitAutoSend(pool) {
  const s = await loadSettings(pool);
  if (!s.auto_send_enabled) return { skipped: "disabled" };
  if (!s.active) return { skipped: "master_off" };

  const { rows } = await pool.query(
    `SELECT id, assigned_mailbox_id FROM permit_drafts
      WHERE status = 'approved'
      ORDER BY approved_at ASC NULLS FIRST, created_at ASC
      LIMIT 200`,
  );

  let sent = 0;
  const errors = [];
  const cappedMailboxes = new Set();
  for (const d of rows) {
    if (d.assigned_mailbox_id && cappedMailboxes.has(d.assigned_mailbox_id)) continue;
    try {
      await approveAndSendPermitDraft(pool, d.id);
      sent++;
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    } catch (e) {
      if (e.code === "daily_cap_reached" && d.assigned_mailbox_id) {
        cappedMailboxes.add(d.assigned_mailbox_id); // skip this inbox's remaining drafts
      } else {
        errors.push({ id: d.id, code: e.code || null, msg: e.message });
      }
    }
  }
  return { sent, approved: rows.length, errors: errors.slice(0, 5) };
}
