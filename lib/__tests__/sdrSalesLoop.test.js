import {describe,it,expect} from 'vitest';
let salesLoop={};
try{salesLoop=await import('../sdrSalesLoop.js');}catch{}

const context={lead:{id:'A',title:'Library',ownerId:'7',personId:'12',contactName:'Pat',contactEmail:'pat@example.test'},tasks:[{id:'task-1',subject:'Call buyer',ownerId:'7',dueDate:'2026-10-11'}],coverage:{partial:true,quoteStatus:'unknown',orderStatus:'unknown',emailStatus:'unavailable'}};

describe('opportunity evidence projection',()=>{
 it('keeps the original task and owner as next action and all commercial stages unknown without exact evidence',()=>{
  expect(salesLoop.projectSalesOpportunity).toBeTypeOf('function');
  const result=salesLoop.projectSalesOpportunity({companyId:'42',context,source:{kind:'tracker_row',id:'export-1:2',url:'https://app.buildingconnected.com/opportunities/opp-17'},publication:null,outcomes:[]});
  expect(result).toMatchObject({leadId:'A',owner:{id:'7'},nextAction:{taskId:'task-1',ownerId:'7',dueDate:'2026-10-11'},coverage:'partial',quote:{requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'},order:{status:'unknown'},handoff:{publication:'private',delivery:'unknown',awareness:'unknown',action:'unknown'}});
 });
 it('treats confirmed note publication as publication alone and retains unknown awareness',()=>{
  const result=salesLoop.projectSalesOpportunity({companyId:'42',context,source:null,publication:{companyId:'42',leadId:'A',status:'confirmed',noteId:'note-9',readbackVerified:true},outcomes:[]});
  expect(result.handoff).toMatchObject({publication:'confirmed',noteId:'note-9',delivery:'unknown',awareness:'unknown',action:'unknown'});
 });
 it('retains uncertain publication and does not promote an observed outgoing reply to human authorship',()=>{
  const result=salesLoop.projectSalesOpportunity({companyId:'42',context,source:null,publication:{companyId:'42',leadId:'A',status:'uncertain',noteId:null},outcomes:[{kind:'outgoing_reply',companyId:'42',leadId:'A',providerMessageId:'m-9',source:'connected_gmail',linkage:'direct_unique',authorship:'unknown'}]});
  expect(result.handoff.publication).toBe('uncertain');
  expect(result.outgoing).toMatchObject({status:'observed',source:'connected_gmail',authorship:'unknown',providerMessageId:'m-9'});
  expect(result.quote.sent).toBe('unknown');
 });
 it('withholds wrong-company and wrong-lead outcomes, publication and action receipts',()=>{
  const result=salesLoop.projectSalesOpportunity({companyId:'42',context:{...context,coverage:{}},publication:{companyId:'other',leadId:'A',status:'confirmed',noteId:'note-9',readbackVerified:true},outcomes:[
   {kind:'outgoing_reply',companyId:'other',leadId:'A',providerMessageId:'m-9',source:'connected_gmail',linkage:'direct_unique'},
   {kind:'quote',stage:'sent',companyId:'42',leadId:'B',sourceId:'q-1',verified:true},
   {kind:'order',companyId:'42',leadId:'B',sourceId:'o-1',verified:true},
   {kind:'original_task_action',companyId:'other',leadId:'A',taskId:'task-1',sourceId:'a-1',verified:true}
  ]});
  expect(result.coverage).toBe('partial');expect(result.outgoing.status).toBe('unknown');expect(result.quote.sent).toBe('unknown');expect(result.order.status).toBe('unknown');expect(result.handoff).toMatchObject({publication:'private',awareness:'unknown',action:'unknown'});
 });
});
