import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {reportingTestDb} from './reportingTestDb.js';
import {leadVisibleTo} from '../sdrAccess.js';

const db=reportingTestDb('lead_thread_access');
const empty={mailbox:null,threadId:null};
let handler,visible,tokens,searches;
describe.skipIf(!db)('lead thread GET authorization',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text,person_email text,crm_company_id text);
   CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id text,status text);
   CREATE TABLE sdr_mailboxes(id text,email text);
   CREATE TABLE sdr_sends(pipedrive_lead_id text,mailbox_id text,sent_at timestamptz);`);
  const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('app.get("/api/sdr/leads/:leadId/thread"'),source.indexOf('// Cross-mailbox OUTREACH overview'));
  const deps={app:{get:(_,...handlers)=>handler=handlers.at(-1)},pool:db.pool,leadVisibleTo,visibleMailboxes:async()=>visible,accessTokenForMailbox:async mailbox=>{tokens.push(mailbox);return mailbox;},gmailInbox:{listThreads:async token=>{searches.push(token);return [{id:'thread-1',date:'2026-10-08'}];}}};
  new Function(...Object.keys(deps),block)(...Object.values(deps));
 });
 afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
 beforeEach(async()=>{
  vi.stubEnv('SDR_CRM_COMPANY_ID','company-a');tokens=[];searches=[];
  visible=[{email:'rep@example.invalid',connected:true}];
  await db.pool.query(`TRUNCATE sdr_lead_state,sdr_drafts,sdr_mailboxes,sdr_sends;
   INSERT INTO sdr_lead_state VALUES('lead-1','buyer@example.invalid','company-a');
   INSERT INTO sdr_mailboxes VALUES('rep','rep@example.invalid'),('other','other@example.invalid');
   INSERT INTO sdr_sends VALUES('lead-1','rep','2026-10-08'),('lead-1','other','2026-10-07');`);
 });
 const invoke=async(user={sub:'rep',role:'admin'})=>{
  let status=200,body;
  await handler({params:{leadId:'lead-1'},sdrUser:user},{status(code){status=code;return this;},json(value){body=value;return this;}});
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
 it('preserves the authorized preferred sender result',async()=>{
  expect((await invoke()).body).toEqual({mailbox:'rep@example.invalid',threadId:'thread-1'});
  expect(tokens).toEqual(['rep@example.invalid']);
 });
 it('fails closed with 503 when company configuration is absent',async()=>{
  vi.stubEnv('SDR_CRM_COMPANY_ID','');
  const result=await invoke();expect(result.status).toBe(503);expect(tokens).toEqual([]);expect(searches).toEqual([]);
 });
});
