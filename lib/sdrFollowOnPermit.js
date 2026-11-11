// Follow-on enrollment: one more sequence for a contact whose earlier sequence ran to its last
// step, on a project that then moved forward a stage (2026-11-11, replaces the re-enroll half of
// the auto-switch that #51 turned off).
//
// The provider guard (reserveEnrollment in lib/sdrProviderOperations.js) refuses any contact we
// enrolled before and puts a hold on the lead. That stays the rule. This file describes the one
// shape it may let through, and proves it from our own records every time:
//
//   - the same lead, the same Pipedrive person, the same company and the same address;
//   - a hop on the allowlist below (anything else, including a contact or company change, is not
//     a follow-on and is never re-enrolled here);
//   - the earlier send is the only send we hold for the lead, the contact, the person and the
//     address, and no permit-lane send reached them;
//   - its provider operations are exactly our confirmed enrollment plus the auto-switch
//     inspection that found the membership finished with "Completed last step" (a reply, a
//     bounce, a manual finish, a paused or still-running drip all read differently);
//   - every outbound message we hold for the address is an Apollo message of that sequence, and
//     none is later than the finish (a membership someone added later would send some, and any
//     other sender is a person or a tool this code knows nothing about);
//   - nobody emailed the person or the address by hand after our send, and nothing ever came
//     back from the address;
//   - our last email to them is at most FOLLOW_ON_MAX_AGE_DAYS old.
//
// The contact cooldown, holds, the customer check, the verdict and the daily cap stay with the
// send path. Nothing here removes, pauses or edits an Apollo membership.
import {presentTables,AUTO_EXPIRED_REASON_PREFIX} from './outreachHistory.js';
import {awardOnlySequenceId} from './sdrAutoSwitch.js';
import {isBidInviteOrigin} from './bidInviteGuard.js';
import {crmLifecycleEnabled} from './sdrCrmGuard.js';
import {hasRecentReply} from './recentReply.js';
import {OWNED_ADD_WINDOW_MS} from './sdrProviderOperations.js';

// LBA -> AGC at the same GC gets one award email (Derek, see lib/sdrAutoSwitch.js). The others
// are a new stage with a new message, so they get that stage's sequence.
export const FOLLOW_ON_HOPS = Object.freeze({'LBA>AGC':'award_only','PB>LBA':'full','PB>AGC':'full','CM>AGC':'full'});
export const FOLLOW_ON_MAX_AGE_DAYS = 30;
// Off unless SDR_STAGE_FOLLOW_ON=on. The guard reads it too, so turning it off also stops a
// follow-on draft that is already waiting for a retry.
export const stageFollowOnEnabled = () => process.env.SDR_STAGE_FOLLOW_ON === 'on';
// Apollo's inactive_reason for a membership that sent every step and stopped by itself.
export const FINISHED_REASON = 'Completed last step';
// Apollo stamps the last message and the finish a moment apart (seen: up to 2 minutes).
const FINISH_SLACK_MS = 10*60*1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED = ['sdr_drafts','sdr_sends','sdr_lead_state','sdr_provider_operations','sdr_message_facts','sdr_outreach_log','sdr_reply_messages',
  'sdr_reply_messages.from_email','sdr_message_facts.campaign_id'];
const OPTIONAL = ['permit_sends','permit_operator_email','permit_drafts'];
export const FOLLOW_ON_TABLES = [...REQUIRED,...OPTIONAL];
const DRAFT_COLUMNS = ['pipedrive_lead_id','apollo_sequence_id','trigger_type','initiated_by','content_origin','status','sent_at',
  'assigned_mailbox_id','contact_email_snapshot','contact_id_snapshot','org_id_snapshot','metadata'].map(column=>`sdr_drafts.${column}`);
const no = reason => ({ok:false,reason});
const lower = value => String(value ?? '').trim().toLowerCase();
const at = value => value ? +new Date(value) : NaN;

// The canary allowlist (SDR_STAGE_FOLLOW_ON_ONLY, comma-separated earlier send ids). Null when
// unset (every candidate). Set, it is strict: a value with no usable id selects nothing, never
// everything. The pass selects by it and the guard checks it again at send time.
export function stageFollowOnOnly(raw = process.env.SDR_STAGE_FOLLOW_ON_ONLY) {
  if (raw == null || !String(raw).trim()) return null;
  return String(raw).split(',').map(v => v.trim().toLowerCase()).filter(v => UUID.test(v));
}

