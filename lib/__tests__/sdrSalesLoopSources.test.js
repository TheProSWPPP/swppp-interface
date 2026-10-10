import {describe,it,expect,vi} from 'vitest';
import {stageInvitationBatch} from '../sdrInvitationIntake.js';
import {createStagedInvitationReader,readAuthorizedSalesSource} from '../sdrSalesLoopSources.js';

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
});
