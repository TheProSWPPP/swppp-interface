// CMD company swap, narrowed (Ivan, 2026-11-11).
//
// When CMD names a different company on a lead (the low bidder or the awarded GC), the n8n
// refresh only records the change as a held proposal: 634 active leads on 2026-11-11. Applying
// every one would move leads Derek has already worked by hand: he hand-emailed 181 of them, 59
// to the very company CMD names.
//
// This applies the change only for leads nobody has touched:
//   - no .co send and no draft on the lead, no email of any kind logged on it in 60 days
//   - the lead still shows the company and contact the proposal saw (no staff edit since)
//   - no Sequence_Started marker, no staff trigger override, no active hold, not a Bid Invite lead
//   - inside the start-date window automation uses
//   - CMD has named the same single company for at least a day, and no other in 14 days
//   - the result is an award stage (LBA, AGC, GC) and the stage never moves backward
//   - the Pipedrive company carries the name CMD gave, and it is not the old company renamed
//   - the new company is not a customer and has no open deal
//   - the contact is at a company domain, has never been emailed by .co, and has no mail with
//     staff in 60 days
//   - the contact's name fits the mailbox (not another person's address or a shared mailbox)
//
// It sets company + contact (+ stage) in one lead PATCH, adds a note, and journals an intent
// and a receipt. It never sends anything: the lead then goes through the normal automation
// path, which verifies the address and applies every send guard before a first email.
//
// OFF unless SDR_COMPANY_SWAP=on. SDR_COMPANY_SWAP_LIMIT caps leads per run (default 25).
import { createHash } from 'node:crypto';
import * as pipedriveClient from './pipedriveClient.js';
import { withLeadLock } from './sdrAccess.js';
import { recordChangeIntent, recordChangeReceipt } from './sdrChangeJournal.js';
import { FIELD_KEYS, resolveTriggerType, deriveStatus, daysSince } from './pipedriveSync.js';
import { looksLikeEmail } from './emailVerify.js';

export const HELD_REASON = 'Review CMD changes against current staff selections';
export const SWAP_REASON = 'CMD company change applied';
export const PROPOSAL_WINDOW_HOURS = 36;  // n8n refreshes twice a day; older means no longer proposed
export const STABLE_HOURS = 24;           // CMD must have named this company for at least this long
export const FLIP_WINDOW_DAYS = 14;       // ...and no other company in this window
export const QUIET_DAYS = 60;             // no mail on the lead or with the contact in this window
export const MAX_ATTEMPTS = 3;

const AWARD_STAGES = new Set(['LBA', 'AGC', 'GC']);
const STAGE_RANK = { 'CD': 0, 'Pre-Bid': 1, 'OB': 2, 'PB': 3, 'LBA': 4, 'AGC': 5, 'CM': 5, 'GC': 6 };
// Personal and ISP mailboxes: the same list the n8n contact parser treats as personal, plus two ISPs.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'fastmail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'comcast.net', 'sbcglobal.net',
  'att.net', 'verizon.net', 'cox.net', 'charter.net', 'earthlink.net', 'bellsouth.net', 'frontiernet.net', 'windstream.net']);
// Same rule the n8n "Org Compare" node uses to decide two names are one company.
const SUFFIX = new Set(['inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd', 'lp', 'llp', 'incorporated', 'the', 'pllc', 'pc', 'limited']);

export const companySwapEnabled = () => process.env.SDR_COMPANY_SWAP === 'on';
export function companySwapLimit() {
  const n = Number(process.env.SDR_COMPANY_SWAP_LIMIT);
  return Number.isInteger(n) && n >= 0 ? n : 25;
}

export const normalizeCompany = name => String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
  .split(' ').filter(token => token && !SUFFIX.has(token)).join(' ');

const isMisc = stage => /^Miscellaneous/i.test(stage);
// What happens to the Project Stage. Forward-only, the same order the n8n stage write uses, and
// the lead must end on an award stage, the only stages that name a company.
export function stageDecision(current, proposed) {
  const cur = String(current ?? '').trim();
  const next = String(proposed ?? '').trim();
  if (!next || next === cur) return AWARD_STAGES.has(cur) ? { ok: true, write: false, final: cur } : { ok: false, reason: 'not_award_stage' };
  const forward = cur === '' ? next in STAGE_RANK
    : isMisc(cur) || isMisc(next) ? false
    : cur in STAGE_RANK && next in STAGE_RANK && STAGE_RANK[next] > STAGE_RANK[cur];
  if (!forward) return { ok: false, reason: 'stage_not_forward' };
  return AWARD_STAGES.has(next) ? { ok: true, write: true, final: next } : { ok: false, reason: 'not_award_stage' };
}

