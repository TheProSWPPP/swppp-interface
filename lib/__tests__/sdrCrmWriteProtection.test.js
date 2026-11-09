import {describe,it,expect,vi,afterEach} from 'vitest';
import * as protection from '../sdrCrmWriteProtection.js';
import {updateLead} from '../pipedriveClient.js';
afterEach(()=>{vi.unstubAllGlobals();protection.configureCrmWriteProtection(null);});
describe('existing CRM field protection',()=>{
 it('blocks existing record changes before any network call even without journal configuration',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(updateLead('lead-a',{person_id:123})).rejects.toMatchObject({code:'crm_change_requires_review'});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('lets our own Sequence_Started marker through on a lead, alone',async()=>{
  const fetch=vi.fn().mockResolvedValue({ok:true,status:200,text:async()=>JSON.stringify({success:true,data:{id:'lead-a'}})});vi.stubGlobal('fetch',fetch);
  process.env.PIPEDRIVE_API_TOKEN=process.env.PIPEDRIVE_API_TOKEN||'test-token';
  await updateLead('lead-a',{'48c4bb758e8642d6372c7fff9df3c0ea716170f1':'Apollo:LBA 2026-11-10'});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].method).toBe('PATCH');
 });
 it('still blocks clearing the marker (a late event cannot prove it owns it)',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(updateLead('lead-a',{'48c4bb758e8642d6372c7fff9df3c0ea716170f1':''})).rejects.toMatchObject({code:'crm_change_requires_review'});
  await expect(updateLead('lead-a',{'48c4bb758e8642d6372c7fff9df3c0ea716170f1':'Derek manual'})).rejects.toMatchObject({code:'crm_change_requires_review'});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('still blocks the marker when it rides along with another field',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(updateLead('lead-a',{'48c4bb758e8642d6372c7fff9df3c0ea716170f1':'Apollo:LBA',owner_id:4})).rejects.toMatchObject({code:'crm_change_requires_review'});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('persists a narrow proposal without claiming a protected write succeeded',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{id:'proposal-1'}]});
  protection.configureCrmWriteProtection({pool:{query},companyId:'42'});
  await expect(protection.protectCrmWrite({entity:'lead',entityId:'lead-a',fields:{owner_id:4}})).rejects.toMatchObject({code:'crm_change_requires_review',proposalId:'proposal-1'});
  expect(query.mock.calls[0][1]).toContain('lead-a');
  expect(query.mock.calls[0][1]).toContainEqual({owner_id:4});
 });
});
