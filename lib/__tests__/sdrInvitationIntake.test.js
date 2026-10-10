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
 it('does not let an older submitted export regress a newer closed observation',()=>{
  const initial=stageInvitationBatch({...base,rows:[{sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:link,status:'closed',statusSource:{kind:'reviewed',id:'closed-1'}}]});
  const repeated=stageInvitationBatch({...base,batchId:'older-export',observedAt:'2026-09-01T12:00:00Z',priorReceipt:initial.receipt,rows:[{sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:link,status:'submitted',statusSource:{kind:'reviewed',id:'submitted-old'}}]});
  expect(repeated.candidates[0]).toMatchObject({status:'closed',observedAt:base.observedAt,statusObservedAt:base.observedAt,staleStatusEvidence:true,conflict:false,statusEvidence:[{status:'closed'},{status:'submitted'}]});
 });
 it('holds contradictory terminal status evidence at the same source time',()=>{
  const initial=stageInvitationBatch({...base,rows:[{sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:link,status:'closed',statusSource:{kind:'reviewed',id:'closed-1'}}]});
  const repeated=stageInvitationBatch({...base,batchId:'conflict-export',priorReceipt:initial.receipt,rows:[{sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:link,status:'submitted',statusSource:{kind:'reviewed',id:'submitted-2'}}]});
  expect(repeated.candidates[0]).toMatchObject({status:'unknown',statusObservedAt:null,conflict:true,match:{status:'unresolved',reason:'status_conflict'},statusEvidence:[{status:'closed'},{status:'submitted'}]});
 });
 it('keeps last explicit status time separate from a newer unknown export observation',()=>{
  const initial=stageInvitationBatch({...base,rows:[{sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:link,status:'closed',statusSource:{kind:'reviewed',id:'closed-1'}}]});
  const repeated=stageInvitationBatch({...base,batchId:'unknown-export',observedAt:'2026-10-11T12:00:00Z',priorReceipt:initial.receipt,rows:[{sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:link,status:'unknown'}]});
  expect(repeated.candidates[0]).toMatchObject({status:'closed',observedAt:'2026-10-11T12:00:00Z',statusObservedAt:base.observedAt,statusEvidence:[{status:'closed'}]});
 });
 it('rejects an altered prior receipt instead of blessing a forged exact match on the next batch',()=>{
  const first=stageInvitationBatch({...base,csvText:csv(`Builder A,Pat,pat@example.test,Library,${link},2026-10-21`)});
  const forged=structuredClone(first.receipt);forged.candidates[0].match={status:'exact',companyId:'42',leadId:'A',sourceUrl:link};
  expect(()=>stageInvitationBatch({...base,batchId:'export-2',priorReceipt:forged,csvText:csv(`Builder A,Pat,pat@example.test,Library,${link},2026-10-21`)})).toThrow('invalid_receipt');
 });
 it('keeps an authorized invitation message reference and date-only deadline without treating metadata as body',()=>{
  const result=stageInvitationBatch({...base,rows:[{sourceRowId:'email-1',projectTitle:'Pump station',bidder:'Builder A',sourceUrl:link,proposalDeadline:'2026-10-23',bidDeadline:'2026-10-26'}],authorizedMessages:[{batchId:'export-1',sourceRowId:'email-1',sourceUrl:link,mailbox:'rep@example.test',provider:'gmail',providerMessageId:'m-1',threadId:'t-1',authorized:true,uniqueLink:true}]});
  expect(result.candidates[0]).toMatchObject({proposalDeadline:'2026-10-23',bidDeadline:'2026-10-26',invitationMessage:{provider:'gmail',mailbox:'rep@example.test',providerMessageId:'m-1',threadId:'t-1',bodyStatus:'unread'}});
  expect(JSON.stringify(result.candidates[0].invitationMessage)).not.toContain('bodyText');
 });
 it('carries an exact existing CRM task as a read-only next action while keeping bid state unknown',()=>{
  const result=stageInvitationBatch({...base,csvText:csv(`Builder A,Pat,pat@example.test,Library,${link},2026-10-21`),crmCandidates:[{companyId:'42',leadId:'A',sourceUrl:link,lifecycle:'active',accessStatus:'accessible',nextAction:{taskId:'task-1',ownerId:'7',dueDate:'2026-10-11'}}]});
  expect(result.candidates[0]).toMatchObject({match:{status:'exact',leadId:'A'},nextExistingAction:{taskId:'task-1',ownerId:'7',dueDate:'2026-10-11'},status:'unknown'});
 });
 it('holds missing URL/contact/start and a saved sent-reply claim with unresolved project',()=>{
  const missing=stageInvitationBatch({...base,rows:[{sourceRowId:'missing',projectTitle:'School',bidder:'Builder B'}]});
  expect(missing.candidates[0]).toMatchObject({sourceUrl:null,contactName:null,contactEmail:null,constructionStart:null,match:{status:'unresolved',reason:'missing_source_url'}});
  const rfp=stageInvitationBatch({...base,rows:[{sourceRowId:'rfp',projectTitle:'Other school',bidder:'Builder C',sourceUrl:link,sourceReply:{providerMessageId:'sent-1',claim:'quote attached'}}],crmCandidates:[{leadId:'A',title:'Other school',email:'rep@example.test'}]});
  expect(rfp.candidates[0]).toMatchObject({match:{status:'unresolved'},quote:{sent:'unknown'},order:{status:'unknown'}});
 });
});
