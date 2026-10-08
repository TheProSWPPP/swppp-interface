import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import http from 'node:http';
import express from 'express';
import {reportingTestDb} from './reportingTestDb.js';
import {readCrmFollowups} from '../sdrCrmObservations.js';
import {registerSdrCrmObservationRoutes} from '../sdrCrmObservationRoutes.js';

const db=reportingTestDb('followup_recovery');
(db?describe:describe.skip)('follow-up recovery views',()=>{
 beforeAll(async()=>{
  await db.setup();
  for(const file of ['2026-10-02-sdr-reporting.sql','2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-manual-protection.sql','2026-10-03-sdr-reply-actions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text,pipedrive_person_id text,pipedrive_org_id text,person_email text,person_name text,project_stage text,trigger_override text,trigger_type text,sequence_started text,crm_source_updated_at timestamptz,crm_source_read_started_at timestamptz,crm_person_source_updated_at timestamptz,crm_person_source_read_started_at timestamptz);
   CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id uuid,status text);`);
  for(const [lead,assignee] of [['shared',null],['mine','00000000-0000-0000-0000-00000000000a'],['private','00000000-0000-0000-0000-00000000000b']]){
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
  await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,link_evidence,reply_kind,intent,detected_at) VALUES('rfc822:<verified@example.test>','gmail','1','thread-1','rep@example.test','2026-10-06T00:00:00Z','mine','verified','gmail-thread:thread-1:outbound-message:sent-1','human','interested','2026-10-06T00:01:00Z'),('ambiguous','gmail','2','thread-2','rep@example.test','2026-10-07T00:00:00Z','mine','ambiguous','historical_link_requires_review','human','interested','2026-10-07T00:01:00Z')`);
  await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,thread_id,pipedrive_lead_id,link_status,link_evidence,observed_at) VALUES('gmail','1','in','rep@example.test','buyer@example.test','thread-1','mine','verified','gmail-thread:thread-1:outbound-message:sent-1','2026-10-06T00:01:00Z')`);
  await db.pool.query(`INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at) VALUES('gmail_watch','rep@example.test','complete','2026-10-06T00:00:00Z','2026-10-06T00:02:00Z')`);
  await db.pool.query(`INSERT INTO sdr_outreach_controls(company_id,scope_kind,scope_id,reason,context_hash,actor,owner_id) VALUES('42','recipient','buyer@example.test','Recipient opted out','hash','{}','admin'),('42','recipient','other@example.test','Private other reason','hash','{}','admin')`);
 });
 afterAll(async()=>db.close());
 it('shows today, recent overdue and next-week tasks while preserving both dates on a project',async()=>{
  const r=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07'});
  expect(r.items.map(x=>x.id)).toEqual(['shared-today','shared-recent','shared-next']);
  expect((await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'backlog',asOf:'2026-10-07'})).items.map(x=>x.id)).toEqual(['shared-old']);
  expect((await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'later',asOf:'2026-10-07'})).items.map(x=>x.id)).toEqual(['shared-later']);
 });
 it('promotes only an old dated task for a current proved human reply',async()=>{
  const options={companyId:'42',leadId:'mine',dueView:'current',asOf:'2026-10-07',includeContext:true,visibleMailboxes:['rep@example.test']};
  const current=await readCrmFollowups(db.pool,options);
  expect(current.items.map(x=>x.id)).toEqual(['mine-old','mine-today','mine-recent','mine-next']);
  expect(current.items[0]).toMatchObject({dueDate:'2026-04-01',ownerId:'7',attention:{reason:'recent_verified_reply',sourceMessageId:'1'}});
  expect(current.items.find(x=>x.id==='mine-later')?.attention).toBeUndefined();
  expect((await readCrmFollowups(db.pool,{...options,leadId:'private'})).items.some(item=>item.id==='private-old')).toBe(false);
  expect((await readCrmFollowups(db.pool,{...options,visibleMailboxes:[]})).items.map(x=>x.id)).toEqual(['mine-today','mine-recent','mine-next']);
 });
 it('requires the current same-mailbox fact, exact proof and completed collection',async()=>{
  const options={companyId:'42',leadId:'mine',dueView:'current',asOf:'2026-10-07',includeContext:true,visibleMailboxes:['rep@example.test']};
  const ids=async()=>{const result=await readCrmFollowups(db.pool,options);return {ids:result.items.map(item=>item.id),reply:result.items[0]?.lastReply};};
  try{
   await db.pool.query("UPDATE sdr_message_facts SET link_status='ambiguous' WHERE provider='gmail' AND provider_message_id='1'");
   expect((await ids()).ids).not.toContain('mine-old');
   await db.pool.query("UPDATE sdr_message_facts SET link_status='verified',link_evidence='historical_link_requires_review' WHERE provider='gmail' AND provider_message_id='1'");
   expect((await ids()).ids).not.toContain('mine-old');
   await db.pool.query("UPDATE sdr_message_facts SET link_evidence='gmail-thread:thread-1:outbound-message:sent-1',mailbox_email='other@example.test' WHERE provider='gmail' AND provider_message_id='1'");
   expect((await ids()).ids).not.toContain('mine-old');
   await db.pool.query("UPDATE sdr_message_facts SET mailbox_email='rep@example.test',is_test=true,test_evidence='synthetic' WHERE provider='gmail' AND provider_message_id='1'");
   expect((await ids()).ids).not.toContain('mine-old');
   await db.pool.query("UPDATE sdr_message_facts SET is_test=false,test_evidence=NULL WHERE provider='gmail' AND provider_message_id='1'");
   await db.pool.query("UPDATE sdr_job_runs SET status='partial' WHERE job='gmail_watch' AND scope='rep@example.test'");
   const partial=await readCrmFollowups(db.pool,options);
   expect(partial.items.map(item=>item.id)).not.toContain('mine-old');
   expect(partial.replyCoverage.status).toBe('unknown');
   await db.pool.query("UPDATE sdr_job_runs SET status='complete' WHERE job='gmail_watch' AND scope='rep@example.test'");
   await db.pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at) VALUES('gmail_watch','rep@example.test','running','2026-10-06T02:00:00Z')");
   expect((await ids()).ids).not.toContain('mine-old');
  }finally{
   await db.pool.query("UPDATE sdr_message_facts SET link_status='verified',link_evidence='gmail-thread:thread-1:outbound-message:sent-1',mailbox_email='rep@example.test',is_test=false,test_evidence=NULL WHERE provider='gmail' AND provider_message_id='1'");
   await db.pool.query("DELETE FROM sdr_job_runs WHERE job='gmail_watch' AND scope='rep@example.test' AND status='running'");
   await db.pool.query("UPDATE sdr_job_runs SET status='complete' WHERE job='gmail_watch' AND scope='rep@example.test'");
  }
 });
 it('keeps the newest proved negative classification and ignores other-mailbox identity reuse',async()=>{
  const now='2026-10-06T01:00:00Z',proof='gmail-thread:thread-3:outbound-message:sent-3';
  await db.pool.query("INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,link_evidence,reply_kind,intent,detected_at) VALUES('gmail:rep:3','gmail','3','thread-3','rep@example.test',$1,'mine','verified',$2,'human','not_interested',$1),('gmail:other:3','gmail','3','thread-3','other@example.test',$1,'mine','verified',$2,'human','interested',$1)",[now,proof]);
  await db.pool.query("INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,thread_id,pipedrive_lead_id,link_status,link_evidence,observed_at) VALUES('gmail','3','in','rep@example.test','buyer@example.test','thread-3','mine','verified',$1,$2)",[proof,now]);
  await db.pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at) VALUES('gmail_watch','other@example.test','complete','2026-10-06T00:00:00Z','2026-10-06T00:02:00Z')");
  try{
   const result=await readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',dueView:'current',asOf:'2026-10-07',visibleMailboxes:['rep@example.test','other@example.test']});
   expect(result.items[0].attention).toMatchObject({providerMessageId:'gmail:rep:3',sourceMessageId:'3'});
   expect(result.items[0].lastReply.intent).toBe('not_interested');
  }finally{
   await db.pool.query("DELETE FROM sdr_reply_messages WHERE provider_message_id IN ('gmail:rep:3','gmail:other:3')");
   await db.pool.query("DELETE FROM sdr_message_facts WHERE provider='gmail' AND provider_message_id='3'");
   await db.pool.query("DELETE FROM sdr_job_runs WHERE scope='other@example.test'");
  }
 });
 it('uses the newest verified human message when one Gmail thread has repeated replies',async()=>{
  const proof='gmail-thread:thread-1:outbound-message:sent-1';
  await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,link_evidence,reply_kind,intent,detected_at)
    VALUES('rfc822:<repeat@example.test>','gmail','repeat-2','thread-1','rep@example.test','2026-10-07T16:00:00Z','mine','verified',$1,'human','not_interested','2026-10-07T16:01:00Z')`,[proof]);
  await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,thread_id,pipedrive_lead_id,link_status,link_evidence,observed_at)
    VALUES('gmail','repeat-2','in','rep@example.test','buyer@example.test','thread-1','mine','verified',$1,'2026-10-07T16:01:00Z')`,[proof]);
  try{
   const result=await readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',dueView:'current',asOf:'2026-10-07',visibleMailboxes:['rep@example.test']});
   expect(result.items.filter(item=>item.id==='mine-old')).toHaveLength(1);
   expect(result.items.find(item=>item.id==='mine-old')).toMatchObject({lastReply:{intent:'not_interested'},attention:{providerMessageId:'rfc822:<repeat@example.test>',sourceMessageId:'repeat-2',threadId:'thread-1'}});
  }finally{
   await db.pool.query("DELETE FROM sdr_reply_messages WHERE provider_message_id='rfc822:<repeat@example.test>'");
   await db.pool.query("DELETE FROM sdr_message_facts WHERE provider_message_id='repeat-2'");
  }
 });
 it('applies existing project visibility before pagination, including the shared pool',async()=>{
  const r=await readCrmFollowups(db.pool,{companyId:'42',viewer:{role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'},dueView:'current',asOf:'2026-10-07',limit:2});
  const next=await readCrmFollowups(db.pool,{companyId:'42',viewer:{role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'},dueView:'current',asOf:'2026-10-07',limit:20,cursor:r.nextCursor});
  expect(r.owners.map(x=>x.id)).toEqual(['7']);
  expect([...r.items,...next.items].map(x=>x.leadId).sort()).toEqual(['mine','mine','mine','shared','shared','shared']);
 });
 it('keeps task and lead owners separate, ignores ambiguous replies and does not invent a sent quote',async()=>{
  const r=await readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',includeContext:true,dueView:'current',asOf:'2026-10-07',visibleMailboxes:['rep@example.test']});
  expect(r.items[0]).toMatchObject({ownerId:'7',leadOwnerId:'8',contactName:'Buyer',contactEmail:'buyer@example.test',quoteStatus:'unverified',lastReply:{receivedAt:expect.anything(),intent:'interested',staffResponseAt:null},restrictions:[{reason:'Recipient opted out'}]});
  expect(new Date(r.items[0].lastReply.receivedAt).toISOString()).toBe('2026-10-06T00:00:00.000Z');
  expect(r.items[0].restrictions).toHaveLength(1);
  await db.pool.query("UPDATE sdr_reply_messages SET staff_response_at='2026-10-07' WHERE provider_message_id='rfc822:<verified@example.test>'");
  expect((await readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',includeContext:true,dueView:'current',asOf:'2026-10-07',visibleMailboxes:['rep@example.test']})).items[0].lastReply.staffResponseAt).toBeTruthy();
 });
 it('keeps LinkedIn reminders out of normal work without deleting or completing them',async()=>{
  await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('42','activity','linkedin','{"subject":"LinkedIn connect - estimator","type":"task","done":false,"due_date":"2026-10-07"}'); INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','activity','linkedin','lead','shared','fixture')`);
  const base={companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07'};
  expect((await readCrmFollowups(db.pool,{...base,activityType:'non_linkedin'})).items.map(x=>x.id)).toEqual(['shared-today','shared-recent','shared-next']);
  expect((await readCrmFollowups(db.pool,{...base,activityType:'linkedin_reminder'})).items.map(x=>x.id)).toEqual(['linkedin']);
  await db.pool.query("DELETE FROM sdr_crm_links WHERE entity_id='linkedin'; DELETE FROM sdr_crm_snapshots WHERE entity_id='linkedin'");
 });
 it('does not choose arbitrarily between two projects linked to the same task',async()=>{
  await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('42','activity','ambiguous-task','{"subject":"Call buyer","type":"call","done":false}'); INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','activity','ambiguous-task','lead','shared','fixture'),('42','activity','ambiguous-task','lead','private','fixture')`);
  try {expect((await readCrmFollowups(db.pool,{companyId:'42'})).items.some(x=>x.id==='ambiguous-task')).toBe(false);}
  finally {await db.pool.query("DELETE FROM sdr_crm_links WHERE entity_id='ambiguous-task'; DELETE FROM sdr_crm_snapshots WHERE entity_id='ambiguous-task'");}
 });
 it('suppresses a direct/deal conflict and an inaccessible parent deal',async()=>{
  await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES
    ('42','deal','conflict-deal','{"title":"Conflict"}'),
    ('42','activity','conflict-task','{"subject":"Call","type":"call","done":false,"due_date":"2026-10-07"}')`);
  await db.pool.query(`INSERT INTO sdr_crm_links VALUES
    ('42','deal','conflict-deal','lead','private','fixture'),
    ('42','activity','conflict-task','lead','mine','fixture'),
    ('42','activity','conflict-task','deal','conflict-deal','fixture')`);
  try{
   const read=()=>readCrmFollowups(db.pool,{companyId:'42',dueView:'all'});
   expect((await read()).items.some(item=>item.id==='conflict-task')).toBe(false);
   await db.pool.query("UPDATE sdr_crm_snapshots SET access_status='denied' WHERE entity='deal' AND entity_id='conflict-deal'");
   expect((await read()).items.some(item=>item.id==='conflict-task')).toBe(false);
  }finally{
   await db.pool.query("DELETE FROM sdr_crm_links WHERE entity_id IN ('conflict-deal','conflict-task')");
   await db.pool.query("DELETE FROM sdr_crm_snapshots WHERE entity_id IN ('conflict-deal','conflict-task')");
  }
 });
 it('uses Chicago dates for timed UTC activities and preserves the original source fields',async()=>{
  await db.pool.query(`UPDATE sdr_crm_snapshots SET data=data||'{"due_date":"2026-10-08","due_time":"01:30"}'::jsonb WHERE entity_id='shared-today'`);
  const result=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07'});
  expect(result.items[0]).toMatchObject({id:'shared-today',dueDate:'2026-10-08',dueTime:'01:30',dueLocalDate:'2026-10-07',dueLocalTime:'20:30'});
 });
 it('requires a refresh after the Chicago date changes and preserves old-view cursor scope',async()=>{
  const first=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07',limit:1});
  await db.pool.query(`UPDATE sdr_crm_snapshots SET data=data||'{"done":true}'::jsonb WHERE entity_id=$1`,[first.items[0].id]);
  await expect(readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-08',limit:10,cursor:first.nextCursor})).rejects.toThrow('reset_required');
  const second=await readCrmFollowups(db.pool,{companyId:'42',leadId:'shared',dueView:'current',asOf:'2026-10-07',limit:10,cursor:first.nextCursor});
  expect(second.items.map(x=>x.id)).toEqual(['shared-recent','shared-next']);
  await expect(readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',dueView:'current',cursor:first.nextCursor})).rejects.toThrow('invalid_cursor');
 });
 it('refuses invalid views and never admits another company through a mirrored lead',async()=>{
  await expect(readCrmFollowups(db.pool,{companyId:'42',dueView:'bogus'})).rejects.toThrow('invalid_due_view');
  await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='other' WHERE pipedrive_lead_id='shared'");
  expect((await readCrmFollowups(db.pool,{companyId:'42',viewer:{role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'},leadId:'shared'})).items).toEqual([]);
 });
 it('serves scoped staff results without global health data and rejects anonymous reads',async()=>{
  const app=express();app.use((req,res,next)=>{if(req.headers['x-role'])req.sdrUser={role:req.headers['x-role'],sub:'00000000-0000-0000-0000-00000000000a'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?context=1`;
  try{
   expect((await fetch(url)).status).toBe(403);
   const reviewUrl=url.replace('followups?context=1','followup-review');
   expect((await fetch(reviewUrl)).status).toBe(403);
   const review=await fetch(reviewUrl,{headers:{'x-role':'sdr'}});expect(review.status).toBe(200);expect((await review.json()).freshness.inbox).toBeNull();
   expect((await fetch(reviewUrl+'?cursor=invalid',{headers:{'x-role':'sdr'}})).status).toBe(400);
   const response=await fetch(url,{headers:{'x-role':'sdr'}});expect(response.status).toBe(200);
   const data=await response.json();expect(data.items.every(x=>x.leadId==='mine')).toBe(true);expect(data.items).toHaveLength(5);expect(data.freshness.inbox).toBeNull();
   expect((await fetch(url+'&dueView=bogus',{headers:{'x-role':'sdr'}})).status).toBe(400);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
 it('invalidates a current page on same-user visibility reassignment and rejects a forged cutoff',async()=>{
  const at=new Date(Date.now()-3600000).toISOString();
  await db.pool.query("UPDATE sdr_reply_messages SET received_at=$1,detected_at=$1 WHERE provider_message_id='rfc822:<verified@example.test>'",[at]);
  await db.pool.query("UPDATE sdr_message_facts SET observed_at=$1 WHERE provider='gmail' AND provider_message_id='1'",[at]);
  await db.pool.query("UPDATE sdr_job_runs SET started_at=$1::timestamptz-INTERVAL '1 minute',finished_at=$1,status='complete' WHERE job='gmail_watch' AND scope='rep@example.test'",[at]);
  const app=express();app.use((req,res,next)=>{if(req.headers['x-role'])req.sdrUser={role:req.headers['x-role'],sub:'00000000-0000-0000-0000-00000000000a'};next();});
  let connected=['rep@example.test'];
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>connected});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current&context=1&limit=1`;
  try{
   const headers={'x-role':'sdr'};
   const first=await fetch(url,{headers});expect(first.status).toBe(200);
   const page=await first.json();expect(page.items[0]).toMatchObject({id:'mine-old',attention:{sourceMessageId:'1'}});
   expect(page.nextCursor?.startsWith('v2:')).toBe(true);
   const next=await fetch(url+'&cursor='+encodeURIComponent(page.nextCursor),{headers});
   expect(next.status).toBe(200);const nextPage=await next.json();expect(nextPage.authorization).toBe(page.authorization);
   expect(nextPage.items[0].id).toBe('mine-today');
   const forged=JSON.parse(Buffer.from(page.nextCursor.slice(3),'base64url').toString());forged.cutoff='2026-10-07T12:00:00.000000Z';
   const forgedCursor='v2:'+Buffer.from(JSON.stringify(forged)).toString('base64url');
   expect((await fetch(url+'&cursor='+encodeURIComponent(forgedCursor),{headers})).status).toBe(400);
   const signedCutoff=value=>{const {sig,...unsigned}=forged;unsigned.cutoff=value;return 'v2:'+Buffer.from(JSON.stringify({...unsigned,sig:createHmac('sha256',process.env.SDR_JWT_SECRET||'swppp-sdr-dev-jwt-secret-change-me').update(JSON.stringify(unsigned)).digest('hex')})).toString('base64url');};
   expect((await fetch(url+'&cursor='+encodeURIComponent(signedCutoff(new Date(Date.now()+86400000).toISOString().replace('Z','000Z'))),{headers})).status).toBe(400);
   expect((await fetch(url+'&cursor='+encodeURIComponent(signedCutoff(new Date(Date.now()-8*86400000).toISOString().replace('Z','000Z'))),{headers})).status).toBe(400);
   expect((await fetch(url+'&cursor='+encodeURIComponent('v1:eyJ0b2RheSI6IjIwMjYtMTAtMDcifQ'),{headers})).status).toBe(409);
   expect((await fetch(url+'&cursor='+encodeURIComponent('v2:not-base64'),{headers})).status).toBe(400);
   expect((await fetch(url+'&cursor='+encodeURIComponent(page.nextCursor)+'&activityType=call',{headers})).status).toBe(400);
   expect((await fetch(url+'&limit=2',{headers})).status).toBe(400);
   expect((await fetch(url+'&limit=2&limit=3',{headers})).status).toBe(400);
   connected=[];
   expect((await fetch(url+'&cursor='+encodeURIComponent(page.nextCursor),{headers})).status).toBe(409);
   const ordinary=await fetch(url,{headers});expect(ordinary.status).toBe(200);
   expect((await ordinary.json()).items.some(item=>item.id==='mine-old')).toBe(false);
   connected=['rep@example.test'];
   await db.pool.query("UPDATE sdr_drafts SET assigned_user_id='00000000-0000-0000-0000-00000000000b' WHERE pipedrive_lead_id='mine'");
   const stale=await fetch(url+'&cursor='+encodeURIComponent(page.nextCursor),{headers});
   expect(stale.status).toBe(409);expect(await stale.json()).toEqual({error:'reset_required'});
   const after=await fetch(url,{headers});expect(after.status).toBe(200);
   expect((await after.json()).items.every(item=>item.leadId!=='mine')).toBe(true);
   expect((await fetch(url+'&limit=201',{headers})).status).toBe(400);
  }finally{
   await db.pool.query("UPDATE sdr_drafts SET assigned_user_id='00000000-0000-0000-0000-00000000000a' WHERE pipedrive_lead_id='mine'");
   await new Promise(resolve=>server.close(resolve));
  }
 });
 it('invalidates a non-current v1 page after lead reassignment',async()=>{
  const options={companyId:'42',viewer:{role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'},dueView:'all',visibleMailboxes:['rep@example.test'],limit:1};
  const first=await readCrmFollowups(db.pool,options);
  expect(first.nextCursor?.startsWith('v1:')).toBe(true);
  expect(first.authorization).toBeTruthy();
  await db.pool.query("UPDATE sdr_drafts SET assigned_user_id='00000000-0000-0000-0000-00000000000b' WHERE pipedrive_lead_id='mine'");
  try{await expect(readCrmFollowups(db.pool,{...options,cursor:first.nextCursor})).rejects.toThrow('reset_required');}
  finally{await db.pool.query("UPDATE sdr_drafts SET assigned_user_id='00000000-0000-0000-0000-00000000000a' WHERE pipedrive_lead_id='mine'");}
 });
 it('keeps the task route available if connected-mailbox resolution fails',async()=>{
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>{throw new Error('mailbox_unavailable');}});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  try{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current&context=1`);
   expect(response.status).toBe(200);
   const data=await response.json();
   expect(data.items.some(item=>item.id==='mine-today')).toBe(true);
   expect(data.items.some(item=>item.id==='mine-old')).toBe(false);
   expect(data.replyCoverage.status).toBe('unknown');
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
 it('excludes a latest collection completed one microsecond beyond the frozen cutoff',async()=>{
  const options={companyId:'42',leadId:'mine',dueView:'current',limit:1,visibleMailboxes:['rep@example.test']};
  const first=await readCrmFollowups(db.pool,options);
  expect(first.nextCursor?.startsWith('v2:')).toBe(true);
  const page=JSON.parse(Buffer.from(first.nextCursor.slice(3),'base64url').toString());
  const inserted=await db.pool.query(`INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at)
    VALUES('gmail_watch','rep@example.test','complete',$1::timestamptz-INTERVAL '1 millisecond',$1::timestamptz+INTERVAL '1 microsecond') RETURNING id`,[page.cutoff]);
  try{
   const continuation=await readCrmFollowups(db.pool,{...options,cursor:first.nextCursor});
   expect(continuation.replyCoverage).toMatchObject({status:'unknown',eligibleMailboxes:0});
   expect(continuation.items.some(item=>item.attention)).toBe(false);
  }finally{await db.pool.query('DELETE FROM sdr_job_runs WHERE id=$1',[inserted.rows[0].id]);}
 });
 it('uses an exclusive received cutoff and inclusive detected cutoff at microsecond precision',async()=>{
  const base={companyId:'42',leadId:'mine',dueView:'current',asOf:'2026-10-07',visibleMailboxes:['rep@example.test']};
  const original=(await db.pool.query("SELECT received_at,detected_at FROM sdr_reply_messages WHERE provider_message_id='rfc822:<verified@example.test>'")).rows[0];
  const cutoff='2026-10-07T17:00:00.000000Z';
  const receipt=(await db.pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at) VALUES('gmail_watch','rep@example.test','complete','2026-10-07T16:00:00Z','2026-10-07T16:30:00Z') RETURNING id")).rows[0].id;
  try{
   await db.pool.query("UPDATE sdr_reply_messages SET received_at=$1::timestamptz,detected_at=$1::timestamptz WHERE provider_message_id='rfc822:<verified@example.test>'",[cutoff]);
   expect((await readCrmFollowups(db.pool,base)).items.some(item=>item.id==='mine-old')).toBe(false);
   await db.pool.query("UPDATE sdr_reply_messages SET received_at=$1::timestamptz-INTERVAL '1 microsecond' WHERE provider_message_id='rfc822:<verified@example.test>'",[cutoff]);
   expect((await readCrmFollowups(db.pool,base)).items.some(item=>item.id==='mine-old')).toBe(true);
   await db.pool.query("UPDATE sdr_reply_messages SET detected_at=$1::timestamptz+INTERVAL '1 microsecond' WHERE provider_message_id='rfc822:<verified@example.test>'",[cutoff]);
   expect((await readCrmFollowups(db.pool,base)).items.some(item=>item.id==='mine-old')).toBe(false);
  }finally{await db.pool.query("UPDATE sdr_reply_messages SET received_at=$1,detected_at=$2 WHERE provider_message_id='rfc822:<verified@example.test>'",[original.received_at,original.detected_at]);await db.pool.query('DELETE FROM sdr_job_runs WHERE id=$1',[receipt]);}
 });
 it('uses Chicago calendar-day bounds across the fall daylight-saving transition',async()=>{
  const base={companyId:'42',leadId:'mine',dueView:'current',asOf:'2026-11-01',visibleMailboxes:['rep@example.test']};
  const original=(await db.pool.query("SELECT received_at,detected_at FROM sdr_reply_messages WHERE provider_message_id='rfc822:<verified@example.test>'")).rows[0];
  const receipt=(await db.pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at) VALUES('gmail_watch','rep@example.test','complete','2026-10-31T00:00:00Z','2026-10-31T00:01:00Z') RETURNING id")).rows[0].id;
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-01T20:00:00Z'));
  try{
   await db.pool.query("UPDATE sdr_reply_messages SET received_at='2026-10-26T05:00:00Z',detected_at='2026-10-31T00:00:00Z' WHERE provider_message_id='rfc822:<verified@example.test>'");
   expect((await readCrmFollowups(db.pool,base)).items.some(item=>item.id==='mine-old')).toBe(true);
   await db.pool.query("UPDATE sdr_reply_messages SET received_at='2026-10-26T04:59:59.999999Z' WHERE provider_message_id='rfc822:<verified@example.test>'");
   expect((await readCrmFollowups(db.pool,base)).items.some(item=>item.id==='mine-old')).toBe(false);
  }finally{
   vi.useRealTimers();
   await db.pool.query("UPDATE sdr_reply_messages SET received_at=$1,detected_at=$2 WHERE provider_message_id='rfc822:<verified@example.test>'",[original.received_at,original.detected_at]);
   await db.pool.query('DELETE FROM sdr_job_runs WHERE id=$1',[receipt]);
  }
 });
 it('pages equal-time reply attention through the authorized route without duplication',async()=>{
  const received=(await db.pool.query("SELECT received_at FROM sdr_reply_messages WHERE provider_message_id='rfc822:<verified@example.test>'")).rows[0].received_at;
  await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,link_evidence,reply_kind,intent,detected_at)
    VALUES('gmail:private:same','gmail','same-time','thread-same','rep@example.test',$1,'private','verified','gmail-thread:thread-same:outbound-message:sent-same','human','interested',$1)`,[received]);
  await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,thread_id,pipedrive_lead_id,link_status,link_evidence,observed_at)
    VALUES('gmail','same-time','in','rep@example.test','buyer@example.test','thread-same','private','verified','gmail-thread:thread-same:outbound-message:sent-same',$1)`,[received]);
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'admin',sub:'admin'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>['rep@example.test']});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current&limit=1`;
  try{
   const firstResponse=await fetch(url);expect(firstResponse.status).toBe(200);
   const first=await firstResponse.json();
   const secondResponse=await fetch(url+'&cursor='+encodeURIComponent(first.nextCursor));expect(secondResponse.status).toBe(200);
   const second=await secondResponse.json();
   expect([first.items[0].id,second.items[0].id].sort()).toEqual(['mine-old','private-old']);
   expect(first.items[0].attention.receivedAt).toEqual(second.items[0].attention.receivedAt);
   expect(first.replyCoverage.lastCollectedAt).toBeTruthy();
  }finally{
   await new Promise(resolve=>server.close(resolve));
   await db.pool.query("DELETE FROM sdr_reply_messages WHERE provider_message_id='gmail:private:same'");
   await db.pool.query("DELETE FROM sdr_message_facts WHERE provider_message_id='same-time'");
  }
 });
 it('keeps archived ordinary tasks scoped to the configured company through the admin route',async()=>{
  await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle)
    VALUES('other','lead','foreign', '{"title":"Foreign"}','active'),
      ('other','activity','foreign-old','{"subject":"Foreign call","type":"call","done":false,"due_date":"2026-04-01"}','active')`);
  await db.pool.query("INSERT INTO sdr_crm_links VALUES('other','activity','foreign-old','lead','foreign','fixture')");
  await db.pool.query("UPDATE sdr_crm_snapshots SET lifecycle='archived' WHERE company_id='42' AND entity='lead' AND entity_id='mine'");
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'admin',sub:'admin'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>[]});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  try{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=backlog&lifecycle=archived&ownerId=7&activityType=call`);
   expect(response.status).toBe(200);
   const body=await response.json();
   expect(body.items.map(item=>item.id)).toEqual(['mine-old']);
   expect(body.items[0].attention).toBeUndefined();
   expect(body.items.some(item=>item.id==='foreign-old')).toBe(false);
  }finally{
   await new Promise(resolve=>server.close(resolve));
   await db.pool.query("UPDATE sdr_crm_snapshots SET lifecycle='active' WHERE company_id='42' AND entity='lead' AND entity_id='mine'");
   await db.pool.query("DELETE FROM sdr_crm_links WHERE company_id='other' AND entity_id='foreign-old'");
   await db.pool.query("DELETE FROM sdr_crm_snapshots WHERE company_id='other' AND entity_id IN ('foreign','foreign-old')");
  }
 });
 it('requires exact current Gmail fact proof for old-task attention through the route',async()=>{
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'admin',sub:'admin'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>['rep@example.test']});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current`;
  const old=async()=>{const response=await fetch(url);expect(response.status).toBe(200);return (await response.json()).items.some(item=>item.id==='mine-old');};
  const fact="provider='gmail' AND provider_message_id='1'";
  try{
   expect(await old()).toBe(true);
   const variants=[
    [`UPDATE sdr_reply_messages SET source='pipedrive' WHERE provider_message_id='rfc822:<verified@example.test>'`,`UPDATE sdr_reply_messages SET source='gmail' WHERE provider_message_id='rfc822:<verified@example.test>'`],
    [`UPDATE sdr_message_facts SET direction='out' WHERE ${fact}`,`UPDATE sdr_message_facts SET direction='in' WHERE ${fact}`],
    [`UPDATE sdr_message_facts SET pipedrive_lead_id='private' WHERE ${fact}`,`UPDATE sdr_message_facts SET pipedrive_lead_id='mine' WHERE ${fact}`],
    [`UPDATE sdr_message_facts SET thread_id='wrong-thread' WHERE ${fact}`,`UPDATE sdr_message_facts SET thread_id='thread-1' WHERE ${fact}`],
    [`UPDATE sdr_message_facts SET provider_message_id='missing' WHERE ${fact}`,"UPDATE sdr_message_facts SET provider_message_id='1' WHERE provider='gmail' AND provider_message_id='missing'"],
   ];
   for(const [breakProof,restore] of variants){
    await db.pool.query(breakProof);
    try{expect(await old()).toBe(false);}finally{await db.pool.query(restore);}
   }
   expect(await old()).toBe(true);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
 it('keeps continuation live when fact attribution or task date changes and refresh shows current evidence',async()=>{
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>['rep@example.test']});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current&limit=1`;
  try{
   const first=await (await fetch(url)).json();expect(first.items[0].id).toBe('mine-old');
   await db.pool.query("UPDATE sdr_message_facts SET pipedrive_lead_id='private' WHERE provider='gmail' AND provider_message_id='1'");
   const nextResponse=await fetch(url+'&cursor='+encodeURIComponent(first.nextCursor));expect(nextResponse.status).toBe(200);
   expect((await nextResponse.json()).items[0].id).toBe('mine-today');
   expect((await (await fetch(url)).json()).items[0].id).toBe('mine-today');
   await db.pool.query("UPDATE sdr_message_facts SET pipedrive_lead_id='mine' WHERE provider='gmail' AND provider_message_id='1'");
   await db.pool.query("UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{due_date}',to_jsonb('2026-11-01'::text)) WHERE company_id='42' AND entity='activity' AND entity_id='mine-old'");
   expect((await (await fetch(url)).json()).items[0].id).toBe('mine-today');
  }finally{
   await db.pool.query("UPDATE sdr_message_facts SET pipedrive_lead_id='mine' WHERE provider='gmail' AND provider_message_id='1'");
   await db.pool.query("UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{due_date}',to_jsonb('2026-04-01'::text)) WHERE company_id='42' AND entity='activity' AND entity_id='mine-old'");
   await new Promise(resolve=>server.close(resolve));
  }
 });
 it('reads an actual staff route without provider fetches or business SQL writes',async()=>{
  const verbs=[];
  const guardedPool={connect:async()=>{
   const client=await db.pool.connect();
   return {query:(sql,params)=>{verbs.push(String(sql).trim().split(/\s+/)[0].toUpperCase());return client.query(sql,params);},release:()=>client.release()};
  }};
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};next();});
  registerSdrCrmObservationRoutes(app,{pool:guardedPool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>['rep@example.test']});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const providerFetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('provider_fetch_forbidden');});
  try{
   const response=await new Promise((resolve,reject)=>{
    http.get(`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current`,res=>{
     let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    }).on('error',reject);
   });
   expect(response.status).toBe(200);
   expect(response.body.items.some(item=>item.id==='mine-old')).toBe(true);
   expect(providerFetch).not.toHaveBeenCalled();
   expect(verbs.length).toBeGreaterThan(0);
   expect(verbs.every(verb=>['BEGIN','SET','SELECT','WITH','ROLLBACK'].includes(verb))).toBe(true);
  }finally{providerFetch.mockRestore();await new Promise(resolve=>server.close(resolve));}
 });
 it('keeps a synthetic 12-human/11-thread cohort plus six bounces scoped by verified proof',async()=>{
  const human=[
   ['ambiguous','nurture','a1'],['unlinked','no_action','u2'],['unlinked','no_action','u3'],
   ['ambiguous','nurture','a4'],['unlinked','no_action','u5'],['ambiguous','unsubscribe','a6'],
   ['ambiguous','not_interested','a7'],['ambiguous','no_action','repeat'],['verified','interested','v9'],
   ['verified','interested','v10'],['unlinked','interested','u11'],['ambiguous','nurture','repeat'],
  ];
  expect(human).toHaveLength(12);expect(new Set(human.map(row=>row[2])).size).toBe(11);
  await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('42','lead','cohort-synthetic','{\"title\":\"Synthetic cohort\"}'),('42','activity','cohort-old','{\"subject\":\"Call\",\"type\":\"call\",\"done\":false,\"due_date\":\"2026-04-01\"}')");
  await db.pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,crm_company_id) VALUES('cohort-synthetic','42')");
  await db.pool.query("INSERT INTO sdr_crm_links VALUES('42','activity','cohort-old','lead','cohort-synthetic','fixture')");
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'admin',sub:'admin'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>['rep@example.test']});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current`;
  const cohortTask=async()=>{const response=await fetch(url);expect(response.status).toBe(200);return (await response.json()).items.find(item=>item.id==='cohort-old');};
  try{
   const cases=[...human,...Array.from({length:6},(_,index)=>['verified','bounce',`bounce-${index}`])];
   for(const [index,[linkStatus,intent,thread]] of cases.entries()){
    const humanCase=index<12,sourceId=`cohort-source-${index+1}`,replyId=`cohort-reply-${index+1}`;
    const proof=`gmail-thread:${thread}:outbound-message:sent-${thread}`;
    const received=new Date(Date.now()-(100-index)*60000).toISOString();
    await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,link_evidence,reply_kind,intent,detected_at)
      VALUES($1,'gmail',$2,$3,'rep@example.test',$4,$5,$6,$7,$8,$9,$4)`,[replyId,sourceId,thread,received,linkStatus==='unlinked'?null:'cohort-synthetic',linkStatus,proof,humanCase?'human':'bounce',intent]);
    await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,thread_id,pipedrive_lead_id,link_status,link_evidence,observed_at)
      VALUES('gmail',$1,'in','rep@example.test','synthetic@example.test',$2,'cohort-synthetic','verified',$3,$4)`,[sourceId,thread,proof,received]);
   }
   expect(await cohortTask()).toMatchObject({attention:{providerMessageId:'cohort-reply-10'},lastReply:{intent:'interested'}});
   await db.pool.query("UPDATE sdr_reply_messages SET link_status='ambiguous' WHERE provider_message_id='cohort-reply-10'");
   expect(await cohortTask()).toMatchObject({attention:{providerMessageId:'cohort-reply-9'},lastReply:{intent:'interested'}});
   await db.pool.query("UPDATE sdr_reply_messages SET link_status='ambiguous' WHERE provider_message_id='cohort-reply-9'");
   expect(await cohortTask()).toBeUndefined();
   await db.pool.query("UPDATE sdr_reply_messages SET reply_kind='human' WHERE provider_message_id='cohort-reply-13'");
   expect(await cohortTask()).toMatchObject({attention:{providerMessageId:'cohort-reply-13'}});
  }finally{
   await new Promise(resolve=>server.close(resolve));
   await db.pool.query("DELETE FROM sdr_reply_messages WHERE provider_message_id LIKE 'cohort-reply-%'");
   await db.pool.query("DELETE FROM sdr_message_facts WHERE provider_message_id LIKE 'cohort-source-%'");
   await db.pool.query("DELETE FROM sdr_crm_links WHERE entity_id='cohort-old'");
   await db.pool.query("DELETE FROM sdr_crm_snapshots WHERE entity_id IN ('cohort-old','cohort-synthetic')");
   await db.pool.query("DELETE FROM sdr_lead_state WHERE pipedrive_lead_id='cohort-synthetic'");
  }
 });
 it('keeps ordinary task reads when the reply fact table is unavailable',async()=>{
  await db.pool.query('DROP TABLE sdr_message_facts CASCADE');
  const result=await readCrmFollowups(db.pool,{companyId:'42',leadId:'mine',dueView:'current',asOf:'2026-10-07',visibleMailboxes:['rep@example.test']});
  expect(result.items.map(item=>item.id)).toEqual(['mine-today','mine-recent','mine-next']);
  expect(result.replyCoverage.status).toBe('unknown');
  expect(result.items.every(item=>!item.attention&&!item.lastReply)).toBe(true);
  const app=express();app.use((req,res,next)=>{req.sdrUser={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};next();});
  registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async()=>true,resolveVisibleMailboxes:async()=>['rep@example.test']});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  try{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sdr/crm/followups?dueView=current`);
   expect(response.status).toBe(200);
   const body=await response.json();
   expect(body.items.map(item=>item.id)).toEqual(['mine-today','mine-recent','mine-next']);
   expect(body.replyCoverage).toMatchObject({status:'unknown',eligibleMailboxes:0});
   expect(body.items.every(item=>!item.attention&&!item.lastReply)).toBe(true);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
});
