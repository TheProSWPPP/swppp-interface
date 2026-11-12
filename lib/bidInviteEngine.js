// Bid invite follow-up sequence: short emails to the GC contacts who invited ProSWPPP to bid,
// sent straight from the .co Gmail mailboxes (not Apollo: Apollo cannot anchor steps to each
// bid date, cannot re-enroll a contact, and refuses bid-invite contacts on purpose).
//
// The rules are the ones Derek was shown (client page, Part 1) and live in lib/bidInvitePlan.js
// (timing, windows, grouping, 3-day rule) and lib/bidInviteCopy.js (wording). This file does the
// reads and writes. One pass (runBidInviteSequence):
//   1. ingest: bid invite leads from sdr_lead_state into bid_invite_leads (holds: no email,
//      no bid date, no usable short name, CRM status unknown; archived leads stop);
//   2. reply and bounce sweep over batches that have sent something (before any send);
//   3. leads whose Email 1 is due within a day are grouped per contact into batches
//      (customer check, sender, time zone);
//   4. due steps are sent inside the recipient's send window, under every cap and hold.
// Customers get Email 1 only, then a Pipedrive task for the organization's owner with Email 2
// written out. A reply anywhere stops every bid email to that person (registered exit hook,
// lib/replyExit.js, matched on the replying address). A reply this engine detects (our .co
// thread, or the contact's mail to a rep's .com inbox after our first bid email, same address)
// puts the address on manual follow-up, queues the cross-sequence exit (#125 exit_person) with
// the real reply time and gives the rep a Pipedrive task with a drafted answer.
//
// BID_INVITE_SEQUENCE=off (default) | dry_run | live. dry_run reads only: no claim, no send, no
// Pipedrive write, no verification credit, no local row change. live sends nothing unless
// SDR_REPLY_EXIT_MODE=live too (a reply must take the person out of every sequence): the run is
// held and says why. Pipedrive records are only ever CREATED here (notes, tasks); existing
// records stay behind sdrCrmWriteProtection.
import { randomUUID } from "node:crypto";
import { projectShortName } from "./bidProjectShortName.js";
import { firstName, joinNames, renderBidEmail, replySubject } from "./bidInviteCopy.js";
import { PD_FIELD } from "./sdrDraftGenerator.js";
import {
  DEFAULT_TZ, applyThreeDayRule, buildBatches, e1DueAt, e2DueAt, e3DueAt, inSendWindow, nextWindowSlot, localMidnight,
  normalRecipient, planFollowUp, withinFollowUpWindow, recipientTimezone, companyDomain, stateCode, addDays,
} from "./bidInvitePlan.js";
import { chicagoNow } from "./businessDays.js";
import { looksLikeEmail, canonicalVerdict } from "./emailVerify.js";
import { classifyVerifyResult, writeVerifyCache } from "./emailVerifyRefresh.js";
import { sendableVerdict } from "./autoOutreach.js";
import { dailyCap, mailboxBounceHealth, bounceStepPenalty } from "./sendRamp.js";
import { assertOutreachAllowed } from "./sdrOutreachControls.js";
import { acquireLeadLock } from "./sdrAccess.js";
import { hasRecentReply as defaultHasRecentReply } from "./recentReply.js";
import { registerExitHook, exitHooks, replyExitMode as defaultReplyExitMode, replyExitSchemaReady, enqueueExitOnly } from "./replyExit.js";
import { holdRecipient } from "./sdrReplyActions.js";
import { isSystemSender } from "./systemSenders.js";
import { isAutoReply, taskNote, cleanQuote, properCase, pickBuyerName } from "./quietConversationClock.js";
import { bidInviteSentToday } from "./bidInviteCounts.js";
import { lastOutboundAt } from "./lastOutbound.js";
import { htmlToText } from "./sdrReplyTask.js";

export const BID_INVITE_SOURCE_KEY = "bid_invite";
export const BID_INVITE_MODES = Object.freeze(["off", "dry_run", "live"]);
export const DEFAULT_PER_MAILBOX_DAY = 15;
export const DEFAULT_MIN_BID_DATE = "2026-09-01";
export const MIN_GAP_MINUTES = 4;
export const MAX_SEND_FAILURES = 3;
export const MAX_OWNER_TASK_ATTEMPTS = 3;
export const REPLY_SWEEP_DAYS = 45;
export const REPLY_TASK_WINDOW_HOURS = 48;
export const FALLBACK_TASK_USER_ID = 19499202; // Derek, same fallback as lib/inboxReplyWatch.js
export const REPLY_HOLD_REASON = "Replied to a bid invite follow-up: manual follow-up only";
const OUR_DOMAIN = /@proswppp\.(co|com)\b/i;
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

// ---------- Switches ----------
export function bidInviteMode(env = process.env) {
  const value = String(env.BID_INVITE_SEQUENCE || "").trim().toLowerCase();
  return value === "dry_run" || value === "live" ? value : "off";
}

export function bidInviteConfig(env = process.env) {
  const perDay = Number(env.BID_INVITE_PER_MAILBOX_DAY);
  const floor = String(env.BID_INVITE_MIN_BID_DATE || "").trim();
  return {
    mode: bidInviteMode(env),
    onlyLeads: String(env.BID_INVITE_ONLY_LEADS || "").split(",").map((s) => s.trim()).filter(Boolean),
    perMailboxDay: Number.isFinite(perDay) && perDay >= 0 ? Math.floor(perDay) : DEFAULT_PER_MAILBOX_DAY,
    minBidDate: /^\d{4}-\d{2}-\d{2}$/.test(floor) ? floor : DEFAULT_MIN_BID_DATE,
    replyModel: env.BID_INVITE_REPLY_MODEL || env.QUIET_FOLLOWUP_MODEL || env.GEMINI_MODEL || null,
    companyId: env.SDR_CRM_COMPANY_ID ? String(env.SDR_CRM_COMPANY_ID) : null,
  };
}

// Live mode refuses to start without what the safety checks need. Returns a reason or null.
export function liveRefusal(env = process.env, { gmailConfigured = false } = {}) {
  if (!env.SDR_CRM_COMPANY_ID) return "SDR_CRM_COMPANY_ID is not set";
  if (!env.PIPEDRIVE_API_TOKEN) return "PIPEDRIVE_API_TOKEN is not set";
  if (!gmailConfigured) return "Google OAuth is not configured";
  // With customer suppression off, the customer check answers "not a customer" for everyone.
  if (String(env.SDR_SUPPRESS_CUSTOMERS || "").trim().toLowerCase() === "off") return "SDR_SUPPRESS_CUSTOMERS is off";
  return null;
}

// Live sends need the reply exit live too: Derek was told a reply takes the person out of every
// sequence. Returns the reason live mode sends nothing, or null. dry_run and off are never blocked.
export function liveSendBlock(env = process.env, { mode = bidInviteMode(env), exitMode = defaultReplyExitMode(env) } = {}) {
  if (mode !== "live") return null;
  return exitMode === "live" ? null
    : `SDR_REPLY_EXIT_MODE is ${exitMode}, not live: bid invite emails are held, because a reply must take the person out of every sequence`;
}

// ---------- Small helpers ----------
async function tableAvailable(db, name) {
  return Boolean((await db.query("SELECT to_regclass($1) AS name", [name])).rows[0]?.name);
}
async function columnAvailable(db, table, column) {
  return (await db.query(`SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(quote_ident(current_schema())||'.'||quote_ident($1))
    AND attname=$2 AND NOT attisdropped`, [table, column])).rows.length > 0;
}
export async function bidInviteSchemaReady(db) {
  const { rows } = await db.query(`SELECT to_regclass('bid_invite_leads') IS NOT NULL AND to_regclass('bid_invite_batches') IS NOT NULL
    AND to_regclass('bid_invite_sends') IS NOT NULL AS ready`);
  return rows[0]?.ready === true;
}
const addressOf = (value) => (String(value || "").toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/) || [null])[0];
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const htmlText = (s) => esc(s).replace(/\n/g, "<br>");
const pdTime = (v) => (v ? new Date(`${String(v).replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"}`) : null);
const validDate = (d) => (d && Number.isFinite(+new Date(d)) ? new Date(d) : null);
const maxDate = (...dates) => dates.map(validDate).filter(Boolean).reduce((a, b) => (!a || +b > +a ? b : a), null);
const ymdIn = (date, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date));
const prettyDay = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" }).format(new Date(d));
const ownerIdOf = (v) => (v && typeof v === "object" ? v.id ?? v.value ?? null : v ?? null);
const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };
const stepNumber = (step) => ({ e1: 1, e2: 2, e3: 3 })[step];
// Pipedrive person phones: [{value, primary}] or a plain string. Primary first.
const phoneNumbers = (person) => {
  const list = Array.isArray(person?.phone) ? person.phone : person?.phone ? [person.phone] : [];
  return list.map((p) => (p && typeof p === "object" ? { v: p.value, primary: p.primary === true } : { v: p, primary: false }))
    .filter((p) => p.v).sort((a, b) => Number(b.primary) - Number(a.primary)).map((p) => String(p.v));
};
const leadLocks = async (client, ids) => { for (const id of [...new Set(ids.map(String))].sort()) await acquireLeadLock(client, id); };

// Shared per-mailbox cap: server.js mailboxSentToday adds bid emails to the cold count.
export { bidInviteSentToday };

// ---------- 3-day rule inputs ----------
// Our newest email to the address from any source (lib/lastOutbound.js, shared with the LinkedIn
// prospect lanes): bid emails, Apollo cold (send rows, message facts, engagement events), permit
// sends, the .com mail Pipedrive synced and the person's live Pipedrive "last outgoing mail".
export const lastOutbound = lastOutboundAt;

// The next Apollo step already scheduled for the address (enrolled or sending sequences).
export async function nextScheduledAt(db, { email, now = new Date() } = {}) {
  const address = normalRecipient(email);
  if (!address || !(await tableAvailable(db, "sdr_sends")) || !(await columnAvailable(db, "sdr_sends", "next_send_at"))) return null;
  const { rows } = await db.query(`SELECT min(s.next_send_at) AS t FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id
    WHERE s.status IN ('enrolled','sent') AND lower(trim(d.contact_email_snapshot))=$1 AND s.next_send_at > $2::timestamptz - interval '72 hours'`, [address, now]);
  return validDate(rows[0]?.t);
}

// ---------- Exit hook (lib/replyExit.js contract) ----------
// A reply anywhere (any mailbox, Apollo, Pipedrive-copied, LinkedIn) closes this person's
// bid invite work: open batches become 'replied' and waiting leads never get Email 1.
// Matched on the replying person's address only (the exit's emails, which already include the
// aliases of the same Pipedrive person), never on a lead id or person id the exit carries: a
// colleague who replies on Bob's project exits the colleague, and Bob's batch keeps going.
// Idempotent. The next engine pass prepares the drafted reply for those batches.
export async function bidInviteExit(db, { emails = [], now = new Date(), preview = false } = {}) {
  if (!(await bidInviteSchemaReady(db))) return preview ? { wouldCancel: 0 } : { cancelled: 0 };
  const args = [[...new Set(emails.map(normalRecipient).filter(Boolean))]];
  if (!args[0].length) return preview ? { wouldCancel: 0 } : { cancelled: 0 };
  const batchWhere = `state IN ('active','held') AND contact_email=ANY($1::text[])`;
  const leadWhere = `state IN ('waiting','batched','held') AND contact_email=ANY($1::text[])`;
  if (preview) {
    const b = await db.query(`SELECT count(*)::int n FROM bid_invite_batches WHERE ${batchWhere}`, args);
    const l = await db.query(`SELECT count(*)::int n FROM bid_invite_leads WHERE ${leadWhere}`, args);
    return { wouldCancel: (b.rows[0]?.n || 0) + (l.rows[0]?.n || 0) };
  }
  const b = await db.query(`UPDATE bid_invite_batches SET state='replied', next_step=NULL, stop_reason=coalesce(stop_reason,'reply_exit'),
      reply_detected_at=coalesce(reply_detected_at,$2), reply_source=coalesce(reply_source,'reply_exit'), updated_at=now() WHERE ${batchWhere}`, [...args, now]);
  const l = await db.query(`UPDATE bid_invite_leads SET state='replied', hold_reason='reply_exit', updated_at=now() WHERE ${leadWhere}`, args);
  return { cancelled: (b.rowCount || 0) + (l.rowCount || 0) };
}

// Batches whose synced .com mail counts as a reply (rule 1): an email already went out, and the
// batch is open, or finished (not a customer) with its last email under REPLY_SWEEP_DAYS old. A
// customer's finished batch is left out: customers write to their rep all the time.
const REPLY_WATCHED_BATCH = `((b.state IN ('active','held')) OR (b.state='finished' AND b.customer IS NOT TRUE
  AND EXISTS (SELECT 1 FROM bid_invite_sends s2 WHERE s2.batch_id=b.id AND s2.status='sent' AND s2.sent_at > now() - make_interval(days => ${REPLY_SWEEP_DAYS}))))`;

// For the Pipedrive reply intake (lib/sdrPipedriveReplyIntake.js): each lead of a batch that has
// sent, with the batch contact's address and our first bid email's time. Synced inbound mail on
// such a lead counts only when it is from that same address and arrived after that time.
export async function bidInviteLiveSequenceLeads(db) {
  if (!(await bidInviteSchemaReady(db))) return [];
  return (await db.query(`SELECT DISTINCT l.id AS "leadId", b.contact_email AS email, f.first_sent_at AS since
    FROM bid_invite_batches b CROSS JOIN LATERAL unnest(b.lead_ids) AS l(id)
    JOIN LATERAL (SELECT min(sent_at) AS first_sent_at FROM bid_invite_sends s WHERE s.batch_id=b.id AND s.status='sent') f ON f.first_sent_at IS NOT NULL
    WHERE ${REPLY_WATCHED_BATCH}`)).rows.map((r) => ({ leadId: String(r.leadId), email: r.email, since: new Date(r.since) }));
}