export function followOnSequence(hop) {
  if (!Object.hasOwn(FOLLOW_ON_HOPS,hop)) return null;
  if (FOLLOW_ON_HOPS[hop]==='award_only') return awardOnlySequenceId();
  return process.env[`APOLLO_SEQ_${hop.split('>')[1]}`]?.trim() || null;
}

// The one finished membership a follow-on may be added next to: the very membership we created
// (added at our send, same id and same finish time as the inspection recorded), on a contact
// Apollo still holds under the address we approved (the add is by contact id, so a contact whose
// address was changed would be emailed at the new one). Anything else on the contact (another
// sequence, a paused or active one, a different end reason, or the same sequence added again by
// someone else) is not this shape.
export function finishedMembershipOnly(contact,{contactId,campaignId,sentAt,finish,email}={}) {
  if (String(contact?.id)!==String(contactId) || !Array.isArray(contact?.contact_campaign_statuses)) return false;
  if (!lower(email) || lower(contact.email)!==lower(email)) return false;
  if (contact.contact_campaign_statuses.length!==1) return false;
  const m=contact.contact_campaign_statuses[0];
  if (String(m?.emailer_campaign_id)!==String(campaignId) || lower(m?.status)!=='finished' || m?.inactive_reason!==FINISHED_REASON) return false;
  const added=at(m.added_at),sent=at(sentAt);
  if (!Number.isFinite(added) || !Number.isFinite(sent) || Math.abs(added-sent)>OWNED_ADD_WINDOW_MS) return false;
  const membershipId=String(m.emailer_campaign_contact_id ?? m.id ?? '');
  if (!membershipId || !finish?.id || membershipId!==String(finish.id)) return false;
  const finished=at(m.finished_at);
  return Number.isFinite(finished) && finished===at(finish.finishedAt);
}

/**
 * Reads everything a follow-on depends on for one earlier send. Read only.
 * lastEmailAt is our own last message (the age limit). lastTouchAt also counts the outreach
 * ledger for the lead, which is what the send path's cooldown reads.
 * @returns {ok:true,hop,cadence,target,sequenceId,prior,finish,lastEmailAt,lastTouchAt,operationIds,otherOps} or {ok:false,reason}
 */
