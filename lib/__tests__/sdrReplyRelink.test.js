import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {enqueueReplyActions,relinkHeldReply} from '../sdrReplyActions.js';
import {relinkHeldReplies} from '../inboxReplyWatch.js';
const db=reportingTestDb('reply_relink');
const mailbox='rep@example.test';
const day=n=>new Date(Date.now()-n*86400000);
const out=(over={})=>({id:'g-out',messageId:'<out@apollo.test>',from:mailbox,to:'buyer@example.test',subject:'Project A SWPPP',receivedAt:day(4).toISOString(),lastOutbound:true,...over});
const reply=(over={})=>({id:'g-in',messageId:'<in@buyer.test>',from:'Buyer <buyer@example.test>',to:mailbox,subject:'Re: Project A SWPPP',receivedAt:day(3).toISOString(),...over});
const hold=(over={})=>enqueueReplyActions(db.pool,{messageId:'rfc822:<in@buyer.test>',sourceMessageId:'g-in',threadId:'t1',mailbox,receivedAt:day(3),
  leadLink:{status:'ambiguous',candidates:['lead-a','lead-b']},intent:{kind:'human',label:'interested',worth:true},...over});
const kinds=async()=>(await db.pool.query("SELECT kind,status,requires_review,safe_error FROM sdr_reply_actions ORDER BY kind,target_key")).rows;
const gmail=messages=>({getThread:async()=>({id:'t1',messages})});
const run=messages=>relinkHeldReplies(db.pool,{getToken:async()=>'token',gmail:gmail(messages),featureEnabled:true});

