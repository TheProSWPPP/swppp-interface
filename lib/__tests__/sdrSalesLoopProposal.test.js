import {describe,it,expect,vi} from 'vitest';
import {prepareProposal} from '../sdrSalesLoop.js';

const viewer={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};
const sourceRef={kind:'crm_note',id:'note-1'};
const current={draft:{revision:2},contextToken:'a'.repeat(64),context:{lead:{ownerId:'7',personId:'12'}}};
const source={identity:'crm_note:note-1',text:'Buyer asks for the bid form by October 21.',leadId:'A',companyId:'42',linkage:'direct_unique',provenance:{kind:'crm_note',id:'note-1'},mailboxAuthorization:'not_applicable'};
const input=()=>({pool:{},companyId:'42',leadId:'A',viewer,sourceRef,editorRequestVersion:3,readDraft:vi.fn(async()=>current),readSource:vi.fn(async()=>source),generate:vi.fn(async()=>({subject:'Bid form',body:'I can send the bid form for your review.',missingFacts:['quote amount']}))});

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
});
