import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {claimSoftEnrollment} from '../softEnrollmentPacing.js';
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
   CREATE TABLE sdr_sends(draft_id uuid,apollo_sequence_id text,created_at timestamptz);
   CREATE TABLE sdr_lead_state(pipedrive_lead_id text,email_verified_value text,email_verify_status text);
   CREATE TABLE sdr_reporting_messages(provider text,direction text,campaign_id text,prospect_email text,sequence_step int,occurred_at timestamptz,observed_at timestamptz,provider_status text,bounce boolean,spam_blocked boolean)`);
  for(const f of ['2026-11-03-sdr-volume-alerts.sql','2026-11-16-sdr-soft-admission.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));
 });
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{
  await db.pool.query(`TRUNCATE sdr_settings,sdr_apollo_poll_state,sdr_drafts,sdr_sends,sdr_lead_state,sdr_reporting_messages,sdr_soft_enrollment_checks;
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
   await db.pool.query("INSERT INTO sdr_sends VALUES($1,'pb',NOW())",[d.id]);
  }
  await expect(claim(draft())).rejects.toMatchObject({code:'soft_cap_reached'});
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
