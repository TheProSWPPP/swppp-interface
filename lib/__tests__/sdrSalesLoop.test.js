import {describe,it,expect} from 'vitest';
let salesLoop={};
try{salesLoop=await import('../sdrSalesLoop.js');}catch{}

const context={lead:{id:'A',title:'Library',ownerId:'7',personId:'12',contactName:'Pat',contactEmail:'pat@example.test'},tasks:[{id:'task-1',subject:'Call buyer',ownerId:'7',dueDate:'2026-10-11'}],coverage:{partial:true,quoteStatus:'unknown',orderStatus:'unknown',emailStatus:'unavailable'}};

describe('opportunity evidence projection',()=>{
 it('keeps the original task and owner as next action and all commercial stages unknown without exact evidence',()=>{
  expect(salesLoop.projectSalesOpportunity).toBeTypeOf('function');
  const result=salesLoop.projectSalesOpportunity({context,source:{kind:'tracker_row',id:'export-1:2',url:'https://app.buildingconnected.com/opportunities/opp-17'},publication:null,outcomes:[]});
  expect(result).toMatchObject({leadId:'A',owner:{id:'7'},nextAction:{taskId:'task-1',ownerId:'7',dueDate:'2026-10-11'},coverage:'partial',quote:{requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'},order:{status:'unknown'},handoff:{publication:'private',delivery:'unknown',awareness:'unknown',action:'unknown'}});
 });
 it('treats confirmed note publication as publication alone and retains unknown awareness',()=>{
  const result=salesLoop.projectSalesOpportunity({context,source:null,publication:{status:'confirmed',noteId:'note-9',readbackVerified:true},outcomes:[]});
  expect(result.handoff).toMatchObject({publication:'confirmed',noteId:'note-9',delivery:'unknown',awareness:'unknown',action:'unknown'});
 });
 it('retains uncertain publication and does not promote an observed outgoing reply to human authorship',()=>{
  const result=salesLoop.projectSalesOpportunity({context,source:null,publication:{status:'uncertain',noteId:null},outcomes:[{kind:'outgoing_reply',providerMessageId:'m-9',source:'connected_gmail',authorship:'unknown'}]});
  expect(result.handoff.publication).toBe('uncertain');
  expect(result.outgoing).toMatchObject({status:'observed',source:'connected_gmail',authorship:'unknown',providerMessageId:'m-9'});
  expect(result.quote.sent).toBe('unknown');
 });
});
