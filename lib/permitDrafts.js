// Permit email draft-to-queue. PARALLEL to the SDR auto-outreach engine — permit
// operators are NOT Pipedrive-shaped, so they can't ride sdr_drafts/lib/autoOutreach.js.
//
// Flow: email-able operator (permit_operator_email.email present) → render the MSGP
// copy with dynamic {{first_name}}/{{operator}}/{{permit}}/{{expires}}/{{sender_first}}/
// {{signature}} (sig from the assigned mailbox's permit_signature) → permit_drafts queue
// (status 'pending') → a human approves → Apollo enroll into the MSGP sequence from a
// .co cold mailbox. Generation NEVER sends; approve-and-send is the only send path and is
// gated by the master switch + the shared per-mailbox daily cap + a per-operator dedup.
import { dailyCap } from "./sendRamp.js";
import { engineGateError } from "./permitGate.js";
import * as apollo from "./apolloClient.js";

// Apollo contact custom-field ids the MSGP step-1 template merges (same defaults as the
// SDR path in server.js; env-overridable). The step template renders the blue-Georgia
// wrapper + tracking pixel — Apollo HTML-escapes these values, so body stays plain text.
const CF_SUBJECT = process.env.APOLLO_CF_DRAFT_SUBJECT || "6a2adb32a2b9130020474786";
const CF_BODY = process.env.APOLLO_CF_DRAFT_BODY || "6a2adb32bfaa320020f80f97";
const CF_TRACK = process.env.APOLLO_CF_TRACK || "6a32559593e27d000c4ee92f";

const DEFAULT_SIGNATURE = "Regards,\nDerek E. Chinners - Founder\nPro SWPPP, LLC\nwww.ProSWPPP.com";

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

/** Fill {{token}} placeholders from ctx; unknown tokens render empty. */
function renderTemplate(str, ctx) {
  return String(str || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
    ctx[k] != null ? String(ctx[k]) : "",
  );
}

/** HTML → plain text suitable for an Apollo merge field (block tags → newlines). */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First name from a "First Last" / "First M. Last" contact string. */
function firstNameOf(contactName) {
  const t = String(contactName || "").trim().split(/\s+/)[0];
  return t && t.length > 1 ? t : "there";
}

/** Sender's first name: prefer the signature's name line, then display_name, then email. */
function senderFirstFrom(mb) {
  if (mb?.permit_signature) {
    // signature shape: "Regards,\n<Name ...>\n..." — name is on line 2
    const line = String(mb.permit_signature).split("\n")[1] || "";
    const w = line.trim().split(/\s+/)[0];
    if (w && /^[A-Za-z]/.test(w)) return w;
  }
  if (mb?.display_name) {
    const w = mb.display_name.trim().split(/\s+/)[0];
    if (w) return w;
  }
  return String(mb?.email || "").split("@")[0] || "the team";
}

