import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {claimSoftEnrollment,legacySoftOutcome} from '../softEnrollmentPacing.js';
import {softObservationCoverage} from '../softVerdictGuard.js';
const db=reportingTestDb('soft_pacing');
const draft=(sequence='pb')=>({id:randomUUID(),revision:1,apollo_sequence_id:sequence,contact_email_snapshot:`${randomUUID()}@example.test`});
const claim=async d=>{const c=await db.pool.connect();try{return await claimSoftEnrollment(c,d);}finally{await c.query('SELECT pg_advisory_unlock_all()');c.release();}};
describe.skipIf(!db)('durable uncertain-address batches',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_settings(id int,soft_verdict_daily_cap int,engagement_last_full_scan_at timestamptz);
   CREATE TABLE sdr_apollo_poll_state(scope text,state jsonb);
   CREATE TABLE sdr_drafts(id uuid,metadata jsonb,pipedrive_lead_id text,contact_email_snapshot text,created_at timestamptz,initiated_by text,status text);
   CREATE TABLE sdr_sends(id uuid DEFAULT gen_random_uuid(),apollo_contact_id text, draft_id uuid,apollo_sequence_id text,created_at timestamptz,status text,step_status text,last_status_at timestamptz,apollo_emailer_message_id text);
   CREATE TABLE sdr_provider_operations(kind text,expected_membership jsonb,draft_revision int,campaign_id text,created_at timestamptz DEFAULT NOW(),state text,enrollment_phase text);
   CREATE TABLE sdr_lead_state(pipedrive_lead_id text,email_verified_value text,email_verify_status text);
   CREATE TABLE sdr_reporting_messages(provider text,direction text,campaign_id text,prospect_email text,sequence_step int,occurred_at timestamptz,observed_at timestamptz,provider_status text,bounce boolean,spam_blocked boolean)`);
  for(const f of ['2026-11-03-sdr-volume-alerts.sql','2026-11-16-sdr-soft-admission.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));
 });
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{
  await db.pool.query(`TRUNCATE sdr_soft_legacy_outcomes,sdr_provider_operations,sdr_settings,sdr_apollo_poll_state,sdr_drafts,sdr_sends,sdr_lead_state,sdr_reporting_messages,sdr_soft_enrollment_checks;
   INSERT INTO sdr_settings VALUES(1,40,NOW());
   INSERT INTO sdr_apollo_poll_state VALUES('engagement','{"reconciledSequences":{"pb":true,"lba":true}}');
   INSERT INTO sdr_reporting_messages(provider,direction,campaign_id,observed_at,provider_status) VALUES('apollo','out','pb',NOW(),'scheduled'),('apollo','out','lba',NOW(),'scheduled')`);
 });
 it('serializes concurrent enrollments: five accepted, sixth held, other sequence independent',async()=>{
  const results=await Promise.allSettled(Array.from({length:8},()=>claim(draft())));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5);
  expect(results.filter(r=>r.status==='rejected').map(r=>r.reason.code)).toEqual(['soft_cap_reached','soft_cap_reached','soft_cap_reached']);
  expect(await claim(draft('lba'))).toMatchObject({sequence_id:'lba'});
 });
 it('keeps a retry in the same slot without permitting changed address or sequence',async()=>{
  const d=draft();const first=await claim(d);const again=await claim(d);
  expect(again.checked_at).toEqual(first.checked_at);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_soft_enrollment_checks')).rows[0].n).toBe(1);
  await expect(claim({...d,contact_email_snapshot:'changed@example.test'})).rejects.toMatchObject({code:'soft_bounce_guard'});
 });
 it('enforces the daily cap across different sequences under concurrent calls',async()=>{
  await db.pool.query('UPDATE sdr_settings SET soft_verdict_daily_cap=2');
  const results=await Promise.allSettled(['pb','lba','pb','lba'].map(s=>claim(draft(s))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
 });
 it('does not release old pending slots just because three days elapsed',async()=>{
  for(let i=0;i<5;i++)await claim(draft());
  await db.pool.query("UPDATE sdr_soft_enrollment_checks SET checked_at=NOW()-interval '10 days'");
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_cap_reached',preserveDraft:true});
  await db.pool.query(`INSERT INTO sdr_reporting_messages(provider,direction,campaign_id,prospect_email,sequence_step,occurred_at,observed_at,provider_status)
   SELECT 'apollo','out',sequence_id,recipient_email,1,NOW()-interval '4 days',NOW(),'completed' FROM sdr_soft_enrollment_checks`);
  expect(await claim(draft())).toMatchObject({sequence_id:'pb'});
 });
 it('counts existing soft enrollments made before this release',async()=>{
  for(let i=0;i<5;i++){
   const d=draft();await db.pool.query(`INSERT INTO sdr_drafts VALUES($1,'{"email_verdict":"soft"}','old',$2,NOW(),'automatic','sent')`,[d.id,d.contact_email_snapshot]);
   await db.pool.query("INSERT INTO sdr_sends(draft_id,apollo_sequence_id,created_at) VALUES($1,'pb',NOW())",[d.id]);
  }
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_cap_reached'});
 });
 const legacy=async(status,step,last="NOW()-interval '4 days'",message=null)=>{
  const d=draft();
  await db.pool.query(`INSERT INTO sdr_drafts VALUES($1,'{"email_verdict":"soft"}','old',$2,NOW()-interval '10 days','automatic','sent')`,[d.id,d.contact_email_snapshot]);
  await db.pool.query(`INSERT INTO sdr_sends(draft_id,apollo_sequence_id,created_at,status,step_status,last_status_at,apollo_emailer_message_id) VALUES($1,'pb',NOW()-interval '10 days',$2,$3,${last},$4)`,[d.id,status,step,message]);return d;
 };
 const operation=async(d,state,revision=1)=>db.pool.query(`INSERT INTO sdr_provider_operations(kind,expected_membership,draft_revision,campaign_id,state,enrollment_phase)
  VALUES('enroll',$1,$2,'pb',$3,'add_started')`,[JSON.stringify({draftId:d.id,recipientEmail:d.contact_email_snapshot}),revision,state]);
 it('settles aged known legacy outcomes without requiring a first email that never existed',async()=>{
  for(const [status,step] of [['failed','refused'],['failed','removed'],['failed','finished'],['bounced','bounced'],['replied','replied'],['unsubscribed','unsubscribed']])await legacy(status,step);
  expect(await claim(draft())).toMatchObject({sequence_id:'pb'});
 });
 it('keeps unknown legacy outcomes, recent outcomes and recently attempted sends counted',async()=>{
  await legacy('switched',null);await legacy('failed','failed');await legacy('failed',null);await legacy('failed','refused','NOW()');
  const d=await legacy('replied','replied');
  await db.pool.query(`INSERT INTO sdr_reporting_messages VALUES('apollo','out','pb',$1,1,NOW(),NOW(),'completed',false,false)`,[d.contact_email_snapshot]);
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_cap_reached'});
 });
 it('releases definite no-send operations, while a retry competes for a new slot',async()=>{
  const d=draft();await claim(d);await operation(d,'pre_add_refused');
  for(let i=0;i<5;i++)await claim(draft());
  await expect(claim(d)).rejects.toMatchObject({code:'soft_cap_reached'});
 });
 it('does not let a receipt from a previous attempt release a retried reservation',async()=>{
  const d=draft();await claim(d);await operation(d,'provider_skipped');
  const retry=await claim(d);expect(retry.sequence_id).toBe('pb');
  for(let i=0;i<4;i++)await claim(draft());
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_cap_reached'});
 });
 it('keeps uncertainty and different-revision receipts counted',async()=>{
  const d=draft();await claim(d);await operation(d,'pre_add_refused');await operation(d,'unresolved');
  const other=draft();await claim(other);await operation(other,'provider_skipped',2);
  for(let i=0;i<3;i++)await claim(draft());
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_cap_reached'});
 });
 it('uses exact terminal provider receipts after the settling period without changing legacy send history',async()=>{
  for(let i=0;i<5;i++)await legacy('switched',null);
  await db.pool.query("UPDATE sdr_sends SET apollo_contact_id='contact'");
  await db.pool.query(`INSERT INTO sdr_soft_legacy_outcomes(send_id,sequence_id,contact_id,recipient_email,outcome,evidence)
   SELECT s.id,s.apollo_sequence_id,s.apollo_contact_id,d.contact_email_snapshot,'absent','{"source":"apollo_contact_read"}'
   FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id`);
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_cap_reached'});
  await db.pool.query("UPDATE sdr_soft_legacy_outcomes SET observed_at=NOW()-interval '4 days'");
  expect(await claim(draft())).toMatchObject({sequence_id:'pb'});
  expect((await db.pool.query("SELECT count(*)::int n FROM sdr_sends WHERE status='switched'")).rows[0].n).toBe(5);
 });
 it('holds missing, stale or incomplete sequence observations, including a fresh other sequence',async()=>{
  await db.pool.query("UPDATE sdr_reporting_messages SET observed_at=NOW()-interval '2 hours' WHERE campaign_id='pb'");
  expect((await softObservationCoverage(db.pool)).covered.has('pb')).toBe(false);
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_bounce_guard'});
  await db.pool.query('UPDATE sdr_reporting_messages SET observed_at=NOW()');
  await db.pool.query("UPDATE sdr_settings SET engagement_last_full_scan_at=NOW()-interval '7 hours'");
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_bounce_guard'});
  await db.pool.query('UPDATE sdr_settings SET engagement_last_full_scan_at=NOW()');
  await db.pool.query("UPDATE sdr_apollo_poll_state SET state='{}'");
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_bounce_guard'});
 });
 it('checks the bounce threshold again on retry, retaining the reserved slot',async()=>{
  const d=draft();await claim(d);
  await db.pool.query(`INSERT INTO sdr_reporting_messages VALUES('apollo','out','pb','bad@example.test',1,NOW(),NOW(),'failed',true,false)`);
  await expect(claim(d)).rejects.toMatchObject({code:'soft_bounce_guard'});
 });
 it('keeps the draft queued on a missing tracking table',async()=>{
  await db.pool.query('ALTER TABLE sdr_soft_enrollment_checks RENAME TO unavailable');
  try{await expect(claim(draft())).rejects.toMatchObject({code:'soft_bounce_guard',preserveDraft:true});}
  finally{await db.pool.query('ALTER TABLE unavailable RENAME TO sdr_soft_enrollment_checks');}
 });
});

describe('legacy receipt identity',()=>{
 const send={id:'send',apollo_contact_id:'c',recipient_email:'person@example.test',sequence_id:'pb'};
 const contact={id:'c',email:'person@example.test',contact_campaign_statuses:[]};
 it('accepts complete absence and closed memberships',()=>{
  expect(legacySoftOutcome(send,contact)?.outcome).toBe('absent');
  expect(legacySoftOutcome(send,{...contact,contact_campaign_statuses:[{emailer_campaign_id:'pb',status:'finished'}]})?.outcome).toBe('finished');
 });
 it('keeps missing, mismatched, open and ambiguous memberships held',()=>{
  for(const value of [{...contact,id:'other'},{...contact,email:'other@example.test'},{...contact,contact_campaign_statuses:null},
   {...contact,contact_campaign_statuses:[{}]},
   ...['active','paused','unknown'].map(status=>({...contact,contact_campaign_statuses:[{emailer_campaign_id:'pb',status}]})),
   {...contact,contact_campaign_statuses:[{emailer_campaign_id:'pb',status:'finished'},{emailer_campaign_id:'pb',status:'finished'}]}])expect(legacySoftOutcome(send,value)).toBeNull();
 });
});
