import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {readFollowupReview} from '../sdrFollowupReview.js';
const db=reportingTestDb('followup_review');
(db?describe:describe.skip)('recent context review without an observed open task',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql',import.meta.url),'utf8'));
  await db.pool.query('CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text); CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id text,status text)');
  for(const lead of ['wait','contract','has-task','private','test','ambiguous','auto']){
   await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,is_test,test_evidence) VALUES('42','lead',$1,$2,'2026-10-07',$3,$4)`,[lead,{title:lead,owner_id:8},lead==='test',lead==='test'?'Reviewed fixture':null]);
   await db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,'42')`,[lead]);
   await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at) VALUES('42','note',$1,$2,'2026-10-06')`,[lead+'-note',{content:lead==='auto'?'[Auto] Stage unchanged':lead==='wait'?'Call in November. Email scheduled Nov 2.':'Proposal received. PM will contact us.'}]);
   await db.pool.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','note',$1,'lead',$2,'fixture')`,[lead+'-note',lead]);
  }
  await db.pool.query(`INSERT INTO sdr_drafts VALUES('private','other','sent'); INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('42','activity','open','{"done":false,"type":"call"}'); INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','activity','open','lead','has-task','fixture'),('42','note','ambiguous-note','lead','private','fixture')`);
 });
 afterAll(()=>db.close());
 const options={companyId:'42',viewer:{role:'sdr',sub:'me'},asOf:'2026-10-07T12:00:00Z'};
 it('preserves timing and contract context without inventing tasks or a won sale',async()=>{
  const result=await readFollowupReview(db.pool,options);
  expect(result.items.map(x=>x.leadId)).toEqual(['contract','wait']);
  expect(result.items[1].evidence[0].text).toBe('Call in November. Email scheduled Nov 2.');
  expect(result.items[0].evidence[0].text).toBe('Proposal received. PM will contact us.');
  expect((await db.pool.query("SELECT count(*)::int n FROM sdr_crm_snapshots WHERE entity='activity'")).rows[0].n).toBe(1);
 });
 it('paginates after visibility and rejects a cursor used by another viewer',async()=>{
  const first=await readFollowupReview(db.pool,{...options,limit:1});
  expect(first.items.map(x=>x.leadId)).toEqual(['contract']);
  const second=await readFollowupReview(db.pool,{...options,limit:1,cursor:first.nextCursor});
  expect(second.items.map(x=>x.leadId)).toEqual(['wait']);expect(second.nextCursor).toBeNull();
  await expect(readFollowupReview(db.pool,{...options,viewer:{role:'admin'},cursor:first.nextCursor})).rejects.toThrow('invalid_cursor');
 });
 it('allows administrators to review private projects within this company',async()=>{
  const result=await readFollowupReview(db.pool,{...options,viewer:{role:'admin'}});
  expect(result.items.map(x=>x.leadId)).toEqual(['contract','private','wait']);
 });
 it('never bridges a denied deal or an unknown company into a visible project',async()=>{
  await db.pool.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','note','contract-note','deal','denied','fixture'); UPDATE sdr_lead_state SET crm_company_id='other' WHERE pipedrive_lead_id='wait'`);
  expect((await readFollowupReview(db.pool,options)).items).toEqual([]);
 });
 it('fails closed when source permission is lost, while reporting collection gaps',async()=>{
  await db.pool.query(`INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,error_category) VALUES('42','notes','partial','rate_limit')`);
  expect((await readFollowupReview(db.pool,options)).freshness.scopes[0]).toMatchObject({scope:'notes',status:'partial',errorCategory:'rate_limit'});
  await db.pool.query("UPDATE sdr_crm_scope_coverage SET error_category='permission'");
  expect(await readFollowupReview(db.pool,options)).toMatchObject({items:[],unavailable:'permission_denied'});
 });
});
