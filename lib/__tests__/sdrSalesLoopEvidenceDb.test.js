import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import * as evidence from '../sdrSalesLoopObservations.js';
const db=reportingTestDb('sales_loop_evidence');
const base={companyId:'42',leadId:'A',viewer:{role:'sdr',sub:'user'},current:{context:{lead:{personId:'12',ownerId:'7'},records:[],holds:[]}}};
(db?describe:describe.skip)('cached exact project evidence',()=>{
 beforeAll(async()=>{await db.setup();for(const file of ['2026-10-05-sdr-crm-observations.sql','2026-10-03-sdr-conversation-history.sql','2026-10-07-sdr-conversation-sync.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  for(const [id,company,done,links] of [['completed','42',true,['A']],['open','42',false,['A']],['ambiguous','42',true,['A','B']],['foreign','other',true,['A']]]){
   await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES($1,'activity',$2,$3)",[company,id,{done,owner_id:7,type:'call',subject:'Review existing quote',note:'Staff recorded contact',due_date:'2026-10-09'}]);
   for(const link of links)await db.pool.query("INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES($1,'activity',$2,'lead',$3,'fixture')",[company,id,link]);
  }
  for(const [id,provider,account,to] of [['buyer-out','gmail','seller@example.test','buyer@example.test'],['internal-out','gmail','seller@example.test','seller@internal.test'],['pipedrive-out','pipedrive','staff@internal.test','buyer@example.test']])await db.pool.query(`INSERT INTO sdr_conversation_messages(provider,account_key,provider_message_id,provider_thread_id,person_id,pipedrive_lead_id,direction,from_address,to_addresses,link_evidence,source_evidence)
   VALUES($1,$2,$3,'thread','12','A','out',$2,$4,'pipedrive:lead_id',$5)`,[provider,account,id,JSON.stringify([to]),JSON.stringify([{leadId:'A'}])]);
 });
 afterAll(async()=>db.close());
 it('keeps completed and open direct activities with no mailbox access; excludes ambiguous and wrong-company records',async()=>{
  expect(evidence.readSalesLoopEvidence).toBeTypeOf('function');
  const result=await evidence.readSalesLoopEvidence(db.pool,base);
  expect(result.activities.map(a=>[a.id,a.status]).sort()).toEqual([['completed','recorded_complete'],['open','open']]);
  expect(result.activities.every(a=>a.performed==='unknown')).toBe(true);
  expect(result.messages).toEqual([]);expect(result.coverage.pipedriveMail).toBe('unavailable');
 });
 it('exposes only authorized exact-linked metadata and never promotes outgoing metadata to customer reply proof',async()=>{
  expect(evidence.readSalesLoopEvidence).toBeTypeOf('function');
  const result=await evidence.readSalesLoopEvidence(db.pool,{...base,resolveVisibleMailboxes:async()=>[{email:'seller@example.test',connected:true}]});
  expect(result.messages.map(m=>m.id).sort()).toEqual(['buyer-out','internal-out']);
  expect(result.messages.every(m=>m.customerReply==='unverified'&&m.body===undefined)).toBe(true);
  const admin=await evidence.readSalesLoopEvidence(db.pool,{...base,viewer:{...base.viewer,role:'admin'}});
  expect(admin.messages.map(m=>m.id)).toEqual(['pipedrive-out']);expect(admin.coverage.pipedriveMail).toBe('partial');
 });
});