export function registerBidInviteExitHook(pool) {
  return registerExitHook("bid_invites", {
    exit: (input) => bidInviteExit(pool, input),
    preview: (input) => bidInviteExit(pool, { ...input, preview: true }),
    liveSequenceLeads: (db) => bidInviteLiveSequenceLeads(db),
  });
}

// ---------- Mailboxes ----------
async function loadMailboxes(ctx) {
  if (ctx.mailboxes) return ctx.mailboxes;
  const { pool } = ctx;
  const routes = await tableAvailable(pool, "sdr_reply_routes");
  const accounts = await tableAvailable(pool, "sdr_inbox_accounts");
  const signature = await columnAvailable(pool, "sdr_mailboxes", "permit_signature");
  const { rows } = await pool.query(`SELECT m.id, lower(m.email) AS email, m.display_name, m.daily_send_limit, m.warmup_started_at, m.active, m.warmup_status,
      ${signature ? "m.permit_signature" : "NULL::text AS permit_signature"},
      ${accounts ? "(a.mailbox_email IS NOT NULL AND a.refresh_token IS NOT NULL)" : "false"} AS connected,
      ${accounts && await columnAvailable(pool, "sdr_inbox_accounts", "last_error") ? "coalesce(a.last_error,'') LIKE 'needs_reconnect%'" : "false"} AS needs_reconnect,
      ${routes ? "r.pipedrive_user_id::text" : "NULL::text"} AS route_user_id, ${routes ? "(r.mailbox_email IS NOT NULL)" : "false"} AS routed
    FROM sdr_mailboxes m
    ${accounts ? "LEFT JOIN sdr_inbox_accounts a ON lower(a.mailbox_email)=lower(m.email)" : ""}
    ${routes ? "LEFT JOIN sdr_reply_routes r ON lower(r.mailbox_email)=lower(m.email) AND r.active AND r.verified_at IS NOT NULL" : ""}`);
  const health = await mailboxBounceHealth(pool).catch(() => new Map());
  const sentToday = new Map();
  for (const m of rows) sentToday.set(m.id, await bidInviteSentToday(pool, m.id));
  const assigned = new Map();
  if (ctx.schema) {
    for (const r of (await pool.query(`SELECT mailbox_id, count(*)::int n FROM bid_invite_batches WHERE state='active' AND mailbox_id IS NOT NULL GROUP BY 1`)).rows)
      assigned.set(r.mailbox_id, r.n);
  }
  ctx.mailboxes = rows.map((m) => ({
    ...m,
    usable: m.active !== false && !["paused", "disabled"].includes(m.warmup_status) && m.connected === true && m.needs_reconnect !== true,
    // Revoked grant or no Gmail connection: someone has to reconnect it (not a deliberate pause).
    needsReconnect: m.connected !== true || m.needs_reconnect === true,
    penalty: bounceStepPenalty(health.get(m.id)),
    health: health.get(m.id),
    bidToday: sentToday.get(m.id) || 0,
    assigned: assigned.get(m.id) || 0,
  }));
  // Live: a token refresh per usable mailbox (cached by the caller for an hour) finds a revoked
  // grant before any batch is given to that mailbox.
  if (ctx.live && ctx.deps.getToken) {
    for (const m of ctx.mailboxes.filter((x) => x.usable)) {
      try { await ctx.deps.getToken(m.email); }
      catch (e) { if (e?.needsReconnect || Number(e?.status) === 409) await markNeedsReconnect(ctx, m, e); }
    }
  }
  return ctx.mailboxes;
}

// Customer: the organization owner's .co twin (verified reply route). Otherwise, or when the
// owner has no connected mailbox: rotation across connected mailboxes with a verified reply
// route (so replies get forwarded) and a healthy bounce rate, fewest bid emails first.
async function pickSender(ctx, { customer, ownerUserId }) {
  const boxes = await loadMailboxes(ctx);
  if (customer && ownerUserId != null) {
    const own = boxes.find((m) => m.usable && m.routed && String(m.route_user_id) === String(ownerUserId));
    if (own) return { mailbox: own, reason: "customer_owner" };
  }
  const pool = boxes.filter((m) => m.usable && m.routed && m.penalty < 2)
    .sort((a, b) => (a.bidToday + a.assigned) - (b.bidToday + b.assigned) || a.email.localeCompare(b.email));
  if (!pool.length) return null;
  pool[0].assigned++;
  return { mailbox: pool[0], reason: "rotation" };
}

// ---------- 1. Ingest ----------
async function ingest(ctx) {
  const { pool, live, deps, now, out } = ctx;
  const { rows } = await pool.query(`SELECT s.pipedrive_lead_id, s.pipedrive_person_id, s.pipedrive_org_id, s.person_name, s.person_email, s.lead_title,
      to_char(s.bid_date,'YYYY-MM-DD') AS bid_date, s.crm_status, s.email_verify_status, s.email_verified_at, s.email_verified_value
    FROM sdr_lead_state s
    WHERE lower(btrim(coalesce(s.lead_origin,''))) LIKE 'bid invite%'
      AND ($1::text IS NULL OR s.crm_company_id=$1)
      AND (s.bid_date IS NULL OR s.bid_date >= $2::date)`, [deps.companyId || null, deps.minBidDate || DEFAULT_MIN_BID_DATE]);
  const existing = new Map();
  if (ctx.schema) for (const r of (await pool.query(`SELECT *, to_char(bid_date,'YYYY-MM-DD') AS bid_ymd FROM bid_invite_leads`)).rows) existing.set(r.pipedrive_lead_id, r);
  const records = [];
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.pipedrive_lead_id);
    const prev = existing.get(r.pipedrive_lead_id);
    const email = normalRecipient(r.person_email);
    const shortName = projectShortName(r.lead_title);
    // A lead stopped only because it dropped out of the CRM read (and never batched) comes back.
    const revived = prev?.state === "stopped" && !prev.batch_id && ["not_selected", "crm_archived", "crm_missing"].includes(prev.hold_reason);
    let state = revived ? "waiting" : prev?.state || "waiting";
    let hold = null;
    if (r.crm_status === "archived" || r.crm_status === "missing") { if (!["replied", "done"].includes(state)) state = "stopped"; hold = `crm_${r.crm_status}`; }
    else if (["waiting", "held"].includes(state)) {
      if (r.crm_status !== "active") hold = "crm_status_unknown";
      else if (!looksLikeEmail(email)) hold = "no_email";
      else if (!r.bid_date) hold = "no_bid_date";
      else if (!shortName) hold = "short_name_unusable";
      state = hold ? "held" : "waiting";
    }
    if (state === "held") bump(out.holds, hold);
    bump(out.counts, `leads_${state}`);
    records.push({
      leadId: r.pipedrive_lead_id, email: looksLikeEmail(email) ? email : null, personId: r.pipedrive_person_id, orgId: r.pipedrive_org_id,
      personName: r.person_name, title: r.lead_title, bidDate: r.bid_date, shortName, crmStatus: r.crm_status,
      firstSeenAt: prev?.first_seen_at ? new Date(prev.first_seen_at) : now, state, holdReason: hold, batchId: prev?.batch_id || null,
      verify: { email_verify_status: r.email_verify_status, email_verified_at: r.email_verified_at, email_verified_value: r.email_verified_value, person_email: r.person_email },
      changed: !prev || prev.state !== state || prev.hold_reason !== hold || prev.contact_email !== (looksLikeEmail(email) ? email : null)
        || prev.short_name !== shortName || (prev.bid_ymd || null) !== r.bid_date || prev.pipedrive_person_id !== r.pipedrive_person_id,
    });
  }
  // Leads no longer selected (origin changed, deleted, below the date floor) stop.
  const gone = [...existing.values()].filter((r) => !seen.has(r.pipedrive_lead_id) && ["waiting", "held", "batched"].includes(r.state));
  out.counts.leads_gone = gone.length;
  if (live) {
    const changed = records.filter((r) => r.changed);
    if (changed.length) {
      await pool.query(`INSERT INTO bid_invite_leads (pipedrive_lead_id, contact_email, pipedrive_person_id, bid_date, short_name, first_seen_at, state, hold_reason, updated_at)
        SELECT x.lead_id, x.email, x.person_id, x.bid_date, x.short_name, $2::timestamptz, x.state, x.hold_reason, now()
          FROM jsonb_to_recordset($1::jsonb) AS x(lead_id text, email text, person_id text, bid_date date, short_name text, state text, hold_reason text)
        ON CONFLICT (pipedrive_lead_id) DO UPDATE SET contact_email=EXCLUDED.contact_email, pipedrive_person_id=EXCLUDED.pipedrive_person_id,
          bid_date=EXCLUDED.bid_date, short_name=EXCLUDED.short_name, hold_reason=EXCLUDED.hold_reason, updated_at=now(),
          state=CASE WHEN bid_invite_leads.state IN ('replied','done') THEN bid_invite_leads.state
                     WHEN bid_invite_leads.state='batched' AND EXCLUDED.state<>'stopped' THEN 'batched' ELSE EXCLUDED.state END`,
      [JSON.stringify(changed.map((r) => ({ lead_id: r.leadId, email: r.email, person_id: r.personId, bid_date: r.bidDate, short_name: r.shortName, state: r.state, hold_reason: r.holdReason }))), now]);
    }
    if (gone.length) await pool.query(`UPDATE bid_invite_leads SET state='stopped', hold_reason='not_selected', updated_at=now()
      WHERE pipedrive_lead_id=ANY($1::text[]) AND state IN ('waiting','held','batched')`, [gone.map((r) => r.pipedrive_lead_id)]);
  }
  return records;
}

// ---------- 2. Reply and bounce sweep ----------
const deliveryFailure = (from) => /mailer-daemon|postmaster@|mail delivery (subsystem|system)/i.test(String(from || ""));
export const REPLY_CHECKS_PER_RUN = 25;
export const ACTIVE_CHECK_DAYS = 60;
export const PAUSE_DAYS = 7;

