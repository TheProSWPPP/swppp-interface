// A human reply exits the PERSON from every sequence, not only the one sequence the reply
// landed in (Derek, 2026-11-02 call: a reply in one sequence did not stop the other).
//
// Before this, a reply stopped only the replying lead's own sdr_sends rows, and only when the
// app could prove it created the Apollo membership. The same person on another project, an
// unlinked reply, a membership Derek added by hand in Apollo, queued drafts and staged
// LinkedIn work all kept going.
//
// exit_person (a reply action, drained with the other reply actions) does, for one person:
//   1. finds every Apollo contact for the person (our sends, permit drafts, LinkedIn links,
//      and an exact-email Apollo search) and marks every active/paused membership finished;
//      the receipt is Apollo's own status on a fresh read, never the write's 200;
//   2. marks the person's live sdr_sends rows replied and cancels their queued drafts;
//   3. holds the person's LinkedIn candidates and cancels pending LinkedIn actions;
//   4. runs registered exit hooks (LinkedIn lanes, bid invites) so other channels plug in
//      without this file importing them.
//
// SDR_REPLY_EXIT_MODE=off (default) | dry_run | live. dry_run reads Apollo and records the
// computed plan in sdr_reply_exits; it writes nothing to Apollo and changes no local rows.
import { randomUUID } from 'node:crypto';
import { withProviderContactLock } from './sdrProviderOperations.js';
import { canonicalMailbox } from './mailboxAliases.js';

export const REPLY_EXIT_MODES = Object.freeze(['off', 'dry_run', 'live']);
export function replyExitMode(env = process.env) {
  const value = String(env.SDR_REPLY_EXIT_MODE || '').trim().toLowerCase();
  return value === 'dry_run' || value === 'live' ? value : 'off';
}

const OPEN_MEMBERSHIP = new Set(['active', 'paused']);
const OWN_DOMAIN = /@proswppp\.(co|com)$/;

// ---------- Exit hooks ----------
// Contract (see PR body): registerExitHook(name, fnOrHook)
//   exit({emails, leadIds, personIds, contactIds, now, mode:'live'}) -> {cancelled:number}
//     Must close that channel's open work for this person. Must be idempotent: it can run
//     again for the same person (retries, a second copy of the same reply).
//   preview({...same, mode:'dry_run'}) -> {wouldCancel:number}   optional, read only
//   liveSequenceLeadIds(db) -> string[]                           optional, read only
//     Lead ids that have a live sequence owned by this channel, so a Pipedrive-copied
//     reply on such a lead is picked up even without a live Apollo send.
//   liveSequenceLeads(db) -> [{leadId, email, since}]             optional, read only
//     The same, narrowed: a Pipedrive-copied message on the lead counts only when it is from
//     `email` (same address) and arrived after `since` (the channel's first email). Bid
//     invites use this: older mail, or a colleague's, is not a reply to our follow-up.
const hooks = new Map();
export function registerExitHook(name, hook) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('exit_hook_name_required');
  const entry = typeof hook === 'function' ? { exit: hook } : { ...hook };
  if (typeof entry.exit !== 'function') throw new Error('exit_hook_function_required');
  for (const key of ['preview', 'liveSequenceLeadIds', 'liveSequenceLeads'])
    if (entry[key] != null && typeof entry[key] !== 'function') throw new Error(`exit_hook_${key}_invalid`);
  hooks.set(name, entry);
  return () => { if (hooks.get(name) === entry) hooks.delete(name); };
}
export function exitHooks() { return [...hooks.entries()].map(([name, hook]) => ({ name, ...hook })); }
export function resetExitHooksForTests() { hooks.clear(); }

// Union of every hook's live-sequence leads. A failing hook licenses nothing.
export async function hookLiveSequenceLeadIds(db) {
  const ids = new Set();
  for (const hook of hooks.values()) {
    if (!hook.liveSequenceLeadIds) continue;
    try { for (const id of (await hook.liveSequenceLeadIds(db)) || []) if (id) ids.add(String(id)); } catch { /* ignored */ }
  }
  return [...ids];
}

// Every hook's live-sequence leads as {leadId, email, since}: email and since are null for a
// hook that gives plain lead ids (any message on the lead counts). A failing hook licenses nothing.
export async function hookLiveSequenceLeads(db) {
  const out = [], seen = new Set();
  const push = (leadId, email = null, since = null) => {
    const at = since && Number.isFinite(+new Date(since)) ? new Date(since).toISOString() : null;
    const row = { leadId: String(leadId), email: email ? String(email).trim().toLowerCase() : null, since: at };
    const key = `${row.leadId}\u0000${row.email}\u0000${row.since}`;
    if (!seen.has(key)) { seen.add(key); out.push(row); }
  };
  for (const id of await hookLiveSequenceLeadIds(db)) push(id);
  for (const hook of hooks.values()) {
    if (!hook.liveSequenceLeads) continue;
    try {
      for (const r of (await hook.liveSequenceLeads(db)) || []) {
        // A scoped entry needs both its address and its time; anything less licenses nothing.
        if (r?.leadId && r.email && r.since && Number.isFinite(+new Date(r.since))) push(r.leadId, r.email, r.since);
      }
    } catch { /* ignored */ }
  }
  return out;
}