export async function followOnFacts(db,{priorSendId,companyId=process.env.SDR_CRM_COMPANY_ID,now=new Date(),ignoreDraftId=null,
  lifecycleEnabled=crmLifecycleEnabled(),tables}={}) {
  if (!UUID.test(String(priorSendId||''))) return no('prior_send_invalid');
  if (ignoreDraftId!==null && !UUID.test(String(ignoreDraftId))) return no('draft_invalid');
  if (!companyId) return no('company_scope_unverified');
  tables = tables || await presentTables(db,FOLLOW_ON_TABLES);
  if (REQUIRED.some(name=>!tables.has(name))) return no('facts_unreadable');
  const row=(await db.query(`SELECT s.id::text AS send_id, s.pipedrive_lead_id AS lead_id, s.draft_id::text AS draft_id,
      s.apollo_sequence_id AS campaign_id, s.apollo_contact_id AS contact_id, s.mailbox_id::text AS mailbox_id, s.sent_at,
      s.status, s.step_status, s.enrolled_trigger, s.enrolled_person_id, s.enrolled_org_id,
      ls.trigger_type, ls.trigger_override, ls.pipedrive_person_id AS person_id, ls.pipedrive_org_id AS org_id,
      ls.person_email, ls.crm_status, ls.crm_company_id::text AS crm_company_id, ls.lead_origin, ls.last_outgoing_mail_time,
      d.contact_email_snapshot
    FROM sdr_sends s
    JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=s.pipedrive_lead_id
    JOIN sdr_drafts d ON d.id=s.draft_id
    WHERE s.id=$1::uuid`,[priorSendId])).rows[0];
  if (!row) return no('prior_send_missing');
  if (!['enrolled','sent'].includes(row.status) || row.step_status!=='completed') return no('prior_sequence_not_finished');
  const hop=`${row.enrolled_trigger}>${row.trigger_type}`;
  if (!Object.hasOwn(FOLLOW_ON_HOPS,hop)) return no('hop_not_allowed');
  if (row.trigger_override!=null) return no('trigger_override_set');
  if (!row.person_id || String(row.person_id)!==String(row.enrolled_person_id ?? '')) return no('person_changed');
  if (!row.org_id || String(row.org_id)!==String(row.enrolled_org_id ?? '')) return no('company_changed');
  const email=lower(row.contact_email_snapshot);
  if (!email || lower(row.person_email)!==email) return no('address_changed');
  if (!row.contact_id || !row.campaign_id) return no('prior_contact_missing');
  if (!row.mailbox_id) return no('prior_mailbox_missing');
  if (lifecycleEnabled && row.crm_status!=='active') return no('crm_not_active');
  if (row.crm_company_id && row.crm_company_id!==String(companyId)) return no('other_company');
  if (isBidInviteOrigin(row.lead_origin)) return no('bid_invite_warm_lead');
  const sequenceId=followOnSequence(hop);
  if (!sequenceId) return no('sequence_not_configured');
  if (sequenceId===String(row.campaign_id)) return no('same_sequence');

  // One send, ever, for this lead, this Apollo contact, this Pipedrive person and this address.
  const others=(await db.query(`SELECT 1 FROM sdr_sends x LEFT JOIN sdr_drafts xd ON xd.id=x.draft_id
    WHERE x.id<>$1::uuid AND (x.pipedrive_lead_id=$2 OR x.apollo_contact_id=$3 OR x.enrolled_person_id=$4
      OR xd.contact_id_snapshot=$4 OR lower(btrim(xd.contact_email_snapshot))=$5) LIMIT 1`,
  [priorSendId,row.lead_id,row.contact_id,String(row.person_id),email])).rows;
  if (others.length) return no('other_send_exists');
  if (tables.has('permit_sends')) {
    const parts=['SELECT 1 FROM permit_sends WHERE apollo_contact_id=$1'];
    if (tables.has('permit_operator_email')) parts.push('SELECT 1 FROM permit_sends ps JOIN permit_operator_email pe ON pe.operator_key=ps.operator_key WHERE lower(btrim(pe.email))=$2');
    if (tables.has('permit_drafts')) parts.push('SELECT 1 FROM permit_sends ps JOIN permit_drafts pdr ON pdr.id=ps.draft_id WHERE lower(btrim(pdr.email))=$2');
    const permit=(await db.query(`SELECT 1 FROM (${parts.join(' UNION ALL ')}) p WHERE $2::text IS NOT NULL LIMIT 1`,[row.contact_id,email])).rows;
    if (permit.length) return no('permit_send_exists');
  }
  // Any other draft on the lead is a decision or an attempt this code does not understand, apart
  // from a draft that failed or aged out before the send we are following. A draft whose reason
  // or date cannot be read counts as a decision. This also makes a follow-on a one-time thing:
  // its own draft, in any state, blocks the next one.
  const drafts=(await db.query(`SELECT 1 FROM sdr_drafts o JOIN sdr_drafts p ON p.id=$2::uuid
    WHERE o.pipedrive_lead_id=$1 AND o.id<>$2::uuid AND ($3::uuid IS NULL OR o.id<>$3::uuid)
      AND NOT COALESCE(o.created_at < p.created_at AND (o.status='failed' OR (o.status='rejected' AND o.reject_reason LIKE $4)), FALSE)
    LIMIT 1`,[row.lead_id,row.draft_id,ignoreDraftId,`${AUTO_EXPIRED_REASON_PREFIX}%`])).rows;
  if (drafts.length) return no('other_draft_on_lead');

  const ops=(await db.query(`SELECT id::text AS id,kind,state,reason,campaign_id,contact_id,lead_id,action_id,expected_membership,receipt
    FROM sdr_provider_operations WHERE contact_id=$1 OR lead_id=$2`,[row.contact_id,row.lead_id])).rows;
  const own=op=>String(op.campaign_id)===String(row.campaign_id) && String(op.contact_id)===String(row.contact_id);
  const enrolls=ops.filter(op=>op.kind==='enroll' && op.state==='confirmed' && own(op) && String(op.lead_id)===String(row.lead_id)
    && String(op.expected_membership?.draftId ?? '')===row.draft_id);
  const stops=ops.filter(op=>op.kind==='stop' && op.state==='confirmed' && own(op) && op.action_id===`auto-switch:${row.send_id}`
    && op.reason==='membership_finished' && op.receipt?.membershipStatus==='finished' && op.receipt?.inactiveReason===FINISHED_REASON);
  if (enrolls.length!==1) return no('enroll_receipt_missing');
  if (stops.length!==1) return no('finish_receipt_missing');
  const operationIds=[enrolls[0].id,stops[0].id];
  const otherOps=ops.filter(op=>!operationIds.includes(op.id)).map(op=>op.id);
  // Which membership finished, and when. Without both, a membership added again later cannot be
  // told from ours.
  const sentAt=new Date(row.sent_at);
  const finish={id:String(stops[0].receipt.id ?? ''),finishedAt:stops[0].receipt.finishedAt ?? null};
  const finishedAt=at(finish.finishedAt);
  if (!Number.isFinite(+sentAt)) return no('prior_send_time_unknown');
  if (!finish.id || !Number.isFinite(finishedAt) || finishedAt<+sentAt) return no('finish_receipt_incomplete');

  // Every outbound message we hold for the address must be an Apollo message of that sequence
  // (all of production's are Apollo and carry the sequence, checked 2026-11-11). Anything else,
  // at any time, is a sender this code cannot account for. The finish slack applies to our own
  // sequence only; one of its messages later than that, or with no time and not failed, means
  // the membership was added again or is not done.
  const out=(await db.query(`SELECT
      count(*) FILTER (WHERE f.provider IS DISTINCT FROM 'apollo' OR f.campaign_id IS DISTINCT FROM $2)::int AS foreign_count,
      count(*) FILTER (WHERE f.provider='apollo' AND f.campaign_id=$2 AND (f.occurred_at>$3
        OR (f.occurred_at IS NULL AND f.provider_status IS DISTINCT FROM 'failed')))::int AS late_count,
      MAX(f.occurred_at) FILTER (WHERE f.provider='apollo' AND f.campaign_id=$2 AND f.provider_status='completed') AS sent_at
    FROM sdr_message_facts f WHERE f.direction='out' AND lower(btrim(f.prospect_email))=$1`,
  [email,String(row.campaign_id),new Date(finishedAt+FINISH_SLACK_MS)])).rows[0];
  if (!out || out.foreign_count) return no('other_email_on_record');
  if (out.late_count) return no('email_after_finish');
  const lastEmailAt=out?.sent_at && +new Date(out.sent_at)>+sentAt ? new Date(out.sent_at) : sentAt;
  if (+now - +lastEmailAt > FOLLOW_ON_MAX_AGE_DAYS*86400000) return no('last_email_too_old');
  const logged=(await db.query('SELECT MAX(o.sent_at) AS at FROM sdr_outreach_log o WHERE o.pipedrive_lead_id=$1',[row.lead_id])).rows[0]?.at;
  const lastTouchAt=logged && +new Date(logged)>+lastEmailAt ? new Date(logged) : lastEmailAt;

  // A hand email after our send: Pipedrive's mail time (empty on people only Apollo emailed) or
  // the outreach ledger's Pipedrive row, on this lead, any lead of the person, or any lead whose
  // person has this address (Pipedrive holds duplicate people).
  if (row.last_outgoing_mail_time && +new Date(row.last_outgoing_mail_time)>+sentAt) return no('hand_email_after_send');
  const hand=(await db.query(`SELECT 1 FROM sdr_lead_state pl
    WHERE (pl.pipedrive_lead_id=$1 OR pl.pipedrive_person_id=$2 OR lower(btrim(pl.person_email))=$4)
      AND (pl.last_outgoing_mail_time>$3 OR EXISTS(SELECT 1 FROM sdr_outreach_log o
        WHERE o.pipedrive_lead_id=pl.pipedrive_lead_id AND o.source='pipedrive' AND o.sent_at>$3)) LIMIT 1`,
  [row.lead_id,String(row.person_id),sentAt,email])).rows;
  if (hand.length) return no('hand_email_after_send');
  // Anything that came back, ever: a recorded reply on the lead or from the address, or any
  // inbound message from the address (a bounce and an auto-reply count, this is a second
  // approach). Then the 180-day reply rule the automatic send path applies, which a rep's
  // approval does not run.
  const replied=(await db.query(`SELECT 1 FROM sdr_reply_messages WHERE pipedrive_lead_id=$1 OR lower(btrim(from_email))=$2
    UNION ALL SELECT 1 FROM sdr_message_facts WHERE direction='in' AND lower(btrim(prospect_email))=$2 LIMIT 1`,[row.lead_id,email])).rows;
  if (replied.length) return no('reply_on_record');
  if (await hasRecentReply(db,email)) return no('recent_reply');

  return {ok:true,hop,cadence:FOLLOW_ON_HOPS[hop],target:row.trigger_type,sequenceId,finish,lastEmailAt,lastTouchAt,operationIds,otherOps,
    prior:{sendId:row.send_id,leadId:String(row.lead_id),draftId:row.draft_id,campaignId:String(row.campaign_id),contactId:String(row.contact_id),
      mailboxId:row.mailbox_id,personId:String(row.person_id),orgId:String(row.org_id),email,sentAt}};
}