const text = value => String(value ?? '');
const positiveId = value => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; };
const idOf = value => text(value && typeof value === 'object' ? (value.value ?? value.id) : value);
const mailWithin = (person, days) => [person?.last_outgoing_mail_time, person?.last_incoming_mail_time]
  .some(ts => { const d = daysSince(ts || null); return d !== null && d <= days; });
const escapeHtml = value => text(value).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);

// Held company changes on untouched leads. Everything checkable from our own tables is here;
// the live Pipedrive checks are in swapOne.
export async function selectSwapCandidates(db, { companyId, graceDays = 0 }) {
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (i.entity_id) i.entity_id AS lead_id, i.action_id, i.proposed_fields AS pf, i.expected_fields AS ef
         FROM sdr_change_intents i
        WHERE i.company_id = $1 AND i.entity = 'lead' AND i.reason = $2
          AND i.created_at > NOW() - make_interval(hours => $3::int)
        ORDER BY i.entity_id, i.created_at DESC),
     c AS (
       SELECT l.lead_id, l.action_id AS source_action_id,
              l.pf->'proposed_fields'->>'organization_id' AS new_org,
              l.pf->'proposed_fields'->>$4 AS new_stage,
              l.ef->>'organization_id' AS seen_org,
              l.pf->'contact_candidate'->>'selected_person_id' AS seen_person,
              l.pf->'source_evidence'->>'company' AS cmd_company,
              lower(btrim(l.pf->'contact_candidate'->'candidate'->>'email')) AS cand_email,
              btrim(l.pf->'contact_candidate'->'candidate'->>'name') AS cand_name,
              btrim(l.pf->'contact_candidate'->'candidate'->>'phone') AS cand_phone,
              s.project_stage AS cur_stage, s.lead_title
         FROM latest l JOIN sdr_lead_state s ON s.pipedrive_lead_id = l.lead_id
        WHERE l.pf->'proposed_fields' ? 'organization_id'
          AND s.crm_status = 'active' AND (s.crm_company_id IS NULL OR s.crm_company_id = $1)
          AND s.trigger_override IS NULL
          AND coalesce(btrim(s.sequence_started), '') = ''
          AND lower(btrim(coalesce(s.lead_origin, ''))) NOT LIKE 'bid invite%'
          AND s.start_date >= CURRENT_DATE - $5::int
          AND (l.pf->'proposed_fields'->>'organization_id') IS DISTINCT FROM s.pipedrive_org_id
          AND (l.ef->>'organization_id') IS NOT DISTINCT FROM s.pipedrive_org_id
          AND (l.pf->'contact_candidate'->>'selected_person_id') IS NOT DISTINCT FROM s.pipedrive_person_id)
     SELECT c.* FROM c
      WHERE c.cand_email LIKE '%_@_%._%' AND c.cand_email !~ '\\s'
        -- Nothing of ours on the lead, and no email of any kind on it (a rep's hand email included).
        AND NOT EXISTS (SELECT 1 FROM sdr_sends x WHERE x.pipedrive_lead_id = c.lead_id)
        AND NOT EXISTS (SELECT 1 FROM sdr_drafts d WHERE d.pipedrive_lead_id = c.lead_id)
        AND NOT EXISTS (SELECT 1 FROM sdr_outreach_log ol WHERE ol.pipedrive_lead_id = c.lead_id
              AND ol.sent_at > NOW() - make_interval(days => $6::int))
        AND NOT EXISTS (SELECT 1 FROM sdr_outreach_controls h WHERE h.company_id = $1 AND h.status = 'active'
              AND h.scope_kind = 'lead' AND h.scope_id = c.lead_id)
        -- The new contact has no history with us on any lead.
        AND NOT EXISTS (SELECT 1 FROM sdr_message_facts f WHERE lower(btrim(f.prospect_email)) = c.cand_email)
        AND NOT EXISTS (SELECT 1 FROM sdr_drafts d JOIN sdr_sends x ON x.draft_id = d.id
              WHERE lower(btrim(d.contact_email_snapshot)) = c.cand_email)
        AND NOT EXISTS (SELECT 1 FROM sdr_lead_state o WHERE lower(btrim(o.person_email)) = c.cand_email
              AND o.last_outgoing_mail_time > NOW() - make_interval(days => $6::int))
        -- CMD has named this one company for a while, and no other lately.
        AND (SELECT count(DISTINCT i.proposed_fields->'source_evidence'->>'company') FROM sdr_change_intents i
              WHERE i.entity = 'lead' AND i.entity_id = c.lead_id AND i.reason = $2
                AND i.created_at > NOW() - make_interval(days => $7::int)) <= 1
        AND (SELECT min(i.created_at) FROM sdr_change_intents i
              WHERE i.entity = 'lead' AND i.entity_id = c.lead_id AND i.reason = $2
                AND i.proposed_fields->'proposed_fields'->>'organization_id' = c.new_org) <= NOW() - make_interval(hours => $8::int)
        -- One swap per lead. An attempt that failed outright may be retried a couple of times;
        -- one that went through, or whose outcome was never recorded, is never repeated.
        AND NOT EXISTS (SELECT 1 FROM sdr_change_intents a WHERE a.entity = 'lead' AND a.entity_id = c.lead_id AND a.reason = $9
              AND NOT EXISTS (SELECT 1 FROM sdr_change_receipts r WHERE r.action_id = a.action_id AND r.status = 'failed'))
        AND (SELECT count(*) FROM sdr_change_intents a WHERE a.entity = 'lead' AND a.entity_id = c.lead_id AND a.reason = $9) < $10::int
      ORDER BY c.lead_id`,
    [String(companyId), HELD_REASON, PROPOSAL_WINDOW_HOURS, FIELD_KEYS.STAGE, graceDays, QUIET_DAYS, FLIP_WINDOW_DAYS, STABLE_HOURS, SWAP_REASON, MAX_ATTEMPTS],
  );
  return rows;
}

// Does the contact name belong to this mailbox? The first email greets the contact by first
// name, and CMD often pairs a name with someone else's address, a shared mailbox, or the company
// name. Those stay held. A name fits when part of it is in the mailbox name (dstrickland,
// pat.hardy), when the mailbox is an initial plus the start of a surname (dstrick), or when it
// is the person's initials (vxp).
export function nameMatchesAddress(name, email) {
  const local = text(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const tokens = text(name).toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(Boolean);
  if (!local || !tokens.length) return false;
  const [first, ...rest] = tokens;
  // tcourkamp is not Kirt Courkamp: a surname behind someone else's initial is another person.
  const otherInitial = token => token !== first && local === local[0] + token && local[0] !== first[0];
  if (tokens.some(token => token.length >= 3 && local.includes(token) && !otherInitial(token))) return true;
  if (local.length >= 4 && local[0] === first[0] && rest.some(token => token.startsWith(local.slice(1)))) return true;
  if (tokens.length < 2 || local.length < 2 || local.length > 4) return false;
  const last = tokens[tokens.length - 1];
  return local === tokens.map(token => token[0]).join('') || local === first[0] + last[0]
    || (local.length === 3 && local[0] === first[0] && local[2] === last[0]);
}

const skip = (reason, extra = {}) => ({ action: 'skip', reason, ...extra });

// One lead: live checks against Pipedrive, then (unless dryRun) the write.
export async function swapOne(pool, row, { pd = pipedriveClient, companyId, dryRun = false } = {}) {
  const leadId = text(row.lead_id);
  const newOrgId = positiveId(row.new_org);
  const email = text(row.cand_email).trim().toLowerCase();
  const wanted = normalizeCompany(row.cmd_company);
  if (!newOrgId || !wanted) return skip('company_unresolved');
  if (!looksLikeEmail(email)) return skip('no_contact');
  if (FREE_MAIL.has(email.split('@')[1])) return skip('free_mail_contact');

  const lead = await pd.getLead(leadId);
  if (!lead || text(lead.id) !== leadId || lead.is_archived === true) return skip('lead_unavailable');
  if (idOf(lead.organization_id) !== text(row.seen_org)) return skip('company_edited_since');
  if (idOf(lead.person_id) !== text(row.seen_person)) return skip('contact_edited_since');
  if (text(lead[FIELD_KEYS.SEQ]).trim()) return skip('sequence_started');
  const currentStage = text(lead[FIELD_KEYS.STAGE]).trim();
  const stage = stageDecision(currentStage, row.new_stage);
  if (!stage.ok) return skip(stage.reason);

  const org = await pd.getOrganization(newOrgId);
  if (!org || text(org.id) !== text(newOrgId) || org.active_flag === false) return skip('company_unavailable');
  if (normalizeCompany(org.name) !== wanted) return skip('company_name_mismatch');
  if (Number(org.closed_deals_count || 0) > 0 || Number(org.won_deals_count || 0) > 0 || (org.label_ids || []).includes(1) || org.label === 1) return skip('customer_company');
  if (Number(org.open_deals_count || 0) > 0) return skip('open_deal_company');
  let oldOrgName = null;
  if (lead.organization_id != null) {
    const oldOrg = await pd.getOrganization(idOf(lead.organization_id));
    oldOrgName = oldOrg?.name || null;
    if (normalizeCompany(oldOrgName) === wanted) return skip('same_company');
  }

  // The contact: reuse the person already holding this address at the new company, else create.
  const holders = await pd.findPersonsByEmail(email);
  let person = null;
  if (holders.length) {
    const atCompany = holders.filter(p => idOf(p.organization) === text(newOrgId));
    if (atCompany.length !== 1 || holders.length !== 1) return skip('contact_on_other_record');
    person = await pd.getPerson(atCompany[0].id);
    if (!person || text(person.id) !== text(atCompany[0].id) || person.active_flag === false) return skip('contact_unavailable');
    if (mailWithin(person, QUIET_DAYS)) return skip('contact_in_conversation');
  }
  const contactName = person?.name || row.cand_name || '';
  if (!nameMatchesAddress(contactName, email)) return skip('contact_name_mismatch');
  const plan = { leadId, fromCompany: oldOrgName, toCompany: org.name, toCompanyId: newOrgId, email, contactName,
    createPerson: !person, stageFrom: currentStage || null, stageTo: stage.final, stageWrite: stage.write };
  if (dryRun) return { action: 'would_apply', ...plan };

  const actionId = `swap:${leadId}:${newOrgId}:${createHash('sha256').update(text(row.source_action_id)).digest('hex').slice(0, 12)}`;
  const proposed = { organization_id: newOrgId, contact_email: email, ...(stage.write ? { [FIELD_KEYS.STAGE]: stage.final } : {}) };
  try {
    await recordChangeIntent(pool, {
      actionId, companyId, entity: 'lead', entityId: leadId,
      expectedFields: { organization_id: lead.organization_id ?? null, person_id: idOf(lead.person_id) || null, [FIELD_KEYS.STAGE]: currentStage || null },
      proposedFields: { proposed_fields: proposed, source_evidence: { company: row.cmd_company, stage: row.new_stage || null }, source_action_id: row.source_action_id },
      actor: { type: 'automation', job: 'company_swap' }, reason: SWAP_REASON,
      contextHash: createHash('sha256').update(JSON.stringify([leadId, newOrgId, row.seen_org, row.seen_person, email, stage.final])).digest('hex'),
    });
  } catch (error) {
    if (error?.code === '23505') return skip('already_attempted');
    throw error;
  }
  try {
    let created = false;
    if (!person) {
      person = await pd.createPerson({ name: contactName, email, phone: row.cand_phone || undefined, orgId: newOrgId, ownerId: positiveId(idOf(lead.owner_id)) || undefined });
      created = true;
    }
    const personId = positiveId(person?.id);
    if (!personId) throw new Error('contact_unresolved');
    const outcome = await withLeadLock(pool, leadId, async client => {
      // A draft or send that appeared since selection wins: leave the lead as it is.
      const busy = await client.query(
        `SELECT EXISTS (SELECT 1 FROM sdr_sends WHERE pipedrive_lead_id = $1) OR EXISTS (SELECT 1 FROM sdr_drafts WHERE pipedrive_lead_id = $1) AS busy`, [leadId]);
      if (busy.rows[0]?.busy) return { status: 'superseded', observed: null };
      await pd.swapLeadCompany(leadId, { organizationId: newOrgId, personId, stage: stage.write ? stage.final : undefined });
      const after = await pd.getLead(leadId);
      const observed = { organization_id: after?.organization_id ?? null, person_id: idOf(after?.person_id) || null, [FIELD_KEYS.STAGE]: text(after?.[FIELD_KEYS.STAGE]).trim() || null };
      const confirmed = idOf(after?.organization_id) === text(newOrgId) && idOf(after?.person_id) === text(personId) && observed[FIELD_KEYS.STAGE] === stage.final;
      if (confirmed) {
        // Mirror the change now, so nothing drafts for the old contact before the next sync.
        // The new address is unverified here, which keeps the lead out of automation until the
        // verifier has checked it.
        try {
          await client.query(
            `UPDATE sdr_lead_state SET pipedrive_org_id = $2, pipedrive_person_id = $3, person_name = $4, person_email = $5,
                    project_stage = $6, trigger_type = $7, last_outgoing_mail_time = $8, outreach_status = $9,
                    crm_person_source_updated_at = NULL, crm_person_source_read_started_at = NULL
              WHERE pipedrive_lead_id = $1`,
            [leadId, text(newOrgId), text(personId), person.name || contactName, email, stage.final, resolveTriggerType(after, stage.final),
              person.last_outgoing_mail_time ? new Date(`${person.last_outgoing_mail_time}`.replace(' ', 'T') + 'Z') : null,
              deriveStatus({ lastOutgoing: person.last_outgoing_mail_time || null, seqStarted: null })]);
        } catch (error) { console.warn(`[company-swap] lead ${leadId}: local state not updated (${error.message}); the next sync corrects it`); }
      }
      return { status: confirmed ? 'confirmed' : 'unresolved', observed };
    });
    await recordChangeReceipt(pool, { actionId, status: outcome.status, providerReceipt: { person_id: personId, person_created: created }, observedFields: outcome.observed });
    if (outcome.status === 'superseded') return skip('draft_or_send_appeared');
    if (outcome.status !== 'confirmed') return { action: 'unresolved', ...plan };
    try {
      await pd.addNote({ leadId, content:
        `[Auto] Company updated from CMD: ${escapeHtml(oldOrgName || 'none')} to ${escapeHtml(org.name)}.`
        + (stage.write ? ` Project Stage: ${escapeHtml(currentStage || 'blank')} to ${escapeHtml(stage.final)}.` : '')
        + ` Contact set to ${escapeHtml(contactName)} (${escapeHtml(email)}), the contact CMD lists for this company. Role not confirmed.` });
    } catch (error) { console.warn(`[company-swap] lead ${leadId}: note not added (${error.message})`); }
    return { action: 'applied', ...plan, personId, personCreated: created };
  } catch (error) {
    await recordChangeReceipt(pool, { actionId, status: 'failed', providerReceipt: { error: text(error?.message).slice(0, 200) } }).catch(() => {});
    throw error;
  }
}

// One pass. Stops at `limit` applied leads, or at a Pipedrive rate limit.
export async function runCompanySwap(pool, { pd = pipedriveClient, companyId = process.env.SDR_CRM_COMPANY_ID, limit = companySwapLimit(), dryRun = false, only = null } = {}) {
  const stats = { candidates: 0, applied: 0, wouldApply: 0, unresolved: 0, failed: 0, skipped: {}, rateLimited: false, leads: [] };
  if (!companyId) return { ...stats, error: 'company_scope_missing' };
  const settings = (await pool.query('SELECT start_date_grace_days FROM sdr_settings WHERE id = 1')).rows[0];
  let rows = await selectSwapCandidates(pool, { companyId, graceDays: settings?.start_date_grace_days ?? 0 });
  if (only) rows = rows.filter(row => only.includes(text(row.lead_id)));
  stats.candidates = rows.length;
  for (const row of rows) {
    if (stats.applied + stats.wouldApply >= limit) break;
    let result;
    try { result = await swapOne(pool, row, { pd, companyId, dryRun }); }
    catch (error) {
      if (Number(error?.status) === 429) { stats.rateLimited = true; break; }
      stats.failed++;
      console.warn(`[company-swap] lead ${row.lead_id} failed: ${error.message}`);
      continue;
    }
    if (result.action === 'skip') stats.skipped[result.reason] = (stats.skipped[result.reason] || 0) + 1;
    else if (result.action === 'applied') { stats.applied++; stats.leads.push(result); }
    else if (result.action === 'would_apply') { stats.wouldApply++; stats.leads.push(result); }
    else stats.unresolved++;
  }
  return stats;
}