// ---------- Identity ----------
// One prospect address, lower-case. Our own mailboxes are staff, never an exit identity.
export function normalExitEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  const address = (raw.match(/<([^<>\s]+@[^<>\s]+)>/) || raw.match(/([^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]+)/) || [])[1] || null;
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || OWN_DOMAIN.test(address)) return null;
  return address;
}

export function exitTargetKey({ fromEmail = null, leadId = null } = {}) {
  const email = normalExitEmail(fromEmail);
  return email ? `exit:${email}` : leadId ? `exit:lead:${leadId}` : null;
}

async function tableAvailable(db, name) {
  return Boolean((await db.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name);
}

// The exit is wired only after migrations/2026-11-03-sdr-reply-exit.sql: the sender column
// on sdr_reply_messages, the exit_person kind and the exit_signal reply kind. Before that, nothing is enqueued.
// The column and constraints are read by table oid only, so another schema being dropped at the same time
// (parallel test runs) can never make pg_get_constraintdef read a vanished relation.
export async function replyExitSchemaReady(db) {
  const { rows } = await db.query(`SELECT
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(quote_ident(current_schema())||'.sdr_reply_messages')
        AND a.attname='from_email' AND NOT a.attisdropped) AS has_column,
      (SELECT c.oid FROM pg_constraint c WHERE c.conrelid=to_regclass(quote_ident(current_schema())||'.sdr_reply_actions')
        AND c.conname='sdr_reply_actions_kind_check') AS kind_oid,
      (SELECT c.oid FROM pg_constraint c WHERE c.conrelid=to_regclass(quote_ident(current_schema())||'.sdr_reply_messages')
        AND c.conname='sdr_reply_messages_reply_kind_check') AS signal_oid`);
  const r = rows[0];
  if (r?.has_column !== true || !r.kind_oid || !r.signal_oid) return false;
  // The definitions are read only for our own two constraints.
  const defs = (await db.query('SELECT pg_get_constraintdef($1::oid) AS kind, pg_get_constraintdef($2::oid) AS signal', [r.kind_oid, r.signal_oid])).rows[0];
  return String(defs?.kind || '').includes('exit_person') && String(defs?.signal || '').includes('exit_signal');
}

const sorted = set => [...set].filter(Boolean).map(String).sort();

// Every identity of the person who replied: the reply address, expanded to every project
// with the same Pipedrive person or the same address. The replying project's person and its
// live sends count only when they ARE the sender (same address): a colleague replying on
// Alice's thread exits the colleague, not Alice, and a project whose contact changed from Bob
// to Alice never exits Bob. The project's own sequence is still stopped by stop_sequence.
// Sends are matched on the person (draft contact id or address), never on the project alone.
export async function exitIdentities(db, { fromEmail = null, leadId = null, threadParticipants = [], extraEmails = [] } = {}) {
  const emails = new Set(), leadIds = new Set(), personIds = new Set(), contactIds = new Set(), sendIds = new Set();
  const linkedin = new Map();
  for (const value of [fromEmail, ...threadParticipants, ...extraEmails]) { const email = normalExitEmail(value); if (email) emails.add(email); }
  if (leadId) {
    leadIds.add(String(leadId));
    const senders = new Set(emails);
    const lead = (await db.query('SELECT pipedrive_person_id, person_email FROM sdr_lead_state WHERE pipedrive_lead_id=$1', [String(leadId)])).rows[0];
    if (lead?.pipedrive_person_id && senders.has(normalExitEmail(lead.person_email))) personIds.add(String(lead.pipedrive_person_id));
    const live = await db.query(`SELECT s.id, s.apollo_contact_id, d.contact_id_snapshot, d.contact_email_snapshot
      FROM sdr_sends s LEFT JOIN sdr_drafts d ON d.id=s.draft_id
      WHERE s.pipedrive_lead_id=$1 AND s.status IN ('enrolled','sent')`, [String(leadId)]);
    for (const row of live.rows) {
      if (!senders.has(normalExitEmail(row.contact_email_snapshot))) continue;
      sendIds.add(String(row.id));
      if (row.apollo_contact_id) contactIds.add(String(row.apollo_contact_id));
      if (row.contact_id_snapshot) personIds.add(String(row.contact_id_snapshot));
    }
  }
  // Two passes: person -> address -> person covers a person record and its address aliases.
  for (let pass = 0; pass < 2; pass++) {
    const leads = await db.query(`SELECT pipedrive_lead_id, pipedrive_person_id, person_email FROM sdr_lead_state
      WHERE (pipedrive_person_id IS NOT NULL AND pipedrive_person_id=ANY($1::text[])) OR lower(trim(person_email))=ANY($2::text[])`,
    [sorted(personIds), sorted(emails)]);
    for (const row of leads.rows) {
      leadIds.add(String(row.pipedrive_lead_id));
      if (row.pipedrive_person_id) personIds.add(String(row.pipedrive_person_id));
      const email = normalExitEmail(row.person_email); if (email) emails.add(email);
    }
    const sends = await db.query(`SELECT s.id, s.pipedrive_lead_id, s.status, s.apollo_contact_id FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id
      WHERE d.contact_id_snapshot=ANY($1::text[]) OR lower(trim(d.contact_email_snapshot))=ANY($2::text[])`, [sorted(personIds), sorted(emails)]);
    for (const row of sends.rows) {
      leadIds.add(String(row.pipedrive_lead_id));
      if (row.apollo_contact_id) contactIds.add(String(row.apollo_contact_id));
      if (['enrolled', 'sent'].includes(row.status)) sendIds.add(String(row.id));
    }
  }
  if (emails.size && await tableAvailable(db, 'permit_drafts')) {
    const permit = await db.query(`SELECT DISTINCT apollo_contact_id FROM permit_drafts WHERE apollo_contact_id IS NOT NULL AND lower(trim(email))=ANY($1::text[])`, [sorted(emails)]);
    for (const row of permit.rows) contactIds.add(String(row.apollo_contact_id));
  }
  if (emails.size && await tableAvailable(db, 'sdr_linkedin_links')) {
    const links = await db.query(`SELECT company_id, account_id, person_id, lead_id, apollo_contact_id FROM sdr_linkedin_links
      WHERE status='verified' AND verified_email IS NOT NULL AND lower(trim(verified_email))=ANY($1::text[])`, [sorted(emails)]);
    for (const row of links.rows) {
      if (row.apollo_contact_id) contactIds.add(String(row.apollo_contact_id));
      if (row.lead_id) leadIds.add(String(row.lead_id));
      const key = `${row.company_id}\u0000${row.account_id}\u0000${row.person_id}`;
      linkedin.set(key, { companyId: String(row.company_id), accountId: String(row.account_id), personId: String(row.person_id) });
    }
  }
  return { emails: sorted(emails), leadIds: sorted(leadIds), personIds: sorted(personIds), contactIds: sorted(contactIds), sendIds: sorted(sendIds),
    linkedin: [...linkedin.values()].sort((a, b) => `${a.companyId}${a.accountId}${a.personId}`.localeCompare(`${b.companyId}${b.accountId}${b.personId}`)) };
}

// ---------- Planning ----------
export function membershipsReadable(contact, contactId = null) {
  return Boolean(contact?.id) && (contactId == null || String(contact.id) === String(contactId))
    && Array.isArray(contact.contact_campaign_statuses) && contact.contact_campaign_statuses.every(s => s && typeof s === 'object');
}

// Open memberships (active/paused) on one Apollo contact, one per sequence. Terminal ones
// (finished, failed) and malformed entries are skipped: they are never written to. With
// replyAt, a membership Apollo says was added AFTER the reply is skipped too: a rep put the
// person back in a sequence on purpose after reading the reply (re-run dry runs, backfills).
export const addedAfterReply = (s, replyAt) => Boolean(replyAt && s?.added_at && Number.isFinite(+new Date(s.added_at))
  && Number.isFinite(+new Date(replyAt)) && +new Date(s.added_at) > +new Date(replyAt));
export function planMembershipExits(contact, { replyAt = null } = {}) {
  if (!membershipsReadable(contact)) return [];
  const seen = new Set(), out = [];
  for (const s of contact.contact_campaign_statuses) {
    const campaignId = s.emailer_campaign_id == null ? '' : String(s.emailer_campaign_id);
    const status = String(s.status || '').toLowerCase();
    if (!campaignId || !OPEN_MEMBERSHIP.has(status) || seen.has(campaignId) || addedAfterReply(s, replyAt)) continue;
    seen.add(campaignId);
    out.push({ contactId: String(contact.id), campaignId, membershipId: s.emailer_campaign_contact_id ?? s.id ?? null, status });
  }
  return out;
}

const statusOf = (contact, campaignId) => String((contact?.contact_campaign_statuses || [])
  .find(s => String(s?.emailer_campaign_id) === String(campaignId))?.status || 'absent').toLowerCase();

// Provider errors mapped onto the reply-action ledger (lib/sdrReplyActions.js runReplyAction).
// Every step is safe to repeat (reads, and mark_as_finished on a fresh plan), so ordinary
// failures retry with backoff; a rate limit waits for Apollo's own retry time.
function providerError(error, step) {
  const status = Number(error?.status);
  if (status === 429) return Object.assign(new Error(`apollo_${step}_rate_limited`), {
    status: 429, definiteFailure: true, retryAfterSec: error.retryAfterSec ?? null, retryAt: error.retryAt ?? null });
  if (status === 401 || status === 403) return Object.assign(new Error(`apollo_${step}_auth`), { status, permanent: true, definiteFailure: true });
  return Object.assign(new Error(`apollo_${step}_failed`), { definiteFailure: true });
}

// ---------- Execution ----------
export async function exitPersonEverywhere({ pool, apollo, identities, mode = replyExitMode(), now = new Date(), actionId = null,
  providerMessageId = null, replyAt = null, hookList = exitHooks(), lock = withProviderContactLock } = {}) {
  if (!['dry_run', 'live'].includes(mode)) return { skipped: true, reason: 'no_action' };
  const live = mode === 'live';
  const ids = { emails: [], leadIds: [], personIds: [], contactIds: [], sendIds: [], linkedin: [], ...identities };
  const plan = { contacts: [], sends: [], drafts: [], linkedin: { candidates: 0, actions: 0 }, hooks: [] };
  const outcome = { finished: [], stillOpen: [], finishErrors: [], hookErrors: [], skippedContacts: [], contactErrors: [], pendingContacts: [] };
  // A rate limit or an auth failure stops further Apollo calls in this run; anything else is
  // recorded for that one contact and the rest carry on. The local step always runs.
  let blocked = null;
  const halts = (error, step) => {
    if (![429, 401, 403].includes(Number(error?.status))) return false;
    blocked ||= providerError(error, step);
    return true;
  };

  // 1. Every Apollo contact of this person, including ones this app never enrolled.
  const contactIds = new Set(ids.contactIds.map(String));
  if (typeof apollo?.findContactsByEmail === 'function') {
    for (const email of ids.emails) {
      if (blocked) break;
      try { for (const contact of (await apollo.findContactsByEmail(email)) || []) if (contact?.id) contactIds.add(String(contact.id)); }
      catch (error) { if (!halts(error, 'contact_search')) outcome.contactErrors.push({ email, step: 'contact_search', status: Number(error?.status) || null }); }
    }
  }

  // 2. Finish each open membership, then read the contact again as the receipt. A contact
  // Apollo no longer has (404, 422) is absent, not a failure.
  for (const contactId of [...contactIds].sort()) {
    if (blocked) { outcome.pendingContacts.push(contactId); continue; }
    try {
      await lock(pool, contactId, ids.leadIds, async () => {
        let contact;
        try { contact = await apollo.getContact(contactId); }
        catch (error) {
          if ([404, 422].includes(Number(error?.status))) outcome.skippedContacts.push({ contactId, reason: 'contact_absent' });
          else if (halts(error, 'contact_read')) outcome.pendingContacts.push(contactId);
          else outcome.contactErrors.push({ contactId, step: 'contact_read', status: Number(error?.status) || null });
          return;
        }
        if (!membershipsReadable(contact, contactId)) { outcome.stillOpen.push({ contactId, campaignId: null, reason: 'membership_unreadable' }); return; }
        const exits = planMembershipExits(contact, { replyAt });
        const later = planMembershipExits(contact).filter(m => !exits.some(e => e.campaignId === m.campaignId)).map(m => m.campaignId);
        plan.contacts.push({ contactId, open: exits.map(m => ({ campaignId: m.campaignId, status: m.status })), ...(later.length ? { reEnrolledAfterReply: later } : {}) });
        if (!live || !exits.length) return;
        for (const membership of exits) {
          if (blocked) break;
          try { await apollo.finishContactInSequence(membership.campaignId, contactId); }
          catch (error) { if (!halts(error, 'finish')) outcome.finishErrors.push({ contactId, campaignId: membership.campaignId, status: Number(error?.status) || null }); }
        }
        let after;
        try { after = await apollo.getContact(contactId); }
        catch (error) {
          halts(error, 'receipt_read');
          for (const m of exits) outcome.stillOpen.push({ contactId, campaignId: m.campaignId, reason: 'receipt_unavailable' });
          return;
        }
        const reread = membershipsReadable(after, contactId);
        const open = new Set(planMembershipExits(after).map(m => m.campaignId));
        for (const m of exits) {
          if (!reread || open.has(m.campaignId)) outcome.stillOpen.push({ contactId, campaignId: m.campaignId, reason: reread ? 'membership_open' : 'membership_unreadable' });
          else outcome.finished.push({ contactId, campaignId: m.campaignId, status: statusOf(after, m.campaignId) });
        }
      });
    } catch { outcome.contactErrors.push({ contactId, step: 'contact_lock', status: null }); }
  }

  // 3. Other channels (registered hooks). Live hooks close work; dry-run hooks only preview.
  const hookInput = { emails: ids.emails, leadIds: ids.leadIds, personIds: ids.personIds, contactIds: [...contactIds].sort(), now, mode };
  for (const hook of hookList) {
    const run = live ? hook.exit : hook.preview;
    if (!run) { plan.hooks.push({ name: hook.name, skipped: 'no_preview' }); continue; }
    try { plan.hooks.push({ name: hook.name, result: (await run(hookInput)) || {} }); }
    catch { outcome.hookErrors.push({ name: hook.name }); }
  }

  // 4. Local rows: live sends -> replied, queued drafts -> cancelled, LinkedIn held. In dry
  // run the same rows are only counted. The record row is written in both modes.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sendSql = `FROM sdr_sends WHERE status IN ('enrolled','sent') AND (id::text=ANY($1::text[]) OR apollo_contact_id=ANY($2::text[]))`;
    const sendArgs = [ids.sendIds, [...contactIds]];
    plan.sends = live
      ? (await client.query(`UPDATE sdr_sends SET status='replied',last_status_at=$3,updated_at=NOW() WHERE id IN (SELECT id ${sendSql}) RETURNING id::text AS id`, [...sendArgs, now])).rows.map(r => r.id)
      : (await client.query(`SELECT id::text AS id ${sendSql}`, sendArgs)).rows.map(r => r.id);
    // A draft with a send row is immutable (sdr_protect_draft_revision); only unsent queued drafts.
    const draftSql = `FROM sdr_drafts d WHERE d.status IN ('pending','approved','edited') AND d.sent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sdr_sends s WHERE s.draft_id=d.id)
      AND (lower(trim(d.contact_email_snapshot))=ANY($1::text[]) OR d.contact_id_snapshot=ANY($2::text[]))`;
    const draftArgs = [ids.emails, ids.personIds];
    plan.drafts = live
      ? (await client.query(`UPDATE sdr_drafts SET status='cancelled',reject_reason='reply_exit',updated_at=NOW() WHERE id IN (SELECT d.id ${draftSql}) RETURNING id::text AS id`, draftArgs)).rows.map(r => r.id)
      : (await client.query(`SELECT d.id::text AS id ${draftSql}`, draftArgs)).rows.map(r => r.id);
    if (ids.linkedin.length && await tableAvailable(client, 'sdr_linkedin_candidates')) {
      const people = JSON.stringify(ids.linkedin);
      const match = `EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS p("companyId" text,"accountId" text,"personId" text)
        WHERE p."companyId"=company_id AND p."accountId"=account_id AND p."personId"=person_id)`;
      const candidates = live
        ? await client.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason='email_reply',revision=revision+1
            WHERE ${match} AND state NOT IN ('held','replied','archived','opted_out')`, [people])
        : await client.query(`SELECT 1 FROM sdr_linkedin_candidates WHERE ${match} AND state NOT IN ('held','replied','archived','opted_out')`, [people]);
      const actions = live
        ? await client.query(`UPDATE sdr_linkedin_actions SET state='cancelled' WHERE ${match} AND state='pending'`, [people])
        : await client.query(`SELECT 1 FROM sdr_linkedin_actions WHERE ${match} AND state='pending'`, [people]);
      plan.linkedin = { candidates: candidates.rowCount || 0, actions: actions.rowCount || 0 };
    }
    if (actionId && await tableAvailable(client, 'sdr_reply_exits')) {
      await client.query(`INSERT INTO sdr_reply_exits(action_id,provider_message_id,mode,identities,plan,outcome)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(action_id) DO UPDATE SET mode=EXCLUDED.mode,identities=EXCLUDED.identities,
          plan=EXCLUDED.plan,outcome=EXCLUDED.outcome,updated_at=NOW()`,
      [actionId, providerMessageId || 'unknown', mode, JSON.stringify({ ...ids, contactIds: [...contactIds].sort() }), JSON.stringify(plan), JSON.stringify(outcome)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }

  // Order: a rate limit waits for Apollo; other failures retry with backoff (every step is
  // safe to repeat); an open membership after the write is a receipt question.
  if (blocked) throw blocked;
  if (live && (outcome.hookErrors.length || outcome.contactErrors.length))
    throw Object.assign(new Error(outcome.hookErrors.length ? 'exit_hook_failed' : 'exit_contact_failed'), { definiteFailure: true });
  if (live && outcome.stillOpen.length) {
    // A write Apollo refused outright needs a person; anything else is re-read (reconcile).
    if (outcome.finishErrors.length) throw Object.assign(new Error('exit_finish_refused'), { permanent: true, definiteFailure: true, exitReviewReason: 'exit_review' });
    throw Object.assign(new Error('exit_completion_uncertain'), { uncertain: true });
  }
  // A dry-run receipt is re-run when the mode becomes live (requeueDryRunExits).
  return { id: `${live ? 'reply-exit' : 'reply-exit-dry'}:${actionId || 'direct'}`, mode, contacts: plan.contacts.length, finished: outcome.finished.length,
    sends: plan.sends.length, drafts: plan.drafts.length, linkedin: plan.linkedin, hooks: plan.hooks.length };
}

// Re-read only: is any membership of this person still open? Used to settle an exit whose
// receipt was uncertain without writing to Apollo again.
export async function exitOpenMemberships({ apollo, contactIds, emails = [], replyAt = null }) {
  const open = [], ids = new Set((contactIds || []).map(String));
  if (typeof apollo?.findContactsByEmail === 'function')
    for (const email of emails) for (const contact of (await apollo.findContactsByEmail(email)) || []) if (contact?.id) ids.add(String(contact.id));
  for (const contactId of [...ids].sort()) {
    let contact;
    try { contact = await apollo.getContact(String(contactId)); }
    catch (error) {
      if ([404, 422].includes(Number(error?.status))) continue;
      throw error;
    }
    if (!membershipsReadable(contact, contactId)) { open.push({ contactId, campaignId: null }); continue; }
    for (const m of planMembershipExits(contact, { replyAt })) open.push({ contactId: m.contactId, campaignId: m.campaignId });
  }
  return open;
}

// ---------- Enqueue outside the Gmail/Pipedrive reply ledger ----------
// Apollo-detected, LinkedIn and bid-invite replies never pass through enqueueReplyActions.
// This records the trigger once (idempotent on messageId) and adds the exit_person action.
//
// The trigger row has reply_kind 'exit_signal' and no project or thread link, so readers of
// human inbox replies (quiet follow-up clock, ops snapshot, engagement summary, inbox lists)
// never see it. The project and provider thread stay in the action payload only.
//
// Apollo does not say whether a "reply" is a person or an out-of-office. Its exit waits
// APOLLO_EXIT_DELAY_MS so the inbox watch can classify the same message first, and is
// skipped (now and again at run time) when that address has a classified automatic reply or
// bounce, or an already recorded reply, within EXIT_DEDUP_DAYS.
export const APOLLO_EXIT_DELAY_MS = 30 * 60 * 1000;
export const EXIT_DEDUP_DAYS = 3;

export const AUTO_MATCH_MS = 24 * 3600 * 1000;
// Why an exit trigger should not run: the same message was classified automatic (Apollo
// triggers only), or the reply is already recorded and has its own exit.
//  - automatic: an auto/bounce row from the same address in the same mailbox (when Apollo
//    named it) and the same thread (when both carry one), within a day;
//  - recorded: a human reply, or another exit trigger; an Apollo trigger that has not yet
//    exited live never blocks a LinkedIn or bid-invite one (it may still be cancelled).
async function signalDisposition(db, { messageId, email, at, source, mailbox = null, threadId = null }) {
  if (!email) return null;
  const rows = (await db.query(`SELECT m.reply_kind, m.source, lower(m.mailbox_email) AS mailbox, m.thread_id, m.received_at,
      EXISTS (SELECT 1 FROM sdr_reply_actions a WHERE a.provider_message_id=m.provider_message_id AND a.kind='exit_person'
        AND a.status='completed' AND a.external_id LIKE 'reply-exit:%') AS exited
    FROM sdr_reply_messages m WHERE m.provider_message_id<>$1 AND lower(m.from_email)=$2
    AND m.received_at BETWEEN $3::timestamptz - make_interval(days => $4::int) AND $3::timestamptz + make_interval(days => $4::int)`,
  [messageId, email, at, EXIT_DEDUP_DAYS])).rows;
  const box = mailbox && mailbox !== 'apollo' ? canonicalMailbox(mailbox) : null;
  if (source === 'apollo' && rows.some(r => ['auto', 'bounce'].includes(r.reply_kind) && Math.abs(+new Date(r.received_at) - +new Date(at)) <= AUTO_MATCH_MS
    && (!box || canonicalMailbox(r.mailbox) === box) && (!threadId || !r.thread_id || String(r.thread_id) === String(threadId)))) return 'classified_automatic';
  if (rows.some(r => r.reply_kind === 'human' || (r.reply_kind === 'exit_signal' && (source === 'apollo' || r.source !== 'apollo' || r.exited)))) return 'reply_already_recorded';
  return null;
}

export async function enqueueExitOnly(pool, { messageId, source, mailbox, receivedAt, leadId = null, fromEmail = null,
  threadId = null, intent = null, providerEventAt = null, mode = replyExitMode() } = {}) {
  if (mode === 'off') return { skipped: 'disabled' };
  const at = new Date(receivedAt);
  const email = normalExitEmail(fromEmail);
  const target = exitTargetKey({ fromEmail: email, leadId });
  if (!messageId || !source || !mailbox || !Number.isFinite(+at) || !target) return { skipped: 'identity_missing' };
  if (!await replyExitSchemaReady(pool)) return { skipped: 'schema_missing' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const skip = await signalDisposition(client, { messageId, email, at, source, mailbox, threadId });
    if (skip) { await client.query('COMMIT'); return { skipped: skip }; }
    const box = String(mailbox).toLowerCase();
    const inserted = await client.query(`INSERT INTO sdr_reply_messages
      (provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind,intent,link_evidence,from_email)
      VALUES($1,$2,$1,NULL,$3,$4,NULL,'unlinked','exit_signal',$5,$6,$7) ON CONFLICT(provider_message_id) DO NOTHING RETURNING provider_message_id`,
    [messageId, source, box, at, intent, `${source}:exit_signal`, email]);
    let enqueued = 0;
    if (inserted.rowCount) {
      const payload = { exitLeadId: leadId, mailbox: box, source, intent: intent || 'unknown', replyAt: at.toISOString(),
        ...(email ? { fromEmail: email, exitEmails: [email] } : {}), ...(threadId ? { sourceThreadId: String(threadId) } : {}),
        ...(providerEventAt ? { providerEventAt: String(providerEventAt) } : {}) };
      const retryAt = source === 'apollo' ? new Date(+at + APOLLO_EXIT_DELAY_MS) : null;
      const r = await client.query(`INSERT INTO sdr_reply_actions(id,provider_message_id,mailbox_email,kind,target_key,payload,status,retry_at)
        VALUES($5,$1,$2,'exit_person',$3,$4,'pending',$6) ON CONFLICT(provider_message_id,kind,target_key) DO NOTHING`,
      [messageId, box, target, JSON.stringify(payload), randomUUID(), retryAt]);
      enqueued = r.rowCount || 0;
    }
    await client.query('COMMIT');
    return { detected: inserted.rowCount || 0, enqueued };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

// Dry-run exits completed with a dry receipt. When the mode is live they run again for real,
// so replies seen during the dry-run window still exit the person. Only replies from the last
// REQUEUE_MAX_DAYS; memberships added after the reply are left alone (planMembershipExits).
// Marked requeued: the drain runs them after fresh reply work. Idempotent.
export const REQUEUE_MAX_DAYS = 14;
export async function requeueDryRunExits(db, { now = new Date(), maxAgeDays = REQUEUE_MAX_DAYS } = {}) {
  const r = await db.query(`UPDATE sdr_reply_actions SET status='pending',attempts=0,retry_at=NULL,requires_review=false,safe_error=NULL,
      external_id=NULL,receipt_at=NULL,updated_at=$1,payload=payload||'{"requeued":true}'::jsonb
    WHERE kind='exit_person' AND status='completed' AND external_id LIKE 'reply-exit-dry:%'
      AND created_at > $1::timestamptz - make_interval(days => $2::int)`, [now, maxAgeDays]);
  return r.rowCount || 0;
}

// One-time: human replies recorded before the exit was switched on (or while it was off)
// get the exit_person action they would have had, one per sender address. Default dry run.
export async function backfillReplyExits(pool, { days = 30, now = new Date(), dryRun = true } = {}) {
  if (!await replyExitSchemaReady(pool)) return { dryRun, count: 0, planned: [], skipped: 'schema_missing' };
  const rows = (await pool.query(`SELECT DISTINCT ON (lower(m.from_email)) m.provider_message_id, m.mailbox_email, m.pipedrive_lead_id,
      m.link_status, m.source, m.received_at, lower(m.from_email) AS from_email
    FROM sdr_reply_messages m
    WHERE m.reply_kind='human' AND m.from_email IS NOT NULL AND m.received_at > $1::timestamptz - make_interval(days => $2::int)
      AND m.received_at <= $1::timestamptz
      AND NOT EXISTS (SELECT 1 FROM sdr_reply_actions a WHERE a.kind='exit_person' AND a.target_key='exit:'||lower(m.from_email))
    ORDER BY lower(m.from_email), m.received_at DESC`, [now, days])).rows;
  const planned = [];
  for (const m of rows) {
    const target = exitTargetKey({ fromEmail: m.from_email });
    if (!target || target.startsWith('exit:lead:')) continue;
    const leadId = m.link_status === 'verified' ? m.pipedrive_lead_id : null;
    planned.push({ messageId: m.provider_message_id, receivedAt: m.received_at, mailbox: m.mailbox_email, leadId, fromEmail: m.from_email, target });
    if (dryRun) continue;
    const payload = { leadId, mailbox: String(m.mailbox_email).toLowerCase(), fromEmail: m.from_email, exitEmails: [m.from_email],
      replyAt: new Date(m.received_at).toISOString(),
      ...(m.source !== 'gmail' ? { source: m.source } : {}), backfill: 'reply-exit-2026-11-03' };
    const r = await pool.query(`INSERT INTO sdr_reply_actions(id,provider_message_id,mailbox_email,kind,target_key,payload,status)
      VALUES($1,$2,$3,'exit_person',$4,$5,'pending') ON CONFLICT(provider_message_id,kind,target_key) DO NOTHING`,
    [randomUUID(), m.provider_message_id, String(m.mailbox_email).toLowerCase(), target, JSON.stringify(payload)]);
    planned.at(-1).inserted = r.rowCount || 0;
  }
  return { dryRun, count: planned.length, planned };
}

// When the person replied: stored on the action, else the recorded reply's time.
const replyTimeOf = (action, signal) => {
  const value = action?.payload?.replyAt || signal?.received_at || null;
  return value && Number.isFinite(+new Date(value)) ? new Date(value) : null;
};

// Reply-action client for kind exit_person (registered in createReplyActionClients).
export function createExitPersonClient({ pool, apollo, mode = replyExitMode, now = () => new Date() }) {
  const current = () => (typeof mode === 'function' ? mode() : mode);
  const identitiesFor = action => {
    const p = action.payload || {};
    return exitIdentities(pool, { fromEmail: p.fromEmail || null, leadId: p.leadId || p.exitLeadId || null, extraEmails: Array.isArray(p.exitEmails) ? p.exitEmails : [] });
  };
  return {
    beforeDrain: async (_db, at = new Date()) => (current() === 'live' ? requeueDryRunExits(pool, { now: at }) : 0),
    execute: async action => {
      const m = current();
      if (m === 'off') return { skipped: true, reason: 'no_action' };
      // A trigger recorded outside the inbox is re-checked now that the inbox watch has had
      // time to classify the same message (out-of-office, bounce) or record it as a reply.
      const signal = action.provider_message_id ? (await pool.query(`SELECT source, reply_kind, received_at, mailbox_email, lower(from_email) AS from_email
        FROM sdr_reply_messages WHERE provider_message_id=$1`, [action.provider_message_id])).rows[0] : null;
      if (signal?.reply_kind === 'exit_signal' && signal.source === 'apollo') {
        const skip = await signalDisposition(pool, { messageId: action.provider_message_id, email: signal.from_email, at: signal.received_at, source: signal.source,
          mailbox: signal.mailbox_email, threadId: action.payload?.sourceThreadId || null });
        if (skip === 'classified_automatic') return { skipped: true, reason: 'no_action' };
        if (skip === 'reply_already_recorded') return { skipped: true, reason: 'duplicate' };
      }
      const identities = await identitiesFor(action);
      return exitPersonEverywhere({ pool, apollo, identities, mode: m, now: now(), actionId: action.id, providerMessageId: action.provider_message_id,
        replyAt: replyTimeOf(action, signal) });
    },
    // Completed only when a fresh read shows no open membership for the person.
    reconcile: async action => {
      const identities = await identitiesFor(action);
      const stored = action.id && await tableAvailable(pool, 'sdr_reply_exits')
        ? (await pool.query('SELECT identities FROM sdr_reply_exits WHERE action_id=$1', [action.id])).rows[0]?.identities : null;
      const contactIds = [...new Set([...(identities.contactIds || []), ...((stored?.contactIds) || [])].map(String))];
      let open;
      const signal = action.provider_message_id ? (await pool.query('SELECT received_at FROM sdr_reply_messages WHERE provider_message_id=$1', [action.provider_message_id])).rows[0] : null;
      try { open = await exitOpenMemberships({ apollo, contactIds, emails: identities.emails || [], replyAt: replyTimeOf(action, signal) }); }
      catch (error) {
        if (Number(error?.status) === 429) return { state: 'deferred', safeError: 'rate_limit', retryAt: error.retryAt || new Date(Date.now() + 900000) };
        return { state: 'unknown' };
      }
      return open.length ? { state: 'not_applied' } : { state: 'completed', receipt: { id: `reply-exit:${action.id}` } };
    },
  };
}
