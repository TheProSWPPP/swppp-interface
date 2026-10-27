// Draft, send and person history rules for automatic outreach. Shared by the automatic selector
// (lib/autoOutreach.js), the verification pass that decides who is worth a verdict
// (lib/emailVerifyRefresh.js) and the provider membership guard (lib/sdrProviderOperations.js),
// so the three agree on which history blocks a person. No imports: the provider guard and the
// verification pass load this without pulling in the draft generator.

// A failed draft holds its lead back this long, whatever the failure said. Selection and the
// in-lock check before insert must use the same window: when selection used 14 days for an
// Apollo "in_other_campaigns" failure and the lock used 30, the same leads were picked and
// refused on every hourly run between day 14 and day 30, each one using a draft slot. 30 is
// the stricter of the two; a contact sitting in another campaign is refused by the provider
// membership guard anyway (lib/sdrProviderOperations.js), so an earlier retry gains nothing.
export const FAILED_DRAFT_BACKOFF_DAYS = 30;

// A queued draft names a specific bid on a specific project. Two weeks on, the bid is
// decided and the copy is wrong, so a draft nobody approved by then is not one anybody
// should be able to approve later. Matches sdr_settings.contact_cooldown_days.
export const DRAFT_EXPIRY_DAYS = 14;
// A draft a person edited or regenerated is only expired once nobody has touched it for this
// long. It is still a draft nobody sent; expiry only takes it out of the queue.
export const STAFF_DRAFT_EXPIRY_DAYS = 30;
// The reject_reason expireStaleQueuedDrafts writes. A draft rejected with this reason was never
// reviewed by anyone: it only aged out, so it is not a staff decision about the lead.
export const AUTO_EXPIRED_REASON_PREFIX = 'auto: expired unapproved after ';

// An approval receipt written by a person. Automatic sends used to write their receipt before
// the provider checks, so a refused automatic attempt left a receipt behind and expiry, pruning
// and retry all skipped the draft for good (193 pending drafts older than 14 days on
// 2026-10-26). Only a person's receipt keeps a pending draft out of housekeeping.
export const staffApproval=alias=>`EXISTS(SELECT 1 FROM sdr_draft_approvals approved WHERE approved.draft_id=${alias}.id
   AND coalesce(approved.actor->>'execution','') <> 'automatic')`;

// A send row marked failed that never produced an email: no message id, no sent/replied/bounced
// step, no outbound Apollo message to the address, no sent/reply/bounce event on the project,
// no completed-send ledger entry and no reply. 514 such rows were stamped failed in bulk on
// 2026-10-15 during the PB/LBA cleanup (Apollo had paused both sequences, so the enrollments
// sent nothing and were removed). When the evidence tables are not all present nothing counts
// as undelivered, so every failed send keeps blocking.
export const DELIVERY_EVIDENCE_TABLES=['sdr_message_facts','sdr_engagement_events','sdr_reply_messages'];
// Both rules are written as uncorrelated `IN (SELECT ...)` sets, which Postgres evaluates once
// per query as hashed sets. Correlated per row (and matching addresses with a per-row scan of the
// message facts), they made the candidate query take 12 minutes against production.
const lowerEmail=column=>`lower(btrim(${column}))`;
// `status` is the SQL condition on the send row's own status (alias u).
const sendIdsWithoutEmail=status=>`SELECT u.id FROM sdr_sends u LEFT JOIN sdr_drafts xd ON xd.id=u.draft_id
   WHERE ${status}
   AND u.apollo_emailer_message_id IS NULL
   -- 'refused': Apollo declined to send and still lists the failed membership (see
   -- lib/apolloEngagementPoll.js and lib/sdrSendReconcile.js); another add would be refused too.
   AND coalesce(u.step_status,'') NOT IN ('sent','replied','bounced','completed','finished','refused')
   AND u.pipedrive_lead_id IS NOT NULL
   AND coalesce(${lowerEmail('xd.contact_email_snapshot')},'') NOT IN (SELECT ${lowerEmail('xf.prospect_email')} FROM sdr_message_facts xf
     WHERE xf.provider='apollo' AND xf.direction='out' AND xf.prospect_email IS NOT NULL)
   AND u.pipedrive_lead_id NOT IN (SELECT xe.pipedrive_lead_id FROM sdr_engagement_events xe WHERE xe.pipedrive_lead_id IS NOT NULL
     AND xe.event_type IN ('email_sent','email_replied','email_bounced','email_opened','email_clicked'))
   AND u.pipedrive_lead_id NOT IN (SELECT xl.pipedrive_lead_id FROM sdr_outreach_log xl WHERE xl.pipedrive_lead_id IS NOT NULL AND xl.source='interface')
   AND u.pipedrive_lead_id NOT IN (SELECT xr.pipedrive_lead_id FROM sdr_reply_messages xr WHERE xr.pipedrive_lead_id IS NOT NULL)`;