// What the contact did after our first bid email. A reply (kind 'human' or 'bounce'):
//   - mail that reached OUR .co mailbox: the batch's Gmail thread (auto-replies and out-of-office
//     skipped), the inbox reply log and the reply ledger for that mailbox;
//   - rule 1: mail to a rep's .com inbox that Pipedrive synced and the Pipedrive reply intake
//     classified as a person writing (reply ledger, source 'pipedrive'), from the batch contact's
//     own address and after our first bid email. A customer's finished batch is left out.
// Only a pause (kind 'pause', the next email waits a week): synced mail the intake has not
// classified (no subject or body here to tell an out-of-office), Pipedrive's "last email
// received" for the person (address unknown), and replies recorded on another channel (their
// own exit closes the batch through the exit hook).
// external=false: database sources only (no Gmail or Pipedrive read).
export async function detectReply(ctx, batch, { external = true } = {}) {
  const { pool, deps } = ctx;
  const since = validDate(batch.first_sent_at);
  if (!since) return null;
  const email = batch.contact_email;
  const mailbox = String(batch.mailbox_email || "").toLowerCase();
  let human = null, bounce = null, pause = null;
  const take = (found) => {
    if (found.kind === "bounce") bounce = bounce || found;
    else if (found.kind === "pause") { if (!pause || +found.at > +pause.at) pause = found; }
    else if (!human || (found.text && !human.text) || (+found.at > +human.at && (!human.text || found.text))) human = found;
  };
  if (external && batch.gmail_thread_id && mailbox && deps.gmail?.getThread && deps.getToken) {
    try {
      const thread = await deps.gmail.getThread(await deps.getToken(mailbox), batch.gmail_thread_id);
      for (const m of thread?.messages || []) {
        const at = validDate(m.receivedAt);
        if (m.lastOutbound || !at || +at <= +since) continue;
        const from = addressOf(m.from);
        if (!from || from === mailbox || OUR_DOMAIN.test(from)) continue;
        if (deliveryFailure(m.from)) { if (!/\bdelay(ed)?\b/i.test(String(m.subject || ""))) take({ kind: "bounce", source: "gmail_thread", at }); continue; }
        if (isSystemSender(from) || isAutoReply({ from: m.from, subject: m.subject, text: m.body })) continue;
        take({ kind: "human", source: "gmail_thread", at, text: m.body || m.snippet || "", subject: m.subject, from: m.from, messageId: m.messageId || null });
      }
    } catch (e) {
      ctx.out.errors.push({ batchId: batch.id, step: "thread_read", error: String(e.message || e).slice(0, 160) });
    }
  }
  const q = async (name, sql, args) => {
    if (!(await tableAvailable(pool, name))) return [];
    return (await pool.query(sql, args)).rows;
  };
  if (mailbox) {
    // The legacy inbox log marks bounces and auto-replies with a "[" prefix.
    for (const r of await q("sdr_inbox_reply_log", `SELECT created_at AS at FROM sdr_inbox_reply_log WHERE from_addr NOT LIKE '[%'
        AND lower(mailbox_email)=$3 AND lower(trim(coalesce(substring(from_addr from '<([^>]+)>'),from_addr)))=$1 AND created_at > $2
        ORDER BY created_at DESC LIMIT 1`, [email, since, mailbox]))
      take({ kind: "human", source: "inbox_log", at: new Date(r.at) });
  }
  const fromColumn = await columnAvailable(pool, "sdr_reply_messages", "from_email");
  // Classified rows only ('auto' never counts). Exit signals are replies seen on other channels.
  // A customer's finished batch never takes a .com reply (rule 1 above).
  // 'replied': closed by the exit hook since; the reply still gets its drafted answer here.
  const comCounts = ["active", "held", "replied"].includes(batch.state) || (batch.state === "finished" && !batch.customer);
  for (const r of await q("sdr_reply_messages", `SELECT provider_message_id, source_message_id, received_at AS at, reply_kind, source,
        lower(mailbox_email) AS mailbox, ${fromColumn ? "lower(trim(from_email))" : "NULL::text"} AS from_email FROM sdr_reply_messages
      WHERE reply_kind IN ('human','bounce','exit_signal') AND received_at > $2
        AND (pipedrive_lead_id=ANY($1::text[])${fromColumn ? " OR lower(trim(from_email))=$3" : ""})
      ORDER BY received_at DESC LIMIT 10`, fromColumn ? [batch.lead_ids, since, email] : [batch.lead_ids, since])) {
    const ours = mailbox && r.mailbox === mailbox && r.source !== "pipedrive";
    // Exit rows this engine wrote itself (source bid_invite) are never a new signal.
    if (r.reply_kind === "exit_signal") { if (r.source !== BID_INVITE_SOURCE_KEY) take({ kind: "pause", source: `exit_signal:${r.source}`, at: new Date(r.at) }); }
    else if (ours) take({ kind: r.reply_kind === "bounce" ? "bounce" : "human", source: "reply_ledger", at: new Date(r.at) });
    else if (r.reply_kind === "human" && r.source === "pipedrive" && r.from_email === email && comCounts)
      take({ kind: "human", source: "pipedrive_reply", at: new Date(r.at), messageId: r.provider_message_id, pipedriveMessageId: r.source_message_id || null });
    else if (r.reply_kind === "human") take({ kind: "pause", source: `reply_ledger:${r.source}`, at: new Date(r.at) });
  }
  if (human && human.source === "pipedrive_reply" && external && !human.text && deps.pd?.getMailMessage && human.pipedriveMessageId) {
    // The intake recorded who wrote and when; the words are read once here for the drafted answer.
    try {
      const m = await deps.pd.getMailMessage(human.pipedriveMessageId, { includeBody: true });
      human.text = htmlToText(m?.body) || m?.snippet || "";
      human.subject = m?.subject || null;
      human.from = m?.from?.[0]?.email_address ? `${m.from[0].name || ""} <${m.from[0].email_address}>` : null;
    } catch (e) { ctx.out.errors.push({ batchId: batch.id, step: "pipedrive_mail_read", error: String(e.message || e).slice(0, 160) }); }
  }
  if (human || bounce || !["active", "held"].includes(batch.state)) return human || bounce;
  // Pause signals: synced mail to a rep's .com inbox from this very address that the intake has
  // not classified yet, and Pipedrive's "last email received".
  for (const r of await q("sdr_conversation_messages", `SELECT occurred_at AS at FROM sdr_conversation_messages WHERE provider='pipedrive' AND direction='in'
      AND lower(btrim(coalesce(substring(from_address from '<([^>]+)>'), from_address, '')))=$1 AND occurred_at > $2 ORDER BY occurred_at DESC LIMIT 1`, [email, since]))
    take({ kind: "pause", source: "pipedrive_mail", at: new Date(r.at) });
  if (external && deps.pd?.getPerson && batch.pipedrive_person_id) {
    try {
      const person = await deps.pd.getPerson(batch.pipedrive_person_id);
      const last = pdTime(person?.last_incoming_mail_time);
      if (last && +last > +since) take({ kind: "pause", source: "pipedrive_person", at: last });
    } catch (e) {
      ctx.out.errors.push({ batchId: batch.id, step: "person_read", error: String(e.message || e).slice(0, 160) });
    }
  }
  return pause;
}

async function sweepReplies(ctx) {
  const { pool, live, out, now } = ctx;
  if (!ctx.schema) return;
  const perRun = ctx.deps.replyChecksPerRun ?? REPLY_CHECKS_PER_RUN;
  const base = `SELECT b.*, lower(m.email) AS mailbox_email, to_char(b.anchor_bid_date,'YYYY-MM-DD') AS anchor_ymd,
      (SELECT min(sent_at) FROM bid_invite_sends s WHERE s.batch_id=b.id AND s.status='sent') AS first_sent_at,
      (SELECT max(coalesce(sent_at, claimed_at)) FROM bid_invite_sends s WHERE s.batch_id=b.id AND s.status IN ('sent','uncertain')) AS last_sent_at
    FROM bid_invite_batches b LEFT JOIN sdr_mailboxes m ON m.id=b.mailbox_id
    WHERE b.reply_detected_at IS NULL`;
  // Open batches with a send in the last 60 days: Gmail thread and Pipedrive read, at most 25 a
  // run, least recently checked first.
  const open = (await pool.query(`${base} AND b.state IN ('active','held') AND EXISTS (SELECT 1 FROM bid_invite_sends s WHERE s.batch_id=b.id
      AND s.status='sent' AND s.sent_at > $1::timestamptz - make_interval(days => $2::int))
    ORDER BY (b.state='active' AND b.next_due_at <= $1::timestamptz + interval '15 minutes') DESC, b.reply_checked_at NULLS FIRST, b.created_at
    LIMIT $3`, [now, ACTIVE_CHECK_DAYS, perRun])).rows;
  // Finished batches whose last email is under 45 days old: database sources only.
  const closed = (await pool.query(`${base} AND b.state IN ('finished','stopped') AND EXISTS (SELECT 1 FROM bid_invite_sends s WHERE s.batch_id=b.id
      AND s.status='sent' AND s.sent_at > $1::timestamptz - make_interval(days => $2::int)) ORDER BY b.created_at`, [now, REPLY_SWEEP_DAYS])).rows;
  for (const [batch, external] of [...open.map((b) => [b, true]), ...closed.map((b) => [b, false])]) {
    const found = await detectReply(ctx, batch, { external });
    if (live && external) await pool.query(`UPDATE bid_invite_batches SET reply_checked_at=$2 WHERE id=$1`, [batch.id, now]);
    if (!found) continue;
    if (found.kind === "bounce") {
      bump(out.counts, live ? "bounced" : "would_mark_bounced");
      if (live) await onBounce(ctx, batch, found);
    } else if (found.kind === "pause") {
      // Not a reply to us: hold the next email back a week after they wrote, nothing else.
      if (+found.at <= +(validDate(batch.last_sent_at) || 0) || batch.state !== "active") continue;
      const until = nextWindowSlot(new Date(+found.at + PAUSE_DAYS * DAY_MS), batch.timezone || DEFAULT_TZ, { jitterKey: batch.id });
      if (batch.next_due_at && +new Date(batch.next_due_at) >= +until) continue;
      bump(out.counts, live ? "paused_contact_wrote" : "would_pause_contact_wrote");
      if (live) await pool.query(`UPDATE bid_invite_batches SET next_due_at=$2, paused_at=$3, pause_reason=$4, updated_at=now() WHERE id=$1 AND state='active'`,
        [batch.id, until, now, found.source]);
    } else {
      bump(out.counts, live ? "replied" : "would_mark_replied");
      if (live) await onReply(ctx, batch, found);
    }
  }
  // Batches closed by a reply elsewhere (exit hook) or whose drafted reply has not been made yet.
  if (live) {
    const pending = (await pool.query(`SELECT b.*, lower(m.email) AS mailbox_email,
        (SELECT min(sent_at) FROM bid_invite_sends s WHERE s.batch_id=b.id AND s.status='sent') AS first_sent_at
      FROM bid_invite_batches b LEFT JOIN sdr_mailboxes m ON m.id=b.mailbox_id
      WHERE b.state='replied' AND b.reply_handled_at IS NULL ORDER BY b.created_at LIMIT $1`, [perRun])).rows;
    for (const batch of pending) {
      // Closed by a reply recorded elsewhere: handled as our reply (hold, exit, drafted answer)
      // only when they wrote in our own thread or, under rule 1, to the rep's .com inbox.
      const found = batch.first_sent_at ? await detectReply(ctx, batch).catch(() => null) : null;
      if (found?.kind === "human") await onReply(ctx, batch, found);
      else await prepareReplyTask(ctx, batch, null);
    }
  }
}

// C2. A reply: every bid batch for this person stops, the address goes on manual follow-up
// (recipient hold), the cross-sequence exit is queued (#125 exit_person: every Apollo
// membership, queued drafts, LinkedIn, other hooks) with the real reply time, and the rep gets
// a Pipedrive task with a drafted answer. Live sends require SDR_REPLY_EXIT_MODE=live
// (liveSendBlock), so the exit is always queued in live.
async function onReply(ctx, batch, reply) {
  const { pool, deps, out } = ctx;
  const messageId = reply.messageId || `<bid-reply-${batch.id}@proswppp.co>`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await leadLocks(client, batch.lead_ids);
    const stopped = await client.query(`UPDATE bid_invite_batches SET state='replied', next_step=NULL, stop_reason=coalesce(stop_reason,'replied'),
        reply_detected_at=coalesce(reply_detected_at,$3), reply_source=coalesce(reply_source,$4), updated_at=now()
      WHERE id=$1 OR (contact_email=$2 AND state IN ('active','held')) RETURNING lead_ids`, [batch.id, batch.contact_email, reply.at, reply.source]);
    const covered = [...new Set(stopped.rows.flatMap((r) => r.lead_ids || []))];
    await client.query(`UPDATE bid_invite_leads SET state='replied', hold_reason='replied', updated_at=now()
      WHERE (pipedrive_lead_id=ANY($1::text[]) OR contact_email=$2) AND state IN ('waiting','batched','held')`, [covered, batch.contact_email]);
    if (await holdRecipient(client, { email: batch.contact_email, messageId, reason: REPLY_HOLD_REASON, contextHash: `bid-invite-reply:${batch.id}`,
      accountId: "bid-invite-sequence", companyId: deps.companyId })) bump(out.counts, "recipient_holds");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    out.errors.push({ batchId: batch.id, step: "reply_stop", error: String(e.message || e).slice(0, 160) });
    return;
  } finally { client.release(); }
  // One exit_person for the person, at the time they actually wrote. A reply the inbox watch or
  // the Pipedrive intake already recorded has its own exit (enqueueExitOnly skips it).
  try {
    const r = await enqueueExitOnly(pool, { messageId, source: BID_INVITE_SOURCE_KEY, mailbox: batch.mailbox_email || "pipedrive", receivedAt: reply.at,
      leadId: batch.named_lead_ids[0] || batch.lead_ids[0] || null, fromEmail: batch.contact_email,
      threadId: reply.source === "gmail_thread" ? batch.gmail_thread_id : null, intent: "bid_invite_reply", mode: (deps.replyExitMode || defaultReplyExitMode)() });
    bump(out.counts, r?.enqueued ? "exit_actions" : `exit_${r?.skipped || "already_recorded"}`, r?.enqueued || 1);
  } catch (e) { out.errors.push({ batchId: batch.id, step: "reply_exit", error: String(e.message || e).slice(0, 160) }); }
  // Stop every other channel now as well (LinkedIn lanes and any other registered exit hook), not
  // only when #125's exit_person drains: this is a confirmed reply to our own mailbox.
  for (const hook of exitHooks()) {
    if (hook.name === "bid_invites") continue;
    try {
      const r = await hook.exit({ emails: [batch.contact_email], leadIds: batch.lead_ids, personIds: batch.pipedrive_person_id ? [String(batch.pipedrive_person_id)] : [],
        contactIds: [], now: reply.at, mode: "live" });
      bump(out.counts, `exit_hook_${hook.name}`, Number(r?.cancelled) || 0);
    } catch (e) { out.errors.push({ batchId: batch.id, step: `exit_hook:${hook.name}`, error: String(e.message || e).slice(0, 160) }); }
  }
  await prepareReplyTask(ctx, { ...batch, state: "replied" }, reply);
}

async function routeUserFor(pool, mailbox) {
  if (!mailbox || !(await tableAvailable(pool, "sdr_reply_routes"))) return null;
  return (await pool.query(`SELECT pipedrive_user_id::text AS id FROM sdr_reply_routes WHERE lower(mailbox_email)=lower($1) AND active AND verified_at IS NOT NULL`, [mailbox])).rows[0]?.id || null;
}

