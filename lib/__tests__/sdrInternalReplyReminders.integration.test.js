import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import pg from 'pg';import fs from 'node:fs/promises';
import * as mod from '../sdrInternalReplyReminders.js';
const schema='internal_reminders_'+process.pid,url=process.env.SDR_TEST_DATABASE_URL;
if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('local test DB required');
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
let sent,client,ctx;
const now=new Date('2026-11-16T15:00:00Z');
const options=()=>({mode:'live',companyId:'13105180',since:'2026-11-16T00:00:00Z',seedTaskIds:['39093'],derekUserId:11,now,client,notify:async m=>{sent.push(m);return {id:'sent-1'};}});
beforeAll(async()=>{await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`
 CREATE TABLE sdr_reply_messages(provider_message_id text PRIMARY KEY,source text,source_message_id text,thread_id text,mailbox_email text,received_at timestamptz,pipedrive_lead_id text,reply_kind text,intent text,staff_response_at timestamptz,from_email text);
 CREATE TABLE sdr_reply_actions(id uuid PRIMARY KEY,provider_message_id text,external_id text,kind text,status text,payload jsonb,receipt_at timestamptz,created_at timestamptz);
 CREATE TABLE sdr_reply_routes(mailbox_email text,forward_to text,pipedrive_user_id bigint,active boolean,verified_at timestamptz);
 `);await pool.query(await fs.readFile(new URL('../../migrations/2026-11-16-sdr-internal-reply-reminders.sql',import.meta.url),'utf8'));});
afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE sdr_internal_reply_reminder_notices,sdr_internal_reply_reminder_checks,sdr_reply_actions,sdr_reply_messages,sdr_reply_routes');
 await pool.query(`INSERT INTO sdr_reply_messages VALUES('reply','gmail','msg','thread','pm@proswppp.co','2026-11-10T12:10:00Z','lead','human','question',NULL,'cody@buyer.test');
 INSERT INTO sdr_reply_actions VALUES('00000000-0000-0000-0000-000000000001','reply','39093','create_task','completed','{"leadId":"lead"}','2026-11-10T12:16:00Z','2026-11-10T12:16:00Z');
 INSERT INTO sdr_reply_routes VALUES('pm@proswppp.co','pm@proswppp.com',22,true,now()),('dc@proswppp.co','dc@proswppp.com',11,true,now());`);
 sent=[];ctx={task:{id:39093,user_id:22,done:false,due_date:'2026-11-10',subject:'Cody request'},original:{body:'Please send the proposal'},handled:false,fingerprint:'fresh',context:[]};
 client={validateIdentity:async()=>{},users:async()=>[{id:22,email:'pm@proswppp.com',active_flag:true},{id:11,email:'dc@proswppp.com',active_flag:true}],inspect:async()=>structuredClone(ctx)};
});
describe('internal reminder worker',()=>{
 it('sends to the verified current staff owner once across repeated runs',async()=>{
  await mod.runInternalReplyReminders(pool,options());await mod.runInternalReplyReminders(pool,options());
  expect(sent).toHaveLength(1);expect(sent[0].to).toBe('pm@proswppp.com');expect(sent[0].to).not.toBe('cody@buyer.test');
  expect((await pool.query('SELECT state FROM sdr_internal_reply_reminder_notices')).rows).toEqual([{state:'sent'}]);
 });
 it('preserves the database calendar day when an owner changes the same day',async()=>{
  await mod.runInternalReplyReminders(pool,options());ctx.task.user_id=11;
  const next=await mod.runInternalReplyReminders(pool,{...options(),mode:'dry_run'});
  expect(next.plans).toHaveLength(0);
 });
 it('rechecks human classification immediately before delivery',async()=>{
  let reads=0;client.inspect=async()=>{if(++reads===2)await pool.query("UPDATE sdr_reply_messages SET reply_kind='automated'");return ctx;};
  await mod.runInternalReplyReminders(pool,options());expect(sent).toHaveLength(0);
 });
 it('dry-run has plans but zero notice or check writes',async()=>{
  const r=await mod.runInternalReplyReminders(pool,{...options(),mode:'dry_run'});
  expect(r.plans).toHaveLength(1);expect(sent).toHaveLength(0);
  expect((await pool.query('SELECT * FROM sdr_internal_reply_reminder_notices')).rowCount).toBe(0);
  expect((await pool.query('SELECT * FROM sdr_internal_reply_reminder_checks')).rowCount).toBe(0);
 });
 it('does not blindly retry a timeout that may already have sent',async()=>{
  const opts={...options(),notify:async m=>{sent.push(m);throw Error('timeout');}};
  await mod.runInternalReplyReminders(pool,opts);await mod.runInternalReplyReminders(pool,opts);
  expect(sent).toHaveLength(1);expect((await pool.query('SELECT state FROM sdr_internal_reply_reminder_notices')).rows[0].state).toBe('uncertain');
 });
 it('rechecks completion immediately before sending',async()=>{
  let reads=0;client.inspect=async()=>({...ctx,handled:++reads>1,fingerprint:reads>1?'changed':'fresh'});
  await mod.runInternalReplyReminders(pool,options());expect(sent).toHaveLength(0);
 });
 it('suppresses a read failure, inactive owner or external recipient',async()=>{
  client.inspect=async()=>{throw Error('source unavailable');};await mod.runInternalReplyReminders(pool,options());expect(sent).toHaveLength(0);
  client.inspect=async()=>ctx;await pool.query("UPDATE sdr_reply_routes SET forward_to='buyer@external.test' WHERE pipedrive_user_id=22");
  await mod.runInternalReplyReminders(pool,options());expect(sent).toHaveLength(0);
 });
 it('snoozing a due date also prevents escalation',async()=>{
  await mod.runInternalReplyReminders(pool,options());ctx.task.due_date='2026-11-20';
  await mod.runInternalReplyReminders(pool,{...options(),now:new Date('2026-11-17T15:00:00Z')});expect(sent).toHaveLength(1);
 });
 it('escalates to Derek only on a later business day',async()=>{
  await mod.runInternalReplyReminders(pool,options());
  await mod.runInternalReplyReminders(pool,{...options(),now:new Date('2026-11-17T15:00:00Z')});
  expect(sent.map(m=>m.to)).toEqual(['pm@proswppp.com','dc@proswppp.com']);
 });
 it('two concurrent workers cannot duplicate a reminder',async()=>{
  await Promise.all([mod.runInternalReplyReminders(pool,options()),mod.runInternalReplyReminders(pool,options())]);expect(sent).toHaveLength(1);
 });
 it('cancelled preflight can be reconsidered after the task stops changing',async()=>{
  let reads=0;client.inspect=async()=>({...ctx,fingerprint:++reads===2?'changed':'fresh'});
  await mod.runInternalReplyReminders(pool,options());await mod.runInternalReplyReminders(pool,options());expect(sent).toHaveLength(1);
 });
 it('revoked recipient routing during preflight prevents delivery',async()=>{
  let reads=0;client.inspect=async()=>{if(++reads===2)await pool.query("UPDATE sdr_reply_routes SET active=false WHERE pipedrive_user_id=22");return ctx;};
  await mod.runInternalReplyReminders(pool,options());expect(sent).toHaveLength(0);
 });
 it('a crash-reserved send blocks all later reminders without a confirmed sent receipt',async()=>{
  await mod.runInternalReplyReminders(pool,options());await pool.query("UPDATE sdr_internal_reply_reminder_notices SET state='reserved',sent_at=NULL,provider_id=NULL");
  await mod.runInternalReplyReminders(pool,{...options(),now:new Date('2026-11-17T15:00:00Z')});expect(sent).toHaveLength(1);
 });
 it('confirmed reconciliation settles uncertainty without another email',async()=>{
  const notify=async()=>{throw Error('timeout')};await mod.runInternalReplyReminders(pool,{...options(),notify});
  notify.check=async()=>({id:'existing-sent-message'});await mod.runInternalReplyReminders(pool,{...options(),notify});
  const row=(await pool.query('SELECT state,provider_id FROM sdr_internal_reply_reminder_notices')).rows[0];
  expect(row).toEqual({state:'sent',provider_id:'existing-sent-message'});expect(sent).toHaveLength(0);
 });
 it('preflight crossing out of office hours cancels the pending email',async()=>{
  await mod.runInternalReplyReminders(pool,{...options(),clock:()=>new Date('2026-11-16T23:00:00Z')});expect(sent).toHaveLength(0);
 });
 it('excludes old tasks outside the approved seed scope and disabled mode',async()=>{
  await mod.runInternalReplyReminders(pool,{...options(),seedTaskIds:[]});
  await mod.runInternalReplyReminders(pool,{...options(),mode:'off'});expect(sent).toHaveLength(0);
 });
});