const FAILED_ONLY="u.status='failed'";
// The provider guard also sets aside rows still marked enrolled or switched that produced no
// email after two days: Apollo refused or dropped those contacts without telling us (Sept PB rows
// still "enrolled" after the pause; Oct rows Apollo failed at step 1). The guard reads Apollo's
// live membership right after, so a contact really still in a sequence is refused there. The
// selector keeps to failed rows: drafting for a contact Apollo still holds would only end in a
// refusal and a hold on the lead.
export const ANY_STATUS_AFTER_DAYS=2;
const ANY_STATUS=`(u.status='failed' OR (u.status IN ('enrolled','switched') AND u.sent_at < NOW() - make_interval(days => ${ANY_STATUS_AFTER_DAYS})))`;
const evidence=tables=>DELIVERY_EVIDENCE_TABLES.every(t=>tables.has(t));
const withoutEmail=(x,tables,status)=>evidence(tables) ? `coalesce(${x}.id IN (${sendIdsWithoutEmail(status)}),FALSE)` : 'FALSE';
export const undeliveredFailedSend=(x,tables)=>withoutEmail(x,tables,FAILED_ONLY);
export const sendWithoutEmail=(x,tables)=>withoutEmail(x,tables,ANY_STATUS);

// A provider enrollment receipt whose membership never produced an email: a confirmed 'enroll'
// operation, and every send row we hold for that contact in that campaign never produced an
// email, with at least one such row on the operation's own lead. The PB/LBA cleanup removed these
// memberships from Apollo (mode 'remove', which leaves no membership behind), so the receipt only
// records an add that sent nothing. Stop operations (replies, bounces, auto-switch), unresolved or
// reserved enrollments and every other kind keep blocking. `anyStatus` applies the provider
// guard's wider rule (sendWithoutEmail) instead of failed rows only.
export const spentEnrollOperation=(po,tables,{anyStatus=false}={})=>{
  if(!evidence(tables))return 'FALSE';
  const ids=sendIdsWithoutEmail(anyStatus ? ANY_STATUS : FAILED_ONLY);
  return `coalesce(${po}.id IN (SELECT o.id FROM sdr_provider_operations o
   WHERE o.kind='enroll' AND o.state='confirmed'
   AND EXISTS(SELECT 1 FROM sdr_sends so WHERE so.apollo_contact_id=o.contact_id AND so.apollo_sequence_id=o.campaign_id
     AND so.pipedrive_lead_id=o.lead_id AND so.id IN (${ids}))
   AND NOT EXISTS(SELECT 1 FROM sdr_sends so WHERE so.apollo_contact_id=o.contact_id AND so.apollo_sequence_id=o.campaign_id
     AND NOT coalesce(so.id IN (${ids}),FALSE))),FALSE)`;
};

// An enrollment Apollo explicitly declined (the contact came back under skipped_contact_ids, so no
// membership exists): 'provider_skipped' since 2026-10-27, and before that a reservation left
// 'reserved' whose draft failed with "Apollo did not enroll the contact: <reason>". The reply that
// named no skipped contact and no enrolled one ("not added (Apollo returned no enrolled contact)")
// is uncertain and keeps blocking. Apollo's live membership is still read before any new add.
export const APOLLO_SKIP_PREFIX='Apollo did not enroll the contact: ';
const LEGACY_SKIP_COLUMNS=['sdr_drafts.error_message','sdr_provider_operations.expected_membership'];
export const skippedEnrollOperation=(po,tables)=>`(${po}.kind='enroll' AND (${po}.state='provider_skipped'${LEGACY_SKIP_COLUMNS.every(c=>tables.has(c)) ? `
   OR (${po}.state='reserved' AND EXISTS(SELECT 1 FROM sdr_drafts sk WHERE sk.id::text=${po}.expected_membership->>'draftId'
     AND sk.status='failed' AND sk.error_message LIKE '${APOLLO_SKIP_PREFIX}%' AND sk.error_message NOT LIKE '${APOLLO_SKIP_PREFIX}not added%'))` : ''}))`;
// Apollo declines a contact it believes changed jobs. When our verdict for that exact address is a
// fresh valid one the send path retries with sequence_job_change, so such a failure is not a reason
// to wait out the failed-draft backoff.
export const JOB_CHANGE_SKIP='contacts_with_job_change';

