import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {storeSalesHistory} from '../pipedriveSalesHistory.js';
import {observeOutbound,syncDealFacts} from '../sdrReportingIngest.js';

const db=reportingTestDb('sales_attribution');
const deal=(id,extra={})=>({id,title:'Real project',currency:'USD',value:2500,status:'won',won_time:'2026-09-10T15:00:00Z',...extra});
const snapshot=deals=>({deals,checkedAt:'2026-10-15T20:00:00Z',counts:{history_complete:true,company_scope_accepted:true,includes_archived:true}});
const touch=(id,leadId,sourceKey='cmd',extra={})=>observeOutbound(db.pool,{
 id,from_email:'rep@example.test',to_email:'builder@example.test',status:'completed',completed_at:'2026-09-01T15:00:00Z',...extra
},{leadLink:{status:'verified',leadId,sourceKey,evidence:`message:${id}`},outreachClassification:'sales_outreach',classificationEvidence:`apollo:${id}`});
const facts=async()=> (await db.pool.query('SELECT pipedrive_deal_id,pipedrive_lead_id,link_status,link_evidence,source FROM sdr_deal_facts ORDER BY pipedrive_deal_id')).rows;

describe.skipIf(!db)('sales history project attribution',()=>{
 beforeAll(async()=>{
  await db.setup();
  for(const file of ['2026-10-02-sdr-reporting.sql','2026-10-04-sdr-metric-evidence.sql','2026-10-05-sdr-test-exclusions.sql'])await db.pool.query(await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
 });
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_deal_facts,sdr_message_facts,sdr_job_runs');});
 it('preserves an explicit conversion and derives its source only from that project',async()=>{
  await touch('m1','lead-a');await touch('m2','lead-other','agc');
  await storeSalesHistory(db.pool,snapshot([deal(1,{source_lead_id:'lead-a'})]));
  expect(await facts()).toEqual([{pipedrive_deal_id:'1',pipedrive_lead_id:'lead-a',link_status:'verified',link_evidence:'pipedrive:deal:1:source_lead_id:lead-a',source:'cmd'}]);
 });
 it('retains a conversion without claiming an outreach source when no prior project send exists',async()=>{
  await touch('future','lead-a','cmd',{completed_at:'2026-09-11T15:00:00Z'});
  await storeSalesHistory(db.pool,snapshot([deal(1,{source_lead_id:'lead-a'}),deal(2,{source_lead_id:'never-contacted'})]));
  expect((await facts()).map(r=>[r.pipedrive_lead_id,r.link_status,r.source])).toEqual([['lead-a','verified','unknown'],['never-contacted','verified','unknown']]);
 });
 it('never attributes a deal from a shared contact, title or organization',async()=>{
  await touch('m1','lead-a');
  await storeSalesHistory(db.pool,snapshot([deal(1,{person_id:42,org_id:12}),deal(2,{source_lead_id:{id:'lead-a'}})]));
  expect((await facts()).map(r=>[r.pipedrive_lead_id,r.link_status])).toEqual([[null,'unmatched'],[null,'unmatched']]);
 });
 it('withholds conflicting sources and ignores test and incomplete messages',async()=>{
  await touch('a','mixed','cmd');await touch('b','mixed','agc');
  await touch('test','only-test','cmd',{subject:'[TEST] fixture'});
  await touch('failed','only-failed','cmd',{status:'failed'});
  await storeSalesHistory(db.pool,snapshot(['mixed','only-test','only-failed'].map((id,i)=>deal(i+1,{source_lead_id:id}))));
  expect((await facts()).map(r=>r.source)).toEqual(['unknown','unknown','unknown']);
 });
 it('upgrades a source on later collection while preserving existing reviewed links and one row per deal',async()=>{
  await storeSalesHistory(db.pool,snapshot([deal(1,{source_lead_id:'lead-a'})]));
  await syncDealFacts(db.pool,[deal(2,{leadLink:{status:'verified',leadId:'reviewed',sourceKey:'agc',evidence:'review:owner'}})]);
  await touch('m1','lead-a');
  const s=snapshot([deal(1,{source_lead_id:'lead-a'}),deal(2,{source_lead_id:'different'})]);
  await storeSalesHistory(db.pool,s);await storeSalesHistory(db.pool,s);
  expect((await facts()).map(r=>[r.pipedrive_lead_id,r.source,r.link_evidence])).toEqual([
   ['lead-a','cmd','pipedrive:deal:1:source_lead_id:lead-a'],['reviewed','agc','review:owner']]);
 });
 it('withdraws an automatic source when later evidence conflicts, while preserving a reviewed source on the same lead',async()=>{
  await touch('m1','lead-a');
  await syncDealFacts(db.pool,[deal(2,{leadLink:{status:'verified',leadId:'lead-a',sourceKey:'cmd',evidence:'review:owner'}})]);
  const s=snapshot([deal(1,{source_lead_id:'lead-a'}),deal(2,{source_lead_id:'lead-a'})]);
  await storeSalesHistory(db.pool,s);await touch('m2','lead-a','agc');await storeSalesHistory(db.pool,s);
  expect((await facts()).map(r=>r.source)).toEqual(['unknown','cmd']);
 });
 it('withholds attribution for held sale dates and messages after a reconstructed sale date',async()=>{
  await touch('m1','lead-a');
  const s=snapshot([deal(1,{source_lead_id:'lead-a'}),deal(2,{source_lead_id:'lead-a'})]);
  s.counts.date_reviews=[{id:'1',provider_won_at:'2026-09-10T15:00:00Z',reason:'bulk_status_change'}];
  s.counts.date_adjustments=[{id:'2',provider_won_at:'2026-09-10T15:00:00Z',sales_at:'2026-08-01T15:00:00Z'}];
  await storeSalesHistory(db.pool,s);
  expect((await facts()).map(r=>r.source)).toEqual(['unknown','unknown']);
 });
 it('requires evidenced sales outreach before assigning a source',async()=>{
  await observeOutbound(db.pool,{id:'auto',from_email:'rep@example.test',to_email:'builder@example.test',status:'completed',completed_at:'2026-09-01T15:00:00Z'},
   {leadLink:{status:'verified',leadId:'lead-a',sourceKey:'cmd',evidence:'message:auto'},outreachClassification:'automatic',classificationEvidence:'auto'});
  await storeSalesHistory(db.pool,snapshot([deal(1,{source_lead_id:'lead-a'})]));
  expect((await facts())[0].source).toBe('unknown');
 });
 it('refreshes or removes only its own provider conversion when the complete CRM snapshot changes',async()=>{
  await touch('m1','lead-a');await touch('m2','lead-b','agc');
  await storeSalesHistory(db.pool,snapshot([deal(1,{source_lead_id:'lead-a'})]));
  await storeSalesHistory(db.pool,snapshot([deal(1,{source_lead_id:'lead-b'})]));
  expect((await facts())[0]).toMatchObject({pipedrive_lead_id:'lead-b',source:'agc',link_evidence:'pipedrive:deal:1:source_lead_id:lead-b'});
  await storeSalesHistory(db.pool,snapshot([deal(1,{source_lead_id:null})]));
  expect((await facts())[0]).toMatchObject({pipedrive_lead_id:null,source:'unknown',link_status:'unmatched',link_evidence:null});
 });
});
