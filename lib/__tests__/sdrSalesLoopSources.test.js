import {describe,it,expect,vi} from 'vitest';
import {stageInvitationBatch} from '../sdrInvitationIntake.js';
import {createStagedInvitationReader,readAuthorizedSalesSource,readExactStagedCrmMatch} from '../sdrSalesLoopSources.js';

const viewer={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};
const base={companyId:'42',leadId:'A',viewer,current:{context:{lead:{personId:'12'}}}};
const link='https://app.buildingconnected.com/opportunities/opp-17';

describe('selected source authorization',()=>{
 it('passes actual staged receipt through exact independently rechecked CRM linkage',async()=>{
  const stage=stageInvitationBatch({batchId:'export-1',observedAt:'2026-10-10T12:00:00Z',csvText:`Company,Contact Name,Primary Email,Project Title,Quick Link,Bid Date\nBuilder A,Pat,pat@example.test,Library,${link},2026-10-21`,crmCandidates:[{companyId:'42',leadId:'A',sourceUrl:link,lifecycle:'active',accessStatus:'accessible'}]});
  const readExactCrmMatch=vi.fn(async()=>({verified:true,companyId:'42',leadId:'A',sourceUrl:link}));
  const readSource=createStagedInvitationReader({receipt:JSON.parse(JSON.stringify(stage.receipt)),readExactCrmMatch});
  const result=await readSource({...base,sourceRef:stage.candidates[0].sourceRef});
  expect(result).toMatchObject({companyId:'42',leadId:'A',linkage:'direct_unique',provenance:{kind:'staged_invitation',key:`url:${link}`}});
  expect(result.text).toContain('Library');expect(readExactCrmMatch).toHaveBeenCalledTimes(1);
 });
 it('rejects forged staged lead claims, changed receipt and CRM mismatch',async()=>{
  const stage=stageInvitationBatch({batchId:'export-1',observedAt:'2026-10-10T12:00:00Z',rows:[{sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:link}]});
  const reader=createStagedInvitationReader({receipt:stage.receipt,readExactCrmMatch:async()=>({verified:true,companyId:'42',leadId:'B',sourceUrl:link})});
  await expect(reader({...base,sourceRef:{...stage.candidates[0].sourceRef,match:{status:'exact',leadId:'A'}}})).rejects.toMatchObject({code:'source_unavailable'});
  await expect(reader({...base,sourceRef:stage.candidates[0].sourceRef})).rejects.toMatchObject({code:'source_unavailable'});
  const tampered=structuredClone(stage.receipt);tampered.candidates[0].projectTitle='Other';
  const tamperedReader=createStagedInvitationReader({receipt:tampered,readExactCrmMatch:async()=>({verified:true,companyId:'42',leadId:'A',sourceUrl:link})});
  await expect(tamperedReader({...base,sourceRef:stage.candidates[0].sourceRef})).rejects.toMatchObject({code:'source_unavailable'});
 });
 it('withholds a CRM note when the source is linked to another lead or ambiguous',async()=>{
  const pool={query:vi.fn(async()=>({rows:[]}))};
  await expect(readAuthorizedSalesSource(pool,{...base,sourceRef:{kind:'crm_note',id:'n'}})).rejects.toMatchObject({code:'source_unavailable'});
 });
 it('does not infer staged linkage from title or email when exact CRM source URL is absent',async()=>{
  const pool={query:vi.fn(async()=>({rows:[]}))};
  expect(await readExactStagedCrmMatch(pool,{...base,sourceUrl:link})).toEqual({verified:false});
 });
 it('rejects a provider message relinked while its authorized body was being read',async()=>{
  let sourceReads=0;
  const pool={query:vi.fn(async sql=>String(sql).includes('SELECT provider_thread_id,person_id')?{rows:[{provider_thread_id:'thread-1',person_id:'12',pipedrive_lead_id:++sourceReads===1?'A':'B',pipedrive_deal_id:null,link_evidence:'pipedrive:lead_id',source_evidence:[{leadId:'A'}]}]}:{rows:[{provider_thread_id:'thread-1'}]})};
  const gmail={getThread:vi.fn(async()=>({messages:[{id:'m-1',body:'Buyer asks for quote'}]}))};
  await expect(readAuthorizedSalesSource(pool,{...base,sourceRef:{kind:'gmail_message',provider:'gmail',account:'rep@example.test',id:'m-1',threadId:'thread-1'},resolveVisibleMailboxes:async()=>['rep@example.test'],getGmailToken:async()=> 'synthetic-token',gmail})).rejects.toMatchObject({code:'source_unavailable'});
 });
 it('blocks an invisible Gmail mailbox and a staff Pipedrive mailbox before provider reads',async()=>{
  const row={provider_thread_id:'thread-1',person_id:'12',pipedrive_lead_id:'A',pipedrive_deal_id:null,link_evidence:'pipedrive:lead_id',source_evidence:[{leadId:'A'}]};
  const pool={query:vi.fn(async()=>({rows:[row]}))},gmail={getThread:vi.fn()};
  await expect(readAuthorizedSalesSource(pool,{...base,sourceRef:{kind:'gmail_message',provider:'gmail',account:'hidden@example.test',id:'m-1',threadId:'thread-1'},resolveVisibleMailboxes:async()=>['visible@example.test'],gmail})).rejects.toMatchObject({code:'source_unavailable'});
  await expect(readAuthorizedSalesSource(pool,{...base,sourceRef:{kind:'pipedrive_message',provider:'pipedrive',account:'account-1',id:'m-1',threadId:'thread-1'},pipedrive:{getMailMessage:vi.fn()}})).rejects.toMatchObject({code:'source_unavailable'});
  expect(gmail.getThread).not.toHaveBeenCalled();
 });
 it('refuses metadata with an arbitrary linkage label or no exact source observation',async()=>{
  const baseRow={provider_thread_id:'thread-1',person_id:'12',pipedrive_lead_id:'A',pipedrive_deal_id:null,link_evidence:'claimed',source_evidence:[{leadId:'A'}]};
  const pool={query:vi.fn(async()=>({rows:[baseRow]}))},gmail={getThread:vi.fn()};
  const input={...base,sourceRef:{kind:'gmail_message',provider:'gmail',account:'rep@example.test',id:'m-1',threadId:'thread-1'},resolveVisibleMailboxes:async()=>['rep@example.test'],gmail};
  await expect(readAuthorizedSalesSource(pool,input)).rejects.toMatchObject({code:'source_unavailable'});
  baseRow.link_evidence='pipedrive:lead_id';baseRow.source_evidence=[];
  await expect(readAuthorizedSalesSource(pool,input)).rejects.toMatchObject({code:'source_unavailable'});
  expect(gmail.getThread).not.toHaveBeenCalled();
 });
});