// TRUE when automatic outreach must not draft for this lead. `lead`, `person` and `emails` are
// SQL expressions: the lead id, its Pipedrive person id and a text[] of lower-cased addresses.
// Selection and the in-lock check before insert both use this, so a lead is never picked and
// then refused (each refusal spends a draft slot).
//
// Lead history: an open draft, a staff rejection or cancellation, a failure inside the backoff,
// a send. Not blocking: a draft rejected only because it aged out (unless an automatic send of it
// was refused for review or ran out of attempts, which would only repeat), and a send row marked
// failed that never produced an email (undeliveredFailedSend).
//
// Person history: the provider membership guard (lib/sdrProviderOperations.js) refuses an Apollo
// contact we enrolled before, on any project and in any state, unless that enrollment never
// produced an email, and puts a hold on the lead. So a person or address we already enrolled
// (through any lead, or the permit lane), that Apollo already emailed, or a lead with an earlier
// provider operation is skipped here instead of getting a draft that can only be refused. On
// 2026-10-26 8 of 9 new drafts went to people already sequenced under another lead. The same
// exception applies here: a send that never delivered and its spent enrollment receipt
// (spentEnrollOperation) do not block. Any outbound Apollo message to the address still does.
export function outreachHistoryBlocks({lead,person,emails},tables) {
  const emailIn=column=>`lower(btrim(${column})) = ANY(${emails})`;
  const parts=[
    `EXISTS(SELECT 1 FROM sdr_drafts hd WHERE hd.pipedrive_lead_id=${lead} AND (
       hd.status IN ('pending','approved','edited','cancelled')
       OR (hd.status='rejected' AND NOT coalesce(${tables.has('sdr_draft_approvals') ? 'TRUE' : 'FALSE'}
             AND hd.reject_reason LIKE '${AUTO_EXPIRED_REASON_PREFIX}%'
             AND hd.content_origin IN ('machine','unknown') AND hd.initiated_by IN ('automatic','auto-switch')
             AND NOT ${tables.has('sdr_draft_approvals') ? staffApproval('hd') : 'FALSE'}
             ${tables.has('sdr_enrollment_attempts') ? `AND NOT EXISTS(SELECT 1 FROM sdr_enrollment_attempts ea WHERE ea.draft_id=hd.id AND ea.status IN ('review','exhausted'))` : ''},FALSE))
       OR (hd.status='failed' AND hd.created_at > NOW() - make_interval(days => ${FAILED_DRAFT_BACKOFF_DAYS})
             ${tables.has('sdr_drafts.error_message') ? `AND coalesce(hd.error_message,'') <> '${APOLLO_SKIP_PREFIX}${JOB_CHANGE_SKIP}'` : ''})
       OR (hd.status='sent' AND (NOT EXISTS(SELECT 1 FROM sdr_sends hs WHERE hs.draft_id=hd.id)
             OR EXISTS(SELECT 1 FROM sdr_sends hs WHERE hs.draft_id=hd.id AND NOT ${undeliveredFailedSend('hs',tables)})))))`,
    `EXISTS(SELECT 1 FROM sdr_sends hx WHERE hx.pipedrive_lead_id=${lead} AND NOT ${undeliveredFailedSend('hx',tables)})`,
    `EXISTS(SELECT 1 FROM sdr_sends px JOIN sdr_drafts pd ON pd.id=px.draft_id
       WHERE (${emailIn('pd.contact_email_snapshot')} OR (${person} IS NOT NULL AND (px.enrolled_person_id=${person} OR pd.contact_id_snapshot=${person})))
         AND NOT ${undeliveredFailedSend('px',tables)})`,
  ];
  if(tables.has('sdr_message_facts'))parts.push(`EXISTS(SELECT 1 FROM sdr_message_facts pf WHERE pf.provider='apollo' AND pf.direction='out' AND ${emailIn('pf.prospect_email')})`);
  if(tables.has('sdr_provider_operations'))parts.push(`EXISTS(SELECT 1 FROM sdr_provider_operations po WHERE po.lead_id=${lead} AND NOT ${spentEnrollOperation('po',tables)} AND NOT ${skippedEnrollOperation('po',tables)})`);
  if(tables.has('permit_sends')&&tables.has('permit_operator_email'))parts.push(`EXISTS(SELECT 1 FROM permit_sends ps JOIN permit_operator_email pe ON pe.operator_key=ps.operator_key WHERE ${emailIn('pe.email')})`);
  if(tables.has('permit_sends')&&tables.has('permit_drafts'))parts.push(`EXISTS(SELECT 1 FROM permit_sends ps JOIN permit_drafts pdr ON pdr.id=ps.draft_id WHERE ${emailIn('pdr.email')})`);
  return `(${parts.join('\n   OR ')})`;
}
export const HISTORY_TABLES=[...DELIVERY_EVIDENCE_TABLES,'sdr_draft_approvals','sdr_enrollment_attempts','sdr_provider_operations','permit_sends','permit_operator_email','permit_drafts',...LEGACY_SKIP_COLUMNS];
// Table names, and 'table.column' names for optional columns, that exist on this connection.
export async function presentTables(db,names=HISTORY_TABLES) {
  const {rows}=await db.query(`SELECT name FROM unnest($1::text[]) AS name WHERE CASE WHEN position('.' in name)>0
    THEN EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(split_part(name,'.',1)) AND a.attname=split_part(name,'.',2) AND NOT a.attisdropped)
    ELSE to_regclass(name) IS NOT NULL END`,[names]);
  return new Set(rows.map(row=>row.name));
}