/**
 * Called by the provider guard with the trusted send context. Null when the draft is not a
 * follow-on (the guard then behaves exactly as before). Otherwise the facts are read again and
 * compared with the draft and the context; any difference is a refusal, never a wider permit.
 * @returns null | {refused:reason} | {priorSendId,priorCampaignId,priorSentAt,finish,email,operationIds,hop}
 */
export async function followOnPermit(db,context,{now=new Date()}={}) {
  const draftId=String(context?.draftId ?? '');
  if (!UUID.test(draftId)) return null;
  const tables=await presentTables(db,[...FOLLOW_ON_TABLES,...DRAFT_COLUMNS]);
  // No drafts table in the shape this reads: nothing here can be a follow-on, the guard stays as it was.
  if (!tables.has('sdr_drafts') || DRAFT_COLUMNS.some(name=>!tables.has(name))) return null;
  const draft=(await db.query(`SELECT id::text AS id,pipedrive_lead_id,apollo_sequence_id,trigger_type,initiated_by,content_origin,status,sent_at,
      assigned_mailbox_id::text AS mailbox_id,contact_email_snapshot,contact_id_snapshot,org_id_snapshot,metadata FROM sdr_drafts WHERE id=$1::uuid`,[draftId])).rows[0];
  const marker=draft?.metadata?.follow_on;
  if (!marker) return null;
  const refuse=reason=>({refused:reason});
  if (!stageFollowOnEnabled()) return refuse('follow_on_disabled');
  // The canary list holds at send time too: a draft made before the list was narrowed, or queued
  // for a retry, is not sent outside it.
  const only=stageFollowOnOnly();
  if (only && !only.includes(lower(marker.prior_send_id))) return refuse('follow_on_not_allowlisted');
  if (draft.initiated_by!=='auto-switch' || draft.content_origin!=='machine') return refuse('draft_not_machine_follow_on');
  if (!['pending','approved'].includes(draft.status) || draft.sent_at) return refuse('draft_not_open');
  const facts=await followOnFacts(db,{priorSendId:marker.prior_send_id,companyId:context.companyId,now,ignoreDraftId:draftId,tables});
  if (!facts.ok) return refuse(facts.reason);
  const awardOnly=facts.cadence==='award_only';
  const same=(...values)=>values.every(value=>String(value ?? '')===String(values[0] ?? '')) && String(values[0] ?? '')!=='';
  if (marker.hop!==facts.hop) return refuse('hop_changed');
  if (!same(facts.prior.leadId,draft.pipedrive_lead_id,context.leadId)) return refuse('lead_mismatch');
  // The person and the company as Pipedrive shows them now (the send context), as the draft was
  // written for, and as the earlier send recorded.
  if (!same(facts.prior.personId,draft.contact_id_snapshot,context.personId)) return refuse('person_mismatch');
  if (!same(facts.prior.orgId,draft.org_id_snapshot,context.organizationId)) return refuse('company_mismatch');
  if (!same(facts.sequenceId,draft.apollo_sequence_id,context.sequenceId)) return refuse('sequence_mismatch');
  if (!same(facts.target,draft.trigger_type,context.trigger)) return refuse('trigger_mismatch');
  if (!same(facts.prior.contactId,context.apolloContactId)) return refuse('contact_mismatch');
  if (!same(facts.prior.mailboxId,draft.mailbox_id,context.mailboxId)) return refuse('mailbox_mismatch');
  if (!same(facts.prior.email,lower(draft.contact_email_snapshot),lower(context.recipientEmail))) return refuse('address_mismatch');
  if (awardOnly!==(draft.metadata?.cadence==='award_only') || awardOnly!==(context.cadence==='award_only')) return refuse('cadence_mismatch');
  return {priorSendId:facts.prior.sendId,priorCampaignId:facts.prior.campaignId,priorSentAt:facts.prior.sentAt,finish:facts.finish,
    email:facts.prior.email,operationIds:facts.operationIds,hop:facts.hop};
}
