import {describe,it,expect} from 'vitest';
let stageInvitationBatch;
try{({stageInvitationBatch}=await import('../sdrInvitationIntake.js'));}catch{}

const header='Company,Contact Name,Primary Email,Project Title,Quick Link,Bid Date';
const link='https://app.buildingconnected.com/opportunities/opp-17';
const csv=(...rows)=>[header,...rows].join('\n');
const base={batchId:'export-1',observedAt:'2026-10-10T12:00:00Z',priorReceipt:null,crmCandidates:[]};

describe('read-only invitation staging',()=>{
 it('exposes a pure staging function',()=>expect(stageInvitationBatch).toBeTypeOf('function'));
 it('retains source identity, separate bidder and project, date-only bid date, and unknown commercial facts',()=>{
  const result=stageInvitationBatch({...base,csvText:csv(`Builder A,Pat,pat@example.test,Library,${link},2026-10-21`)});
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({source:'BuildingConnected',sourceUrl:link,projectTitle:'Library',bidder:'Builder A',bidDate:'2026-10-21',status:'unknown',match:{status:'unresolved'}});
  expect(result.candidates[0].proposalDeadline).toBeNull();
  expect(result.candidates[0].quote).toMatchObject({requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'});
  expect(result.candidates[0].order).toMatchObject({status:'unknown'});
 });
 it('uses a serialized prior receipt across separate invocations without duplicating an invitation',()=>{
  const first=stageInvitationBatch({...base,csvText:csv(`Builder A,Pat,pat@example.test,Library,${link},2026-10-21`)});
  const second=stageInvitationBatch({...base,batchId:'export-2',priorReceipt:JSON.parse(JSON.stringify(first.receipt)),csvText:csv(`Builder A,Pat,pat@example.test,Library,${link},2026-10-21`)});
  expect(second.candidates).toHaveLength(1);
  expect(second.receipt.candidates).toHaveLength(1);
  expect(second.candidates[0].sourceRows).toHaveLength(2);
  expect(second.candidates[0].match.status).toBe('unresolved');
 });
 it('holds conflicting same-URL evidence and never links by title or email alone',()=>{
  const first=stageInvitationBatch({...base,csvText:csv(`Builder A,Pat,pat@example.test,Library,${link},2026-10-21`)});
  const second=stageInvitationBatch({...base,batchId:'export-2',priorReceipt:first.receipt,crmCandidates:[{leadId:'lead-1',title:'Library',email:'pat@example.test'}],csvText:csv(`Builder B,Pat,pat@example.test,Other project,${link},2026-10-21`)});
  expect(second.candidates).toHaveLength(1);
  expect(second.candidates[0].match).toMatchObject({status:'unresolved',reason:'source_conflict'});
  expect(second.candidates[0].match.leadId).toBeUndefined();
 });
 it('preserves closed and submitted evidence as separate non-open states',()=>{
  const result=stageInvitationBatch({...base,rows:[{sourceRowId:'closed',projectTitle:'Library',bidder:'Builder A',sourceUrl:link,status:'closed',statusSource:{kind:'reviewed',id:'review-1'}},{sourceRowId:'submitted',projectTitle:'School',bidder:'Builder B',sourceUrl:'https://app.buildingconnected.com/opportunities/opp-18',status:'submitted',statusSource:{kind:'reviewed',id:'review-2'}}]});
  expect(result.candidates.map(c=>c.status)).toEqual(['closed','submitted']);
  expect(result.candidates.every(c=>c.match.status==='unresolved')).toBe(true);
 });
});
