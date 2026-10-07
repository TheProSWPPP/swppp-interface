import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import express from 'express';
import {reportingTestDb} from './reportingTestDb.js';
import {readCrmFollowups} from '../sdrCrmObservations.js';
import {registerSdrCrmObservationRoutes} from '../sdrCrmObservationRoutes.js';

const db=reportingTestDb('followup_recovery');
(db?describe:describe.skip)('follow-up recovery views',()=>{
 beforeAll(async()=>{
  await db.setup();
  for(const file of ['2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-manual-protection.sql','2026-10-03-sdr-reply-actions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text,pipedrive_person_id text,pipedrive_org_id text,person_email text,person_name text,project_stage text,trigger_override text,trigger_type text,sequence_started text,crm_source_updated_at timestamptz,crm_source_read_started_at timestamptz,crm_person_source_updated_at timestamptz,crm_person_source_read_started_at timestamptz);
   CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id text,status text);`);
  for(const [lead,assignee] of [['shared',null],['mine','rep-a'],['private','rep-b']]){
   await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle) VALUES('42','lead',$1,$2,'active')`,[lead,{title:lead,owner_id:8,person_id:2}]);
   await db.pool.query('INSERT INTO sdr_lead_state(pipedrive_lead_id,crm_company_id) VALUES($1,$2)',[lead,'42']);
   if(assignee)await db.pool.query('INSERT INTO sdr_drafts VALUES($1,$2,$3)',[lead,assignee,'pending']);
   for(const [suffix,due] of [['old','2026-04-01'],['recent','2026-10-06'],['today','2026-10-07'],['next','2026-10-12'],['later','2026-11-01']]){
    const activity=lead+'-'+suffix;
    await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle) VALUES('42','activity',$1,$2,'active')`,[activity,{lead_id:lead,subject:suffix,type:'call',done:false,owner_id:7,due_date:due}]);
    await db.pool.query(`INSERT INTO sdr_crm_links VALUES('42','activity',$1,'lead',$2,'pipedrive:lead_id')`,[activity,lead]);
   }
  }
  await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle) VALUES('42','person','2',$1,'active')`,[{name:'Buyer',email:[{value:'buyer@example.test',primary:true}]}]);
  await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind,intent) VALUES('verified','gmail','1','rep@example.test','2026-10-06T00:00:00Z','mine','verified','human','interested'),('ambiguous','gmail','2','rep@example.test','2026-10-07T00:00:00Z','mine','ambiguous','human','interested')`);
  await db.pool.query(`INSERT INTO sdr_outreach_controls(company_id,scope_kind,scope_id,reason,context_hash,actor,owner_id) VALUES('42','recipient','buyer@example.test','Recipient opted out','hash','{}','admin'),('42','recipient','other@example.test','Private other reason','hash','{}','admin')`);
 });
 afterAll(async()=>db.close());
 it('shows today, recent overdue and next-week tasks while preserving both dates on a project',async()=>{
  const r=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07'});
  expect(r.items.map(x=>x.id)).toEqual(['shared-today','shared-recent','shared-next']);
  expect((await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'backlog',asOf:'2026-10-07'})).items.map(x=>x.id)).toEqual(['shared-old']);
  expect((await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'later',asOf:'2026-10-07'})).items.map(x=>x.id)).toEqual(['shared-later']);
 });
 it('applies existing project visibility before pagination, including the shared pool',async()=>{
  const r=await readCrmFollowups(db.pool,{companyId:'42',viewer:{role:'sdr',sub:'rep-a'},dueView:'current',asOf:'2026-10-07',limit:2});
  const next=await readCrmFollowups(db.pool,{companyId:'42',viewer:{role:'sdr',sub:'rep-a'},dueView:'current',asOf:'2026-10-07',limit:20,cursor:r.nextCursor});
  expect(r.owners.map(x=>x.id)).toEqual(['7']);
  expect([...r.items,...next.items].map(x=>x.leadId).sort()).toEqual(['mine','mine','mine','shared','shared','shared']);
 });
 it('keeps task and lead owners separate, ignores ambiguous replies and does not invent a sent quote',async()=>{
  const r=await readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',includeContext:true,dueView:'current',asOf:'2026-10-07'});
  expect(r.items[0]).toMatchObject({ownerId:'7',leadOwnerId:'8',contactName:'Buyer',contactEmail:'buyer@example.test',quoteStatus:'unverified',lastReply:{receivedAt:expect.anything(),intent:'interested',staffResponseAt:null},restrictions:[{reason:'Recipient opted out'}]});
  expect(new Date(r.items[0].lastReply.receivedAt).toISOString()).toBe('2026-10-06T00:00:00.000Z');
  expect(r.items[0].restrictions).toHaveLength(1);
  await db.pool.query("UPDATE sdr_reply_messages SET staff_response_at='2026-10-07' WHERE provider_message_id='verified'");
  expect((await readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',includeContext:true})).items[0].lastReply.staffResponseAt).toBeTruthy();
 });
 it('uses Chicago dates for timed UTC activities and preserves the original source fields',async()=>{
  await db.pool.query(`UPDATE sdr_crm_snapshots SET data=data||'{"due_date":"2026-10-08","due_time":"01:30"}'::jsonb WHERE entity_id='shared-today'`);
  const result=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07'});
  expect(result.items[0]).toMatchObject({id:'shared-today',dueDate:'2026-10-08',dueTime:'01:30',dueLocalDate:'2026-10-07',dueLocalTime:'20:30'});
 });
 it('keeps paging stable after an earlier task completes and across midnight',async()=>{
  const first=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07',limit:1});
  await db.pool.query(`UPDATE sdr_crm_snapshots SET data=data||'{"done":true}'::jsonb WHERE entity_id=$1`,[first.items[0].id]);
  const second=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-08',limit:10,cursor:first.nextCursor});
  expect(second.items.map(x=>x.id)).toEqual(['shared-recent','shared-next']);
  await expect(readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',dueView:'current',cursor:first.nextCursor})).rejects.toThrow('invalid_cursor');
 });
 it('refuses invalid views and never admits another company through a mirrored lead',async()=>{
  await expect(readCrmFollowups(db.pool,{companyId:'42',dueView:'bogus'})).rejects.toThrow('invalid_due_view');
  await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='other' WHERE pipedrive_lead_id='shared'");
  expect((await readCrmFollowups(db.pool,{companyId:'42',viewer:{role:'sdr',sub:'rep-a'},leadId:'shared'})).items).toEqual([]);
 });
 it('serves scoped staff results without global health data and rejects anonymous reads',async()=>{
  const app=express();app.use((req,res,next)=>{if(req.headers['x-role'])req.sdrUser={role:req.headers['x-role'],sub:'rep-a'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?context=1`;
  try{
   expect((await fetch(url)).status).toBe(403);
   const response=await fetch(url,{headers:{'x-role':'sdr'}});expect(response.status).toBe(200);
   const data=await response.json();expect(data.items.every(x=>x.leadId==='mine')).toBe(true);expect(data.items).toHaveLength(5);expect(data.freshness.inbox).toBeNull();
   expect((await fetch(url+'&dueView=bogus',{headers:{'x-role':'sdr'}})).status).toBe(400);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
});
