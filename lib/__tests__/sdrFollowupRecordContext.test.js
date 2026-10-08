import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {readFollowupRecordContext} from '../sdrFollowupRecordContext.js';

const db=reportingTestDb('followup_record_context');
const at='2026-10-08T12:00:00Z';
const admin={role:'admin',sub:'admin'};
const staff={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};
const read=(leadIds=['A','B'],viewer=admin)=>readFollowupRecordContext(db.pool,{companyId:'42',viewer,leadIds,asOf:at});
const lead=async(id,company='42')=>{
 await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle) VALUES($1,'lead',$2,$3,'active')",[company,id,{title:id,person_id:7,org_id:9}]);
 await db.pool.query('INSERT INTO sdr_lead_state VALUES($1,$2)',[id,company]);
};
const record=async(entity,id,data,{company='42',updated='2026-10-07T10:00:00Z',url=null}={})=>
 db.pool.query('INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle,source_updated_at,source_url) VALUES($1,$2,$3,$4,\'active\',$5,$6)',[company,entity,id,data,updated,url]);
const link=async(entity,id,type,target,company='42')=>db.pool.query('INSERT INTO sdr_crm_links VALUES($1,$2,$3,$4,$5,\'fixture\')',[company,entity,id,type,target]);

(db?describe:describe.skip)('recent CRM records on selected follow-up projects',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql',import.meta.url),'utf8'));
  await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-note-events.sql',import.meta.url),'utf8'));
  await db.pool.query('CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text); CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id uuid,status text)');
 });
 beforeEach(async()=>{
  await db.pool.query('TRUNCATE sdr_crm_links,sdr_crm_snapshots,sdr_lead_state,sdr_drafts,sdr_note_events');
  await lead('A');await lead('B');
 });
 afterAll(async()=>db.close());

 it('rejects person-only evidence, cross-project conflicts and unresolved extra deal paths',async()=>{
  await record('note','person-only',{content:'person',update_time:'2026-10-07 10:00:00'});
  await link('note','person-only','person','7');
  await record('note','conflict',{content:'conflict',update_time:'2026-10-07 10:00:00'});
  await link('note','conflict','lead','A');
  await record('deal','dB',{title:'B'});await link('deal','dB','lead','B');await link('note','conflict','deal','dB');
  await record('note','unresolved',{content:'unresolved',update_time:'2026-10-07 10:00:00'});
  await link('note','unresolved','lead','A');
  await record('deal','dMissing',{title:'Missing mapping'});await link('note','unresolved','deal','dMissing');
  const context=await read();
  expect(context.get('A')).toMatchObject({status:'available',note:null});
  expect(context.get('B')).toMatchObject({status:'available',note:null});
 });

 it('accepts a unique accessible deal path and binds its URL to that parent',async()=>{
  await record('deal','dA',{title:'A'});await link('deal','dA','lead','A');
  await record('note','via-deal',{content:'Deal note',update_time:'2026-10-07 10:00:00'},
   {url:'https://proswpppllc.pipedrive.com/deal/dA'});
  await link('note','via-deal','deal','dA');
  const found=await read();
  expect(found.get('A').note).toMatchObject({id:'via-deal',sourceUrl:'https://proswpppllc.pipedrive.com/deal/dA',originStatus:'unknown'});
  expect(found.get('B').note).toBeNull();
  await db.pool.query("UPDATE sdr_crm_snapshots SET source_url='https://proswpppllc.pipedrive.com/deal/dB' WHERE entity='note' AND entity_id='via-deal'");
  expect((await read()).get('A').note.sourceUrl).toBeNull();
  await db.pool.query("UPDATE sdr_crm_snapshots SET access_status='denied' WHERE entity='deal' AND entity_id='dA'");
  expect((await read()).get('A').note).toBeNull();
 });

 it('returns the exact verified URL parent among three valid deal paths',async()=>{
  for(const dealId of ['d1','d2','d3']){await record('deal',dealId,{title:'A'});await link('deal',dealId,'lead','A');}
  await record('note','three-deals',{content:'Three paths',update_time:'2026-10-07 10:00:00'},
   {url:'https://proswpppllc.pipedrive.com/deal/d3'});
  await link('note','three-deals','lead','A');
  for(const dealId of ['d1','d2','d3'])await link('note','three-deals','deal',dealId);
  const note=(await read(['A'])).get('A').note;
  expect(note.sourceUrl).toBe('https://proswpppllc.pipedrive.com/deal/d3');
  expect(note.linkEvidence).toContainEqual({type:'deal',id:'d3',leadId:'A'});
  expect(note.linkEvidence).toContainEqual({type:'lead',id:'A',leadId:'A'});
  expect(note.linkEvidence.length).toBeLessThanOrEqual(2);
 });

 it('rejects nonactive, test and multi-lead deal parents before project attribution',async()=>{
  await record('deal','parent',{title:'A'});await link('deal','parent','lead','A');
  await record('note','parent-note',{content:'Only if parent resolves',update_time:'2026-10-07 10:00:00'});
  await link('note','parent-note','deal','parent');
  expect((await read(['A'])).get('A').note.id).toBe('parent-note');
  for(const lifecycle of ['deleted','merged','unresolved']){
   await db.pool.query("UPDATE sdr_crm_snapshots SET lifecycle=$1 WHERE entity='deal' AND entity_id='parent'",[lifecycle]);
   expect((await read(['A'])).get('A').note).toBeNull();
  }
  await db.pool.query("UPDATE sdr_crm_snapshots SET lifecycle='active',is_test=true,test_evidence='synthetic' WHERE entity='deal' AND entity_id='parent'");
  expect((await read(['A'])).get('A').note).toBeNull();
  await db.pool.query("UPDATE sdr_crm_snapshots SET is_test=false,test_evidence=NULL WHERE entity='deal' AND entity_id='parent'");
  await link('deal','parent','lead','B');
  expect((await read(['A','B'])).get('A').note).toBeNull();
  expect((await read(['A','B'])).get('B').note).toBeNull();
 });

 it('keeps same source ID in another company and unrelated or encoded parent URLs separate',async()=>{
  await record('note','shared-id',{content:'Company 42',update_time:'2026-10-07 10:00:00'},
   {url:'https://proswpppllc.pipedrive.com/leads/inbox/%41'});
  await link('note','shared-id','lead','A');
  await record('note','shared-id',{content:'Other company',update_time:'2026-10-07 10:00:00'},{company:'other'});
  await link('note','shared-id','lead','B','other');
  expect((await read()).get('A').note).toMatchObject({text:'Company 42',sourceUrl:'https://proswpppllc.pipedrive.com/leads/inbox/%41'});
  expect((await read()).get('B').note).toBeNull();
  await db.pool.query("UPDATE sdr_crm_snapshots SET source_url='https://proswpppllc.pipedrive.com/leads/inbox/B' WHERE company_id='42' AND entity='note' AND entity_id='shared-id'");
  expect((await read(['A'])).get('A').note.sourceUrl).toBeNull();
 });

 it('keeps historical app creation receipts from certifying the current edited note',async()=>{
  await record('note','app-id',{content:'Edited current source text',update_time:'2026-10-07 10:00:00',add_time:'2026-09-01 10:00:00'});
  await link('note','app-id','lead','A');
  await db.pool.query("INSERT INTO sdr_note_events(event_key,lead_id,evidence,content,status,provider_note_id) VALUES('historical','A','{}','Created by app','confirmed','app-id')");
  expect((await read(['A'])).get('A').note).toMatchObject({id:'app-id',originStatus:'unknown',text:'Edited current source text'});
 });

 it('rejects fallback, invalid-priority and future timestamps but preserves an old creation date',async()=>{
  await record('note','fallback',{content:'fallback'}, {updated:'2026-10-07T11:00:00Z'});await link('note','fallback','lead','A');
  await record('note','invalid',{content:'invalid',update_time:'2026-99-99 10:00:00',add_time:'2026-10-07 10:00:00'}, {updated:'2026-10-07T10:00:00Z'});await link('note','invalid','lead','A');
  await record('note','future',{content:'future',update_time:'2026-10-09 10:00:00'}, {updated:'2026-10-09T10:00:00Z'});await link('note','future','lead','A');
  await record('note','edited',{content:'Edited older note',update_time:'2026-10-07 09:00:00',add_time:'2026-01-02 03:04:05'}, {updated:'2026-10-07T09:00:00Z'});await link('note','edited','lead','A');
  const note=(await read()).get('A').note;
  expect(note).toMatchObject({id:'edited',sourceUpdatedAt:'2026-10-07T09:00:00.000Z',eventAt:'2026-01-02T03:04:05.000Z',sourceUpdatedField:'update_time'});
 });

 it('rejects unsupported raw formats and invalid calendar dates; invalid creation stays unknown',async()=>{
  const invalid=['2026-10-07T10:00:00','2026-10-07T10:00:00+00:00','2026-10-07T10:00:00.000Z','2026-02-30 10:00:00'];
  for(const [index,raw] of invalid.entries()){
   const id=`invalid-${index}`;
   await record('note',id,{content:'Invalid source time',update_time:raw},{updated:'2026-10-07T10:00:00Z'});await link('note',id,'lead','A');
  }
  expect((await read(['A'])).get('A').note).toBeNull();
  await record('note','valid-update',{content:'Unknown creation',update_time:'2026-10-07 10:00:00',add_time:'2026-02-30 09:00:00'});
  await link('note','valid-update','lead','A');
  expect((await read(['A'])).get('A').note).toMatchObject({id:'valid-update',eventAt:null});
 });

 it('breaks equal source-update and observation ties by source ID',async()=>{
  for(const id of ['tie-a','tie-z']){await record('note',id,{content:id,update_time:'2026-10-07 10:00:00'});await link('note',id,'lead','A');}
  await db.pool.query("UPDATE sdr_crm_snapshots SET observed_at='2026-10-07T10:01:00Z' WHERE entity='note' AND entity_id IN ('tie-a','tie-z')");
  expect((await read(['A'])).get('A').note.id).toBe('tie-z');
 });

 it('shows completed CRM calls without text but never infers call time or manual origin',async()=>{
  await record('activity','done-no-note',{done:true,type:'call',update_time:'2026-10-07T10:00:00Z',marked_as_done_time:'2026-10-07T09:00:00Z'});
  await link('activity','done-no-note','lead','A');
  await record('activity','planned',{done:false,type:'call',note:'planned',update_time:'2026-10-07T11:00:00Z'},{updated:'2026-10-07T11:00:00Z'});await link('activity','planned','lead','A');
  const call=(await read()).get('A').completedCall;
  expect(call).toMatchObject({id:'done-no-note',text:'',eventAt:null,originStatus:'unknown'});
 });

 it('requires configured company, current visibility and a live accessible project source',async()=>{
  await record('note','A-note',{content:'Private',update_time:'2026-10-07 10:00:00'});await link('note','A-note','lead','A');
  await db.pool.query("INSERT INTO sdr_drafts VALUES('A','00000000-0000-0000-0000-00000000000b','pending')");
  expect((await read(['A','B'],staff)).get('A')).toMatchObject({status:'unavailable',note:null});
  expect((await read(['A','B'],staff)).get('B')).toMatchObject({status:'available',note:null});
  await db.pool.query("UPDATE sdr_drafts SET assigned_user_id='00000000-0000-0000-0000-00000000000a' WHERE pipedrive_lead_id='A'");
  expect((await read(['A'],staff)).get('A').note.id).toBe('A-note');
  await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='other' WHERE pipedrive_lead_id='A'");
  expect((await read(['A'],admin)).get('A').status).toBe('unavailable');
 });

 it('bounds plain text and title before returning them to the browser',async()=>{
  await record('note','long',{content:`<p>${'x'.repeat(350)}</p><script>unsafe</script>`,update_time:'2026-10-07 10:00:00'},
   {url:'https://proswpppllc.pipedrive.com/leads/inbox/A'});await link('note','long','lead','A');
  const note=(await read(['A'])).get('A').note;
  expect(note.text).toHaveLength(301);
  expect(note.text.endsWith('…')).toBe(true);
  expect(note.textTruncated).toBe(true);
  expect(note.text).not.toContain('<');
 });
});