// The drafted answer, once per contact. When the inbox reply watch already made a "Reply
// received" task for one of the leads (within 48h), the draft goes on the lead as a note;
// otherwise it is a task for the rep behind the sending mailbox.
async function prepareReplyTask(ctx, batch, reply) {
  const { pool, deps, out } = ctx;
  const claim = await pool.query(`UPDATE bid_invite_batches SET reply_handled_at=now(), updated_at=now()
    WHERE contact_email=$1 AND state='replied' AND reply_handled_at IS NULL RETURNING id, lead_ids, names, named_lead_ids, reply_task_error`, [batch.contact_email]);
  if (!claim.rowCount) return;
  const ids = claim.rows.map((r) => r.id);
  const names = [...new Set(claim.rows.flatMap((r) => r.names || []))].slice(0, 3);
  const leadIds = [...new Set(claim.rows.flatMap((r) => r.lead_ids || []))];
  const leadId = batch.named_lead_ids?.[0] || claim.rows[0].named_lead_ids[0];
  const lead = (await pool.query(`SELECT person_name FROM sdr_lead_state WHERE pipedrive_lead_id=$1`, [leadId])).rows[0];
  const buyerName = properCase(pickBuyerName(reply?.from, batch.contact_email, lead?.person_name)) || null;
  const sends = (await pool.query(`SELECT subject, body_text, sent_at FROM bid_invite_sends WHERE batch_id=ANY($1::uuid[]) AND status='sent' ORDER BY sent_at`, [ids])).rows;
  // Nothing went out yet (the exit closed it before Email 1): no bid conversation to answer.
  if (!sends.length) return bump(out.counts, "reply_before_first_email");
  // Closed by a reply on another channel or about another job, with nothing from them in our own
  // thread: that reply has its own handling (inbox watch, reply exit). No bid task here.
  if (!reply && batch.reply_source === "reply_exit") {
    await pool.query(`UPDATE bid_invite_batches SET reply_task_activity_id='reply_elsewhere', updated_at=now() WHERE id=ANY($1::uuid[])`, [ids]);
    return bump(out.counts, "reply_elsewhere_no_task");
  }
  const messages = sends.map((s) => ({ from: "ProSWPPP", at: new Date(s.sent_at).toISOString(), subject: s.subject, text: s.body_text }));
  const theirText = reply?.text ? cleanQuote(reply.text) || reply.text : "";
  if (theirText) messages.push({ from: "buyer", at: reply.at.toISOString(), subject: reply.subject || undefined, text: String(theirText).slice(0, 1500) });
  let draft = null, unchecked = !theirText;
  if (theirText && deps.draftReply) {
    try {
      const result = await deps.draftReply({ step: "waiting", buyerName, project: joinNames(names), messages });
      draft = result?.decision === "draft" ? result.body : null;
    } catch (e) { unchecked = true; out.errors.push({ batchId: batch.id, step: "reply_draft", error: String(e.message || e).slice(0, 160) }); }
  }
  const when = reply?.at || batch.reply_detected_at;
  const intro = `<p>${esc(buyerName || batch.contact_email)} wrote back after a bid invite follow-up about ${esc(joinNames(names))}. They are out of every email sequence now, so follow up by hand.</p>`
    + (theirText ? "" : `<p>We saw them write${when ? ` on ${esc(prettyDay(when))}` : ""}, but the message itself could not be read here. Open the conversation before replying.</p>`);
  const note = intro + taskNote({ step: "waiting", draft, unchecked, lastBuyerText: theirText || null, lastBuyerAt: when ? new Date(when) : null, lastBuyerSubject: reply?.subject || null, project: joinNames(names) });
  try {
    // The inbox watch or the Pipedrive intake already queued a "Reply received" task for one of
    // these leads (48h), or for this very message (rule 1 replies to the rep's .com inbox).
    const existingTask = await tableAvailable(pool, "sdr_reply_actions") && (await pool.query(`SELECT 1 FROM sdr_reply_actions WHERE kind='create_task' AND status<>'skipped'
        AND (provider_message_id=$3 OR (payload->>'leadId'=ANY($1::text[]) AND created_at > now() - make_interval(hours => $2::int))) LIMIT 1`,
    [leadIds, REPLY_TASK_WINDOW_HOURS, reply?.messageId || ""])).rowCount > 0;
    let ref;
    // A "Reply received" task already covers it and there is nothing to add: no second note.
    if (existingTask && !theirText) {
      await pool.query(`UPDATE bid_invite_batches SET reply_task_activity_id='existing_reply_task', updated_at=now() WHERE id=ANY($1::uuid[])`, [ids]);
      return bump(out.counts, "reply_task_exists");
    }
    if (existingTask) {
      const n = await deps.pd.addNote({ leadId, content: `<p><b>Prepared reply for the bid invite reply, copy and paste:</b></p>${note}` });
      ref = `note:${n?.id ?? ""}`;
    } else {
      const userId = (await routeUserFor(pool, batch.mailbox_email)) || batch.owner_user_id || FALLBACK_TASK_USER_ID;
      const replyRef = `bid-invite-reply ${ids[0]}`;
      const earlier = claim.rows.some((r) => r.reply_task_error) ? await findOurActivity(deps.pd, leadId, replyRef).catch(() => null) : null;
      const a = earlier || await deps.pd.addActivity({ leadId, personId: batch.pipedrive_person_id || undefined, subject: `Bid invite reply: ${buyerName || batch.contact_email} on ${joinNames(names)}`,
        type: "task", dueDate: chicagoNow(ctx.now).today, userId: Number(userId) || undefined, strictAssignee: false, note: `${note}<p><small>Ref: ${replyRef}</small></p>` });
      ref = String(a?.id ?? "");
    }
    await pool.query(`UPDATE bid_invite_batches SET reply_task_activity_id=$2, reply_task_error=NULL, updated_at=now() WHERE id=ANY($1::uuid[])`, [ids, ref]);
    bump(out.counts, "reply_tasks");
  } catch (e) {
    const status = Number(e?.status);
    // Pipedrive said no for a reason that may pass (rate limit, outage): try again next run.
    const retry = status === 429 || status >= 500;
    await pool.query(`UPDATE bid_invite_batches SET reply_task_error=$2, reply_handled_at=CASE WHEN $3 THEN NULL ELSE reply_handled_at END, updated_at=now()
      WHERE id=ANY($1::uuid[])`, [ids, String(e.message || e).slice(0, 300), retry]);
    out.errors.push({ batchId: batch.id, step: "reply_task", error: String(e.message || e).slice(0, 160) });
  }
}

async function onBounce(ctx, batch, found) {
  const { pool, deps, out } = ctx;
  await pool.query(`UPDATE bid_invite_batches SET state='bounced', next_step=NULL, stop_reason='bounced', reply_detected_at=$2, reply_source=$3, updated_at=now() WHERE id=$1`,
    [batch.id, found.at, found.source]);
  await pool.query(`UPDATE bid_invite_leads SET state='stopped', hold_reason='bounced', updated_at=now()
    WHERE (pipedrive_lead_id=ANY($1::text[]) OR contact_email=$2) AND state IN ('waiting','batched','held')`, [batch.lead_ids, batch.contact_email]);
  // The address is dead: cache it invalid on every lead that uses it (later bids also check for a
  // bounced batch to this address, so a fresh "valid" from the verifier cannot re-send to it).
  const users = (await pool.query(`SELECT pipedrive_lead_id, person_email FROM sdr_lead_state WHERE lower(btrim(person_email))=$1`, [batch.contact_email])).rows;
  for (const r of users) await writeVerifyCache(pool, r.pipedrive_lead_id, { status: "invalid", verifiedValue: r.person_email });
  try {
    await deps.pd.addNote({ leadId: batch.named_lead_ids[0], content: `<p>The bid follow-up email to ${esc(batch.contact_email)} bounced (the mail server sent it back). No more bid follow-ups go to this address. Check the contact's email.</p>` });
  } catch (e) { out.errors.push({ batchId: batch.id, step: "bounce_note", error: String(e.message || e).slice(0, 160) }); }
}

// ---------- 3. Batching ----------
// Leads per contact, each batch taking the leads whose Email 1 falls within a day of the first.
function chainBatches(due) {
  const byEmail = new Map();
  for (const l of due) { if (!byEmail.has(l.email)) byEmail.set(l.email, []); byEmail.get(l.email).push(l); }
  const groups = [];
  for (const list of byEmail.values()) {
    list.sort((a, b) => +a.e1 - +b.e1);
    let current = [];
    for (const l of list) {
      if (current.length && +l.e1 > +current[0].e1 + DAY_MS) { groups.push(current); current = []; }
      current.push(l);
    }
    if (current.length) groups.push(current);
  }
  // Newest bid first: on switch-on the most recent bids (the ones that can still be won) go first.
  const newest = (g) => g.reduce((m, l) => (l.bidDate > m ? l.bidDate : m), "");
  return groups.sort((a, b) => (newest(b) > newest(a) ? 1 : newest(b) < newest(a) ? -1 : +a[0].e1 - +b[0].e1));
}

// Each named project's address from its Pipedrive lead ("Wagoner, OK"), for the city and the
// state's term in the email. Blank, unreadable or slow: the email goes without a city and says
// "SWPPP". The read is optional, so it never holds a send: it gets a short deadline, and after
// one slow read the rest of the run goes without (the sends run one after another).
export const ADDRESS_LOOKUP_MS = 5000;
const LATE = Symbol("late");
export async function projectAddresses(ctx, leadIds) {
  const out = [];
  for (const id of leadIds || []) {
    let record = null;
    // After a slow read, only leads already read this run are used (no new Pipedrive calls).
    if (ctx.deps.pd?.getLead && (!ctx.addressLookupsOff || ctx.leadCache.has(id))) {
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), ctx.deps.addressLookupMs ?? ADDRESS_LOOKUP_MS); });
      try {
        const got = await Promise.race([readOnce(ctx.leadCache, id, () => ctx.deps.pd.getLead(id)), deadline]);
        if (got === LATE) { ctx.leadCache.delete(id); ctx.addressLookupsOff = true; } else record = got;
      } catch { record = null; }
      finally { clearTimeout(timer); }
    }
    out.push(record?.[PD_FIELD.projectAddress] ?? null);
  }
  return out;
}

