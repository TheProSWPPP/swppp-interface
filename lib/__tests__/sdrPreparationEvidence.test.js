import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
let api={};try{api=await import('../sdrPreparationEvidence.js');}catch{}
const db=reportingTestDb('preparation_evidence'),companyId='13105180',viewer={sub:'00000000-0000-0000-0000-000000000001',role:'admin'};
const options={companyId,viewer,leadId:'A',resolveVisibleMailboxes:async()=>['staff@example.test']};
const orders=async(extra={})=>{expect(api.readOrderCandidates).toBeTypeOf('function');return api.readOrderCandidates(db.pool,{...options,...extra});};
const delivery=async(extra={})=>{expect(api.readDeliveryEvidence).toBeTypeOf('function');return api.readDeliveryEvidence(db.pool,{...options,...extra});};
(db?describe:describe.skip)('preparation evidence boundaries',()=>{
 beforeAll(async()=>{await db.setup();for(const file of ['2026-10-02-sdr-reporting.sql','2026-10-04-sdr-metric-evidence.sql','2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-provider-operations.sql','2026-10-07-sdr-policy-rollout.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 await db.pool.query(`CREATE TABLE sdr_users(id uuid,role text,active boolean);CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text);
 CREATE TABLE projects(id text PRIMARY KEY,name text,status text,data jsonb,archived boolean,deleted_at timestamp);
 CREATE TABLE sdr_mailboxes(id text,email text);CREATE TABLE sdr_drafts(id text,pipedrive_lead_id text,contact_email_snapshot text,revision bigint DEFAULT 1,assigned_mailbox_id text DEFAULT 'm');
 CREATE TABLE sdr_sends(id text,draft_id text,pipedrive_lead_id text,mailbox_id text,status text,sent_at timestamptz,apollo_sequence_id text,apollo_emailer_message_id text,apollo_contact_id text);`);});
 afterAll(()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_users,sdr_lead_state,sdr_crm_snapshots,sdr_crm_scope_coverage,projects,sdr_mailboxes,sdr_drafts,sdr_sends,sdr_message_facts,sdr_provider_operations,sdr_policy_decisions CASCADE');
 await db.pool.query("INSERT INTO sdr_users VALUES($1,'admin',true);",[viewer.sub]);await db.pool.query("INSERT INTO sdr_lead_state VALUES('A',$1)",[companyId]);
 await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES($1,'lead','A','{\"title\":\"Project A\",\"person_id\":12,\"organization_id\":7}'),($1,'person','12','{\"email\":[{\"value\":\"buyer@example.test\"}]}'),($1,'organization','7','{\"name\":\"Builder\"}')",[companyId]);
 await db.pool.query(`INSERT INTO projects VALUES('p','Project A','new','{"projectName":"Project A","companyName":"Builder","contactName":"Buyer","email":"buyer@example.test","dateReceived":"10/08/26","trelloLink":"https://trello.com/c/AbCd1234/project","secret":"private"}',false,null);
 INSERT INTO sdr_mailboxes VALUES('m','staff@example.test');INSERT INTO sdr_drafts(id,pipedrive_lead_id,contact_email_snapshot) VALUES('d','A','buyer@example.test');
 INSERT INTO sdr_sends VALUES('s','d','A','m','enrolled','2020-01-01T00:00:00Z','campaign','message','contact');
 INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,campaign_id,provider_status,occurred_at,link_status) VALUES('apollo','message','out','staff@example.test','buyer@example.test','campaign','completed','2020-01-02T00:00:00Z','unmatched');`);});
 it('returns minimal candidates even for one match, preserves intake date and filters deletion',async()=>{
 const r=await orders();expect(r).toMatchObject({total:1,items:[{projectId:'p',projectName:'Project A',intakeDate:'10/08/26',safeTrelloReference:'https://trello.com/c/AbCd1234',matchReasons:['project_title','contact_email','company_name']}]});expect(JSON.stringify(r)).not.toContain('private');expect(r.coverage.linkStatus).toBe('unverified');
 await db.pool.query("UPDATE projects SET deleted_at=now()");expect((await orders()).total).toBe(0);
 });
 it('escapes manual wildcard search and counts before stable pagination including empty pages',async()=>{
 await db.pool.query("INSERT INTO projects SELECT 'p'||n,'Project A','new','{}',false,null FROM generate_series(1,55)n");expect((await orders()).total).toBe(56);expect((await orders()).items).toHaveLength(20);expect((await orders({offset:80}))).toMatchObject({total:56,items:[]});expect((await orders({query:'%'})).total).toBe(0);expect((await orders({query:'_'})).total).toBe(0);
 });
 it('rejects missing binding, foreign config, machine/admin spoof and current revoked roles',async()=>{
 for(const extra of [{companyId:''},{companyId:'foreign'},{companyId:'company13105180'}])await expect(orders(extra)).rejects.toMatchObject({code:'evidence_unavailable'});
 for(const bad of [{...viewer,machine:true},{...viewer,role:'sdr'},{...viewer,sub:'machine'}])for(const read of [orders,delivery])await expect(read({viewer:bad})).rejects.toMatchObject({code:'admin_required'});
 await db.pool.query("UPDATE sdr_users SET role='sdr'");for(const read of [orders,delivery])await expect(read()).rejects.toMatchObject({code:'admin_required'});
 });
 it('withholds unavailable or ambiguous current lead identities before inventory disclosure',async()=>{
 for(const patch of ["lifecycle='archived'","lifecycle='active',access_status='denied'","access_status='accessible',is_test=true,test_evidence='fixture'"]){await db.pool.query("UPDATE sdr_crm_snapshots SET "+patch+" WHERE entity='lead'");await expect(orders()).rejects.toMatchObject({code:'lead_unavailable'});}
 await db.pool.query("UPDATE sdr_crm_snapshots SET is_test=false;INSERT INTO sdr_lead_state VALUES('A','foreign')");await expect(orders()).rejects.toMatchObject({code:'lead_unavailable'});expect((await delivery()).total).toBe(0);
 });
 it('separates local enrollment time from an exact completed provider message receipt',async()=>{
 const r=await delivery();expect(r).toMatchObject({total:1,items:[{sendId:'s',receipt:{providerMessageId:'message'}}]});expect(new Date(r.items[0].localEnrollmentAt).toISOString()).toBe('2020-01-01T00:00:00.000Z');expect(new Date(r.items[0].receipt.occurredAt).toISOString()).toBe('2020-01-02T00:00:00.000Z');
 await db.pool.query("UPDATE sdr_sends SET apollo_emailer_message_id=null");expect((await delivery()).items[0].receipt).toBeNull();
 });
 it.each(["campaign_id='wrong'","prospect_email='current-not-historical@example.test'","mailbox_email='foreign@example.test'","provider_status='scheduled'","direction='in'","is_test=true","occurred_at=now()+interval '1 day'","occurred_at=null","occurred_at='infinity'","pipedrive_lead_id='OTHER',link_status='verified'","pipedrive_lead_id='A',link_status='ambiguous'","pipedrive_lead_id=null,link_status='ambiguous'"])('withholds invalid direct receipt: %s',async patch=>{await db.pool.query('UPDATE sdr_message_facts SET '+patch);expect((await delivery()).items[0].receipt).toBeNull();});
 it('withholds competing sends globally and caps stable rows at 50 with total',async()=>{
 await db.pool.query("INSERT INTO sdr_sends SELECT 's'||n,'d','A','m','enrolled','2020-01-01T00:00:00Z','campaign','message','contact' FROM generate_series(1,55)n");const r=await delivery();expect(r.total).toBe(56);expect(r.items).toHaveLength(50);expect(r.items.every(i=>i.receipt===null)).toBe(true);expect((await delivery()).items.map(i=>i.sendId)).toEqual(r.items.map(i=>i.sendId));
 });
 it('withholds a competing fact even if its mailbox would otherwise be out of scope',async()=>{
 await db.pool.query('ALTER TABLE sdr_message_facts DROP CONSTRAINT sdr_message_facts_pkey');
 try{await db.pool.query("INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,campaign_id,provider_status,occurred_at,link_status) VALUES('apollo','message','out','foreign@example.test','buyer@example.test','campaign','completed','2020-01-02T00:00:00Z','unmatched')");expect((await delivery()).items[0].receipt).toBeNull();}
 finally{await db.pool.query("DELETE FROM sdr_message_facts WHERE mailbox_email='foreign@example.test';ALTER TABLE sdr_message_facts ADD PRIMARY KEY(provider,provider_message_id)");}
 });
 it('honors mailbox scope and excludes foreign/test/deleted identities',async()=>{expect((await delivery({resolveVisibleMailboxes:async()=>[]})).total).toBe(0);await db.pool.query("UPDATE sdr_crm_snapshots SET lifecycle='deleted' WHERE entity='lead'");expect((await delivery()).total).toBe(0);});
 it('scopes provider operations to the send and company and sanitizes reasons',async()=>{
 await db.pool.query(`INSERT INTO sdr_provider_operations(id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,state,reason) VALUES
 ('00000000-0000-0000-0000-000000000011','a','stop','contact','campaign','A','{"sendId":"s","companyId":"13105180"}','x','unresolved','private exception'),
 ('00000000-0000-0000-0000-000000000012','b','stop','contact','campaign','A','{"sendId":"s","companyId":"foreign"}','x','unresolved','membership_read_failed')`);
 const r=await delivery();expect(r.items[0].operations).toHaveLength(1);expect(r.items[0].operations[0]).toMatchObject({state:'unresolved',reason:'unclassified'});expect(JSON.stringify(r)).not.toContain('private exception');
 });
 it('shows only actual held safety receipts with exact draft revision and safe reasons',async()=>{
 for(const [key,company,action,actual] of [['held',companyId,'draft:d:1','hold'],['shadow',companyId,'draft:d:1','allow'],['foreign','foreign','draft:d:1','hold'],['wrongRevision',companyId,'draft:d:2','review']])await db.pool.query(`INSERT INTO sdr_policy_decisions(decision_key,company_id,lead_id,policy_version,mode,rollout_version,enforced,action_key,phase,context_hash,dependency_hash,source_hash,proposed_outcome,reason_codes,invariant_outcome,invariant_reasons,actual_outcome,actual_reasons) VALUES($1,$2,'A','v','observe',1,false,$3,'preflight','h','h','h','hold','["private proposed"]','hold','[]',$4,'["outreach_held","private error"]')`,[key,company,action,actual]);
 const r=await delivery();expect(r.safetyChecks.total).toBe(1);expect(r.safetyChecks.items[0]).toMatchObject({decisionId:'held',outcome:'hold',reasons:['outreach_held','unclassified'],draftRevision:'1'});expect(JSON.stringify(r)).not.toContain('private error');expect(JSON.stringify(r)).not.toContain('private proposed');
 await db.pool.query("UPDATE sdr_drafts SET assigned_mailbox_id='inaccessible'");expect((await delivery()).safetyChecks.total).toBe(0);
 });
 it('marks known test intake and never upgrades unclassified inventory into verified orders',async()=>{await db.pool.query(`UPDATE projects SET data=data||'{"isTest":true}'::jsonb`);const r=await orders();expect(r.items[0].testStatus).toBe('marked_test');expect(r.coverage.wordpressCompleteness).toBe('unknown');expect(r.coverage.currentTrello).toBe('unavailable');});
 it('never queries untenantized inventory after revoked or inaccessible authorization',async()=>{
 for(const revoke of ["UPDATE sdr_users SET active=false","UPDATE sdr_users SET active=true;UPDATE sdr_crm_snapshots SET access_status='denied' WHERE entity='lead'"]){await db.pool.query(revoke);const client=await db.pool.connect();let projectsRead=false;const pool={connect:async()=>({query:(...args)=>{if(/FROM projects/i.test(String(args[0])))projectsRead=true;return client.query(...args);},release:()=>client.release()})};await expect(api.readOrderCandidates(pool,options)).rejects.toBeTruthy();expect(projectsRead).toBe(false);}
 });
 it('filters unsafe Trello URLs without following them',async()=>{for(const link of ['http://trello.com/c/AbCd1234','https://evil.example/c/AbCd1234','https://user@trello.com/c/AbCd1234','https://trello.com/c/AbCd1234?token=secret','javascript:alert(1)']){await db.pool.query("UPDATE projects SET data=jsonb_set(data,'{trelloLink}',to_jsonb($1::text))",[link]);expect((await orders()).items[0].safeTrelloReference).toBeNull();}});
 it('checks current permission coverage and releases failed readers',async()=>{await db.pool.query("INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,error_category) VALUES($1,'leads_active','error','permission')",[companyId]);for(const read of [orders,delivery])await expect(read()).rejects.toMatchObject({code:'evidence_unavailable'});});
 it('uses bounded repeatable read and prevents writes throughout both reads',async()=>{
 for(const name of ['readOrderCandidates','readDeliveryEvidence']){expect(api[name]).toBeTypeOf('function');const client=await db.pool.connect();let checked=false;const pool={connect:async()=>({query:async(...args)=>{if(String(args[0]).startsWith('SELECT 1 FROM sdr_users')){checked=true;expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s');}return client.query(...args);},release:()=>client.release()})};await api[name](pool,options);expect(checked).toBe(true);}
 });
});
