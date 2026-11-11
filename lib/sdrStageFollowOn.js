// Stage follow-on: one more sequence for a contact whose earlier sequence ran to its last step,
// on a project that then moved forward a stage (2026-11-11).
//
// #51 turned the re-enroll half of the auto-switch off because it removed live memberships and
// re-emailed people with no regard for what had happened since. This is the narrow replacement.
// It never touches an Apollo membership. It only looks at sends whose sequence finished by
// itself, and it drafts and sends through the normal automatic path, so every send-path check
// still applies. What it adds is the proof in lib/sdrFollowOnPermit.js (same lead, person,
// company and address, an allowed hop, one earlier send, nobody emailed by hand since, no reply,
// last email at most 30 days old) and the checks below.
//
// A refusal at send time leaves the draft pending for a rep, and that draft then blocks any later
// follow-on for the lead. So everything the send path would refuse is checked here first, live,
// before a draft exists. The dry run does all of it and writes nothing.
//
// Env: SDR_STAGE_FOLLOW_ON=on, SDR_STAGE_FOLLOW_ON_LIMIT (drafts per pass, default 3, at most 25),
// SDR_STAGE_FOLLOW_ON_ONLY (comma-separated earlier send ids, for a canary; the guard checks it
// again at send time).
import {randomUUID} from 'node:crypto';
import * as apolloClient from './apolloClient.js';
import {buildDraftFromLead} from './sdrDraftGenerator.js';
import {dailyCap,mailboxBounceHealth} from './sendRamp.js';
import {withLeadLock} from './sdrAccess.js';
import {assertOutreachAllowed} from './sdrOutreachControls.js';
import {recentReplyEmails,normalEmail} from './recentReply.js';
import {isCustomerLead} from './customerSuppression.js';
import {bidInviteLeadFor} from './bidInviteGuard.js';
import {sendableVerdict} from './autoOutreach.js';
import {readContactSendDaysAgo} from './apolloCollision.js';
import {crmLifecycleEnabled} from './sdrCrmGuard.js';
import {getPolicyRollout,policyRequiresReview} from './sdrPolicyRollout.js';
import {followOnFacts,finishedMembershipOnly,stageFollowOnEnabled,stageFollowOnOnly,FOLLOW_ON_HOPS,FOLLOW_ON_MAX_AGE_DAYS} from './sdrFollowOnPermit.js';

export {stageFollowOnEnabled,stageFollowOnOnly};

const MAX_LIMIT = 25;
// Leads that already have a follow-on draft are left out in SQL, so this is a ceiling on leads
// still waiting, not on history. Reaching it is reported (truncated).
const SCAN_LIMIT = 1000;
// The earlier send can be up to a full drip older than its last email.
const SELECT_WINDOW_DAYS = FOLLOW_ON_MAX_AGE_DAYS + 45;
const LEAD_KEYS = ['crm_company_id','trigger_type','pipedrive_person_id','pipedrive_org_id','person_email','project_stage','trigger_override'];

export function stageFollowOnLimit() {
  const n = Number(process.env.SDR_STAGE_FOLLOW_ON_LIMIT);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_LIMIT) : 3;
}

// Pipedrive, Apollo or the database not answering (5xx, a dropped or timed-out connection). The
// pass stops on these: a lead is never judged on a read that did not happen.
const NETWORK = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_[A-Z_]+)$/;
export function upstreamDown(error) {
  const status = Number(error?.status ?? error?.response?.status);
  if (Number.isFinite(status) && status >= 500) return true;
  if (NETWORK.test(String(error?.code ?? error?.cause?.code ?? ''))) return true;
  return ['AbortError','TimeoutError'].includes(error?.name) || /fetch failed/i.test(String(error?.message ?? ''));
}

const lower = value => String(value ?? '').trim().toLowerCase();
const text = value => String(value ?? '');
// Pipedrive mail times come without a zone ("2026-11-01 14:03:22"); they are UTC.
const crmTime = value => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value);
  const at = new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isFinite(+at) ? at : undefined; // undefined: present but unreadable
};

/**
 * One pass. Dry run reads only (our tables, Apollo and Pipedrive reads) and writes nothing.
 * @returns {skipped} or {dryRun,candidates,ready,created,enrolled,deferred,skippedBy,stopped?,truncated?,leads}
 */