describe('review delivery regressions',()=>{
 it('does not escalate a task to Derek when he already owns it',async()=>{
  ctx.task.user_id=11;await mod.runInternalReplyReminders(pool,options());
  await mod.runInternalReplyReminders(pool,{...options(),now:new Date('2026-11-17T15:00:00Z')});expect(sent).toHaveLength(1);
 });
 it('retains a January deferral beyond the original 30-day receipt window',async()=>{
  ctx.original.body='Please check back January 12.';await pool.query("UPDATE sdr_reply_messages SET intent='nurture'");
  const r=await mod.runInternalReplyReminders(pool,{...options(),now:new Date('2027-01-12T15:00:00Z')});expect(r.sent).toBe(1);
 });
 it('retries a confirmed rejected send on the next run',async()=>{
  const notify=async()=>{throw Object.assign(Error('rejected'),{status:403});};
  await mod.runInternalReplyReminders(pool,{...options(),notify});
  expect((await pool.query('SELECT state,safe_error FROM sdr_internal_reply_reminder_notices')).rows[0]).toEqual({state:'cancelled',safe_error:'delivery_rejected'});
  await mod.runInternalReplyReminders(pool,options());expect(sent).toHaveLength(1);
 });
 it('keeps HTTP timeouts and server errors uncertain',async()=>{
  for(const status of [408,500]){
   await pool.query('TRUNCATE sdr_internal_reply_reminder_notices');
   await mod.runInternalReplyReminders(pool,{...options(),notify:async()=>{throw Object.assign(Error('unknown'),{status});}});
   expect((await pool.query('SELECT state FROM sdr_internal_reply_reminder_notices')).rows[0].state).toBe('uncertain');
  }
 });
 it('reconciles newer uncertain notices even when ten older notices have no receipt',async()=>{
  await pool.query(`INSERT INTO sdr_internal_reply_reminder_notices(company_id,task_id,action_id,step,local_day,recipient,owner_id,state,context_hash,message_id,created_at)
   SELECT '13105180',n::text,'00000000-0000-0000-0000-000000000001','owner','2026-11-16','pm@proswppp.com',22,'uncertain','x','<m'||n||'@proswppp.co>','2026-11-16T14:00:00Z'::timestamptz+n*interval '1 second' FROM generate_series(1,11) n`);
  const notify=async()=>({id:'fresh'});notify.check=async n=>n.task_id==='11'?{id:'recovered'}:null;
  await mod.runInternalReplyReminders(pool,{...options(),notify});
  await mod.runInternalReplyReminders(pool,{...options(),notify});
  expect((await pool.query("SELECT state FROM sdr_internal_reply_reminder_notices WHERE task_id='11'")).rows[0].state).toBe('sent');
 });
});
