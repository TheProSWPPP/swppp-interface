import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
// B1 review 2026-10-26: the existing-customer check allowed the send whenever Pipedrive could not
// be read, and permit auto-send ran on the engine switch alone with auto-send switched off.
vi.mock('../pipedriveClient.js',()=>({listOrganizations:vi.fn(),getLead:vi.fn(),getOrganization:vi.fn()}));
vi.mock('../permitDrafts.js',()=>({sendPermitToOperator:vi.fn(),looksLikeBadMatch:()=>false,looksLikeWeakContact:()=>false}));
import * as pd from '../pipedriveClient.js';
import {sendPermitToOperator} from '../permitDrafts.js';
import {runPermitAutoOutreach} from '../permitAuto.js';

const fresh=async()=>{vi.resetModules();return import('../customerSuppression.js');};
const unavailable=Object.assign(new Error('Pipedrive GET /organizations → 429'),{status:429});

describe('existing-customer check fails closed',()=>{
 beforeEach(()=>{vi.stubEnv('PIPEDRIVE_API_TOKEN','synthetic');vi.resetAllMocks();vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'log').mockImplementation(()=>{});});
 afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
 it('holds the send (crm_unverified, retryable) when the customer index cannot be read',async()=>{
  pd.listOrganizations.mockRejectedValue(unavailable);
  const {isCustomerLead}=await fresh();
  await expect(isCustomerLead('lead-1')).rejects.toMatchObject({code:'crm_unverified',status:503,preserveDraft:true});
 });
 it('holds the send when the lead cannot be read',async()=>{
  pd.listOrganizations.mockResolvedValue({data:[],pagination:{more_items_in_collection:false}});
  pd.getLead.mockRejectedValue(unavailable);
  const {isCustomerLead}=await fresh();
  await expect(isCustomerLead('lead-1')).rejects.toMatchObject({code:'crm_unverified'});
 });
 it('holds the send when the sibling organization name cannot be read',async()=>{
  pd.listOrganizations.mockResolvedValue({data:[],pagination:{more_items_in_collection:false}});
  pd.getLead.mockResolvedValue({id:'lead-1',organization_id:77,label_ids:[]});
  pd.getOrganization.mockRejectedValue(unavailable);
  const {isCustomerLead}=await fresh();
  await expect(isCustomerLead('lead-1')).rejects.toMatchObject({code:'crm_unverified'});
 });
 it('still answers normally when Pipedrive answers',async()=>{
  pd.listOrganizations.mockResolvedValue({data:[{id:5,name:'Crossland Construction',label:1}],pagination:{more_items_in_collection:false}});
  pd.getLead.mockResolvedValue({id:'lead-1',organization_id:77,label_ids:[]});
  pd.getOrganization.mockResolvedValue({id:77,name:'Crossland Construction - Tulsa'});
  const {isCustomerLead,isCustomerCompany}=await fresh();
  expect(await isCustomerLead('lead-1')).toMatchObject({matchedOn:'company_name'});
  expect(await isCustomerCompany('Crossland Construction')).toMatchObject({matchedOn:'company_name'});
  expect(await isCustomerCompany('Unrelated Paving')).toBeNull();
 });
 it('a permit company check also fails closed',async()=>{
  pd.listOrganizations.mockRejectedValue(unavailable);
  const {isCustomerCompany}=await fresh();
  await expect(isCustomerCompany('Synthetic Facility')).rejects.toMatchObject({code:'crm_unverified'});
 });
});

describe('permit auto-send needs its own switch',()=>{
 const pool=settings=>({query:vi.fn(async sql=>{
  if(sql.includes('FROM permit_engine_settings'))return {rows:[settings]};
  throw new Error(`unexpected query: ${sql.slice(0,60)}`);
 })});
 beforeEach(()=>vi.resetAllMocks());
 it('does nothing with the engine on and auto-send off (production settings on 2026-10-26)',async()=>{
  const db=pool({id:1,active:true,auto_send_enabled:false});
  expect(await runPermitAutoOutreach(db)).toEqual({skipped:'auto_send_off'});
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(sendPermitToOperator).not.toHaveBeenCalled();
 });
 it('does nothing with the engine off',async()=>{
  expect(await runPermitAutoOutreach(pool({id:1,active:false,auto_send_enabled:true}))).toEqual({skipped:'off'});
  expect(sendPermitToOperator).not.toHaveBeenCalled();
 });
 it('stops the batch when Pipedrive is unreadable and reports the errors',async()=>{
  const db={query:vi.fn(async sql=>{
   if(sql.includes('FROM permit_engine_settings'))return {rows:[{active:true,auto_send_enabled:true}]};
   if(sql.includes('FROM sdr_mailboxes'))return {rows:[{id:'mb',email:'rep@example.test',apollo_mailbox_id:'a',daily_send_limit:25,permit_daily_cap:5}]};
   if(sql.includes('FROM permit_msgp_template'))return {rows:[{subject:'s',body_html:'b',apollo_sequence_id:'seq'}]};
   if(sql.includes('FROM permit_sends'))return {rows:[{n:0}]};
   if(sql.includes('FROM permit_operator_email'))return {rows:[{operator_key:'a',email:'a@a.test'},{operator_key:'b',email:'b@b.test'}]};
   throw new Error(`unexpected query: ${sql.slice(0,60)}`);
  })};
  sendPermitToOperator.mockRejectedValue(Object.assign(new Error('unavailable'),{code:'crm_unverified'}));
  const result=await runPermitAutoOutreach(db);
  expect(sendPermitToOperator).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({sent:0,errorCount:1,errors:[{op:'a',code:'crm_unverified'}]});
 });
});
