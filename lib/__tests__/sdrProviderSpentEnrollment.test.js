import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { reserveEnrollment } from '../sdrProviderOperations.js';
import { readContactSendDaysAgo } from '../apolloCollision.js';

// 2026-10-27: Apollo auto-paused PB and LBA, the app kept enrolling into them, and on Oct 15 516
// contacts were removed from those sequences (Apollo mode 'remove', no email sent) and their send
// rows marked failed. The membership guard still treated that send row and its enrollment
// receipt as history to protect, so none of those people could ever be enrolled again.
const db=reportingTestDb('provider_spent_enrollment');
const reset=()=>db.pool.query('TRUNCATE sdr_policy_decisions,sdr_message_facts,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_provider_operations,sdr_provider_membership_observations,sdr_sends,sdr_drafts,sdr_engagement_events,sdr_reply_messages,sdr_outreach_log,permit_sends');
const fresh={getContact:async()=>({id:'contact',contact_campaign_statuses:[]})};
const context={companyId:'company',apolloContactId:'contact',sequenceId:'pb',leadId:'lead-a',recipientEmail:'buyer@example.test',technicalComplete:true};
const args=(over={})=>({pool:db.pool,apollo:fresh,context,draftRevision:1,actionId:'enroll-again',...over});
// The removed enrollment: a failed send with no message, and the receipt the app wrote when Apollo accepted it.
const removed=async({lead='lead-a',contact='contact',seq='pb',sentDaysAgo=12}={})=>{
 const draft=(await db.pool.query("INSERT INTO sdr_drafts(contact_email_snapshot) VALUES('buyer@example.test') RETURNING id")).rows[0].id;
 await db.pool.query(`INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id,apollo_contact_id,apollo_sequence_id,status,sent_at)
  VALUES(gen_random_uuid()::text,$1,$2,$3,$4,'failed',NOW()-make_interval(days=>$5::int))`,[draft,lead,contact,seq,sentDaysAgo]);
 await db.pool.query(`INSERT INTO sdr_provider_operations(id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,state)
  VALUES(gen_random_uuid(),gen_random_uuid()::text,'enroll',$1,$2,$3,'{}','old-enroll-'||$3,'confirmed')`,[contact,seq,lead]);
};

describe.skipIf(!db)('membership guard: an enrollment that never produced an email',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_email_snapshot text);
   CREATE TABLE sdr_sends(id text,draft_id uuid,pipedrive_lead_id text,apollo_contact_id text,apollo_sequence_id text,apollo_emailer_message_id text,status text,step_status text,sent_at timestamptz);
   CREATE TABLE permit_sends(id text,apollo_contact_id text);
   CREATE TABLE sdr_settings(id int,contact_cooldown_days int);INSERT INTO sdr_settings VALUES(1,14);
   CREATE TABLE sdr_message_facts(provider text,direction text,provider_status text,prospect_email text,occurred_at timestamptz);
   CREATE TABLE sdr_engagement_events(pipedrive_lead_id text,event_type text);
   CREATE TABLE sdr_reply_messages(pipedrive_lead_id text);
   CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text)`);
  for(const file of ['2026-10-07-sdr-provider-operations.sql','2026-10-10-sdr-enrollment-phases.sql','2026-10-07-sdr-outreach-controls.sql','2026-10-07-sdr-policy-rollout.sql'])
   await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(async()=>await db.close());
 beforeEach(reset);

 it('reserves a new enrollment, on the same or another project, and the old send is not a recent contact',async()=>{
  await removed();
  expect(await readContactSendDaysAgo(db.pool,{apolloContactId:'contact',recipientEmail:'buyer@example.test'})).toBeNull();
  const same=await reserveEnrollment(args());
  expect(same.reservationId).toBeTruthy();
  await db.pool.query('DELETE FROM sdr_provider_operations WHERE id=$1',[same.reservationId]);
  expect((await reserveEnrollment(args({context:{...context,leadId:'lead-b'},actionId:'other-project'}))).reservationId).toBeTruthy();
  expect((await db.pool.query("SELECT count(*)::int n FROM sdr_outreach_controls")).rows[0].n).toBe(0);
 });

 it('still refuses when the contact got any email or is live elsewhere',async()=>{
  const cases={
   'message id':"UPDATE sdr_sends SET apollo_emailer_message_id='m1'",
   'sent step':"UPDATE sdr_sends SET step_status='sent'",
   'apollo message':"INSERT INTO sdr_message_facts VALUES('apollo','out','scheduled','buyer@example.test',NOW()-interval '40 days')",
   'sent event':"INSERT INTO sdr_engagement_events VALUES('lead-a','email_sent')",
   'reply':"INSERT INTO sdr_reply_messages VALUES('lead-a')",
   'live send':"INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_contact_id,apollo_sequence_id,status,sent_at) VALUES('live','lead-z','contact','lba','enrolled',NOW()-interval '1 day')",
   'delivered send':"INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_contact_id,apollo_sequence_id,status,step_status,sent_at) VALUES('done','lead-z','contact','lba','enrolled','completed',NOW()-interval '40 days')",
   'permit send':"INSERT INTO permit_sends VALUES('p1','contact')",
  };
  for(const [label,sql] of Object.entries(cases)){
   await reset();
   await removed({sentDaysAgo:40});await db.pool.query(sql);
   await expect(reserveEnrollment(args()),label).rejects.toMatchObject({code:expect.stringMatching(/^(external_membership_requires_review|provider_operation_requires_review)$/)});
  }
 });

 it('a reserved, unresolved or stop operation keeps blocking',async()=>{
  for(const [kind,state] of [['enroll','reserved'],['enroll','unresolved'],['stop','confirmed']]){
   await reset();
   await removed();await db.pool.query('UPDATE sdr_provider_operations SET kind=$1,state=$2',[kind,state]);
   await expect(reserveEnrollment(args()),`${kind}/${state}`).rejects.toMatchObject({code:'provider_operation_requires_review'});
  }
 });

 // nathan.kemp@rinkerpipe.com: a September PB row still says "enrolled" with no email; Apollo
 // holds no membership for him. Such a row is not history once two days have passed.
 it('a row still marked enrolled or switched with no email after two days is not history; Apollo still decides',async()=>{
  const stale=async(status,days)=>{await reset();
   await db.pool.query(`INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_contact_id,apollo_sequence_id,status,sent_at) VALUES('old','lead-old','contact','pb',$1,NOW()-make_interval(days=>$2::int))`,[status,days]);};
  for(const status of ['enrolled','switched']){
   await stale(status,50);
   expect(await readContactSendDaysAgo(db.pool,{apolloContactId:'contact',recipientEmail:'buyer@example.test'}),status).toBeNull();
   expect((await reserveEnrollment(args())).reservationId,status).toBeTruthy();
  }
  // Inside two days the enrollment may still send: it stays history.
  await stale('enrolled',1);
  await expect(reserveEnrollment(args())).rejects.toMatchObject({code:'external_membership_requires_review'});
  // Apollo failed the contact at step 1 (invalid MX): the membership it shows still refuses.
  await stale('enrolled',50);
  await expect(reserveEnrollment(args({apollo:{getContact:async()=>({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'pb',status:'failed',inactive_reason:'Invalid MX record'}]})}}))).rejects.toMatchObject({code:'external_membership_requires_review'});
 });

 it('a membership Apollo still shows is refused as before',async()=>{
  await removed();
  await expect(reserveEnrollment(args({apollo:{getContact:async()=>({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'pb',status:'finished'}]})}}))).rejects.toMatchObject({code:'external_membership_requires_review'});
 });
});