export async function runStageFollowOn(pool, {
  apollo = apolloClient, mailboxSentToday, enrollDrafts, dryRun = false, limit = stageFollowOnLimit(), only = stageFollowOnOnly(),
  companyId = process.env.SDR_CRM_COMPANY_ID, now = new Date(), build = buildDraftFromLead, isCustomer = isCustomerLead,
  lifecycleEnabled = crmLifecycleEnabled(),
} = {}) {
  if (!dryRun && !stageFollowOnEnabled()) return {skipped:'disabled'};
  if (!companyId) return {skipped:'company_scope_unverified'};
  if (typeof mailboxSentToday !== 'function' || (!dryRun && typeof enrollDrafts !== 'function')) return {skipped:'not_wired'};
  const settings = (await pool.query('SELECT * FROM sdr_settings WHERE id=1')).rows[0];
  if (!settings) return {skipped:'settings_unreadable'};
  if (!dryRun && !(settings.auto_outreach_enabled && settings.auto_outreach_mode === 'send')) return {skipped:'automatic_sending_off'};
  const cooldown = settings.contact_cooldown_days ?? 14;
  if (!Number.isInteger(cooldown) || cooldown < 0) return {skipped:'cooldown_unreadable'};
  const maxCreate = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, MAX_LIMIT) : 0;
  const out = {dryRun, candidates:0, ready:0, created:0, enrolled:0, deferred:0, skippedBy:{}, leads:[]};
  if (only && !only.length) return out;
  if (!dryRun && !maxCreate) return out;

  const {rows:candidates} = await pool.query(
    `SELECT s.id::text AS send_id, s.pipedrive_lead_id AS lead_id, s.enrolled_trigger || '>' || ls.trigger_type AS hop
       FROM sdr_sends s JOIN sdr_lead_state ls ON ls.pipedrive_lead_id = s.pipedrive_lead_id
      WHERE s.status IN ('enrolled','sent') AND s.step_status = 'completed'
        AND (s.enrolled_trigger || '>' || ls.trigger_type) = ANY($1::text[])
        AND ls.pipedrive_person_id::text = s.enrolled_person_id::text AND ls.pipedrive_org_id::text = s.enrolled_org_id::text
        AND s.sent_at > $2::timestamptz - make_interval(days => $3::int)
        AND ($4::text[] IS NULL OR s.id::text = ANY($4::text[]))
        AND NOT EXISTS (SELECT 1 FROM sdr_drafts fd WHERE fd.pipedrive_lead_id = s.pipedrive_lead_id AND fd.metadata->'follow_on' IS NOT NULL)
      ORDER BY s.sent_at ASC, s.id ASC LIMIT ${SCAN_LIMIT}`,
    [Object.keys(FOLLOW_ON_HOPS), now, SELECT_WINDOW_DAYS, only],
  );
  out.candidates = candidates.length;
  if (candidates.length >= SCAN_LIMIT) out.truncated = true;
  if (!candidates.length) return out;

  const mailboxes = new Map((await pool.query(
    `SELECT id::text AS id, email, owner_user_id, apollo_mailbox_id, warmup_started_at, daily_send_limit
       FROM sdr_mailboxes WHERE active = TRUE AND apollo_mailbox_id IS NOT NULL AND owner_user_id IS NOT NULL`)).rows.map(m => [m.id, m]));
  const health = await mailboxBounceHealth(pool);
  const used = new Map();
  const remaining = async mb => {
    if (!used.has(mb.id)) used.set(mb.id, await mailboxSentToday(mb.id));
    return dailyCap(mb.warmup_started_at, {target:mb.daily_send_limit, health:health.get(mb.id) ?? health.get(String(mb.id))}) - used.get(mb.id);
  };
  const replied = await recentReplyEmails(pool);
  // One Apollo read per sequence per pass: is it running, and for the award hop, is it really a
  // single automatic email. An unreadable sequence is a skip here (the send path lets it through).
  const sequences = new Map();
  const sequenceState = async id => {
    if (!sequences.has(id)) {
      let state = null;
      try {
        const detail = await apollo.getSequenceDetail(id);
        const steps = Array.isArray(detail?.emailer_steps) ? detail.emailer_steps : null;
        if (typeof detail?.emailer_campaign?.active === 'boolean') state = {active:detail.emailer_campaign.active,
          singleAutoStep:Boolean(steps && steps.length === 1 && steps[0]?.type === 'auto_email')};
      } catch (error) { if (error?.status === 429 || upstreamDown(error)) throw error; }
      sequences.set(id, state);
    }
    return sequences.get(id);
  };
  const days = at => Math.floor((+now - +new Date(at)) / 86400000);
  const created = [];

  for (const cand of candidates) {
    if (!dryRun && created.length >= maxCreate) break;
    const entry = {sendId:cand.send_id, leadId:text(cand.lead_id), hop:cand.hop, result:'skipped'};
    out.leads.push(entry);
    const skip = reason => { entry.reason = reason; out.skippedBy[reason] = (out.skippedBy[reason] || 0) + 1; };
    try {
      const facts = await followOnFacts(pool, {priorSendId:cand.send_id, companyId, now, lifecycleEnabled});
      if (!facts.ok) { skip(facts.reason); continue; }
      const {prior} = facts;
      if (facts.otherOps.length) { skip('other_provider_operation'); continue; }
      // The send path sends an automatic draft without a rep. Where the outreach policy asks for
      // a review (enforce mode, or the lead is in an active cohort), this pass makes no draft.
      const rollout = await getPolicyRollout(pool, {companyId, leadId:prior.leadId});
      if (policyRequiresReview(rollout, {companyId})) { skip('policy_review_required'); continue; }

      // Cooldown, as the send path reads it: our sends and messages for the contact and the
      // address, and the outreach ledger for the lead.
      const contactDays = await readContactSendDaysAgo(pool, {apolloContactId:prior.contactId, recipientEmail:prior.email, now:+now});
      if (days(facts.lastTouchAt) <= cooldown || (contactDays !== null && contactDays <= cooldown)) { skip('contact_cooldown'); continue; }

      const lead = (await pool.query(`SELECT ls.*, (ls.start_date >= $2::date - $3::int) AS start_ok
        FROM sdr_lead_state ls WHERE ls.pipedrive_lead_id = $1`, [prior.leadId, now.toISOString().slice(0, 10), settings.start_date_grace_days ?? 0])).rows[0];
      if (!lead) { skip('lead_missing'); continue; }
      if (lead.start_ok !== true) { skip('start_date_passed'); continue; }
      if (settings.auto_min_score != null && !(Number(lead.lead_score) >= Number(settings.auto_min_score))) { skip('score_below_minimum'); continue; }
      if (sendableVerdict(lead, lead.person_email, +now) !== 'valid') { skip('address_not_verified_valid'); continue; }
      if (replied.has(normalEmail(prior.email))) { skip('recent_reply'); continue; }
      if (await bidInviteLeadFor(pool, {leadId:prior.leadId, personId:prior.personId, emails:[prior.email]})) { skip('bid_invite_warm_lead'); continue; }
      const draftId = randomUUID();
      const context = {companyId, leadId:prior.leadId, draftId, recipientEmail:lead.person_email, channel:'email', serviceId:null};
      await assertOutreachAllowed(pool, context, {action:'generate_draft'});

      const mb = mailboxes.get(prior.mailboxId);
      if (!mb) { skip('prior_sender_inactive'); continue; }
      if (await remaining(mb) <= 0) { skip('sender_at_daily_cap'); continue; }

      const sequence = await sequenceState(facts.sequenceId);
      if (!sequence) { skip('sequence_unverified'); continue; }
      if (!sequence.active) { skip('sequence_paused'); continue; }
      if (facts.cadence === 'award_only' && !sequence.singleAutoStep) { skip('award_sequence_unverified'); continue; }

      // Apollo, live: still only the membership we created, finished when the inspection said,
      // and the address still resolves to that one contact (the send path matches by address).
      const contact = await apollo.getContact(prior.contactId);
      if (!finishedMembershipOnly(contact, {contactId:prior.contactId, campaignId:prior.campaignId, sentAt:prior.sentAt, finish:facts.finish})) { skip('membership_changed'); continue; }
      const matches = await apollo.findContactsByEmail(prior.email);
      if (matches.length !== 1 || text(matches[0].id) !== prior.contactId) { skip('provider_contact_ambiguous'); continue; }

      if (await isCustomer(prior.leadId)) { skip('customer'); continue; }

      // The generator reads the lead and the person live. No trigger is passed, so it infers the
      // stage itself (the retry refresh does the same) and a lead that moved again shows here.
      let payload;
      try {
        payload = await build({pipedriveLeadId:prior.leadId, pool, assignedUserId:mb.owner_user_id, assignedMailboxId:mb.id, apolloSequenceId:facts.sequenceId});
      } catch (error) {
        if (error?.code === 'crm_unverified' || error?.status === 429 || upstreamDown(error)) throw error;
        skip('draft_build_failed'); continue;
      }
      if (text(payload.trigger_type) !== text(facts.target)) { skip('stage_changed_live'); continue; }
      if (lower(payload.contact_email_snapshot) !== prior.email || payload.contact_email_snapshot !== lead.person_email ||
          text(payload.contact_id_snapshot) !== prior.personId || text(payload.org_id_snapshot) !== prior.orgId) { skip('contact_changed_live'); continue; }
      if (text(payload.assigned_mailbox_id) !== mb.id || text(payload.assigned_user_id) !== text(mb.owner_user_id) ||
          text(payload.apollo_sequence_id) !== facts.sequenceId || !payload.subject || !payload.body) { skip('draft_mismatch'); continue; }
      const lastOutgoing = crmTime(payload.person_last_outgoing);
      if (lastOutgoing === undefined) { skip('crm_mail_time_unreadable'); continue; }
      if (lastOutgoing && (+lastOutgoing > +new Date(prior.sentAt) || days(lastOutgoing) <= cooldown)) { skip('hand_email_after_send'); continue; }

      if (dryRun) { entry.result = 'ready'; entry.sender = mb.email; entry.lastEmailDays = days(facts.lastEmailAt); out.ready++; continue; }

      const metadata = {...(payload.metadata || {}), email_verdict:'valid', follow_on:{prior_send_id:prior.sendId, hop:facts.hop},
        ...(facts.cadence === 'award_only' ? {cadence:'award_only'} : {})};
      const inserted = await withLeadLock(pool, prior.leadId, async client => {
        const current = (await client.query('SELECT * FROM sdr_lead_state WHERE pipedrive_lead_id=$1 FOR UPDATE', [prior.leadId])).rows[0];
        if (!current || LEAD_KEYS.some(key => text(current[key]) !== text(lead[key]))) throw new Error('lead_changed');
        // Everything again under the lead lock: a send, a draft, a reply or a hand email may have
        // appeared while Apollo and Pipedrive were being read.
        const again = await followOnFacts(client, {priorSendId:cand.send_id, companyId, now, lifecycleEnabled});
        if (!again.ok) throw new Error(again.reason);
        if (again.otherOps.length || again.hop !== facts.hop || again.sequenceId !== facts.sequenceId || +again.lastTouchAt !== +facts.lastTouchAt ||
            again.finish.id !== facts.finish.id || again.finish.finishedAt !== facts.finish.finishedAt) throw new Error('lead_changed');
        const policy = await getPolicyRollout(client, {companyId, leadId:prior.leadId});
        if (policyRequiresReview(policy, {companyId})) throw new Error('policy_review_required');
        if (await bidInviteLeadFor(client, {leadId:prior.leadId, personId:current.pipedrive_person_id, emails:[current.person_email, payload.contact_email_snapshot]})) throw new Error('bid_invite_warm_lead');
        await assertOutreachAllowed(client, {...context, recipientEmail:payload.contact_email_snapshot, serviceId:payload.metadata?.service_id}, {action:'generate_draft'});
        if (sendableVerdict(current, payload.contact_email_snapshot, +now) !== 'valid') throw new Error('address_not_verified_valid');
        return client.query(
          `INSERT INTO sdr_drafts (
             pipedrive_lead_id, pipedrive_contact_id, pipedrive_org_id,
             contact_id_snapshot, contact_email_snapshot, org_id_snapshot,
             trigger_type, apollo_sequence_id, subject, body,
             assigned_mailbox_id, assigned_user_id, initiated_by, metadata, content_origin, id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'auto-switch',$13,'machine',$14)
           ON CONFLICT (pipedrive_lead_id, trigger_type)
             WHERE status IN ('pending','approved','edited') DO NOTHING
           RETURNING id, assigned_user_id, initiated_by`,
          [payload.pipedrive_lead_id, payload.pipedrive_contact_id, payload.pipedrive_org_id,
            payload.contact_id_snapshot, payload.contact_email_snapshot, payload.org_id_snapshot,
            payload.trigger_type, payload.apollo_sequence_id, payload.subject, payload.body,
            payload.assigned_mailbox_id, payload.assigned_user_id, metadata, draftId],
        );
      });
      if (!inserted.rows[0]) { skip('open_draft_exists'); continue; }
      created.push(inserted.rows[0]);
      used.set(mb.id, used.get(mb.id) + 1);
      entry.result = 'created'; entry.draftId = draftId; entry.sender = mb.email;
    } catch (error) {
      // Pipedrive or Apollo unreadable: stop the pass, the next one starts over.
      if (error?.code === 'crm_unverified') { out.stopped = 'crm_unverified'; skip('crm_unverified'); break; }
      if (error?.status === 429) { out.stopped = 'provider_rate_limited'; skip('provider_rate_limited'); break; }
      if (error?.code === 'outreach_held') skip('held');
      else if (error?.code === 'contact_history_unverified') skip('contact_history_unverified');
      else if (upstreamDown(error)) { out.stopped = 'upstream_unavailable'; skip('upstream_unavailable'); break; }
      else skip(/^[a-z_]{3,48}$/.test(error?.message || '') ? error.message : 'error');
    }
  }

  out.created = created.length;
  if (created.length) {
    const sent = await enrollDrafts(created);
    out.enrolled = sent?.enrolled || 0;
    out.deferred = sent?.skipped || 0;
  }
  return out;
}
