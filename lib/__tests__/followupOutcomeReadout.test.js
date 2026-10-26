import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {reportingTestDb} from './reportingTestDb.js';
import {readFollowupOutcomes} from '../followupOutcomeReadout.js';

const db=reportingTestDb('followup_outcomes');
const now=new Date('2026-10-23T17:00:00Z'); // Fri; week of Mon Oct 19 (Chicago)
describe.skipIf(!db)('weekly follow-up outcome readout (Postgres)',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`
  CREATE TABLE quiet_followup_marks(pipedrive_lead_id text,conversation_key text,step text,outcome text,activity_id text,created_at timestamptz);
  CREATE TABLE bid_followup_marks(pipedrive_lead_id text,step text,outcome text,due_date date,activity_id text,created_at timestamptz);
  CREATE TABLE sdr_lead_state(pipedrive_lead_id text,person_email text);
  CREATE TABLE sdr_conversation_events(provider text,account_key text,provider_event_id text,status text);
  CREATE TABLE sdr_conversation_coverage(provider text,account_key text,scope text,status text,checked_at timestamptz);
  CREATE TABLE sdr_conversation_messages(provider text,account_key text,provider_message_id text,internet_message_id text,from_address text,to_addresses jsonb DEFAULT '[]',cc_addresses jsonb DEFAULT '[]',occurred_at timestamptz,direction text);
  CREATE TABLE sdr_reply_messages(provider_message_id text,source_message_id text,mailbox_email text,pipedrive_lead_id text,link_status text,reply_kind text,received_at timestamptz);
  CREATE TABLE sdr_deal_facts(pipedrive_deal_id text,pipedrive_lead_id text,link_status text,status text,qualified_quote boolean,quote_evidence jsonb,quote_created_at timestamptz,won_at timestamptz,is_test boolean DEFAULT false);
  CREATE TABLE sdr_job_runs(job text,scope text,status text,finished_at timestamptz);`);});
 afterAll(()=>db.close());
 beforeEach(async()=>{
  await db.pool.query(`TRUNCATE quiet_followup_marks,bid_followup_marks,sdr_lead_state,sdr_conversation_events,sdr_conversation_coverage,sdr_conversation_messages,sdr_reply_messages,sdr_deal_facts,sdr_job_runs;
   INSERT INTO sdr_lead_state VALUES('l1','a@buyer.test'),('l2','b_x@buyer.test'),('l3','c@buyer.test'),('l4','d@buyer.test');
   INSERT INTO quiet_followup_marks VALUES
    ('l1','k','nudge1','created','901','2026-10-19T15:00:00Z'),
    ('l2','k','nudge1','created','902','2026-10-20T15:00:00Z'),
    ('l2','k2','nudge2','pending',null,'2026-10-21T15:00:00Z'),
    ('l4','k','waiting','skipped:declined',null,'2026-10-21T15:00:00Z'),
    ('l1','old','nudge1','created','800','2026-08-03T15:00:00Z'),
    ('l4','k3','nudge1','created','904','2026-10-13T15:00:00Z');
   INSERT INTO bid_followup_marks VALUES('l3','fu1','created','2026-10-22','903','2026-10-20T16:00:00Z'),('l4','fu2','pending',null,null,'2026-10-21T16:00:00Z');
   INSERT INTO sdr_conversation_events VALUES('pipedrive','co','901','completed'),('pipedrive','co','902','pending'),('pipedrive','co','904','completed');
   INSERT INTO sdr_conversation_coverage VALUES('pipedrive','co','activities:all-users','complete','2026-10-23T12:00:00Z');
   INSERT INTO sdr_conversation_messages VALUES
    ('pipedrive','co','m1',null,'Derek <dc@proswppp.com>','["Rodger <A@buyer.test>"]','[]','2026-10-20T10:00:00Z','out'),
    ('pipedrive','co','m2',null,'Derek <dc@proswppp.com>','["c@buyer.test"]','[]','2026-10-19T10:00:00Z','out'),
    ('pipedrive','co','m3',null,'Derek <dc@proswppp.com>','["bax@buyer.test"]','[]','2026-10-21T10:00:00Z','out'),
    ('gmail','dc@proswppp.co','m4','auto-1','b_x@buyer.test','[]','[]','2026-10-21T10:00:00Z','in'),
    ('gmail','dc@proswppp.co','m5',null,'Kyle <c@buyer.test>','[]','[]','2026-10-21T11:00:00Z','in');
   INSERT INTO sdr_reply_messages VALUES
    ('rfc822:auto-1','m4','dc@proswppp.co','l2','verified','auto','2026-10-21T10:00:00Z'),
    ('r1','x1','dc@proswppp.co','l1','verified','human','2026-10-21T09:00:00Z'),
    ('r2','x2','dc@proswppp.co','l4','ambiguous','human','2026-10-14T09:00:00Z');
   INSERT INTO sdr_deal_facts VALUES
    ('d1','l1','verified','won',true,'{"source":"stage"}','2026-10-21T00:00:00Z','2026-10-22T00:00:00Z',false),
    ('d2','l2','verified','open',true,'{"source":"stage"}','2026-10-01T00:00:00Z',null,false),
    ('d3','l2','unmatched','won',true,'{"source":"stage"}','2026-10-22T00:00:00Z','2026-10-22T00:00:00Z',false),
    ('d4','l3','verified','won',true,'{"source":"stage"}','2026-10-22T00:00:00Z','2026-10-22T00:00:00Z',true),
    ('d5','l4','verified','open',true,null,'2026-10-15T00:00:00Z',null,false);
   INSERT INTO sdr_job_runs VALUES('pipedrive_deals','company','complete','2026-10-23T06:00:00Z');`);
 });
 it('counts created, done, emails, replies, quotes and wins after each task, per week and kind',async()=>{
  const out=await readFollowupOutcomes(db.pool,{weeks:2,now});
  expect(out).toMatchObject({weeks:2,since:'2026-10-12T05:00:00.000Z',orders:'unavailable'});
  expect(out.rows).toEqual([
   {kind:'quiet',week:'2026-10-19',created:2,done:1,open:1,statusUnknown:0,emailedAfter:1,replyAfter:1,quoteAfter:1,wonAfter:1},
   {kind:'bid',week:'2026-10-19',created:1,done:0,open:0,statusUnknown:1,emailedAfter:0,replyAfter:1,quoteAfter:0,wonAfter:0},
   {kind:'quiet',week:'2026-10-12',created:1,done:1,open:0,statusUnknown:0,emailedAfter:0,replyAfter:0,quoteAfter:0,wonAfter:0},
  ]);
 });
 it('shows sales and task status as unavailable without a deal sync or activity collection, never zero',async()=>{
  await db.pool.query('TRUNCATE sdr_job_runs,sdr_conversation_coverage');
  const out=await readFollowupOutcomes(db.pool,{weeks:1,now});
  expect(out.salesCheckedAt).toBeNull();expect(out.activitiesCheckedAt).toBeNull();
  expect(out.rows).toEqual([{kind:'quiet',week:'2026-10-19',created:2,done:null,open:null,statusUnknown:null,emailedAfter:1,replyAfter:1,quoteAfter:null,wonAfter:null},
   {kind:'bid',week:'2026-10-19',created:1,done:null,open:null,statusUnknown:null,emailedAfter:0,replyAfter:1,quoteAfter:null,wonAfter:null}]);
 });
 it('A1.5 counts a task the job saw marked done, and the Pipedrive person\'s last outgoing mail as our email after',async()=>{
  await db.pool.query(`TRUNCATE sdr_conversation_coverage,sdr_conversation_events,sdr_conversation_messages`);
  await db.pool.query(`ALTER TABLE quiet_followup_marks ADD COLUMN task_state text;ALTER TABLE sdr_lead_state ADD COLUMN last_outgoing_mail_time timestamptz`);
  try {
   await db.pool.query(`UPDATE quiet_followup_marks SET task_state='done' WHERE activity_id='901';UPDATE quiet_followup_marks SET task_state='open' WHERE activity_id='902';
    UPDATE sdr_lead_state SET last_outgoing_mail_time='2026-10-21T13:56:11Z' WHERE pipedrive_lead_id='l2'`);
   const out=await readFollowupOutcomes(db.pool,{weeks:1,now});
   expect(out.rows.find(r=>r.kind==='quiet')).toMatchObject({created:2,done:1,open:1,statusUnknown:0,emailedAfter:1});
  } finally {
   await db.pool.query(`ALTER TABLE quiet_followup_marks DROP COLUMN task_state;ALTER TABLE sdr_lead_state DROP COLUMN last_outgoing_mail_time`);
  }
 });
 it('ignores a deal sync that finished after the report time and returns nothing before any task table exists',async()=>{
  await db.pool.query(`UPDATE sdr_job_runs SET finished_at='2026-10-24T00:00:00Z'`);
  expect((await readFollowupOutcomes(db.pool,{weeks:1,now})).rows[0].quoteAfter).toBeNull();
  await db.pool.query('ALTER TABLE quiet_followup_marks RENAME TO quiet_marks_hidden;ALTER TABLE bid_followup_marks RENAME TO bid_marks_hidden');
  try{expect((await readFollowupOutcomes(db.pool,{now})).rows).toEqual([]);}
  finally{await db.pool.query('ALTER TABLE quiet_marks_hidden RENAME TO quiet_followup_marks;ALTER TABLE bid_marks_hidden RENAME TO bid_followup_marks');}
 });
});

describe('follow-up outcomes route',()=>{
 const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('app.get("/api/sdr/followups/outcomes"'),source.indexOf('// Resolve a lead to its inbox thread'));
 const route=read=>{let handler;new Function('app','pool','readFollowupOutcomes','console',block)({get:(_,h)=>handler=h},{},read,{error(){}});return handler;};
 const invoke=async(handler,user)=>{let status=200,body;await handler({sdrUser:user,query:{weeks:'4'}},{set(){return this;},status(c){status=c;return this;},json(v){body=v;return this;}});return {status,body};};
 it('is admin only and passes the week span through',async()=>{
  const calls=[];const handler=route(async(_,o)=>{calls.push(o);return {rows:[]};});
  expect(await invoke(handler,{sub:'s',role:'sdr'})).toEqual({status:403,body:{error:'Admin only'}});expect(calls).toEqual([]);
  expect(await invoke(handler,{sub:'a',role:'admin'})).toEqual({status:200,body:{rows:[]}});expect(calls).toEqual([{weeks:'4'}]);
 });
 it('fails closed with 503 on a read error',async()=>{
  expect((await invoke(route(async()=>{throw new Error('relation missing');}),{sub:'a',role:'admin'})).status).toBe(503);
 });
});