describe.skipIf(!db)('held replies get their actions once a single project is proven',()=>{
 beforeAll(async()=>{await db.setup();
  await db.pool.query(`CREATE TABLE sdr_sends(id text PRIMARY KEY,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,status text,last_status_at timestamptz,updated_at timestamptz);
   CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,person_email text,lead_title text,sequence_started text);
   CREATE TABLE sdr_mailboxes(id text PRIMARY KEY,email text);
   CREATE TABLE sdr_drafts(id text PRIMARY KEY,pipedrive_lead_id text,assigned_mailbox_id text,contact_email_snapshot text,subject text,status text,sent_at timestamptz)`);
  await db.pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-reply-actions.sql',import.meta.url),'utf8'));});
 afterAll(()=>db.close());
 beforeEach(async()=>{
  await db.pool.query('TRUNCATE sdr_reply_actions,sdr_reply_messages,sdr_reply_routes,sdr_sends,sdr_lead_state,sdr_mailboxes,sdr_drafts');
  await db.pool.query("INSERT INTO sdr_sends VALUES('send-1','lead-a','seq-a','contact-a','enrolled',NOW(),NOW())");
  await db.pool.query("INSERT INTO sdr_lead_state VALUES('lead-a','buyer@example.test','Project A','2026-10-01'),('lead-b','buyer@example.test','Project B',NULL)");
  await db.pool.query("INSERT INTO sdr_reply_routes(mailbox_email,forward_to,pipedrive_user_id,verified_at) VALUES($1,'real@example.test',7,NOW())",[mailbox]);
  await db.pool.query("INSERT INTO sdr_mailboxes VALUES('mb',$1),('other','other@example.test')",[mailbox]);
  await db.pool.query("INSERT INTO sdr_drafts VALUES('d1','lead-a','mb','buyer@example.test','Project A SWPPP','sent',$1),('d2','lead-b','other','buyer@example.test','Project B SWPPP','sent',$1)",[day(5)]);
 });

 it('adds the task, note and sequence stop, closes the review, and does not forward twice',async()=>{
  await hold();
  expect((await kinds()).map(k=>k.kind)).toEqual(['create_task','forward','match_lead']);
  expect(await relinkHeldReply(db.pool,{messageId:'rfc822:<in@buyer.test>',link:{status:'verified',leadId:'lead-a',evidence:'gmail-thread:t1:outbound-message:g-out:sent-draft:d1'}})).toMatchObject({relinked:true});
  const k=await kinds();
  expect(k.map(x=>x.kind)).toEqual(['clear_sequence_flag','create_note','create_task','create_task','forward','match_lead','stop_sequence']);
  // the no-lead task that never ran is dropped for the project task
  expect(k.filter(x=>x.kind==='create_task').map(x=>x.status)).toEqual(['pending','skipped']);
  expect(k.find(x=>x.kind==='match_lead')).toMatchObject({status:'skipped',requires_review:false,safe_error:'relinked'});
  expect(k.find(x=>x.kind==='create_task')).toMatchObject({status:'pending',requires_review:false});
  expect((await db.pool.query("SELECT pipedrive_lead_id,link_status FROM sdr_reply_messages")).rows).toEqual([{pipedrive_lead_id:'lead-a',link_status:'verified'}]);
  expect((await db.pool.query("SELECT status FROM sdr_sends")).rows).toEqual([{status:'replied'}]);
  expect(await relinkHeldReply(db.pool,{messageId:'rfc822:<in@buyer.test>',link:{status:'verified',leadId:'lead-a',evidence:'x'}})).toMatchObject({relinked:false});
 });

 it('does not make a second task when the no-lead task already reached the rep',async()=>{
  await hold();
  await db.pool.query("UPDATE sdr_reply_actions SET status='completed',external_id='pd-1',receipt_at=NOW() WHERE kind='create_task'");
  expect(await relinkHeldReply(db.pool,{messageId:'rfc822:<in@buyer.test>',link:{status:'verified',leadId:'lead-a',evidence:'gmail-thread:t1:outbound-message:g-out:sent-draft:d1'}})).toMatchObject({relinked:true});
  expect((await kinds()).filter(x=>x.kind==='create_task').map(x=>x.status)).toEqual(['completed']);
 });

 it('relinks a recent held reply from its live thread',async()=>{
  await hold();
  expect(await run([out(),reply()])).toMatchObject({checked:1,relinked:1});
  expect((await kinds()).map(x=>x.kind)).toContain('create_task');
 });

 it('sends a reply someone already answered in the thread to review instead of a new task',async()=>{
  await hold();
  await run([out(),reply(),out({id:'g-later',messageId:'<later@rep.test>',subject:'Re: Project A SWPPP',receivedAt:day(2).toISOString()})]);
  expect((await kinds()).find(x=>x.kind==='create_task')).toMatchObject({requires_review:true,safe_error:'later_outbound_unverified'});
 });

 it('links a returned email to the project and records the bounce without a rep task',async()=>{
  await hold({messageId:'rfc822:<ndr@mail.test>',sourceMessageId:'g-ndr',intent:{kind:'bounce',label:'bounce',worth:false},leadLink:{status:'ambiguous',candidates:['lead-a']}});
  const ndr={id:'g-ndr',messageId:'<ndr@mail.test>',from:'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',to:mailbox,subject:'Delivery Status Notification (Failure)',receivedAt:day(3).toISOString()};
  await db.pool.query("UPDATE sdr_reply_actions SET payload=payload||'{\"sourceMessageId\":\"g-ndr\"}'");
  expect(await run([out(),ndr])).toMatchObject({relinked:1});
  expect((await kinds()).map(x=>x.kind)).toEqual(['clear_sequence_flag','create_note','match_lead','stop_sequence']);
  expect((await db.pool.query("SELECT status FROM sdr_sends")).rows).toEqual([{status:'bounced'}]);
 });

 it('leaves older replies with staff and re-checks an unresolved one at most every six hours',async()=>{
  await hold({receivedAt:day(20)});
  expect(await run([out(),reply()])).toMatchObject({checked:0});
  await db.pool.query('TRUNCATE sdr_reply_actions,sdr_reply_messages');
  await hold();
  const unrelated=[out({to:'someone@example.test'}),reply()];
  expect(await run(unrelated)).toMatchObject({checked:1,unresolved:1});
  expect(await run(unrelated)).toMatchObject({checked:0});
 });
});
