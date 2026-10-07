import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {ownerScope} from '../sdrAccess.js';
const db=reportingTestDb('priority_summary');let handler;
describe.skipIf(!db)('Priority current project attribution',()=>{
 beforeAll(async()=>{
  await db.setup();await db.pool.query(`
 CREATE TABLE sdr_users(id text PRIMARY KEY,username text,display_name text);
 CREATE TABLE sdr_drafts(id text PRIMARY KEY,pipedrive_lead_id text,trigger_type text,assigned_user_id text,contact_email_snapshot text,metadata jsonb,status text,sent_at timestamptz,created_at timestamptz DEFAULT now());
 CREATE TABLE sdr_sends(id text,draft_id text,pipedrive_lead_id text,status text,sent_at timestamptz,apollo_emailer_message_id text,mailbox_id text,apollo_sequence_id text);
 CREATE TABLE sdr_engagement_events(id text,event_type text,pipedrive_lead_id text,occurred_at timestamptz,apollo_emailer_message_id text,mailbox_email text,source text DEFAULT 'apollo');
 CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text,crm_status text,person_email text,lead_title text);
 CREATE TABLE sdr_crm_snapshots(company_id text,entity text,entity_id text,lifecycle text,access_status text,is_test boolean,data jsonb);
 CREATE TABLE sdr_outreach_controls(company_id text,lead_id text,status text,scope_kind text,scope_id text,channel text);
 CREATE TABLE sdr_reply_messages(pipedrive_lead_id text,reply_kind text,link_status text,received_at timestamptz);
 CREATE TABLE sdr_message_facts(provider text,provider_message_id text,pipedrive_lead_id text,prospect_email text,link_status text,is_test boolean,direction text,occurred_at timestamptz,mailbox_email text,campaign_id text);
 CREATE TABLE sdr_mailboxes(id text,email text);
 CREATE TABLE sdr_provider_operations(lead_id text,state text);
 `);
 const source=await fs.readFile(new URL('../../server.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('app.get("/api/sdr/engagement/summary"'),source.indexOf('// SDR drafts — generate'));
 const summary=await import('../sdrEngagementSummary.js');
 const deps={app:{get:(_,...handlers)=>{handler=handlers.at(-1);}},pool:db.pool,ownerScope,...summary};
 new Function(...Object.keys(deps),block)(...Object.values(deps));
 });
 afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
 beforeEach(async()=>{
 vi.stubEnv('DATABASE_URL','synthetic');vi.stubEnv('SDR_CRM_COMPANY_ID','company');
 await db.pool.query(`TRUNCATE sdr_drafts,sdr_sends,sdr_engagement_events,sdr_users,sdr_lead_state,sdr_crm_snapshots,sdr_outreach_controls,sdr_reply_messages,sdr_message_facts,sdr_mailboxes,sdr_provider_operations;
 INSERT INTO sdr_users VALUES('rep','rep','Rep');
 INSERT INTO sdr_lead_state VALUES('lead','company','active','new@buyer.test','Project');
 INSERT INTO sdr_crm_snapshots VALUES('company','lead','lead','active','accessible',false,'{}');
 INSERT INTO sdr_drafts VALUES('old','lead','AGC','rep','old@buyer.test','{}','sent',now()-interval '10 days',now()-interval '10 days'),('current','lead','CM','rep','new@buyer.test','{}','sent',now()-interval '2 days',now()-interval '2 days');
 INSERT INTO sdr_mailboxes VALUES('mailbox','rep@seller.test');
 INSERT INTO sdr_sends VALUES('old-send','old','lead','switched',now()-interval '10 days','old-message','mailbox','old-campaign'),('send','current','lead','sent',now()-interval '2 days','message','mailbox','current-campaign');
 INSERT INTO sdr_engagement_events VALUES('click','email_clicked','lead',now()-interval '1 hour','message','rep@seller.test','apollo');`);
 });
 async function invoke(user={sub:'rep',role:'admin'}){let code=200,body;await handler({sdrUser:user},{status(n){code=n;return this;},json(x){body=x;}});return {code,body};}
 it('returns one current project and does not credit its event to historical trigger or recipient',async()=>{
 const {body}=await invoke();expect(body.leads).toHaveLength(1);expect(body.leads[0]).toMatchObject({draft_id:'current',contact_email_snapshot:'new@buyer.test',clicks:1});expect(body.by_trigger).toEqual([expect.objectContaining({trigger_type:'CM',clicked:1,sent:1})]);
 });
 it.each(['rejected','failed','pending'])('retains an active sent project when a newer %s draft has the same recipient',async status=>{
 await db.pool.query("INSERT INTO sdr_drafts VALUES('newer','lead','LBA','rep','new@buyer.test','{}',$1,NULL,now())",[status]);
 const {body}=await invoke();expect(body.leads).toHaveLength(1);expect(body.leads[0]).toMatchObject({draft_id:'current',clicks:1,priority_eligible:true});
 });
 it('does not credit an old campaign follow-up sent after the current campaign started',async()=>{
 await db.pool.query("UPDATE sdr_drafts SET contact_email_snapshot='new@buyer.test' WHERE id='old'; UPDATE sdr_engagement_events SET apollo_emailer_message_id='old-followup'; INSERT INTO sdr_message_facts VALUES('apollo','old-followup','lead','new@buyer.test','verified',false,'out',now()-interval '2 hours','rep@seller.test','old-campaign')");
 const {body}=await invoke();expect(body.leads[0]).toMatchObject({draft_id:'current',clicks:0});expect(body.by_trigger[0]).toMatchObject({trigger_type:'CM',clicked:0});
 });
 it('does not credit a verified same-campaign follow-up from a different sender',async()=>{
 await db.pool.query("UPDATE sdr_engagement_events SET apollo_emailer_message_id='other-followup',mailbox_email='other@seller.test'; INSERT INTO sdr_message_facts VALUES('apollo','other-followup','lead','new@buyer.test','verified',false,'out',now()-interval '2 hours','other@seller.test','current-campaign')");
 expect((await invoke()).body.leads[0].clicks).toBe(0);
 });
 it('credits a verified current-campaign follow-up from the current sender',async()=>{
 await db.pool.query("UPDATE sdr_engagement_events SET apollo_emailer_message_id='current-followup'; INSERT INTO sdr_message_facts VALUES('apollo','current-followup','lead','new@buyer.test','verified',false,'out',now()-interval '2 hours','rep@seller.test','current-campaign')");
 expect((await invoke()).body.leads[0]).toMatchObject({clicks:1,priority_eligible:true});
 });
 it('does not assign unknown message or old-recipient clicks to the current contact',async()=>{
 await db.pool.query("UPDATE sdr_engagement_events SET apollo_emailer_message_id='old-message'; INSERT INTO sdr_engagement_events VALUES('unknown','email_clicked','lead',now(),NULL,NULL,'apollo')");
 const {body}=await invoke();expect(body.leads.find(l=>l.draft_id==='current').clicks).toBe(0);
 });
 it('counts only nonfuture events inside the 96 hour window',async()=>{
 await db.pool.query("DELETE FROM sdr_engagement_events; INSERT INTO sdr_engagement_events SELECT n::text,'email_opened','lead',CASE WHEN n=1 THEN now()-interval '1 hour' WHEN n=2 THEN now()+interval '1 day' ELSE now()-interval '5 days' END,'message',NULL,'apollo' FROM generate_series(1,4)n");
 const {body}=await invoke();expect(body.leads.find(l=>l.draft_id==='current').opens).toBe(1);
 });
 it.each(['switched','unsubscribed','paused','bounced','canceled'])('excludes %s sends from actionable cards',async status=>{
 await db.pool.query('UPDATE sdr_sends SET status=$1 WHERE draft_id=$2',[status,'current']);const {body}=await invoke();expect(body.leads.filter(l=>l.priority_eligible!==false)).toEqual([]);
 });
 it('suppresses durable human replies even without a legacy event',async()=>{
 await db.pool.query("INSERT INTO sdr_reply_messages VALUES('lead','human','verified',now())");const {body}=await invoke();expect(body.leads.filter(l=>l.priority_eligible!==false)).toEqual([]);
 });
 it.each(['archived','denied','test','held','other-company'])('excludes %s projects',async reason=>{
 if(reason==='archived')await db.pool.query("UPDATE sdr_crm_snapshots SET lifecycle='archived'");
 if(reason==='denied')await db.pool.query("UPDATE sdr_crm_snapshots SET access_status='denied'");
 if(reason==='test')await db.pool.query('UPDATE sdr_crm_snapshots SET is_test=true');
 if(reason==='held')await db.pool.query("INSERT INTO sdr_outreach_controls VALUES('company','lead','active','lead','lead',NULL)");
 if(reason==='other-company')await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='other'");
 const {body}=await invoke();expect(body.leads.filter(l=>l.priority_eligible!==false)).toEqual([]);
 });
 it('keeps unresolved provider containment out of actionable cards',async()=>{
 await db.pool.query("INSERT INTO sdr_provider_operations VALUES('lead','unresolved')");const {body}=await invoke();expect(body.leads.filter(l=>l.priority_eligible!==false)).toEqual([]);expect(body.leads[0].priority_exclusion).toBe('provider_unresolved');
 });
 it('rejects a message assigned to a different mailbox or marked as test evidence',async()=>{
 await db.pool.query("UPDATE sdr_engagement_events SET mailbox_email='other@seller.test'");expect((await invoke()).body.leads[0].clicks).toBe(0);
 await db.pool.query("UPDATE sdr_engagement_events SET mailbox_email='rep@seller.test'; INSERT INTO sdr_message_facts VALUES('apollo','message','lead','new@buyer.test','verified',true,'out',now(),'rep@seller.test','current-campaign')");expect((await invoke()).body.leads[0].clicks).toBe(0);
 });
 it('explicitly excludes a current draft with no verifiable send',async()=>{
 await db.pool.query("DELETE FROM sdr_sends WHERE draft_id='current'");expect((await invoke()).body.leads[0].priority_eligible).toBe(false);
 });
 it('denies missing identity and preserves staff owner scope',async()=>{
 expect((await invoke(null)).code).toBe(401);expect((await invoke({role:'sdr',sub:'other'})).body.leads).toEqual([]);
 });
});