// ── Schema ───────────────────────────────────────────────────────────────────
// Idempotent. Called once from server.js initDB (canonical) so the shared mailbox
// cap counter can rely on permit_sends existing.
export async function ensurePermitDraftSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permit_operator_email (
      operator_key  TEXT PRIMARY KEY,
      operator_name TEXT,
      email         TEXT,
      contact_name  TEXT,
      title         TEXT,
      domain        TEXT,
      apollo_org_id TEXT,
      source        TEXT DEFAULT 'apollo',
      probed_at     TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permit_drafts (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_key        TEXT NOT NULL,
      operator_name       TEXT,
      contact_name        TEXT,
      email               TEXT NOT NULL,
      subject             TEXT NOT NULL,
      body                TEXT NOT NULL,
      apollo_sequence_id  TEXT,
      assigned_mailbox_id UUID REFERENCES sdr_mailboxes(id) ON DELETE SET NULL,
      assigned_email      TEXT,
      status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','sent','rejected')),
      apollo_contact_id   TEXT,
      reject_reason       TEXT,
      error_message       TEXT,
      initiated_by        TEXT NOT NULL DEFAULT 'manual',
      approved_at         TIMESTAMPTZ,
      sent_at             TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_drafts_status ON permit_drafts(status)`);
  // At most one open draft per operator (prevents double-queueing / double-send).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_permit_drafts_open
       ON permit_drafts(operator_key) WHERE status IN ('pending','approved')`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permit_sends (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      draft_id           UUID REFERENCES permit_drafts(id) ON DELETE SET NULL,
      operator_key       TEXT,
      apollo_sequence_id TEXT,
      apollo_contact_id  TEXT,
      mailbox_id         UUID REFERENCES sdr_mailboxes(id) ON DELETE SET NULL,
      status             TEXT NOT NULL DEFAULT 'enrolled'
                           CHECK (status IN ('enrolled','sent','bounced','replied','unsubscribed','failed')),
      sent_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_sends_mailbox ON permit_sends(mailbox_id)`);

  // Automation toggles (all OFF by default; permit_engine_settings.active is the master
  // send switch). auto_find probes picked companies on a schedule up to a daily credit
  // cap, and PAUSES when the unsent backlog (found-but-not-sent) is past backlog_max.
  // auto_send drains 'approved' drafts within each inbox's daily cap.
  await pool.query(`ALTER TABLE permit_engine_settings ADD COLUMN IF NOT EXISTS auto_find_enabled  BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE permit_engine_settings ADD COLUMN IF NOT EXISTS auto_find_daily_cap INT NOT NULL DEFAULT 50`);
  await pool.query(`ALTER TABLE permit_engine_settings ADD COLUMN IF NOT EXISTS auto_find_backlog_max INT NOT NULL DEFAULT 200`);
  await pool.query(`ALTER TABLE permit_engine_settings ADD COLUMN IF NOT EXISTS auto_send_enabled  BOOLEAN NOT NULL DEFAULT FALSE`);

  // NeverBounce verification verdict per found email (valid|invalid|disposable|catchall|unknown).
  // The auto-outreach loop sends 'valid' + 'unknown' (NB couldn't reach the server; the
  // address is not known-bad). 'catchall' and 'invalid' are held back. NULL = not yet
  // verified, treated as sendable for backward compat — verify new finds before scaling.
  await pool.query(`ALTER TABLE permit_operator_email ADD COLUMN IF NOT EXISTS nb_result TEXT`);
  await pool.query(`ALTER TABLE permit_operator_email ADD COLUMN IF NOT EXISTS nb_checked_at TIMESTAMPTZ`);
  // Per-mailbox permit daily cap. NULL = legacy 20%-of-daily_send_limit share.
  await pool.query(`ALTER TABLE sdr_mailboxes ADD COLUMN IF NOT EXISTS permit_daily_cap INT`);
}

// ── Shared per-mailbox budget ─────────────────────────────────────────────────
// Today's sends (America/Chicago) for a mailbox across BOTH cold systems. The permit
// cap is the SAME per-mailbox budget as the SDR construction outreach — not additive.
// server.js's mailboxSentToday counts the same union so both engines agree.
export async function mailboxSentTodayShared(pool, mailboxId) {
  const { rows } = await pool.query(
    `SELECT (
        (SELECT count(*) FROM sdr_sends
          WHERE mailbox_id = $1
            AND (sent_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date)
      + (SELECT count(*) FROM permit_sends
          WHERE mailbox_id = $1
            AND (sent_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date)
     )::int AS n`,
    [mailboxId],
  );
  return rows[0].n;
}

/** Mailboxes eligible to send permit email: permit-enabled + linked to Apollo. */
async function eligibleMailboxes(pool) {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, apollo_mailbox_id, permit_signature, warmup_started_at
       FROM sdr_mailboxes
      WHERE permit_enabled = TRUE AND apollo_mailbox_id IS NOT NULL
      ORDER BY email ASC`,
  );
  return rows;
}

// ── Generation (queue-only, never sends) ──────────────────────────────────────
// Drafts the MSGP copy for email-able operators that are promoted/enriched, not yet
// contacted, and don't already have an open draft. Rotates senders across the enabled
// .co mailboxes. Pure DB + template render — no Apollo calls, no credit cost.
export async function generatePermitDrafts(pool, { cap = 100, operatorKeys = null } = {}) {
  const keys = Array.isArray(operatorKeys) && operatorKeys.length ? operatorKeys : null;
  const limit = keys ? Math.min(500, keys.length) : Math.min(500, Math.max(1, parseInt(cap, 10) || 100));

  const tplRes = await pool.query(
    `SELECT subject, body_html, apollo_sequence_id FROM permit_msgp_template WHERE id = 1`,
  );
  const tpl = tplRes.rows[0];
  if (!tpl || !tpl.subject || !tpl.body_html) {
    throw httpError(400, "MSGP email copy is empty — write it in the Email Copy tab first.");
  }

  const mailboxes = await eligibleMailboxes(pool);

  // Email-able + promoted/enriched + not contacted + no open draft, hottest first.
  const { rows: ops } = await pool.query(
    `SELECT e.operator_key, e.operator_name, e.email, e.contact_name,
            (SELECT f.external_permit_nmbr FROM permit_facilities f
              WHERE f.operator_key = e.operator_key ORDER BY f.score DESC NULLS LAST LIMIT 1) AS permit,
            (SELECT to_char(MIN(f.expiration_date), 'FMMonth FMDD, YYYY') FROM permit_facilities f
              WHERE f.operator_key = e.operator_key) AS expires,
            (SELECT MAX(f.score) FROM permit_facilities f WHERE f.operator_key = e.operator_key) AS best_score
       FROM permit_operator_email e
      WHERE e.email IS NOT NULL AND e.email <> ''
        AND EXISTS (SELECT 1 FROM permit_facilities f
                     WHERE f.operator_key = e.operator_key AND f.status IN ('promoted','enriched'))
        AND NOT EXISTS (SELECT 1 FROM permit_outreach o
                         WHERE o.operator_key = e.operator_key AND o.status IN ('emailed','mailed','replied'))
        AND NOT EXISTS (SELECT 1 FROM permit_drafts d
                         WHERE d.operator_key = e.operator_key AND d.status IN ('pending','approved'))
        ${keys ? "AND e.operator_key = ANY($2::text[])" : ""}
      ORDER BY best_score DESC NULLS LAST
      LIMIT $1`,
    keys ? [limit, keys] : [limit],
  );

  let created = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const mb = mailboxes.length ? mailboxes[i % mailboxes.length] : null; // round-robin
    const ctx = {
      first_name: firstNameOf(op.contact_name),
      operator: op.operator_name || "your facility",
      permit: op.permit || "TXR050000",
      expires: op.expires || "August 13, 2026",
      sender_first: mb ? senderFirstFrom(mb) : "Derek",
      signature: (mb && mb.permit_signature) || DEFAULT_SIGNATURE,
    };
    const subject = renderTemplate(tpl.subject, ctx);
    const body = htmlToText(renderTemplate(tpl.body_html, ctx));
    try {
      const ins = await pool.query(
        `INSERT INTO permit_drafts
           (operator_key, operator_name, contact_name, email, subject, body,
            apollo_sequence_id, assigned_mailbox_id, assigned_email, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [op.operator_key, op.operator_name, op.contact_name, op.email, subject, body,
         tpl.apollo_sequence_id || null, mb?.id || null, mb?.email || null],
      );
      if (ins.rows[0]) created++;
    } catch (e) {
      // unique-open-draft race — skip silently
      if (!/uq_permit_drafts_open/.test(e.message)) throw e;
    }
  }

  return {
    created,
    eligible: ops.length,
    mailboxesEnabled: mailboxes.length,
    sequenceLinked: !!tpl.apollo_sequence_id,
  };
}

// ── Queue reads / edits ───────────────────────────────────────────────────────
export async function listPermitDrafts(pool, { status = "pending", limit = 200 } = {}) {
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
  const params = [lim];
  let where = "";
  if (status && status !== "all") {
    params.unshift(status);
    where = `WHERE status = $1`;
  }
  const { rows } = await pool.query(
    `SELECT id, operator_key, operator_name, contact_name, email, subject, body,
            apollo_sequence_id, assigned_mailbox_id, assigned_email, status,
            reject_reason, error_message, approved_at, sent_at, created_at
       FROM permit_drafts
       ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  // Counts by status for the queue header.
  const c = await pool.query(
    `SELECT status, count(*)::int n FROM permit_drafts GROUP BY status`,
  );
  const counts = { pending: 0, approved: 0, sent: 0, rejected: 0 };
  for (const r of c.rows) counts[r.status] = r.n;
  return { drafts: rows, counts };
}

export async function editPermitDraft(pool, id, { subject, body }) {
  if (typeof subject !== "string" && typeof body !== "string") {
    throw httpError(400, "Provide subject and/or body to edit.");
  }
  const { rows } = await pool.query(
    `UPDATE permit_drafts
        SET subject = COALESCE($2, subject),
            body    = COALESCE($3, body),
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, typeof subject === "string" ? subject : null, typeof body === "string" ? body : null],
  );
  if (!rows[0]) throw httpError(409, "Draft not found or not editable (already sent/rejected).");
  return rows[0];
}

export async function rejectPermitDraft(pool, id, reason) {
  const { rows } = await pool.query(
    `UPDATE permit_drafts
        SET status = 'rejected', reject_reason = $2, updated_at = NOW()
      WHERE id = $1 AND status IN ('pending','approved')
      RETURNING *`,
    [id, reason || null],
  );
  if (!rows[0]) throw httpError(409, "Draft not found or not open.");
  return rows[0];
}

// Mark a draft 'approved' (queued for the auto-sender). Sending still happens via
// approveAndSendPermitDraft — directly ("Send now") or by the auto-send loop.
export async function approvePermitDraft(pool, id) {
  const { rows } = await pool.query(
    `UPDATE permit_drafts SET status = 'approved', approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id],
  );
  if (!rows[0]) throw httpError(409, "Draft not found or not pending.");
  return rows[0];
}

// Manually discard operators (multi-select): mark them probed-with-no-email so they fall
// into the hidden "Discarded" bucket and are never auto-found/re-spent. Reversible by
// deleting the permit_operator_email row. Returns the count discarded.
export async function discardOperators(pool, operatorKeys) {
  const keys = Array.isArray(operatorKeys) ? operatorKeys.filter(Boolean) : [];
  if (!keys.length) throw httpError(400, "No companies selected.");
  const { rowCount } = await pool.query(
    `INSERT INTO permit_operator_email (operator_key, operator_name, email, source)
       SELECT k, (SELECT MIN(operator_name) FROM permit_facilities WHERE operator_key = k), NULL, 'manual-discard'
         FROM unnest($1::text[]) AS k
     ON CONFLICT (operator_key) DO UPDATE
       SET email = NULL, source = 'manual-discard', probed_at = NOW()`,
    [keys],
  );
  return rowCount || 0;
}

// Bulk-approve: all pending drafts, or a specific set of ids. Returns the count.
export async function approveManyDrafts(pool, ids) {
  const hasIds = Array.isArray(ids) && ids.length > 0;
  const { rowCount } = await pool.query(
    `UPDATE permit_drafts SET status = 'approved', approved_at = NOW(), updated_at = NOW()
      WHERE status = 'pending'${hasIds ? " AND id = ANY($1::uuid[])" : ""}`,
    hasIds ? [ids] : [],
  );
  return rowCount || 0;
}

// ── Approve + send (the ONLY send path; human-gated) ──────────────────────────
export async function approveAndSendPermitDraft(pool, id) {
  if (!process.env.APOLLO_API_KEY) throw httpError(503, "Apollo not configured.");

  // Master switch gates SENDING (fail-closed).
  const sRes = await pool.query(`SELECT active FROM permit_engine_settings WHERE id = 1`);
  const gate = engineGateError(sRes.rows[0]);
  if (gate) throw httpError(409, gate, { code: "engine_inactive" });

  const dRes = await pool.query(`SELECT * FROM permit_drafts WHERE id = $1`, [id]);
  const draft = dRes.rows[0];
  if (!draft) throw httpError(404, "Draft not found.");
  if (!["pending", "approved"].includes(draft.status)) {
    throw httpError(409, `Draft is ${draft.status}, cannot send.`);
  }
  if (!draft.apollo_sequence_id) {
    throw httpError(400, "No Apollo sequence linked — create the MSGP sequence in the Email Copy tab first.", { code: "no_sequence" });
  }
  if (!draft.assigned_mailbox_id) {
    throw httpError(400, "No sending mailbox assigned — enable a .co mailbox for permits, then regenerate.", { code: "no_mailbox" });
  }

  // Per-operator dedup: never re-email an operator already contacted.
  const dup = await pool.query(
    `SELECT 1 FROM permit_outreach
      WHERE operator_key = $1 AND status IN ('emailed','mailed','replied') LIMIT 1`,
    [draft.operator_key],
  );
  if (dup.rows[0]) {
    await pool.query(
      `UPDATE permit_drafts SET status = 'rejected',
              reject_reason = 'auto: operator already contacted', updated_at = NOW() WHERE id = $1`,
      [id],
    );
    throw httpError(409, "This company was already contacted — draft auto-rejected.", { code: "already_contacted" });
  }

  // Resolve mailbox + enforce the shared warmup-ramp daily cap.
  const mRes = await pool.query(
    `SELECT id, email, apollo_mailbox_id, permit_enabled, warmup_started_at
       FROM sdr_mailboxes WHERE id = $1`,
    [draft.assigned_mailbox_id],
  );
  const mailbox = mRes.rows[0];
  if (!mailbox?.apollo_mailbox_id) {
    throw httpError(500, "Assigned mailbox isn't linked to Apollo — run SDR → Mailboxes sync.");
  }
  if (!mailbox.permit_enabled) {
    throw httpError(409, `${mailbox.email} is not enabled for permit sending.`, { code: "mailbox_disabled" });
  }

  const cap = dailyCap(mailbox.warmup_started_at);
  const sentToday = await mailboxSentTodayShared(pool, mailbox.id);
  if (sentToday >= cap) {
    throw httpError(429, `Daily cap reached for ${mailbox.email}: ${sentToday}/${cap} sent today (shared with SDR outreach). Try again tomorrow.`, {
      code: "daily_cap_reached", mailbox: mailbox.email, sentToday, cap,
    });
  }

  // Apollo: find-or-create contact → set merge fields → enroll. Order matters — the
  // custom fields must land BEFORE enrollment or Apollo sends raw {{merge}} tags.
  const match = await apollo.matchContactByEmail(draft.email);
  const contactId = match?.id || match?.contact?.id;
  if (!contactId) throw httpError(502, `Apollo could not resolve a contact for ${draft.email}.`);

  await apollo.updateContactCustomFields(contactId, {
    [CF_SUBJECT]: draft.subject,
    [CF_BODY]: draft.body,
    [CF_TRACK]: draft.id,
  });

  const enroll = await apollo.addContactsToSequence(
    draft.apollo_sequence_id,
    [contactId],
    mailbox.apollo_mailbox_id,
    { sequence_active_in_other_campaigns: true },
  );
  const added = (enroll.contacts || []).length;
  if (!added) {
    throw httpError(502, `Apollo did not enroll the contact (skipped: ${JSON.stringify(enroll.skipped_contact_ids || enroll.skipped || {})}).`, {
      code: "enroll_skipped",
    });
  }

  // Apollo enrolled — record send, log outreach, mark draft, start the warmup clock.
  await pool.query(
    `UPDATE permit_drafts SET status = 'sent', sent_at = NOW(), approved_at = NOW(),
            apollo_contact_id = $2, updated_at = NOW() WHERE id = $1`,
    [id, contactId],
  );
  await pool.query(
    `INSERT INTO permit_sends (draft_id, operator_key, apollo_sequence_id, apollo_contact_id, mailbox_id, status)
     VALUES ($1,$2,$3,$4,$5,'enrolled')`,
    [id, draft.operator_key, draft.apollo_sequence_id, contactId, mailbox.id],
  );
  await pool.query(
    `INSERT INTO permit_outreach (operator_key, channel, status, note)
     VALUES ($1, 'email', 'emailed', $2)`,
    [draft.operator_key, `Apollo enroll ${draft.email} via ${mailbox.email}`],
  );
  await pool.query(
    `UPDATE sdr_mailboxes SET warmup_started_at = NOW() WHERE id = $1 AND warmup_started_at IS NULL`,
    [mailbox.id],
  );

  return { id, status: "sent", apollo_contact_id: contactId, enrolled: added };
}

// ── Direct send (auto-outreach, no draft) ─────────────────────────────────────
const FREE_MAIL = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "aol.com", "outlook.com", "icloud.com",
  "me.com", "msn.com", "comcast.net", "sbcglobal.net", "live.com", "ymail.com", "protonmail.com",
]);
const _alnum = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function _sharesToken(a, b) {
  a = _alnum(a); b = _alnum(b);
  if (a.length < 4 || b.length < 4) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  for (let n = Math.min(s.length, 8); n >= 4; n--) {
    for (let i = 0; i + n <= s.length; i++) if (l.includes(s.substr(i, n))) return true;
  }
  return false;
}
// Safety net for auto-send (no human review): flag a corporate email whose domain shares
// nothing with the company name OR its found domain — e.g. Ergon Asphalt -> @louisvuitton.com
// (a contact who moved companies). Free/personal mail is allowed (legit for small operators).
export function looksLikeBadMatch(email, operatorName, companyDomain) {
  const dom = String(email || "").split("@")[1]?.toLowerCase() || "";
  if (!dom) return true;
  if (FREE_MAIL.has(dom)) return false;
  const root = dom.replace(/\.[a-z.]+$/, "");
  const cdRoot = (companyDomain || "").toLowerCase().replace(/\.[a-z.]+$/, "");
  return !(_sharesToken(root, operatorName) || (cdRoot && _sharesToken(root, cdRoot)));
}

// Departments that have nothing to do with a stormwater permit — emailing them wastes the
// touch (and sender reputation): HR / marketing / sales / recruiting / QA / IT / reception.
const WEAK_TITLE = /\b(market|sales|recruit|talent|human resources?|hr|qa|tester|intern|social media|content writer|seo|receptionist|administrative assistant|accounts? (payable|receivable)|bookkeep|help ?desk)/i;
// Decision-maker / compliance-relevant — overrides a weak hit (e.g. "Sales & Operations Mgr").
const STRONG_TITLE = /\b(owner|president|ceo|founder|principal|partner|vice president|vp|general manager|gm|operations|ops|plant manager|environmental|safety|ehs|hse|compliance|facilit|superintendent|estimat|project manager)\b/i;

/**
 * True when the contact's job title is in a department irrelevant to a SWPPP renewal pitch
 * (HR, marketing, sales, QA…) AND carries no decision-maker/compliance signal. The auto-sender
 * skips these so it doesn't email a marketing intern about a stormwater permit. Untitled
 * contacts are NOT weak (we can't tell — let them through).
 */
export function looksLikeWeakContact(title) {
  const t = String(title || "").trim();
  if (!t) return false;
  return WEAK_TITLE.test(t) && !STRONG_TITLE.test(t);
}

/**
 * Render the MSGP copy for one operator and enroll it directly in Apollo — no stored
 * draft. Used by the auto-outreach loop. Gated like the draft path: master switch +
 * per-inbox warmup cap + per-operator dedup. `tpl` = the MSGP template row (cached by caller).
 * Throws httpError with a `code` on any gate so the loop can react.
 */
export async function sendPermitToOperator(pool, op, mailbox, tpl) {
  if (!process.env.APOLLO_API_KEY) throw httpError(503, "Apollo not configured.");
  if (!tpl?.apollo_sequence_id) throw httpError(400, "No Apollo sequence linked.", { code: "no_sequence" });
  if (!mailbox?.apollo_mailbox_id) throw httpError(500, "Mailbox not linked to Apollo.", { code: "no_apollo_mailbox" });

  // Per-operator dedup.
  const dup = await pool.query(
    `SELECT 1 FROM permit_outreach WHERE operator_key = $1 AND status IN ('emailed','mailed','replied') LIMIT 1`,
    [op.operator_key],
  );
  if (dup.rows[0]) throw httpError(409, "Already contacted.", { code: "already_contacted" });

  // Per-inbox warmup cap (shared counter).
  const cap = dailyCap(mailbox.warmup_started_at);
  const sentToday = await mailboxSentTodayShared(pool, mailbox.id);
  if (sentToday >= cap) throw httpError(429, `Daily cap reached for ${mailbox.email}.`, { code: "daily_cap_reached", mailbox: mailbox.email });

  // Render with the assigned sender's signature.
  const ctx = {
    first_name: firstNameOf(op.contact_name),
    operator: op.operator_name || "your facility",
    permit: op.permit || "TXR050000",
    expires: op.expires || "August 13, 2026",
    sender_first: senderFirstFrom(mailbox),
    signature: mailbox.permit_signature || DEFAULT_SIGNATURE,
  };
  const subject = renderTemplate(tpl.subject, ctx);
  const body = htmlToText(renderTemplate(tpl.body_html, ctx));

  // Apollo: match → set merge fields → enroll (fields before enroll, or it sends raw tags).
  const match = await apollo.matchContactByEmail(op.email);
  const contactId = match?.id || match?.contact?.id;
  if (!contactId) throw httpError(502, `Apollo could not resolve a contact for ${op.email}.`);
  await apollo.updateContactCustomFields(contactId, {
    [CF_SUBJECT]: subject,
    [CF_BODY]: body,
    [CF_TRACK]: op.operator_key,
  });
  const enroll = await apollo.addContactsToSequence(
    tpl.apollo_sequence_id, [contactId], mailbox.apollo_mailbox_id, { sequence_active_in_other_campaigns: true },
  );
  if (!(enroll.contacts || []).length) {
    throw httpError(502, "Apollo did not enroll the contact.", { code: "enroll_skipped" });
  }

  await pool.query(
    `INSERT INTO permit_sends (operator_key, apollo_sequence_id, apollo_contact_id, mailbox_id, status)
     VALUES ($1,$2,$3,$4,'enrolled')`,
    [op.operator_key, tpl.apollo_sequence_id, contactId, mailbox.id],
  );
  await pool.query(
    `INSERT INTO permit_outreach (operator_key, channel, status, note)
     VALUES ($1, 'email', 'emailed', $2)`,
    [op.operator_key, `auto: ${op.email} via ${mailbox.email}`],
  );
  await pool.query(
    `UPDATE sdr_mailboxes SET warmup_started_at = NOW() WHERE id = $1 AND warmup_started_at IS NULL`,
    [mailbox.id],
  );
  return { operator_key: op.operator_key, apollo_contact_id: contactId };
}
