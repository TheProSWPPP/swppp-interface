import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {reportingTestDb} from './reportingTestDb.js';
import {leadVisibleTo} from '../sdrAccess.js';

const db=reportingTestDb('lead_thread_access');
const empty={mailbox:null,threadId:null};
let handler,visible,tokens,searches,searchFail=null;
describe.skipIf(!db)('lead thread GET authorization',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text,person_email text,crm_company_id text);
   CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id text,status text);
   CREATE TABLE sdr_mailboxes(id text,email text);
   CREATE TABLE sdr_sends(pipedrive_lead_id text,mailbox_id text,sent_at timestamptz);
   CREATE TABLE sdr_reply_messages(thread_id text,mailbox_email text,pipedrive_lead_id text,link_status text,received_at timestamptz);
   CREATE TABLE sdr_message_facts(provider text,thread_id text,mailbox_email text,pipedrive_lead_id text,link_status text,is_test boolean DEFAULT false,occurred_at timestamptz);`);
  const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('app.get("/api/sdr/leads/:leadId/thread"'),source.indexOf('// Cross-mailbox OUTREACH overview'));
  const deps={app:{get:(_,...handlers)=>handler=handlers.at(-1)},pool:db.pool,leadVisibleTo,visibleMailboxes:async()=>visible,accessTokenForMailbox:async mailbox=>{tokens.push(mailbox);return mailbox;},gmailInbox:{listThreads:async token=>{searches.push(token);if(searchFail)throw searchFail;return [{id:'thread-1',date:'2026-10-08'}];}}};
  new Function(...Object.keys(deps),block)(...Object.values(deps));
 });
 afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
 beforeEach(async()=>{
  vi.stubEnv('SDR_CRM_COMPANY_ID','company-a');tokens=[];searches=[];searchFail=null;
  visible=[{email:'rep@example.invalid',connected:true}];
  await db.pool.query(`TRUNCATE sdr_lead_state,sdr_drafts,sdr_mailboxes,sdr_sends,sdr_reply_messages,sdr_message_facts;
   INSERT INTO sdr_lead_state VALUES('lead-1','buyer@example.invalid','company-a');
   INSERT INTO sdr_mailboxes VALUES('rep','rep@example.invalid'),('other','other@example.invalid');
   INSERT INTO sdr_sends VALUES('lead-1','rep','2026-10-08'),('lead-1','other','2026-10-07');`);
 });
 const invoke=async(user={sub:'rep',role:'admin'},query={})=>{
  let status=200,body;
  await handler({params:{leadId:'lead-1'},query,sdrUser:user},{status(code){status=code;return this;},json(value){body=value;return this;}});
  return {status,body};
 };
 it('denies a foreign company even for admin before token or search',async()=>{
  await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='company-b'");
  expect(await invoke()).toEqual({status:200,body:empty});expect(tokens).toEqual([]);expect(searches).toEqual([]);
 });
 it('denies staff explicitly excluded by draft ownership',async()=>{
  await db.pool.query("INSERT INTO sdr_drafts VALUES('lead-1','other-staff','sent')");
  expect(await invoke({sub:'rep',role:'sdr'})).toEqual({status:200,body:empty});expect(tokens).toEqual([]);
 });
 it('never searches an invisible preferred sender and uses connected visible fallback',async()=>{
  await db.pool.query("DELETE FROM sdr_sends WHERE mailbox_id='rep'");
  expect((await invoke()).body).toEqual({mailbox:'rep@example.invalid',threadId:'thread-1'});
  expect(tokens).toEqual(['rep@example.invalid']);expect(searches).toEqual(['rep@example.invalid']);
 });
 it('denies a disconnected visible sender when no other connected fallback exists',async()=>{
  visible=[{email:'rep@example.invalid',connected:false}];
  expect(await invoke()).toEqual({status:200,body:empty});expect(tokens).toEqual([]);
 });
 it('says the search is busy, not that nothing exists, when Google rate-limits the search',async()=>{
  searchFail=Object.assign(new Error('Quota exceeded'),{status:403,reason:'rateLimitExceeded'});
  const result=await invoke();
  expect(result.status).toBe(503);
  expect(result.body.error).toMatch(/busy/i);
 });
 it('preserves the authorized preferred sender result',async()=>{
  expect((await invoke()).body).toEqual({mailbox:'rep@example.invalid',threadId:'thread-1'});
  expect(tokens).toEqual(['rep@example.invalid']);
 });
 describe('buyer on two projects',()=>{
  beforeEach(async()=>{await db.pool.query(`INSERT INTO sdr_lead_state VALUES('lead-2','Buyer@example.invalid','company-a');`);});
  it('opens this project\'s verified thread, not the newest thread for the address',async()=>{
   await db.pool.query(`INSERT INTO sdr_reply_messages VALUES('thread-own','REP@example.invalid','lead-1','verified','2026-10-01'),('thread-other','rep@example.invalid','lead-2','verified','2026-10-09');
    INSERT INTO sdr_message_facts VALUES('gmail','thread-own-2','rep@example.invalid','lead-1','verified',false,'2026-10-03'),('gmail','thread-test','rep@example.invalid','lead-1','verified',true,'2026-10-20');`);
   expect((await invoke()).body).toEqual({mailbox:'rep@example.invalid',threadId:'thread-own-2'});expect(searches).toEqual([]);
  });
  it('uses the thread pinned by the link only when it is this project\'s',async()=>{
   await db.pool.query(`INSERT INTO sdr_reply_messages VALUES('thread-old','rep@example.invalid','lead-1','verified','2026-10-01'),('thread-new','rep@example.invalid','lead-1','verified','2026-10-05'),('thread-other','rep@example.invalid','lead-2','verified','2026-10-09');`);
   expect((await invoke(undefined,{thread:'thread-old',mailbox:'Rep@example.invalid'})).body).toEqual({mailbox:'rep@example.invalid',threadId:'thread-old'});
   expect((await invoke(undefined,{thread:'thread-other',mailbox:'rep@example.invalid'})).body).toEqual({mailbox:'rep@example.invalid',threadId:'thread-new'});
  });
  it('never opens a thread also linked to the other project or held unverified',async()=>{
   await db.pool.query(`INSERT INTO sdr_reply_messages VALUES('thread-mixed','rep@example.invalid','lead-1','verified','2026-10-05'),('thread-mixed','rep@example.invalid','lead-2','verified','2026-10-06'),('thread-loose','rep@example.invalid','lead-1','ambiguous','2026-10-07');`);
   expect(await invoke()).toEqual({status:200,body:empty});expect(searches).toEqual([]);
  });
  it('does not guess from the address when no thread is proven for this project',async()=>{
   expect(await invoke()).toEqual({status:200,body:empty});expect(tokens).toEqual([]);expect(searches).toEqual([]);
  });
 });
 it('never returns a proven thread from a mailbox the user cannot see',async()=>{
  await db.pool.query(`INSERT INTO sdr_reply_messages VALUES('thread-hidden','other@example.invalid','lead-1','verified','2026-10-09');`);
  expect((await invoke()).body).toEqual({mailbox:'rep@example.invalid',threadId:'thread-1'});
 });
 it('fails closed with 503 when company configuration is absent',async()=>{
  vi.stubEnv('SDR_CRM_COMPANY_ID','');
  const result=await invoke();expect(result.status).toBe(503);expect(tokens).toEqual([]);expect(searches).toEqual([]);
 });
});