async function readOnce(cache, key, fn) {
  if (key == null) return null;
  if (!cache.has(key)) cache.set(key, fn().then((v) => v, (e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

async function batchDueLeads(ctx, records) {
  const { pool, live, deps, now, out } = ctx;
  const pilot = new Set(deps.onlyLeads || []);
  const horizon = +now + DAY_MS;
  let due = records.filter((r) => r.state === "waiting" && !r.batchId).map((r) => ({ ...r, e1: e1DueAt({ bidDate: r.bidDate, firstSeenAt: r.firstSeenAt }) }));
  if (live && pilot.size) {
    const outside = due.filter((r) => !pilot.has(r.leadId)).length;
    if (outside) out.counts.not_in_pilot = outside;
    due = due.filter((r) => pilot.has(r.leadId));
  }
  if (!deps.preview || deps.dueWithinDay) due = due.filter((r) => +r.e1 <= horizon);
  const groups = chainBatches(due);
  out.counts.batches_possible = groups.length;
  let cap = deps.preview ? Math.max(1, Number(deps.limit) || 10) : Math.max(1, Number(deps.maxNewBatches) || 25);
  if (live) {
    // Batch no further ahead than about a day of sending: a batch waiting days for a free mailbox
    // would carry a stale customer check, and leads that come due meanwhile join the next one.
    const boxes = (await loadMailboxes(ctx)).filter((m) => m.usable && m.routed && m.penalty < 2).length;
    const backlog = Number((await pool.query(`SELECT count(*) AS n FROM bid_invite_batches WHERE state='active' AND next_step='e1' AND next_due_at <= $1::timestamptz + interval '1 day'`, [now])).rows[0]?.n || 0);
    cap = Math.min(cap, Math.max(0, boxes * (deps.perMailboxDay ?? DEFAULT_PER_MAILBOX_DAY) - backlog));
    if (!cap && groups.length) out.counts.batching_paused_backlog = backlog;
  }
  const created = [];
  for (const group of groups.slice(0, cap)) {
    const leads = [];
    let customerReason = null, ownerUserId = null, org = null, unavailable = false;
    const flags = [];
    for (const l of group) {
      let record = null;
      if (!deps.pd) flags.push("pipedrive_not_read");
      try { record = deps.pd ? await readOnce(ctx.leadCache, l.leadId, () => deps.pd.getLead(l.leadId)) : null; }
      catch (e) {
        if (Number(e?.status) === 404) { record = { is_archived: true }; }
        else { unavailable = true; break; }
      }
      if (record?.is_archived) {
        if (live) await pool.query(`UPDATE bid_invite_leads SET state='stopped', hold_reason='crm_archived', updated_at=now() WHERE pipedrive_lead_id=$1 AND state='waiting'`, [l.leadId]);
        bump(out.holds, "crm_archived");
        continue;
      }
      let customer = null;
      try { customer = deps.isCustomerLead ? await deps.isCustomerLead(l.leadId, { leadRecord: record }) : null; }
      catch { unavailable = true; break; }
      if (customer && !customerReason) customerReason = `${customer.reason || "customer"}${customer.matchedOn ? `:${customer.matchedOn}` : ""}`;
      const orgId = record?.organization_id ?? record?.org_id ?? l.orgId ?? null;
      if (orgId != null && !org && deps.pd) {
        try { org = await readOnce(ctx.orgCache, String(orgId), () => deps.pd.getOrganization(orgId)); }
        catch { flags.push("org_unreadable_time_zone_defaulted"); }
      }
      ownerUserId = ownerUserId ?? ownerIdOf(org?.owner_id) ?? ownerIdOf(record?.owner_id);
      leads.push({ ...l, customer: Boolean(customer) });
    }
    if (unavailable) {
      // Pipedrive unreadable: nothing is batched or sent this pass (the customer check fails closed).
      out.counts.customer_check_unavailable = 1;
      if (live) { ctx.halt = true; break; }
      flags.push("customer_check_unavailable");
    }
    if (!leads.length) continue;
    const [batch] = buildBatches(leads);
    // The company's state; without one, the contact's phone area code; else Central.
    let phones = [];
    if (!stateCode(org?.address_admin_area_level_1) && deps.pd?.getPerson && batch.personId) {
      try { phones = phoneNumbers(await readOnce(ctx.personCache, String(batch.personId), () => deps.pd.getPerson(batch.personId))); }
      catch { flags.push("person_unreadable_time_zone_defaulted"); }
    }
    const zone = recipientTimezone({ state: org?.address_admin_area_level_1, phones });
    const tz = zone.tz;
    if (zone.source === "phone") flags.push("time_zone_from_phone_area_code");
    const id = live ? randomUUID() : null;
    // The batch waits for its latest lead: nobody's Email 1 goes before their own bid + 2 business days.
    const dueAt = leads.map((l) => e1DueAt({ bidDate: l.bidDate, firstSeenAt: l.firstSeenAt, tz })).reduce((a, b) => (+b > +a ? b : a));
    const sendAt = nextWindowSlot(maxDate(dueAt, now), tz, { jitterKey: id || batch.email });
    const sender = await pickSender(ctx, { customer: batch.customer, ownerUserId });
    if (!sender) {
      bump(out.holds, "no_sender_available");
      if (live) continue;
      flags.push("no_sender_available");
    }
    const row = {
      id, contact_email: batch.email, pipedrive_person_id: batch.personId, pipedrive_org_id: org?.id != null ? String(org.id) : null,
      lead_ids: batch.leadIds, named_lead_ids: batch.namedLeadIds, names: batch.names, anchor_bid_date: batch.anchor, anchor_ymd: batch.anchor, customer: batch.customer,
      customer_reason: customerReason, owner_user_id: ownerUserId != null ? String(ownerUserId) : null, mailbox_id: sender?.mailbox.id || null,
      mailbox_email: sender?.mailbox.email || null, sender_reason: sender?.reason || null, timezone: tz, next_step: "e1", next_due_at: sendAt, state: "active",
      leads, flags,
    };
    if (live) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await leadLocks(client, row.lead_ids);
        // A reply (exit hook) may have closed one of these leads since they were read.
        const still = (await client.query(`SELECT pipedrive_lead_id FROM bid_invite_leads WHERE pipedrive_lead_id=ANY($1::text[]) AND state='waiting' AND batch_id IS NULL FOR UPDATE`, [row.lead_ids])).rows;
        if (still.length !== row.lead_ids.length) { await client.query("ROLLBACK"); bump(out.counts, "batch_raced"); continue; }
        await client.query(`INSERT INTO bid_invite_batches (id, contact_email, pipedrive_person_id, pipedrive_org_id, lead_ids, named_lead_ids, names, anchor_bid_date,
            customer, customer_reason, owner_user_id, mailbox_id, sender_reason, timezone, next_step, next_due_at, state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'e1',$15,'active')`,
        [row.id, row.contact_email, row.pipedrive_person_id, row.pipedrive_org_id, row.lead_ids, row.named_lead_ids, row.names, row.anchor_bid_date,
          row.customer, row.customer_reason, row.owner_user_id, row.mailbox_id, row.sender_reason, row.timezone, row.next_due_at]);
        await client.query(`UPDATE bid_invite_leads SET batch_id=$1, state='batched', updated_at=now() WHERE pipedrive_lead_id=ANY($2::text[])`, [row.id, row.lead_ids]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        out.errors.push({ step: "batch_insert", error: String(e.message || e).slice(0, 160) });
        continue;
      } finally { client.release(); }
    }
    bump(out.counts, live ? "batches_created" : "batches_planned");
    if (batch.leadIds.length > 1) bump(out.counts, live ? "grouped_batches_created" : "grouped_batches_planned");
    created.push(row);
  }
  return created;
}

// ---------- 4. Send ----------
// Leads whose contact address changed since the batch was made, or whose bid date moved to today
// or later, leave the batch and go back to waiting: they get their own Email 1 later, to the
// current contact and after the new bid date. Returns the batch as it now stands.
async function reconcileLeads(ctx, batch, leadRows) {
  const { pool, live, now, out } = ctx;
  const today = chicagoNow(now).today;
  const byId = new Map(leadRows.map((r) => [r.pipedrive_lead_id, r]));
  let closed = new Set();
  if (ctx.schema && batch.id) {
    closed = new Set((await pool.query(`SELECT pipedrive_lead_id FROM bid_invite_leads WHERE pipedrive_lead_id=ANY($1::text[]) AND state IN ('stopped','replied')`,
      [batch.lead_ids])).rows.map((r) => r.pipedrive_lead_id));
  }
  const drops = [];
  for (const id of batch.lead_ids) {
    if (closed.has(id)) continue;
    const r = byId.get(id);
    if (!r) drops.push({ id, reason: "lead_missing" });
    else if (normalRecipient(r.person_email) !== batch.contact_email) drops.push({ id, reason: "contact_changed" });
    // Live only: a send is being prepared now. A dry run previews future bids at their own time.
    else if (live && (!r.bid_date || r.bid_date >= today)) drops.push({ id, reason: "bid_date_moved" });
  }
  const dropped = new Set(drops.map((d) => d.id));
  const keep = batch.lead_ids.filter((id) => !closed.has(id) && !dropped.has(id));
  for (const d of drops) bump(out.counts, live ? `lead_left_batch_${d.reason}` : `lead_would_leave_batch_${d.reason}`);
  if (!drops.length && !closed.size) return { batch, closed, keep };
  // Name the projects that are still in it, newest bid first, from their current titles.
  const rebuilt = keep.length ? buildBatches(keep.map((id) => ({ leadId: id, email: batch.contact_email, bidDate: byId.get(id).bid_date,
    shortName: projectShortName(byId.get(id).lead_title) || batch.names[batch.named_lead_ids.indexOf(id)] || "" })).filter((l) => l.shortName))[0] : null;
  const next = rebuilt
    ? { ...batch, lead_ids: [...rebuilt.leadIds, ...batch.lead_ids.filter((id) => closed.has(id))], named_lead_ids: rebuilt.namedLeadIds, names: rebuilt.names }
    : { ...batch, named_lead_ids: [], names: [] };
  if (live && drops.length) {
    await pool.query(`UPDATE bid_invite_leads SET state='waiting', batch_id=NULL, hold_reason=NULL, updated_at=now()
      WHERE pipedrive_lead_id=ANY($1::text[]) AND batch_id=$2 AND state='batched'`, [[...dropped], batch.id]);
    if (rebuilt) await pool.query(`UPDATE bid_invite_batches SET lead_ids=$2, named_lead_ids=$3, names=$4, updated_at=now() WHERE id=$1`,
      [batch.id, next.lead_ids, next.named_lead_ids, next.names]);
  }
  return { batch: next, closed, keep: rebuilt ? rebuilt.leadIds : [] };
}

// Projects the email covers without naming them (more than 3 for one contact): distinct short
// names of the kept leads that are not named. Shown as "and N more", never dropped silently.
function unnamedProjects(batch, leadRows, keep = batch.lead_ids) {
  const byId = new Map(leadRows.map((r) => [r.pipedrive_lead_id, r]));
  const named = new Set((batch.names || []).map((n) => String(n).toLowerCase()));
  const keys = new Set(keep.filter((id) => !(batch.named_lead_ids || []).includes(id))
    .map((id) => String(projectShortName(byId.get(id)?.lead_title) || "").toLowerCase()).filter((k) => k && !named.has(k)));
  return keys.size;
}

// One bid email per company a Chicago day, across mailboxes (Derek, 2026-11-02: "if James
// Construction already got an email today, don't email them"). A company is keyed both by its
// Pipedrive organization and by the recipient's email domain (never a personal mail domain):
// two sends are the same company when they share either, so a batch with an org id and one
// without it for the same domain still count as one company.
const companyKeys = (batch) => [batch.pipedrive_org_id ? `org:${batch.pipedrive_org_id}` : null,
  companyDomain(batch.contact_email) ? `dom:${companyDomain(batch.contact_email)}` : null].filter(Boolean);
// Placeholders: the batch itself (excluded), the moment whose Chicago day counts, org id, domain.
const companySentThatDay = ({ batch, at, org, domain }) => `EXISTS (SELECT 1 FROM bid_invite_sends cs JOIN bid_invite_batches cb ON cb.id=cs.batch_id
  WHERE cs.status IN ('sent','uncertain','claimed') AND cs.batch_id IS DISTINCT FROM ${batch}::uuid
    AND (coalesce(cs.sent_at, cs.claimed_at) AT TIME ZONE 'America/Chicago')::date = (${at}::timestamptz AT TIME ZONE 'America/Chicago')::date
    AND ((${org}::text IS NOT NULL AND cb.pipedrive_org_id=${org}::text)
      OR (${domain}::text IS NOT NULL AND split_part(lower(cs.recipient_email),'@',2)=${domain}::text)))`;
async function companyEmailedToday(ctx, batch) {
  if (!ctx.schema) return false;
  const { rows } = await ctx.pool.query(`SELECT ${companySentThatDay({ batch: "$1", at: "$2", org: "$3", domain: "$4" })} AS hit`,
    [batch.id || null, ctx.now, batch.pipedrive_org_id ? String(batch.pipedrive_org_id) : null, companyDomain(batch.contact_email)]);
  return rows[0]?.hit === true;
}
// The first send window of the next Chicago day, in the recipient's zone.
const nextDaySlot = (now, tz, jitterKey) => nextWindowSlot(localMidnight(addDays(chicagoNow(now).today, 1), "America/Chicago"), tz, { jitterKey });

// Everything a send needs, read-only apart from leads leaving the batch: holds, the bid date
// and 3-day rules, the follow-up window, the company-a-day rule, rendered copy.
async function prepareStep(ctx, batchIn) {
  const { pool, deps, now, live } = ctx;
  const step = batchIn.next_step;
  const flags = [...(batchIn.flags || [])];
  const holds = [];
  const leadRows = (await pool.query(`SELECT pipedrive_lead_id, person_name, person_email, lead_title, to_char(bid_date,'YYYY-MM-DD') AS bid_date,
      email_verify_status, email_verified_at, email_verified_value FROM sdr_lead_state WHERE pipedrive_lead_id=ANY($1::text[])`, [batchIn.lead_ids])).rows;
  const { batch, keep } = await reconcileLeads(ctx, batchIn, leadRows);
  if (!keep.length || !batch.names.length) return { action: "stop", reason: "leads_changed", batch };
  const byId = new Map(leadRows.map((r) => [r.pipedrive_lead_id, r]));
  const names = batch.names;
  const contact = byId.get(batch.named_lead_ids[0]) || {};
  const pilot = deps.onlyLeads || [];
  if (pilot.length && batch.lead_ids.some((id) => !pilot.includes(id))) { if (live) return { action: "defer", reason: "not_in_pilot", batch }; flags.push("not_in_pilot"); }
  if (deps.companyId && await tableAvailable(pool, "sdr_outreach_controls")) {
    for (const id of batch.lead_ids) {
      try { await assertOutreachAllowed(pool, { companyId: deps.companyId, leadId: id, channel: "email", recipientEmail: batch.contact_email }, { action: "bid_invite_send" }); }
      catch (e) { if (e?.code === "outreach_held") { holds.push("outreach_held"); break; } throw e; }
    }
  }
  if (await (deps.hasRecentReply || defaultHasRecentReply)(pool, batch.contact_email)) holds.push("recent_reply");
  if (ctx.schema && (await pool.query(`SELECT 1 FROM bid_invite_batches WHERE contact_email=$1 AND state='bounced' LIMIT 1`, [batch.contact_email])).rowCount)
    holds.push("address_bounced");
  if (live && holds.length) return { action: "hold", reason: holds[0], batch };
  let verified = true;
  if (step === "e1") {
    verified = leadRows.some((r) => keep.includes(r.pipedrive_lead_id) && normalRecipient(r.person_email) === batch.contact_email && sendableVerdict(r, r.person_email, +now));
    if (!verified) flags.push(live ? "verify_before_send" : "would_verify");
  }
  let base = maxDate(batch.next_due_at, now);
  // A grouped lead never goes out before its own bid date + 2 business days.
  if (step === "e1") {
    const seen = new Map();
    if (ctx.schema && batch.id) for (const r of (await pool.query(`SELECT pipedrive_lead_id, first_seen_at FROM bid_invite_leads WHERE pipedrive_lead_id=ANY($1::text[])`, [keep])).rows)
      seen.set(r.pipedrive_lead_id, r.first_seen_at);
    for (const l of batch.leads || []) if (!seen.has(String(l.leadId))) seen.set(String(l.leadId), l.firstSeenAt);
    const own = keep.map((id) => e1DueAt({ bidDate: byId.get(id).bid_date, firstSeenAt: seen.get(id) || now, tz: batch.timezone })).filter(Boolean);
    const required = maxDate(...own);
    if (required && +required > +base) {
      if (live) return { action: "push", reason: "bid_date", sendAt: nextWindowSlot(required, batch.timezone, { jitterKey: batch.id }), batch };
      base = required;
    }
  }
  let sendAt = base;
  try {
    const last = await lastOutbound(pool, { email: batch.contact_email, personId: batch.pipedrive_person_id, pd: deps.pd });
    const next = await nextScheduledAt(pool, { email: batch.contact_email, now });
    const pushed = applyThreeDayRule(base, { lastOutboundAt: last, nextScheduledAt: next });
    if (+pushed > +base) {
      sendAt = nextWindowSlot(pushed, batch.timezone, { jitterKey: batch.id || batch.contact_email });
      if (live) return { action: "push", reason: "three_day_rule", sendAt, batch };
      flags.push("pushed_by_three_day_rule");
    }
  } catch (e) {
    if (live) return { action: "defer", reason: "history_unavailable", error: e, batch };
    flags.push("history_unavailable");
  }
  if (!live || !inSendWindow(now, batch.timezone)) sendAt = nextWindowSlot(sendAt, batch.timezone, { jitterKey: batch.id || batch.contact_email });
  const tz = batch.timezone || DEFAULT_TZ;
  // Derek's window: Email 2 by bid + 56 days, Email 3 by bid + 70. Past it, that email is skipped.
  if (step !== "e1" && batch.anchor_ymd && !withinFollowUpWindow({ anchor: batch.anchor_ymd, step, at: sendAt, tz })) {
    if (live) return { action: "skip", reason: "follow_up_window_passed", batch, step };
    flags.push(`${step}_skipped_bid_too_old`);
  }
  if (step === "e1" && !batch.customer && batch.anchor_ymd) {
    for (const skipped of planFollowUp({ anchor: batch.anchor_ymd, after: "e1", sentAt: sendAt, tz }).skipped) flags.push(`${skipped}_skipped_bid_too_old`);
  }
  // One bid email per company a Chicago day.
  if (await companyEmailedToday(ctx, batch)) {
    if (live) return { action: "push", reason: "company_daily_limit", sendAt: nextDaySlot(now, tz, batch.id), batch };
    flags.push("company_emailed_today");
  }
  if (!live) {
    // Dry run: a second sample to the same company on the same day would wait a day.
    const day = chicagoNow(sendAt).today;
    const keys = companyKeys(batch).map((k) => `${day}|${k}`);
    if (keys.some((k) => ctx.companiesThisRun.has(k))) flags.push("company_emailed_that_day");
    else for (const k of keys) ctx.companiesThisRun.set(k, true);
  }
  const mailbox = (await loadMailboxes(ctx)).find((m) => m.id === batch.mailbox_id) || null;
  const more = unnamedProjects(batch, leadRows, keep);
  const addresses = await projectAddresses(ctx, batch.named_lead_ids);
  const rendered = renderBidEmail({ step, firstName: firstName(contact.person_name), names, more, addresses, signature: mailbox?.permit_signature || null });
  const subject = step === "e1" ? rendered.subject : replySubject(batch.first_subject || names[0]);
  flags.push(...rendered.flags);
  if (batch.customer) flags.push("customer_owner_task_after_email_1");
  return { action: inSendWindow(now, batch.timezone) ? "send" : "wait", batch, keep, step, names, more, contact, leadRows, mailbox, verified, sendAt, subject, rendered, flags, holds };
}

// A follow-up that can no longer go inside Derek's window is skipped: Email 2 hands over to
// Email 3 (2 weeks after the last email, if that still makes bid + 70), otherwise the bid ends.
async function skipFollowUp(ctx, batch, step) {
  const { pool, now, out } = ctx;
  const tz = batch.timezone || DEFAULT_TZ;
  bump(out.counts, `skipped_${step}_bid_too_old`);
  if (step === "e2") {
    const last = (await pool.query(`SELECT max(sent_at) AS t FROM bid_invite_sends WHERE batch_id=$1 AND status='sent'`, [batch.id])).rows[0]?.t;
    const e3 = nextWindowSlot(maxDate(e3DueAt({ anchor: batch.anchor_ymd, e2SentAt: last || now, tz }), now), tz, { jitterKey: batch.id });
    if (withinFollowUpWindow({ anchor: batch.anchor_ymd, step: "e3", at: e3, tz })) {
      await pool.query(`UPDATE bid_invite_batches SET next_step='e3', next_due_at=$2, updated_at=now() WHERE id=$1 AND state='active' AND next_step='e2'`, [batch.id, e3]);
      return;
    }
    bump(out.counts, "skipped_e3_bid_too_old");
  }
  await pool.query(`UPDATE bid_invite_batches SET state='finished', next_step=NULL, next_due_at=NULL, stop_reason='follow_up_window_passed', updated_at=now()
    WHERE id=$1 AND state='active'`, [batch.id]);
  await pool.query(`UPDATE bid_invite_leads SET state='done', updated_at=now() WHERE batch_id=$1 AND state='batched'`, [batch.id]);
}

function sampleOf(batch, p) {
  return {
    batchId: batch.id || null, step: batch.next_step, from: batch.mailbox_email || p.mailbox?.email || null, to: batch.contact_email,
    subject: p.subject, bodyText: p.rendered.bodyText, sendAt: p.sendAt ? new Date(p.sendAt).toISOString() : null, timezone: batch.timezone,
    customer: batch.customer, senderReason: batch.sender_reason,
    leads: batch.lead_ids.map((id) => {
      const r = p.leadRows.find((x) => x.pipedrive_lead_id === id) || {};
      const i = batch.named_lead_ids.indexOf(id);
      return { id, title: r.lead_title || null, shortName: i >= 0 ? batch.names[i] : projectShortName(r.lead_title), bidDate: r.bid_date || null, named: i >= 0 };
    }),
    more: p.more || 0,
    flags: [...new Set(p.flags)], holds: p.holds,
  };
}

const fromHeader = (m) => (m.display_name && /^[\x20-\x7e]+$/.test(m.display_name) && !/["<>]/.test(m.display_name) ? `"${m.display_name}" <${m.email}>` : m.email);

async function shareCapOk(ctx, mailbox) {
  const { pool, deps, now } = ctx;
  const bidToday = await bidInviteSentToday(pool, mailbox.id);
  if (bidToday >= (deps.perMailboxDay ?? DEFAULT_PER_MAILBOX_DAY)) return "mailbox_bid_cap";
  const shared = (deps.mailboxSentToday ? await deps.mailboxSentToday(mailbox.id) : bidToday);
  const cap = dailyCap(mailbox.warmup_started_at, { target: mailbox.daily_send_limit ?? undefined, health: mailbox.health, now: +now });
  if (shared >= cap) return "mailbox_shared_cap";
  const last = (await pool.query(`SELECT max(sent_at) AS t FROM bid_invite_sends WHERE mailbox_id=$1 AND status IN ('sent','uncertain','claimed')`, [mailbox.id])).rows[0]?.t;
  const gap = last ? +now - +new Date(last) : Infinity;
  if (gap >= 0 && gap < MIN_GAP_MINUTES * 60000) return "mailbox_gap";
  return null;
}

// The claim is one statement that only inserts while everything checked above still holds: the
// batch is active on this step, every kept lead is still batched to this address (and its CRM
// contact is still this address), and no hold or reply for the address has landed since.
// Returns { rowCount } (0 = a claim for this step already exists) or { refused: true }.
async function claimSend(ctx, { sendId, batch, keep, mailbox, subject, bodyText, rfc }) {
  const { pool, deps, now } = ctx;
  const guards = [
    `EXISTS (SELECT 1 FROM bid_invite_batches b WHERE b.id=$2 AND b.state='active' AND b.next_step=$3 AND b.contact_email=$5)`,
    `NOT EXISTS (SELECT 1 FROM bid_invite_leads l WHERE l.pipedrive_lead_id=ANY($10::text[])
      AND (l.batch_id IS DISTINCT FROM $2 OR l.state<>'batched' OR l.contact_email IS DISTINCT FROM $5))`,
    `NOT EXISTS (SELECT 1 FROM sdr_lead_state s WHERE s.pipedrive_lead_id=ANY($10::text[]) AND lower(btrim(coalesce(s.person_email,''))) IS DISTINCT FROM $5)`,
  ];
  const args = [sendId, batch.id, batch.next_step, mailbox.id, batch.contact_email, subject, bodyText, rfc, now, keep.map(String)];
  if (deps.companyId && await tableAvailable(pool, "sdr_outreach_controls")) {
    args.push(String(deps.companyId));
    guards.push(`NOT EXISTS (SELECT 1 FROM sdr_outreach_controls c WHERE c.company_id=$${args.length} AND c.status='active'
      AND ((c.scope_kind='recipient' AND lower(trim(c.scope_id))=$5 AND (c.lead_id IS NULL OR c.lead_id=ANY($10::text[])))
        OR (c.scope_kind='lead' AND c.scope_id=ANY($10::text[])) OR (c.lead_id=ANY($10::text[]) AND c.scope_kind IN ('lead','recipient','channel'))))`);
  }
  // One bid email per company a Chicago day, checked again inside the claim.
  args.push(batch.pipedrive_org_id ? String(batch.pipedrive_org_id) : null, companyDomain(batch.contact_email));
  guards.push(`NOT ${companySentThatDay({ batch: "$2", at: "$9", org: `$${args.length - 1}`, domain: `$${args.length}` })}`);
  if (await columnAvailable(pool, "sdr_reply_messages", "from_email")) {
    guards.push(`NOT EXISTS (SELECT 1 FROM sdr_reply_messages m WHERE lower(trim(m.from_email))=$5 AND m.reply_kind IN ('human','exit_signal')
      AND m.received_at > $9::timestamptz - interval '180 days')`);
  }
  const inserted = await pool.query(`INSERT INTO bid_invite_sends (id, batch_id, step, mailbox_id, recipient_email, subject, body_text, rfc_message_id, status, claimed_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,'claimed',$9 WHERE ${guards.join(" AND ")}
    ON CONFLICT (batch_id, step) DO NOTHING RETURNING id`, args);
  if (inserted.rowCount) return { rowCount: inserted.rowCount };
  const existing = (await pool.query(`SELECT 1 FROM bid_invite_sends WHERE batch_id=$1 AND step=$2`, [batch.id, batch.next_step])).rowCount;
  return existing ? { rowCount: 0 } : { refused: true };
}

// A revoked or expired Gmail grant (invalid_grant): the mailbox needs reconnecting. Recorded on
// sdr_inbox_accounts.last_error (cleared when someone reconnects it) and shown on /status.
async function markNeedsReconnect(ctx, mailbox, error) {
  mailbox.usable = false;
  mailbox.needsReconnect = true;
  bump(ctx.out.counts, "mailbox_needs_reconnect");
  if (!ctx.live || !(await tableAvailable(ctx.pool, "sdr_inbox_accounts"))) return;
  await ctx.pool.query(`UPDATE sdr_inbox_accounts SET last_error=$2 WHERE lower(mailbox_email)=$1`,
    [mailbox.email, `needs_reconnect: ${String(error?.oauthError || error?.message || "token refresh failed").slice(0, 120)}`]).catch(() => {});
}

// The batch's mailbox cannot send. Email 1 not sent yet: give it another sender. Email 2/3 must
// come from the same mailbox (same thread), so the batch is held.
async function strandBatch(ctx, batch) {
  const { pool, out } = ctx;
  const sent = (await pool.query(`SELECT 1 FROM bid_invite_sends WHERE batch_id=$1 LIMIT 1`, [batch.id])).rowCount > 0;
  if (batch.next_step === "e1" && !sent) {
    const sender = await pickSender(ctx, { customer: batch.customer, ownerUserId: batch.owner_user_id });
    if (sender) {
      await pool.query(`UPDATE bid_invite_batches SET mailbox_id=$2, sender_reason=$3, updated_at=now() WHERE id=$1 AND state='active'`, [batch.id, sender.mailbox.id, sender.reason]);
      return bump(out.counts, "moved_to_another_mailbox");
    }
    return bump(out.counts, "deferred_no_sender_available");
  }
  await holdBatch(pool, batch.id, "sender_unavailable");
  return bump(out.holds, "sender_unavailable");
}

// Before sending. A batch held as sender_unavailable whose mailbox can send again is released.
// A batch on a mailbox that needs reconnecting (revoked grant, disconnected) with a step due within
// a day moves (Email 1) or is held (Email 2/3). A paused or disabled mailbox is left alone: its
// batches wait.
async function rehomeStrandedBatches(ctx) {
  const { pool, now, out } = ctx;
  const boxes = await loadMailboxes(ctx);
  const good = boxes.filter((m) => m.usable).map((m) => m.id);
  if (good.length) {
    const released = await pool.query(`UPDATE bid_invite_batches SET state='active', hold_reason=NULL, updated_at=now()
      WHERE state='held' AND hold_reason='sender_unavailable' AND next_step IS NOT NULL AND mailbox_id=ANY($1::uuid[])`, [good]);
    if (released.rowCount) bump(out.counts, "released_sender_back", released.rowCount);
  }
  const bad = boxes.filter((m) => m.needsReconnect).map((m) => m.id);
  if (!bad.length) return;
  const rows = (await pool.query(`SELECT * FROM bid_invite_batches WHERE state='active' AND next_step IS NOT NULL AND mailbox_id=ANY($1::uuid[])
    AND next_due_at <= $2::timestamptz + interval '1 day' ORDER BY anchor_bid_date DESC`, [bad, now])).rows;
  for (const b of rows) await strandBatch(ctx, b);
}

async function holdBatch(pool, id, reason) {
  await pool.query(`UPDATE bid_invite_batches SET state='held', hold_reason=$2, updated_at=now() WHERE id=$1 AND state='active'`, [id, reason]);
}

function ownerTaskNote({ sentText, sentAt, mailbox, draftStep, draftText, became = false }) {
  const p = (s) => `<p>${s}</p>`;
  return [
    p(became
      ? "This contact is now a customer, so the automatic bid follow-ups stopped. The next follow-up is yours. Nothing else has been sent."
      : "This contact is a customer, so the automatic bid follow-ups stopped after Email 1. The next follow-up is yours. Nothing else has been sent."),
    p("If it still makes sense, send it from your own mailbox (or reply in the thread), edit it as you like, then mark this task done. Skip it if you already spoke to them."),
    sentText ? p(`<b>Last email sent</b> (${esc(prettyDay(sentAt))}, from ${esc(mailbox)}):`) + p(`<i>${htmlText(sentText)}</i>`) : "",
    p("________________________________"),
    p(`<b>READY TO SEND</b> (Email ${stepNumber(draftStep)}, edit as you like):`),
    p(htmlText(draftText)),
  ].join("");
}

// Our own task on a lead, found by the reference line in its note (read only).
async function findOurActivity(pd, leadId, ref) {
  if (!pd?.listActivities) return null;
  const list = await pd.listActivities(leadId, { limit: 100 });
  return (list || []).find((a) => String(a?.note || "").includes(ref)) || null;
}

// Customers: one email, then a Pipedrive task for the owner with the next email written out.
async function createOwnerTask(ctx, batchId) {
  const { pool, deps, out } = ctx;
  const b = (await pool.query(`SELECT b.*, lower(m.email) AS mailbox_email, to_char(b.owner_task_due,'YYYY-MM-DD') AS owner_due_ymd
    FROM bid_invite_batches b LEFT JOIN sdr_mailboxes m ON m.id=b.mailbox_id WHERE b.id=$1`, [batchId])).rows[0];
  if (!b || b.owner_task_activity_id) return;
  const sends = (await pool.query(`SELECT step, body_text, sent_at FROM bid_invite_sends WHERE batch_id=$1 AND status='sent' ORDER BY sent_at`, [batchId])).rows;
  const last = sends[sends.length - 1];
  const draftStep = sends.some((s) => s.step === "e2") ? "e3" : "e2";
  const contact = (await pool.query(`SELECT person_name FROM sdr_lead_state WHERE pipedrive_lead_id=$1`, [b.named_lead_ids[0]])).rows[0];
  const titles = (await pool.query(`SELECT pipedrive_lead_id, lead_title FROM sdr_lead_state WHERE pipedrive_lead_id=ANY($1::text[])`, [b.lead_ids])).rows;
  const draft = renderBidEmail({ step: draftStep, firstName: firstName(contact?.person_name), names: b.names, more: unnamedProjects(b, titles),
    addresses: await projectAddresses(ctx, b.named_lead_ids), signature: null });
  const ref = `bid-invite-task ${batchId}`;
  try {
    // A retry after a failed or timed-out POST first looks for the task it may have created.
    const found = b.owner_task_attempts > 0 ? await findOurActivity(deps.pd, b.named_lead_ids[0], ref) : null;
    const a = found || await deps.pd.addActivity({
      leadId: b.named_lead_ids[0], personId: b.pipedrive_person_id || undefined, subject: `Bid follow-up (customer): ${joinNames(b.names)}`, type: "task",
      dueDate: b.owner_due_ymd || chicagoNow(ctx.now).today, userId: b.owner_user_id ? Number(b.owner_user_id) : undefined,
      strictAssignee: Boolean(b.owner_user_id),
      note: ownerTaskNote({ sentText: last?.body_text, sentAt: last?.sent_at, mailbox: b.mailbox_email, draftStep, draftText: draft.bodyText, became: b.stop_reason === "became_customer" })
        + `<p><small>Ref: ${ref}</small></p>`,
    });
    await pool.query(`UPDATE bid_invite_batches SET owner_task_activity_id=$2, owner_task_error=NULL, owner_task_attempts=owner_task_attempts+1, updated_at=now() WHERE id=$1`, [batchId, String(a?.id ?? "")]);
    bump(out.counts, "owner_tasks");
  } catch (e) {
    await pool.query(`UPDATE bid_invite_batches SET owner_task_error=$2, owner_task_attempts=owner_task_attempts+1, updated_at=now() WHERE id=$1`, [batchId, String(e.message || e).slice(0, 300)]);
    out.errors.push({ batchId, step: "owner_task", error: String(e.message || e).slice(0, 160) });
  }
}

async function retryOwnerTasks(ctx) {
  const ids = (await ctx.pool.query(`SELECT id FROM bid_invite_batches WHERE customer IS TRUE AND state IN ('finished','stopped') AND owner_task_activity_id IS NULL
    AND owner_task_due IS NOT NULL AND owner_task_attempts < $1 ORDER BY updated_at`, [MAX_OWNER_TASK_ATTEMPTS])).rows;
  for (const { id } of ids) await createOwnerTask(ctx, id);
}

async function recordSent(ctx, batch, p, { sendId, rfc, result, mailbox }) {
  const { pool, deps, out, now } = ctx;
  const threadId = result?.threadId || batch.gmail_thread_id || null;
  await pool.query(`UPDATE bid_invite_sends SET status='sent', gmail_message_id=$2, gmail_thread_id=$3, sent_at=$4 WHERE id=$1`, [sendId, result?.id || null, threadId, now]);
  const step = batch.next_step;
  const tz = batch.timezone || DEFAULT_TZ;
  let next = null, due = null, state = "active", ownerDue = null;
  if (step === "e1" && batch.customer) { state = "finished"; ownerDue = ymdIn(e2DueAt({ anchor: batch.anchor_ymd, e1SentAt: now, tz }), tz); }
  else if (step === "e1" || step === "e2") {
    // Inside Derek's window only (Email 2 by bid + 56, Email 3 by bid + 70); otherwise the bid ends.
    const plan = planFollowUp({ anchor: batch.anchor_ymd, after: step, sentAt: now, tz, jitterKey: batch.id });
    for (const skipped of plan.skipped) bump(out.counts, `skipped_${skipped}_bid_too_old`);
    if (plan.step) { next = plan.step; due = plan.dueAt; } else state = "finished";
  } else state = "finished";
  await pool.query(`UPDATE bid_invite_batches SET next_step=$2, next_due_at=$3, state=$4, owner_task_due=coalesce($5::date, owner_task_due),
      gmail_thread_id=coalesce(gmail_thread_id,$6), first_rfc_message_id=coalesce(first_rfc_message_id,$7), first_subject=coalesce(first_subject,$8),
      send_failures=0, updated_at=now() WHERE id=$1`, [batch.id, next, due, state, ownerDue, threadId, step === "e1" ? rfc : null, step === "e1" ? p.subject : null]);
  if (state === "finished") await pool.query(`UPDATE bid_invite_leads SET state='done', updated_at=now() WHERE batch_id=$1 AND state='batched'`, [batch.id]);
  bump(out.counts, `sent_${step}`);
  // Bookkeeping. A failure here never resends: the claim row already says 'sent'.
  const safe = async (label, fn) => { try { await fn(); } catch (e) { out.errors.push({ batchId: batch.id, step: label, error: String(e.message || e).slice(0, 160) }); } };
  await safe("message_fact", async () => {
    if (!(await tableAvailable(pool, "sdr_message_facts")) || !result?.id) return;
    await pool.query(`INSERT INTO sdr_message_facts (provider, provider_message_id, direction, mailbox_email, prospect_email, thread_id, source_key, sequence_step,
        occurred_at, provider_status, pipedrive_lead_id, link_status, link_evidence)
      VALUES ('gmail',$1,'out',$2,$3,$4,$5,$6,$7,'completed',$8,'verified',$9) ON CONFLICT (provider, provider_message_id) DO NOTHING`,
    [result.id, mailbox.email, batch.contact_email, threadId, BID_INVITE_SOURCE_KEY, stepNumber(step), now, batch.named_lead_ids[0], `bid_invite_send:${sendId}`]);
  });
  await safe("outreach_log", async () => {
    if (!(await tableAvailable(pool, "sdr_outreach_log"))) return;
    await pool.query(`INSERT INTO sdr_outreach_log (pipedrive_lead_id, source, sent_at, sender_name, sender_email, subject, external_ref, updated_at)
      SELECT id, 'interface', $2, $3, $4, $5, $6, now() FROM unnest($1::text[]) AS id
      ON CONFLICT (pipedrive_lead_id, source) DO UPDATE SET sent_at=GREATEST(sdr_outreach_log.sent_at, EXCLUDED.sent_at),
        sender_name=EXCLUDED.sender_name, sender_email=EXCLUDED.sender_email, subject=EXCLUDED.subject, external_ref=EXCLUDED.external_ref, updated_at=now()`,
    [batch.lead_ids, now, mailbox.display_name || null, mailbox.email, p.subject, `bid_invite_send:${sendId}`]);
  });
  for (const leadId of batch.lead_ids) {
    await safe("lead_note", () => deps.pd.addNote({ leadId, content: `<p>Bid follow-up email ${stepNumber(step)} sent from ${esc(mailbox.email)} to ${esc(batch.contact_email)}:</p><p><b>Subject:</b> ${esc(p.subject)}</p><p>${htmlText(p.rendered.bodyText)}</p>` }));
  }
  if (state === "finished" && batch.customer) await createOwnerTask(ctx, batch.id);
}

async function sendOne(ctx, batchIn) {
  const { pool, deps, out, now } = ctx;
  const p = await prepareStep(ctx, batchIn);
  const batch = p.batch || batchIn;
  if (p.action === "stop") {
    await pool.query(`UPDATE bid_invite_batches SET state='stopped', stop_reason=$2, next_step=NULL, updated_at=now() WHERE id=$1`, [batch.id, p.reason]);
    return bump(out.counts, `stopped_${p.reason}`);
  }
  if (p.action === "hold") { await holdBatch(pool, batch.id, p.reason); return bump(out.holds, p.reason); }
  if (p.action === "push") {
    await pool.query(`UPDATE bid_invite_batches SET next_due_at=$2, updated_at=now() WHERE id=$1`, [batch.id, p.sendAt]);
    return bump(out.counts, `pushed_${p.reason}`);
  }
  if (p.action === "defer") return bump(out.counts, `deferred_${p.reason}`);
  if (p.action === "skip") return skipFollowUp(ctx, batch, p.step);
  if (p.action === "wait") return bump(out.counts, "waiting_for_window");
  const mailbox = p.mailbox;
  // Paused or disabled on purpose: the batch just waits. Revoked or disconnected: move or hold it.
  if (mailbox && !mailbox.usable && !mailbox.needsReconnect) return bump(out.counts, "deferred_mailbox_paused");
  if (!mailbox || !mailbox.usable) return strandBatch(ctx, batch);
  if (ctx.usedThisRun.has(mailbox.id)) return bump(out.counts, "deferred_mailbox_gap");
  const capped = await shareCapOk(ctx, mailbox);
  if (capped) return bump(out.counts, `deferred_${capped}`);
  // Customer re-check before Email 2/3: a contact who became a customer gets the owner task instead.
  if (batch.next_step !== "e1") {
    try {
      for (const id of batch.lead_ids) {
        const c = await deps.isCustomerLead(id);
        if (c) {
          await pool.query(`UPDATE bid_invite_batches SET state='stopped', stop_reason='became_customer', customer=true, customer_reason=$2, next_step=NULL,
            owner_task_due=$3::date, updated_at=now() WHERE id=$1`, [batch.id, `${c.reason || "customer"}`, chicagoNow(now).today]);
          await createOwnerTask(ctx, batch.id);
          return bump(out.counts, "stopped_became_customer");
        }
      }
    } catch { return bump(out.counts, "deferred_customer_check_unavailable"); }
  }
  if (batch.next_step === "e1" && !p.verified) {
    const v = await deps.verifyEmail(batch.contact_email);
    const kind = classifyVerifyResult(v);
    if (kind === "skip") return bump(out.counts, "deferred_verify_unavailable");
    const status = kind === "hard_fail" ? "invalid" : canonicalVerdict(v?.status);
    for (const r of p.leadRows.filter((x) => normalRecipient(x.person_email) === batch.contact_email))
      await writeVerifyCache(pool, r.pipedrive_lead_id, { status, verifiedValue: r.person_email });
    bump(out.counts, "verified");
    if (kind === "hard_fail") { await holdBatch(pool, batch.id, "email_invalid"); return bump(out.holds, "email_invalid"); }
  }
  let token;
  try { token = await deps.getToken(mailbox.email); }
  catch (e) {
    if (Number(e?.status) === 409 || e?.needsReconnect) { await markNeedsReconnect(ctx, mailbox, e); return strandBatch(ctx, batch); }
    return bump(out.counts, "deferred_token_unavailable");
  }
  const sendId = randomUUID();
  const rfc = `<bid-${sendId}@proswppp.co>`;
  const claim = await claimSend(ctx, { sendId, batch, keep: p.keep, mailbox, subject: p.subject, bodyText: p.rendered.bodyText, rfc });
  if (claim.refused) {
    // Something changed between the checks and the claim (a reply, a hold, a new contact, the batch
    // moved on): nothing is sent; the next run sees the new state.
    return bump(out.counts, "claim_refused_state_changed");
  }
  if (!claim.rowCount) {
    // A claim already exists for this step and the batch did not move on: an earlier run died
    // between the claim and its bookkeeping. It may have gone out, so a person checks it.
    await holdBatch(pool, batch.id, "send_uncertain");
    bump(out.holds, "send_uncertain");
    return bump(out.counts, "already_claimed");
  }
  ctx.usedThisRun.add(mailbox.id);
  const thread = batch.next_step === "e1" ? {} : { threadId: batch.gmail_thread_id || undefined, inReplyTo: batch.first_rfc_message_id || undefined, references: batch.first_rfc_message_id || undefined };
  let result;
  try {
    result = await deps.gmail.sendMail(token, { from: fromHeader(mailbox), to: batch.contact_email, subject: p.subject, bodyText: p.rendered.bodyText, bodyHtml: p.rendered.bodyHtml, messageId: rfc, ...thread });
  } catch (e) {
    const status = Number(e?.status);
    if (status >= 400 && status < 500) {
      // Gmail refused it before accepting: nothing was sent. Release the claim and retry next run.
      await pool.query(`DELETE FROM bid_invite_sends WHERE id=$1 AND status='claimed'`, [sendId]);
      const r = await pool.query(`UPDATE bid_invite_batches SET send_failures=send_failures+1, updated_at=now() WHERE id=$1 RETURNING send_failures`, [batch.id]);
      if ((r.rows[0]?.send_failures || 0) >= MAX_SEND_FAILURES) { await holdBatch(pool, batch.id, "send_failed"); bump(out.holds, "send_failed"); }
      out.errors.push({ batchId: batch.id, step: "send", error: String(e.message || e).slice(0, 160) });
      return bump(out.counts, "send_failed");
    }
    // Timeout, network or server error: it may have gone out. Never resend on its own.
    await pool.query(`UPDATE bid_invite_sends SET status='uncertain', error=$2 WHERE id=$1`, [sendId, String(e.message || e).slice(0, 300)]);
    await holdBatch(pool, batch.id, "send_uncertain");
    bump(out.holds, "send_uncertain");
    out.errors.push({ batchId: batch.id, step: "send", error: String(e.message || e).slice(0, 160) });
    return;
  }
  await recordSent(ctx, batch, p, { sendId, rfc, result, mailbox });
}

async function sendDue(ctx, created) {
  const { pool, live, deps, now, out } = ctx;
  if (live) {
    const due = (await pool.query(`SELECT b.*, lower(m.email) AS mailbox_email, to_char(b.anchor_bid_date,'YYYY-MM-DD') AS anchor_ymd
      FROM bid_invite_batches b LEFT JOIN sdr_mailboxes m ON m.id=b.mailbox_id
      WHERE b.state='active' AND b.next_step IS NOT NULL AND b.next_due_at <= $1 ORDER BY b.anchor_bid_date DESC, b.next_due_at, b.created_at`, [now])).rows;
    out.counts.due = due.length;
    for (const batch of due) {
      try { await sendOne(ctx, batch); }
      catch (e) { out.errors.push({ batchId: batch.id, step: "send_step", error: String(e.message || e).slice(0, 160) }); }
    }
    return;
  }
  // Dry run: render what would go out, new batches first, then the next step of open batches.
  const limit = deps.preview ? Math.max(1, Number(deps.limit) || 10) : Infinity;
  const open = ctx.schema ? (await pool.query(`SELECT b.*, lower(m.email) AS mailbox_email, to_char(b.anchor_bid_date,'YYYY-MM-DD') AS anchor_ymd
      FROM bid_invite_batches b LEFT JOIN sdr_mailboxes m ON m.id=b.mailbox_id
      WHERE b.state='active' AND b.next_step IS NOT NULL ORDER BY b.next_due_at LIMIT $1`, [Number.isFinite(limit) ? limit : 1000])).rows : [];
  for (const batch of [...created, ...open]) {
    if (out.samples.length >= limit) break;
    try {
      const p = await prepareStep(ctx, batch);
      if (p.action === "stop") { bump(out.counts, `would_stop_${p.reason}`); continue; }
      out.samples.push(sampleOf(p.batch || batch, p));
      if (+new Date(p.sendAt) <= +now + 15 * 60000 && !p.holds.length) bump(out.counts, "would_send_now");
    } catch (e) { out.errors.push({ batchId: batch.id, step: "preview", error: String(e.message || e).slice(0, 160) }); }
  }
  out.counts.samples = out.samples.length;
  out.counts.samples_flagged_wording = out.samples.filter((s) => s.flags.some((f) => /_not_on_page$/.test(f))).length;
}

// ---------- Entry point ----------
/**
 * deps = { mode, pd, gmail, getToken, verifyEmail, isCustomerLead, draftReply, now, onlyLeads, perMailboxDay,
 *          minBidDate, companyId, mailboxSentToday, hasRecentReply, replyExitMode, preview, limit, maxNewBatches }
 * Returns { mode, counts, holds, samples, errors } (samples only in dry run).
 */
export async function runBidInviteSequence(pool, deps = {}) {
  const mode = BID_INVITE_MODES.includes(deps.mode) ? deps.mode : "off";
  const out = { mode, counts: {}, holds: {}, samples: [], errors: [] };
  if (mode === "off") return { ...out, skipped: "off" };
  const live = mode === "live";
  if (live) {
    for (const key of ["pd", "gmail", "getToken", "verifyEmail", "isCustomerLead", "companyId"]) if (!deps[key]) return { ...out, skipped: `missing_${key}` };
  }
  const schema = await bidInviteSchemaReady(pool);
  if (live && !schema) return { ...out, skipped: "schema_missing" };
  const now = deps.now ? new Date(deps.now) : new Date();
  if (live) {
    // A reply must take the person out of every sequence before any bid email goes out live.
    const exitMode = (deps.replyExitMode || defaultReplyExitMode)();
    let reason = liveSendBlock({}, { mode, exitMode });
    if (!reason && !(await replyExitSchemaReady(pool))) reason = "migrations/2026-11-03-sdr-reply-exit.sql is not applied: bid invite emails are held";
    if (reason) {
      const due = Number((await pool.query(`SELECT count(*)::int AS n FROM bid_invite_batches WHERE state='active' AND next_step IS NOT NULL AND next_due_at <= $1`, [now])).rows[0]?.n || 0);
      out.holds[exitMode === "live" ? "reply_exit_schema_missing" : "reply_exit_not_live"] = due;
      return { ...out, skipped: exitMode === "live" ? "reply_exit_schema_missing" : "reply_exit_not_live", reason };
    }
  }
  let lockClient = null;
  if (live) {
    lockClient = await pool.connect();
    const ok = (await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended('bid_invite_sequence',0)) AS ok`)).rows[0]?.ok;
    if (!ok) { lockClient.release(); return { ...out, skipped: "already_running" }; }
  }
  const ctx = { pool, live, schema, now, deps, out, leadCache: new Map(), orgCache: new Map(), personCache: new Map(), mailboxes: null, usedThisRun: new Set(),
    companiesThisRun: new Map() };
  try {
    const records = await ingest(ctx);
    await sweepReplies(ctx);
    if (live) await retryOwnerTasks(ctx);
    const created = await batchDueLeads(ctx, records);
    // Pipedrive unreadable for the customer check: nothing is sent this pass (fail closed).
    if (!ctx.halt) {
      if (live) await rehomeStrandedBatches(ctx);
      await sendDue(ctx, created);
    }
  } finally {
    if (lockClient) {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended('bid_invite_sequence',0))`).catch(() => {});
      lockClient.release();
    }
  }
  out.coverage = out.errors.length || ctx.halt ? "partial" : "complete";
  return out;
}

// ---------- Status and preview ----------
export async function bidInviteStatus(db, { env = process.env } = {}) {
  const sendBlocked = liveSendBlock(env);
  if (!(await bidInviteSchemaReady(db))) return { schema: false, sendBlocked };
  const batches = (await db.query(`SELECT state, coalesce(next_step,'-') AS next_step, count(*)::int AS n FROM bid_invite_batches GROUP BY 1,2 ORDER BY 1,2`)).rows;
  const holds = (await db.query(`SELECT 'batch' AS kind, hold_reason AS reason, count(*)::int AS n FROM bid_invite_batches WHERE state='held' GROUP BY 2
    UNION ALL SELECT 'lead', hold_reason, count(*)::int FROM bid_invite_leads WHERE state IN ('held','stopped') GROUP BY 2 ORDER BY 1,2`)).rows;
  const leads = (await db.query(`SELECT state, count(*)::int AS n FROM bid_invite_leads GROUP BY 1 ORDER BY 1`)).rows;
  const today = (await db.query(`SELECT lower(m.email) AS mailbox, s.step, count(*)::int AS n FROM bid_invite_sends s JOIN sdr_mailboxes m ON m.id=s.mailbox_id
    WHERE s.status='sent' AND (s.sent_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date GROUP BY 1,2 ORDER BY 1,2`)).rows;
  const uncertain = (await db.query(`SELECT count(*)::int AS n FROM bid_invite_sends WHERE status='uncertain'`)).rows[0]?.n || 0;
  // A claim older than 15 minutes that never became 'sent' or 'uncertain': the run died mid-send.
  const staleClaims = (await db.query(`SELECT s.id, s.batch_id, s.step, s.recipient_email, s.claimed_at FROM bid_invite_sends s
    WHERE s.status='claimed' AND s.claimed_at < now() - interval '15 minutes' ORDER BY s.claimed_at LIMIT 50`)).rows;
  const accounts = await tableAvailable(db, "sdr_inbox_accounts") && await columnAvailable(db, "sdr_inbox_accounts", "last_error");
  const needsReconnect = accounts ? (await db.query(`SELECT a.mailbox_email, a.last_error,
      (SELECT count(*)::int FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id WHERE lower(m.email)=lower(a.mailbox_email)
        AND b.state='held' AND b.hold_reason='sender_unavailable') AS held_batches
    FROM sdr_inbox_accounts a WHERE coalesce(a.last_error,'') LIKE 'needs_reconnect%' ORDER BY 1`)).rows : [];
  return { schema: true, sendBlocked, leads, batches, holds, sentToday: today, uncertainSends: uncertain, staleClaims, mailboxesNeedingReconnect: needsReconnect };
}

const FLAG_TEXT = {
  grouped_followup_wording_not_on_page: "Email 2/3 naming several projects: this wording is not on the page Derek saw. Needs his OK.",
  customer_owner_task_after_email_1: "Customer: Email 1 only, then a Pipedrive task for the owner.",
  would_verify: "The address has no fresh verification yet; it is checked right before sending.",
  pushed_by_three_day_rule: "Moved later: we emailed this person in the last 3 days, or another sequence step is close.",
  not_in_pilot: "Not in the pilot list (BID_INVITE_ONLY_LEADS), so live mode would skip it.",
  customer_check_unavailable: "Pipedrive could not be read for the customer check; live mode would wait.",
  no_sender_available: "No connected mailbox with a verified reply route; live mode would wait.",
  org_unreadable_time_zone_defaulted: "Organization could not be read; Central time used.",
  pipedrive_not_read: "Pipedrive was not read (no token): no customer check, Central time used.",
  history_unavailable: "Send history could not be read for the 3-day rule; live mode would wait.",
  time_zone_assumed_central: "Time zone not known before import; Central time used. Live mode uses the company's state, else the contact's phone area code.",
  time_zone_from_phone_area_code: "The company has no state in Pipedrive: time zone taken from the contact's phone area code.",
  person_unreadable_time_zone_defaulted: "The company has no state and the contact could not be read; Central time used.",
  more_projects_wording_not_on_page: "More than 3 projects for this contact: the first 3 are named, then \"and N more\". This wording is not on the page Derek saw. Needs his OK.",
  e2_skipped_bid_too_old: "Email 2 is skipped: it could not go by 8 weeks after the bid (Derek's window is 4 to 6 weeks).",
  e3_skipped_bid_too_old: "Email 3 is skipped: it could not go by 10 weeks after the bid (Derek's window is 4 to 6 weeks).",
  company_emailed_today: "This company already got a bid email today; live mode sends it on the next day.",
  company_emailed_that_day: "Another sample goes to the same company that day; live mode sends only one a company a day, so this one waits a day.",
  sender_picked_at_send_time: "Sending mailbox is picked when it goes out (customer's owner, else rotation).",
  title_shortened_at_import_first: "The import shortens long project titles first, so the real short name can differ.",
};

export function renderPreviewHtml(result, { title = "Bid invite follow-ups: sample emails" } = {}) {
  const fmt = (iso, tz) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz || DEFAULT_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso)) : "not scheduled");
  const items = (result.samples || []).map((s, i) => `
  <article>
    <h2>${i + 1}. Email ${stepNumber(s.step)} to ${esc(s.to)}${s.customer ? ' <span class="tag">customer</span>' : ""}</h2>
    <p class="meta">From ${esc(s.from || "no sender yet")} (${esc(s.senderReason || "none")}). Goes out ${esc(fmt(s.sendAt, s.timezone))}.</p>
    <pre><b>Subject:</b> ${esc(s.subject)}\n\n${esc(s.bodyText)}</pre>
    <p class="meta">Projects: ${s.leads.map((l) => `${esc(l.title || l.id)} (bid ${esc(l.bidDate || "?")})${l.named ? ` as "${esc(l.shortName)}"` : s.more ? `, counted in "and ${esc(s.more)} more"` : ", same project name as a named one"}`).join("; ")}</p>
    ${s.flags.length ? `<ul class="flags">${s.flags.map((f) => `<li class="${/_not_on_page$/.test(f) ? "warn" : ""}">${esc(FLAG_TEXT[f] || f)}</li>`).join("")}</ul>` : ""}
    ${s.holds.length ? `<p class="hold">Held: ${esc(s.holds.join(", "))}</p>` : ""}
  </article>`).join("");
  const counts = Object.entries({ ...result.counts, ...Object.fromEntries(Object.entries(result.holds || {}).map(([k, v]) => [`hold: ${k}`, v])) })
    .map(([k, v]) => `<li>${esc(k)}: ${esc(v && typeof v === "object" ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(", ") : v)}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1f2937;background:#fff}
article{border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:16px 0}h1{font-size:20px}h2{font-size:16px;margin:4px 0}
pre{white-space:pre-wrap;font:inherit;background:#f9fafb;padding:10px;border-radius:6px}.meta{color:#6b7280;font-size:13px}
.tag{background:#e0f2fe;color:#075985;border-radius:4px;padding:0 6px;font-size:12px}.flags li.warn{color:#b45309;font-weight:600}.hold{color:#b91c1c}</style></head>
<body><h1>${esc(title)}</h1><p class="meta">Dry run. Nothing was sent or written. ${esc(result.samples?.length || 0)} sample(s).</p><ul class="meta">${counts}</ul>${items || "<p>No emails would go out.</p>"}</body></html>`;
}
