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
//   - no Sequence_Started marker, no staff trigger override, not a Bid Invite lead
//   - no active email hold on the lead, on the old or the new address, or on the whole channel
//   - inside the start-date window automation uses
//   - CMD has named the same single company for at least a day, and no other in 14 days
//   - the result is an award stage (LBA, AGC, GC) and the stage never moves backward
//   - the Pipedrive company carries the name CMD gave, and it is not the old company renamed
//   - the new company is not a customer and has no open deal
//   - the contact is at a company domain, has never been emailed by .co, and has no mail with
//     staff in 60 days
//   - the contact's name fits the mailbox (not another person's address, a shared mailbox, or
//     the company name standing in for a person)
//
// Per lead, everything from the last eligibility check to the receipt runs under the lead lock,
// and the lead is read once more right before the write. It sets company + contact (+ stage) in
// one lead PATCH, adds a note, and journals an intent and a receipt. It never sends anything:
// the lead then goes through the normal automation path, which verifies the address and applies
// every send guard before a first email.
//
// OFF unless SDR_COMPANY_SWAP=on. SDR_COMPANY_SWAP_LIMIT caps leads per run (default 25).
import { createHash } from 'node:crypto';
import * as pipedriveClient from './pipedriveClient.js';
import { withLeadLock } from './sdrAccess.js';
import { recordChangeIntent, recordChangeReceipt } from './sdrChangeJournal.js';
import { FIELD_KEYS, resolveTriggerType, deriveStatus, daysSince, personEmail, sourceTimestamp } from './pipedriveSync.js';
import { looksLikeEmail } from './emailVerify.js';
import { NOT_A_NAME } from './bidInviteCopy.js';

export const HELD_REASON = 'Review CMD changes against current staff selections';
export const SWAP_REASON = 'CMD company change applied';
export const PROPOSAL_WINDOW_HOURS = 36;  // n8n refreshes twice a day; older means no longer proposed
export const STABLE_HOURS = 24;           // CMD must have named this company for at least this long
export const FLIP_WINDOW_DAYS = 14;       // ...and no other company in this window
export const QUIET_DAYS = 60;             // no mail on the lead or with the contact in this window
export const MAX_ATTEMPTS = 3;
export const RUN_BUDGET_MS = 5 * 60 * 1000;   // one pass never runs longer than this
export const CALL_DEADLINE_MS = 20 * 1000;    // ...and no single Pipedrive call longer than this

const AWARD_STAGES = new Set(['LBA', 'AGC', 'GC']);
const STAGE_RANK = { 'CD': 0, 'Pre-Bid': 1, 'OB': 2, 'PB': 3, 'LBA': 4, 'AGC': 5, 'CM': 5, 'GC': 6 };
// Personal and ISP mailboxes: the same list the n8n contact parser treats as personal, plus two ISPs.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'fastmail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'comcast.net', 'sbcglobal.net',
  'att.net', 'verizon.net', 'cox.net', 'charter.net', 'earthlink.net', 'bellsouth.net', 'frontiernet.net', 'windstream.net']);
// Same rule the n8n "Org Compare" node uses to decide two names are one company.
const SUFFIX = new Set(['inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd', 'lp', 'llp', 'incorporated', 'the', 'pllc', 'pc', 'limited']);
const LEGAL_FORM = new Set(['inc', 'llc', 'corp', 'corporation', 'company', 'ltd', 'llp', 'incorporated', 'pllc', 'limited']);
const NAME_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

export const companySwapEnabled = () => process.env.SDR_COMPANY_SWAP === 'on';
export function companySwapLimit() {
  const n = Number(process.env.SDR_COMPANY_SWAP_LIMIT);
  return Number.isInteger(n) && n >= 0 ? n : 25;
}

export const normalizeCompany = name => String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
  .split(' ').filter(token => token && !SUFFIX.has(token)).join(' ');

