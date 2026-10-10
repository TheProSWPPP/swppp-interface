import {describe,it,expect,vi} from 'vitest';
import {prepareProposal} from '../sdrSalesLoop.js';
import {stageInvitationBatch} from '../sdrInvitationIntake.js';
import {createStagedInvitationReader} from '../sdrSalesLoopSources.js';

const viewer={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};
const sourceRef={kind:'crm_note',id:'note-1'};
const current={draft:{revision:2},contextToken:'a'.repeat(64),context:{lead:{ownerId:'7',personId:'12'}}};
const source={identity:'crm_note:note-1',text:'Buyer asks for the bid form by October 21.',leadId:'A',companyId:'42',linkage:'direct_unique',provenance:{kind:'crm_note',id:'note-1'},mailboxAuthorization:'not_applicable'};
const input=()=>({pool:{},companyId:'42',leadId:'A',viewer,sourceRef,editorRequestVersion:3,readDraft:vi.fn(async()=>current),readSource:vi.fn(async()=>source),readUnresolved:vi.fn(async()=>false),generate:vi.fn(async()=>({subject:'Bid form',body:'I can send the bid form for your review.',missingFacts:['quote amount']}))});

describe('source-bound private proposal',()=>{
 it('returns a bounded editable proposal with source provenance and no publication',async()=>{
  const args=input();const result=await prepareProposal(args);
  expect(result).toMatchObject({subject:'Bid form',body:'I can send the bid form for your review.',source:{identity:'crm_note:note-1',provenance:{kind:'crm_note',id:'note-1'}},missingFacts:['quote amount'],editorRequestVersion:3,revision:2});
  expect(result.publication).toBeUndefined();
  expect(args.readSource).toHaveBeenCalledTimes(2);
 });
 it('rejects a changed source body after generation even if CRM context token stays the same',async()=>{
  const args=input();args.readSource=vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce({...source,text:'Different buyer instruction'});
  await expect(prepareProposal(args)).rejects.toMatchObject({code:'source_changed'});
 });
 it('rejects a changed saved draft revision or CRM task context after generation',async()=>{
  const args=input();args.readDraft=vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce({...current,draft:{revision:3}});
  await expect(prepareProposal(args)).rejects.toMatchObject({code:'context_changed'});
 });
 it('withholds proposal when exact source linkage is absent or the mailbox is invisible',async()=>{
  for(const patch of [{linkage:'ambiguous'},{mailboxAuthorization:'denied'},{leadId:'B'},{companyId:'other'}]){
   const args=input();args.readSource=vi.fn(async()=>({...source,...patch}));
   await expect(prepareProposal(args)).rejects.toMatchObject({code:'source_unavailable'});
   expect(args.generate).not.toHaveBeenCalled();
  }
 });
 it('withholds generation when the private draft already has changed CRM context',async()=>{
  const args=input();args.readDraft=vi.fn(async()=>({...current,contextChanged:true}));
  await expect(prepareProposal(args)).rejects.toMatchObject({code:'context_changed'});expect(args.generate).not.toHaveBeenCalled();
 });
 it('blocks unresolved publication before generation and if it appears while the model is pending',async()=>{
  const before=input();before.readUnresolved=vi.fn(async()=>true);
  await expect(prepareProposal(before)).rejects.toMatchObject({code:'publication_unresolved'});expect(before.generate).not.toHaveBeenCalled();
  const late=input();late.readUnresolved=vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await expect(prepareProposal(late)).rejects.toMatchObject({code:'publication_unresolved'});
 });
 it('rechecks authorization, owner/task context, revision and handoff after the second async source read',async()=>{
  for(const mode of ['deactivated','context','revision','handoff']){
   const args=input();
   let reads=0;
   args.readSource=vi.fn(async()=>{if(++reads===2)mode==='handoff'?handoff=true:changed=true;return source;});
   let changed=false,handoff=false,draftReads=0;
   args.readDraft=vi.fn(async()=>{
    draftReads++;
    if(changed&&mode==='deactivated')throw Object.assign(new Error('session_required'),{code:'session_required'});
    if(changed&&mode==='context')return {...current,contextToken:'b'.repeat(64)};
    if(changed&&mode==='revision')return {...current,draft:{revision:3}};
    return current;
   });
   args.readUnresolved=vi.fn(async()=>handoff);
   await expect(prepareProposal(args)).rejects.toMatchObject({code:mode==='handoff'?'publication_unresolved':mode==='deactivated'?'session_required':'context_changed'});
   expect(draftReads).toBeGreaterThanOrEqual(3);
  }
 });
 it('withholds terminal tracker evidence in either arrival order and same-time contradiction',async()=>{
  const url='https://app.buildingconnected.com/opportunities/opp-17';
  const crmCandidates=[{companyId:'42',leadId:'A',sourceUrl:url,lifecycle:'active',accessStatus:'accessible'}];
  const row=status=>({sourceRowId:'2',projectTitle:'Library',bidder:'Builder A',sourceUrl:url,status,statusSource:status==='unknown'?null:{kind:'reviewed',id:status}});
  for(const [firstStatus,firstAt,secondStatus,secondAt] of [
   ['unknown','2026-10-10T12:00:00Z','closed','2026-09-01T12:00:00Z'],
   ['closed','2026-09-01T12:00:00Z','unknown','2026-10-10T12:00:00Z'],
   ['closed','2026-10-10T12:00:00Z','submitted','2026-10-10T12:00:00Z']
  ]){
   const first=stageInvitationBatch({batchId:'first',observedAt:firstAt,rows:[row(firstStatus)],crmCandidates});
   const second=stageInvitationBatch({batchId:'second',observedAt:secondAt,rows:[row(secondStatus)],crmCandidates,priorReceipt:JSON.parse(JSON.stringify(first.receipt))});
   const args=input();
   args.sourceRef=second.candidates[0].sourceRef;
   args.readSource=createStagedInvitationReader({receipt:second.receipt,readExactCrmMatch:async()=>({verified:true,companyId:'42',leadId:'A',sourceUrl:url})});
   await expect(prepareProposal(args)).rejects.toMatchObject({code:'source_unavailable'});
   expect(args.generate).not.toHaveBeenCalled();
  }
 });
});
