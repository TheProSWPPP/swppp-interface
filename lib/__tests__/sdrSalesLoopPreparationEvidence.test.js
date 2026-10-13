import {describe,it,expect,vi} from 'vitest';
import {prepareProposal,projectSalesOpportunity} from '../sdrSalesLoop.js';
const current={contextToken:'current',draft:null,context:{lead:{title:'Project',ownerId:'7',personId:'12'},records:[],holds:[]}};
const source={identity:'crm_note:n1',companyId:'42',leadId:'A',linkage:'direct_unique',mailboxAuthorization:'not_applicable',text:'Old buyer message asks for missing quote.',provenance:{kind:'crm_note',id:'n1'}};
const evidence={project:current.context.lead,records:[{id:'n2',entity:'note',text:'Staff recorded quote resent on October 9.',sourceUpdatedAt:'2026-10-09T12:00:00Z'}],activities:[{id:'a1',status:'recorded_complete',ownerId:'7'}],messages:[],coverage:{history:'partial',pipedriveMail:'unavailable',messageBodies:'not_collected'}};
function args(action='quote_lookup') {return {pool:{},companyId:'42',leadId:'A',viewer:{sub:'viewer',role:'admin'},sourceRef:{kind:'crm_note',id:'n1'},editorRequestVersion:1,action,readDraft:async()=>structuredClone(current),readSource:async()=>structuredClone(source),readUnresolved:async()=>false,readEvidence:async()=>structuredClone(evidence),generate:vi.fn(async()=>({action,reason:'Review the recorded resend before contacting the buyer.',subject:null,body:null,missingFacts:['verified quote receipt']}))};}
describe('reviewed action preparation with current evidence',()=>{
 it('carries a newer recorded quote resend into preparation and keeps customer text absent for lookup',async()=>{
  const input=args();const result=await prepareProposal(input);
  expect(input.generate.mock.calls[0][0].evidence.records[0].text).toBe('Staff recorded quote resent on October 9.');
  expect(result).toMatchObject({action:'quote_lookup',subject:null,body:null,evidence:{activities:[{id:'a1',status:'recorded_complete'}]},evidenceDigest:expect.any(String)});
 });
 it.each(['wait','no_action'])('supports %s without inventing a customer draft',async action=>{
  const input=args(action);input.readEvidence=async()=>({...evidence,records:[{id:'decision',entity:'note',text:action==='wait'?'Buyer waiting for NTP; staff already acknowledged.':'Buyer reported no current permit need; Derek acknowledged and buyer thanked him.'}]});
  const result=await prepareProposal(input);expect(result.action).toBe(action);expect(result.body).toBeNull();
 });
 it('rejects customer text for non-reply actions and refuses a generator-selected different action',async()=>{
  for(const output of [{action:'wait',reason:'Wait.',subject:'Checking in',body:'Any update?',missingFacts:[]},{action:'reply',reason:'Reply.',subject:'Re',body:'Any update?',missingFacts:[]}]){
   const input=args('wait');input.generate=async()=>output;await expect(prepareProposal(input)).rejects.toMatchObject({code:'invalid_proposal'});
  }
 });
 it('rejects changed conversation evidence even when the CRM context token is unchanged',async()=>{
  const input=args();input.readEvidence=vi.fn().mockResolvedValueOnce(evidence).mockResolvedValueOnce({...evidence,messages:[{id:'new-response',direction:'out'}]});
  await expect(prepareProposal(input)).rejects.toMatchObject({code:'source_changed'});
 });
 it('can withhold a reply draft when current evidence contradicts the selected older source',async()=>{const input=args('reply');input.conversationReviewed=true;expect(await prepareProposal(input)).toMatchObject({action:'reply',body:null,subject:null,reason:expect.any(String)});});
 it('requires current conversation review for reply text',async()=>{const input=args('reply');await expect(prepareProposal(input)).rejects.toMatchObject({code:'invalid_preparation'});expect(input.generate).not.toHaveBeenCalled();});
 it('withholds oversized evidence before any generator call',async()=>{const input=args();input.readEvidence=async()=>({...evidence,records:[{text:'x'.repeat(65000)}]});await expect(prepareProposal(input)).rejects.toMatchObject({code:'source_unavailable'});expect(input.generate).not.toHaveBeenCalled();});
 it('requires a reviewed action before invoking generation',async()=>{const input=args();delete input.action;await expect(prepareProposal(input)).rejects.toMatchObject({code:'invalid_preparation'});expect(input.generate).not.toHaveBeenCalled();});
 it('retains completed CRM activities without claiming an original-task or handoff outcome',()=>{
  const result=projectSalesOpportunity({companyId:'42',context:{lead:{id:'A',ownerId:'7'},tasks:[{id:'oldest-open',dueDate:'2020-01-01'}]},activities:[{id:'done-1',status:'recorded_complete',ownerId:'7'}],outcomes:[]});
  expect(result.nextAction).toBeNull();expect(result.activities).toEqual([{id:'done-1',status:'recorded_complete',ownerId:'7'}]);expect(result.handoff.action).toBe('unknown');
 });
});

it('describes missing receipts and coverage without declaring every commercial stage missing',async()=>{
 const input=args('call');await prepareProposal(input);
 const packet=input.generate.mock.calls[0][0];
 expect(packet.missingFacts).not.toContain('quote requested');
 expect(packet.missingFacts).not.toContain('quote sent');
 expect(packet.missingFacts.some(f=>f.toLowerCase().includes('receipt'))).toBe(true);
});
