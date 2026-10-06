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
 it('persists a narrow proposal without claiming a protected write succeeded',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{id:'proposal-1'}]});
  protection.configureCrmWriteProtection({pool:{query},companyId:'42'});
  await expect(protection.protectCrmWrite({entity:'lead',entityId:'lead-a',fields:{owner_id:4}})).rejects.toMatchObject({code:'crm_change_requires_review',proposalId:'proposal-1'});
  expect(query.mock.calls[0][1]).toContain('lead-a');
  expect(query.mock.calls[0][1]).toContainEqual({owner_id:4});
 });
});
