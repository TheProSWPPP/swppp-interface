import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {leadVisibilityScope} from '../sdrAccess.js';
const db=reportingTestDb('inbox_overview');let handler,pages,boxes;
const thread=(id='thread',at='2026-10-07T12:00:00Z')=>({id,from:'Buyer <buyer@example.test>',subject:'Project',snippet:'Please send scope',participants:['buyer@example.test'],date:'2000-01-01',receivedAt:at,lastOutbound:false,messages:[{id:'reply',receivedAt:at,lastOutbound:false,from:'buyer@example.test',subject:'Project',snippet:'Please send scope'}]});
describe.skipIf(!db)('Inbox overview handling and coverage',()=>{
 beforeAll(async()=>{
 await db.setup();await db.pool.query(`
 CREATE TABLE sdr_lead_state(pipedrive_lead_id text,person_email text,lead_title text,crm_company_id text);
 CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id text,status text);
 CREATE TABLE sdr_crm_snapshots(company_id text,entity text,entity_id text,access_status text,lifecycle text,is_test boolean);
 CREATE TABLE permit_operator_email(email text,contact_name text,operator_key text);
 CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,sender_name text,sender_email text,subject text,sent_at timestamptz,source text);
 CREATE TABLE permit_sends(operator_key text,sent_at timestamptz,mailbox_id text);
 CREATE TABLE permit_operators(operator_key text,operator_name text);
 CREATE TABLE sdr_mailboxes(id text,email text);
 CREATE TABLE sdr_inbox_handled(thread_id text,mailbox_email text,handled_at timestamptz);
 CREATE TABLE sdr_reply_messages(thread_id text,mailbox_email text,pipedrive_lead_id text,link_status text);
 CREATE TABLE sdr_message_facts(thread_id text,mailbox_email text,pipedrive_lead_id text,link_status text,is_test boolean,provider text);
 `);
 const source=await fs.readFile(new URL('../../server.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('app.get("/api/sdr/inbox/overview"'),source.indexOf('// Shared 5-minute cache'));
 const gmailInbox={listThreads:async token=>(await pages(token)).threads,listThreadPage:async(token,options)=>pages(token,options)};
 const helpers=await import('../sdrInboxOverview.js');
 const deps={app:{get:(_,...hs)=>handler=hs.at(-1)},pool:db.pool,visibleMailboxes:async()=>boxes,accessTokenForMailbox:async mb=>mb,gmailInbox,parseEmailAddr:v=>v?.match(/<([^>]+)>/)?.[1]||v,classifyInbound:()=>null,leadVisibilityScope,...helpers};
 new Function(...Object.keys(deps),block)(...Object.values(deps));
 });
 afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
 beforeEach(async()=>{
 vi.stubEnv('SDR_CRM_COMPANY_ID','company');boxes=[{email:'rep@seller.test',connected:true}];pages=async()=>({threads:[thread()],nextPageToken:null});
 await db.pool.query(`TRUNCATE sdr_lead_state,sdr_drafts,sdr_crm_snapshots,sdr_inbox_handled,sdr_reply_messages,sdr_message_facts;
 INSERT INTO sdr_lead_state VALUES('lead','buyer@example.test','Project','company');
 INSERT INTO sdr_crm_snapshots VALUES('company','lead','lead','accessible','active',false);
 INSERT INTO sdr_reply_messages VALUES('thread','rep@seller.test','lead','verified');
 INSERT INTO sdr_inbox_handled VALUES('thread','rep@seller.test','2026-10-06');`);
 });
 const invoke=async(user={sub:'rep',role:'admin'})=>{let body,code=200;await handler({sdrUser:user},{status(n){code=n;return this;},json(x){body=x;}});expect(code,JSON.stringify(body)).toBe(200);return body;};
 it('single mailbox view does not guess a project and reports unread pages',async()=>{
 const source=await fs.readFile(new URL('../../server.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('app.get("/api/sdr/inbox/threads",'),source.indexOf('// Full thread (all messages'));
 const helpers=await import('../sdrInboxOverview.js');let listHandler;const deps={app:{get:(_,...hs)=>listHandler=hs.at(-1)},pool:db.pool,resolveMailbox:async()=> 'rep@seller.test',accessTokenForMailbox:async()=> 'token',gmailInbox:{listThreads:async()=>[thread()],listThreadPage:async()=>({threads:[thread()],nextPageToken:'more'})},parseEmailAddr:v=>v?.match(/<([^>]+)>/)?.[1]||v,...helpers};
 new Function(...Object.keys(deps),block)(...Object.values(deps));await db.pool.query('DELETE FROM sdr_reply_messages');let result;
 await listHandler({sdrUser:{role:'admin',sub:'rep'},query:{}},{json:r=>result=r,status(){return this;}});
 expect(result.threads[0].lead).toBeNull();expect(result.coverage.complete).toBe(false);
 });
 it('preserves handled watermark millisecond precision',async()=>{
 await db.pool.query("UPDATE sdr_inbox_handled SET handled_at='2026-10-07T12:00:00.500Z'");pages=async()=>({threads:[thread('thread','2026-10-07T12:00:00.400Z')],nextPageToken:null});expect((await invoke()).threads[0].handled).toBe(true);
 });
 it('keeps conflicting exact thread links unresolved even if one project is not visible',async()=>{
 await db.pool.query("INSERT INTO sdr_reply_messages VALUES('thread','rep@seller.test','hidden-lead','verified')");expect((await invoke()).threads[0].lead).toBeNull();
 });
 it('reopens handled mail on a later arrival, ignoring forged Date headers',async()=>{expect((await invoke()).threads[0].handled).not.toBe(true);});
 it('keeps an older inbound handled and does not inherit another mailbox handling',async()=>{
 pages=async()=>({threads:[thread('thread','2026-10-05')],nextPageToken:null});expect((await invoke()).threads[0].handled).toBe(true);
 await db.pool.query("UPDATE sdr_inbox_handled SET mailbox_email='other@seller.test'");expect((await invoke()).threads[0].handled).not.toBe(true);
 });
 it('reads subsequent pages so an older waiting thread is not silently dropped',async()=>{
 pages=async(_,o)=>o?.pageToken?{threads:[thread('older')],nextPageToken:null}:{threads:[thread()],nextPageToken:'page2'};
 expect((await invoke()).threads.map(t=>t.id)).toContain('older');
 });
 it('reports mailbox failure and retained page limit as partial coverage',async()=>{
 boxes.push({email:'failed@seller.test',connected:true});pages=async mb=>{if(mb.startsWith('failed'))throw Error('token detail must stay private');return {threads:[thread()],nextPageToken:'more'};};
 const result=await invoke();expect(result.coverage).toMatchObject({complete:false,mailboxes:expect.arrayContaining([expect.objectContaining({mailbox:'failed@seller.test',status:'error'}),expect.objectContaining({mailbox:'rep@seller.test',status:'limited'})])});
 });
 it('does not guess a project from the subject even for a single participant match',async()=>{
 await db.pool.query('DELETE FROM sdr_reply_messages');const result=await invoke();expect(result.threads[0]).toMatchObject({lead:null,attribution:'unresolved'});
 });
 it('never exposes a different company project through a participant match',async()=>{
 await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='other'; UPDATE sdr_crm_snapshots SET company_id='other'");expect((await invoke()).threads.every(t=>!t.lead)).toBe(true);
 });
 it('does not expose another staff owners project through shared mailbox evidence',async()=>{
 await db.pool.query("INSERT INTO sdr_drafts VALUES('lead','another','sent')");expect((await invoke({sub:'rep',role:'sdr'})).threads.every(t=>!t.lead)).toBe(true);
 });
});