// The lead already sits on this company: the same name, or one name inside the other, which is
// how a branch or division record of one company reads ("J Raymond Construction" and
// "J Raymond Construction - Longwood (HQ)"). Nothing to swap.
export function sameCompany(a, b) {
  const one = normalizeCompany(a).split(' ').filter(Boolean);
  const two = normalizeCompany(b).split(' ').filter(Boolean);
  if (!one.length || !two.length) return false;
  if (one.join(' ') === two.join(' ')) return true;
  const [short, long] = one.length <= two.length ? [one, two] : [two, one];
  return short.length >= 2 && short.every(token => long.includes(token));
}
// A city, state or federal mailbox (delaware.gov, ci.pleasant-hill.ca.us). CMD sometimes lists the
// project owner where the winning contractor goes, and an agency does not buy a SWPPP from us.
const PUBLIC_AGENCY_DOMAIN = /(^|\.)(gov|mil)$|\.[a-z]{2}\.us$/;

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

// Is this mailbox the named person's own? The first email greets the contact by first name, and
// CMD often pairs a name with someone else's address, a shared mailbox, or the company name.
// Those stay held. Only the usual personal formats count: the first name (jeff), the surname
// (liming), both in either order (pat.hardy, hardypat), an initial with the surname (dstrickland,
// stricklandd, amcarino with a middle initial), the first name with a surname initial (rodj), an
// initial with a clipped surname (dstrick), or every initial of a three-part name (jjh).
// A piece of the name inside a longer word is never enough: "tim" is inside "estimating".
export function nameMatchesAddress(name, email, company = '') {
  const local = text(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const all = text(name).toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(Boolean);
  if (!local || !all.length) return false;
  // A company, a role or a team written where a person's name goes.
  if (all.some(token => LEGAL_FORM.has(token) || NOT_A_NAME.has(token))) return false;
  const companyTokens = normalizeCompany(company).split(' ').filter(Boolean);
  if (companyTokens.length && (companyTokens.every(token => all.includes(token)) || all.every(token => companyTokens.includes(token)))) return false;
  const tokens = all.filter(token => !NAME_SUFFIX.has(token));
  if (!tokens.length) return false;
  const [first, ...rest] = tokens;
  if (first.length >= 2 && local === first) return true;
  const surnames = rest.filter(token => token.length >= 2);
  if (surnames.length > 1) surnames.push(surnames.join(''));
  for (const last of surnames) {
    if (last.length >= 3 && local === last) return true;
    if ([first + last, last + first, first[0] + last, first + last[0], last + first[0]].includes(local)) return true;
    if (last.length >= 4 && local.length === last.length + 2 && local[0] === first[0] && local.endsWith(last)) return true;
    if (local.length >= 5 && local.length <= last.length && local[0] === first[0] && last.startsWith(local.slice(1))) return true;
  }
  return tokens.length >= 3 && local === tokens.map(token => token[0]).join('');
}

// Held company changes on untouched leads. Everything checkable from our own tables is here;
// the live Pipedrive checks are in liveChecks. `leadId` narrows it to one lead: the recheck
// made under the lead lock.
export async function selectSwapCandidates(db, { companyId, graceDays = 0, leadId = null }) {
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (i.entity_id) i.entity_id AS lead_id, i.action_id, i.proposed_fields AS pf, i.expected_fields AS ef
         FROM sdr_change_intents i
        WHERE i.company_id = $1 AND i.entity = 'lead' AND i.reason = $2
          AND i.created_at > NOW() - make_interval(hours => $3::int)
          AND ($11::text IS NULL OR i.entity_id = $11)
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
              lower(btrim(coalesce(s.person_email, ''))) AS cur_email,
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
        -- No active email hold: anything tied to this lead, a hold on the old or the new address,
        -- or a hold on the whole email channel.
        AND NOT EXISTS (SELECT 1 FROM sdr_outreach_controls h WHERE h.company_id = $1 AND h.status = 'active'
              AND (h.channel IS NULL OR h.channel = 'email')
              AND (h.lead_id = c.lead_id
                OR h.lead_id IS NULL AND (h.scope_kind = 'lead' AND h.scope_id = c.lead_id
                  OR h.scope_kind = 'recipient' AND lower(btrim(h.scope_id)) IN (c.cand_email, c.cur_email)
                  OR h.scope_kind = 'channel' AND h.scope_id = 'email')))
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
        -- One swap per lead. An attempt Pipedrive certainly refused may be retried a couple of
        -- times; one that went through, or whose outcome is not known, is never repeated.
        AND NOT EXISTS (SELECT 1 FROM sdr_change_intents a WHERE a.entity = 'lead' AND a.entity_id = c.lead_id AND a.reason = $9
              AND NOT (EXISTS (SELECT 1 FROM sdr_change_receipts r WHERE r.action_id = a.action_id AND r.status = 'failed')
                AND NOT EXISTS (SELECT 1 FROM sdr_change_receipts r WHERE r.action_id = a.action_id AND r.status <> 'failed')))
        AND (SELECT count(*) FROM sdr_change_intents a WHERE a.entity = 'lead' AND a.entity_id = c.lead_id AND a.reason = $9) < $10::int
      ORDER BY c.lead_id`,
    [String(companyId), HELD_REASON, PROPOSAL_WINDOW_HOURS, FIELD_KEYS.STAGE, graceDays, QUIET_DAYS, FLIP_WINDOW_DAYS, STABLE_HOURS, SWAP_REASON, MAX_ATTEMPTS,
      leadId == null ? null : String(leadId)],
  );
  return rows;
}

const skip = reason => ({ action: 'skip', reason });

// Every Pipedrive call gets a deadline, so one hung request cannot stall the sync loop.
const PD_CALLS = ['getLead', 'getOrganization', 'findPersonsByEmail', 'getPerson', 'createPerson', 'swapLeadCompany', 'addNote'];
const withDeadline = (pd, ms) => Object.fromEntries(PD_CALLS.map(name => [name, (...args) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`pipedrive_timeout:${name}`), { timedOut: true })), ms); });
  return Promise.race([Promise.resolve().then(() => pd[name](...args)), late]).finally(() => clearTimeout(timer));
}]));

// What the lead shows right now: compared between the checks and the write.
const identityOf = lead => JSON.stringify([idOf(lead?.organization_id), idOf(lead?.person_id), text(lead?.[FIELD_KEYS.SEQ]).trim(),
  text(lead?.[FIELD_KEYS.STAGE]).trim(), lead?.is_archived === true]);

// The live Pipedrive checks for one candidate: { skip } or everything the write needs.
async function liveChecks(pd, row) {
  const leadId = text(row.lead_id);
  const newOrgId = positiveId(row.new_org);
  const email = text(row.cand_email).trim().toLowerCase();
  const wanted = normalizeCompany(row.cmd_company);
  if (!newOrgId || !wanted) return { skip: skip('company_unresolved') };
  if (!looksLikeEmail(email)) return { skip: skip('no_contact') };
  if (FREE_MAIL.has(email.split('@')[1])) return { skip: skip('free_mail_contact') };
  if (PUBLIC_AGENCY_DOMAIN.test(email.split('@')[1])) return { skip: skip('public_agency_contact') };

  const lead = await pd.getLead(leadId);
  if (!lead || text(lead.id) !== leadId || lead.is_archived === true) return { skip: skip('lead_unavailable') };
  if (idOf(lead.organization_id) !== text(row.seen_org)) return { skip: skip('company_edited_since') };
  if (idOf(lead.person_id) !== text(row.seen_person)) return { skip: skip('contact_edited_since') };
  if (text(lead[FIELD_KEYS.SEQ]).trim()) return { skip: skip('sequence_started') };
  const currentStage = text(lead[FIELD_KEYS.STAGE]).trim();
  const stage = stageDecision(currentStage, row.new_stage);
  if (!stage.ok) return { skip: skip(stage.reason) };

  const org = await pd.getOrganization(newOrgId);
  if (!org || text(org.id) !== text(newOrgId) || org.active_flag === false) return { skip: skip('company_unavailable') };
  if (normalizeCompany(org.name) !== wanted) return { skip: skip('company_name_mismatch') };
  if (Number(org.closed_deals_count || 0) > 0 || Number(org.won_deals_count || 0) > 0 || (org.label_ids || []).includes(1) || org.label === 1) return { skip: skip('customer_company') };
  if (Number(org.open_deals_count || 0) > 0) return { skip: skip('open_deal_company') };
  let oldOrgName = null;
  if (lead.organization_id != null) {
    const oldOrg = await pd.getOrganization(idOf(lead.organization_id));
    oldOrgName = oldOrg?.name || null;
    if (sameCompany(oldOrgName, org.name)) return { skip: skip('same_company') };
  }

  // The contact: reuse the one person holding this address at the new company, else create.
  const holders = await pd.findPersonsByEmail(email);
  let person = null;
  if (holders.length) {
    const atCompany = holders.filter(p => idOf(p.organization) === text(newOrgId));
    if (atCompany.length !== 1 || holders.length !== 1) return { skip: skip('contact_on_other_record') };
    person = await pd.getPerson(atCompany[0].id);
    if (!person || text(person.id) !== text(atCompany[0].id) || person.active_flag === false) return { skip: skip('contact_unavailable') };
    // The search also matches a secondary address and can lag a company change. The sync and
    // every send use the person's primary address, so the record itself must show both.
    if (idOf(person.org_id) !== text(newOrgId)) return { skip: skip('contact_on_other_record') };
    if (text(personEmail(person)).trim().toLowerCase() !== email) return { skip: skip('contact_address_not_primary') };
    if (mailWithin(person, QUIET_DAYS)) return { skip: skip('contact_in_conversation') };
  }
  const contactName = text(person?.name || row.cand_name).trim();
  if (!nameMatchesAddress(contactName, email, org.name)) return { skip: skip('contact_name_mismatch') };
  return { lead, newOrgId, email, org, oldOrgName, person, contactName, currentStage, stage,
    plan: { leadId, fromCompany: oldOrgName, toCompany: org.name, toCompanyId: newOrgId, email, contactName,
      createPerson: !person, stageFrom: currentStage || null, stageTo: stage.final, stageWrite: stage.write } };
}

// One lead. A dry run does the live checks and stops. A real run holds the lead lock from the
// last eligibility check to the receipt, so no draft, send, hold or second attempt of ours can
// slip in between, and reads the lead once more right before the write for staff edits.
export async function swapOne(pool, row, { pd: rawPd = pipedriveClient, companyId, graceDays = 0, dryRun = false, callDeadlineMs = CALL_DEADLINE_MS } = {}) {
  const pd = withDeadline(rawPd, callDeadlineMs);
  if (dryRun) {
    const live = await liveChecks(pd, row);
    return live.skip || { action: 'would_apply', ...live.plan };
  }
  const leadId = text(row.lead_id);
  const outcome = await withLeadLock(pool, leadId, async client => {
    // Still eligible by the same selection: no send, draft, hand email, hold or override has
    // appeared, this proposal is still the latest, and no other attempt went through.
    const [again] = await selectSwapCandidates(client, { companyId, graceDays, leadId });
    if (!again || again.source_action_id !== row.source_action_id || again.new_org !== row.new_org || again.cand_email !== row.cand_email) return skip('no_longer_eligible');
    const live = await liveChecks(pd, again);
    if (live.skip) return live.skip;
    const { newOrgId, email, org, oldOrgName, contactName, currentStage, stage, plan } = live;
    let { person } = live;

    const actionId = `swap:${leadId}:${newOrgId}:${createHash('sha256').update(text(again.source_action_id)).digest('hex').slice(0, 12)}`;
    const proposed = { organization_id: newOrgId, contact_email: email, ...(stage.write ? { [FIELD_KEYS.STAGE]: stage.final } : {}) };
    try {
      // Journal rows go through the pool, not this transaction: they must survive a rollback.
      await recordChangeIntent(pool, {
        actionId, companyId, entity: 'lead', entityId: leadId,
        expectedFields: { organization_id: live.lead.organization_id ?? null, person_id: idOf(live.lead.person_id) || null, [FIELD_KEYS.STAGE]: currentStage || null },
        proposedFields: { proposed_fields: proposed, source_evidence: { company: again.cmd_company, stage: again.new_stage || null }, source_action_id: again.source_action_id },
        actor: { type: 'automation', job: 'company_swap' }, reason: SWAP_REASON,
        contextHash: createHash('sha256').update(JSON.stringify([leadId, newOrgId, again.seen_org, again.seen_person, email, stage.final])).digest('hex'),
      });
    } catch (error) {
      if (error?.code === '23505') return skip('already_attempted');
      throw error;
    }
    const failure = error => ({ error: text(error?.message).slice(0, 200) });
    let created = false;
    let personId = null;
    const receipt = (status, extra = {}, observedFields = null) => recordChangeReceipt(pool, { actionId, status,
      providerReceipt: { person_id: personId, person_created: created, ...extra }, observedFields });

    // Until the PATCH nothing on the lead has changed, so an error here is a plain failure.
    let before;
    try {
      if (!person) {
        person = await pd.createPerson({ name: contactName, email, phone: again.cand_phone || undefined, orgId: newOrgId, ownerId: positiveId(idOf(live.lead.owner_id)) || undefined });
        created = true;
      }
      personId = positiveId(person?.id);
      if (!personId) throw new Error('contact_unresolved');
      // Pipedrive has no conditional write, so read the lead once more right before writing.
      before = await pd.getLead(leadId);
    } catch (error) {
      await receipt('failed', failure(error)).catch(() => {});
      throw error;
    }
    if (identityOf(before) !== identityOf(live.lead)) {
      await receipt('superseded');
      return skip('changed_before_write');
    }

    try {
      await pd.swapLeadCompany(leadId, { organizationId: newOrgId, personId, stage: stage.write ? stage.final : undefined });
    } catch (error) {
      // A 4xx answer means Pipedrive refused the write. Anything else (5xx, timeout, network)
      // may have gone through: that is "unresolved", is never retried, and the next sync shows
      // what the lead really holds.
      const status = Number(error?.status);
      const refused = status >= 400 && status < 500 && status !== 408;
      await receipt(refused ? 'failed' : 'unresolved', failure(error)).catch(() => {});
      if (refused) throw error;
      console.warn(`[company-swap] lead ${leadId}: write outcome unknown (${error.message})`);
      return { action: 'unresolved', ...plan };
    }

    const readStartedAt = new Date();
    let after;
    try { after = await pd.getLead(leadId); }
    catch (error) {
      await receipt('unresolved', failure(error)).catch(() => {});
      return { action: 'unresolved', ...plan };
    }
    const observed = { organization_id: after?.organization_id ?? null, person_id: idOf(after?.person_id) || null, [FIELD_KEYS.STAGE]: text(after?.[FIELD_KEYS.STAGE]).trim() || null };
    const confirmed = idOf(after?.organization_id) === text(newOrgId) && idOf(after?.person_id) === text(personId) && observed[FIELD_KEYS.STAGE] === stage.final;
    if (confirmed) {
      // Mirror the change now, so nothing drafts for the old contact before the next sync. The
      // new address is unverified here, which keeps the lead out of automation until the
      // verifier has checked it. The source stamps move to this read, so a sync pass that
      // listed the lead before the write cannot put the old company and contact back.
      try {
        await client.query('SAVEPOINT company_swap_mirror');
        await client.query(
          `UPDATE sdr_lead_state SET pipedrive_org_id = $2, pipedrive_person_id = $3, person_name = $4, person_email = $5,
                  project_stage = $6, trigger_type = $7, last_outgoing_mail_time = $8, outreach_status = $9,
                  crm_source_updated_at = COALESCE($10::timestamptz, crm_source_updated_at), crm_source_read_started_at = $11,
                  crm_person_source_updated_at = NULL, crm_person_source_read_started_at = $11
            WHERE pipedrive_lead_id = $1`,
          [leadId, text(newOrgId), text(personId), person.name || contactName, email, stage.final, resolveTriggerType(after, stage.final),
            person.last_outgoing_mail_time ? new Date(`${person.last_outgoing_mail_time}`.replace(' ', 'T') + 'Z') : null,
            deriveStatus({ lastOutgoing: person.last_outgoing_mail_time || null, seqStarted: null }),
            sourceTimestamp(after?.update_time), readStartedAt]);
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT company_swap_mirror').catch(() => {});
        console.warn(`[company-swap] lead ${leadId}: local state not updated (${error.message}); the next sync corrects it`);
      }
    }
    await receipt(confirmed ? 'confirmed' : 'unresolved', {}, observed);
    if (!confirmed) return { action: 'unresolved', ...plan };
    return { action: 'applied', ...plan, personId, personCreated: created,
      note: `[Auto] Company updated from CMD: ${escapeHtml(oldOrgName || 'none')} to ${escapeHtml(org.name)}.`
        + (stage.write ? ` Project Stage: ${escapeHtml(currentStage || 'blank')} to ${escapeHtml(stage.final)}.` : '')
        + ` Contact set to ${escapeHtml(contactName)} (${escapeHtml(email)}), the contact CMD lists for this company. Role not confirmed.` };
  });
  if (outcome.action !== 'applied') return outcome;
  const { note, ...applied } = outcome;
  try { await pd.addNote({ leadId, content: note }); }
  catch (error) {
    console.warn(`[company-swap] lead ${leadId}: note not added (${error.message})`);
    if (Number(error?.status) === 429) applied.rateLimited = true;
  }
  return applied;
}

// A proposal row already checked and skipped by this process is not read from Pipedrive again:
// its answer only changes with the next refresh, which writes a new proposal row.
const settled = new Set();

// One pass. Stops at `limit` applied leads, at the time budget, or at a Pipedrive rate limit.
export async function runCompanySwap(pool, { pd = pipedriveClient, companyId = process.env.SDR_CRM_COMPANY_ID, limit = companySwapLimit(), dryRun = false, only = null,
  budgetMs = RUN_BUDGET_MS, callDeadlineMs = CALL_DEADLINE_MS } = {}) {
  const stats = { candidates: 0, applied: 0, wouldApply: 0, unresolved: 0, failed: 0, skipped: {}, rateLimited: false, outOfTime: false, leads: [] };
  if (!companyId) return { ...stats, error: 'company_scope_missing' };
  const settings = (await pool.query('SELECT start_date_grace_days FROM sdr_settings WHERE id = 1')).rows[0];
  const graceDays = settings?.start_date_grace_days ?? 0;
  let rows = await selectSwapCandidates(pool, { companyId, graceDays });
  if (only) rows = rows.filter(row => only.includes(text(row.lead_id)));
  stats.candidates = rows.length;
  const startedAt = Date.now();
  const count = reason => { stats.skipped[reason] = (stats.skipped[reason] || 0) + 1; };
  for (const row of rows) {
    if (stats.applied + stats.wouldApply >= limit) break;
    if (Date.now() - startedAt >= budgetMs) { stats.outOfTime = true; break; }
    const key = `${row.lead_id}|${row.source_action_id}`;
    if (!dryRun && settled.has(key)) { count('checked_earlier'); continue; }
    let result;
    try { result = await swapOne(pool, row, { pd, companyId, graceDays, dryRun, callDeadlineMs }); }
    catch (error) {
      if (Number(error?.status) === 429) { stats.rateLimited = true; break; }
      stats.failed++;
      console.warn(`[company-swap] lead ${row.lead_id} failed: ${error.message}`);
      continue;
    }
    if (result.action === 'skip') {
      count(result.reason);
      if (!dryRun) { if (settled.size >= 20000) settled.clear(); settled.add(key); }
    } else if (result.action === 'applied') { stats.applied++; stats.leads.push(result); }
    else if (result.action === 'would_apply') { stats.wouldApply++; stats.leads.push(result); }
    else stats.unresolved++;
    if (result.rateLimited) { stats.rateLimited = true; break; }
  }
  return stats;
}
