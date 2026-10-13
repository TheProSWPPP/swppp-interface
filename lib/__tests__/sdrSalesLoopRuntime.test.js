import {describe,it,expect,vi} from 'vitest';
let runtime={};try{runtime=await import('../sdrSalesLoopRuntime.js');}catch{}
const reviewer='00000000-0000-0000-0000-00000000000a';
const admin={role:'admin',sub:reviewer};
const config={enabled:true,companyId:'13105180',reviewerIds:[reviewer],model:'explicit-model',apiKey:'synthetic',generate:async()=>({})};
describe('supervised preparation admission',()=>{
 it('requires exact company, explicit configuration and a named human admin for availability',()=>{
  expect(runtime.createSupervisedPreparationPolicy).toBeTypeOf('function');
  const policy=runtime.createSupervisedPreparationPolicy(config);
  expect(policy.available(admin)).toBe(true);
  for(const viewer of [{...admin,role:'sdr'},{...admin,machine:true},{...admin,sub:'other'},{}])expect(policy.available(viewer)).toBe(false);
  for(const patch of [{enabled:false},{companyId:'other'},{model:''},{apiKey:''},{reviewerIds:[]},{generate:null}])expect(runtime.createSupervisedPreparationPolicy({...config,...patch}).available(admin)).toBe(false);
 });
 it('charges failed admitted attempts, enforces the viewer window and rejects unsupported source before consuming quota',()=>{
  expect(runtime.createSupervisedPreparationPolicy).toBeTypeOf('function');
  let time=0;const policy=runtime.createSupervisedPreparationPolicy({...config,now:()=>time,maxAttempts:2});
  expect(()=>policy.admit(admin,{kind:'gmail_message'})).toThrow('source_not_permitted');
  policy.admit(admin,{kind:'crm_note'});policy.admit(admin,{kind:'reviewed_crm_excerpt'});
  expect(()=>policy.admit(admin,{kind:'crm_note'})).toThrow('preparation_limit');
  time=3600000;expect(()=>policy.admit(admin,{kind:'crm_note'})).not.toThrow();
  expect(()=>policy.admit({...admin,role:'sdr'},{kind:'crm_note'})).toThrow('preparation_forbidden');
 });
 it('fails closed on invalid or excessive attempt configuration',()=>{
  expect(runtime.createSupervisedPreparationPolicy).toBeTypeOf('function');
  for(const maxAttempts of [0,-1,11,1.5,NaN])expect(()=>runtime.createSupervisedPreparationPolicy({...config,maxAttempts})).toThrow('preparation_configuration');
 });
 it('builds default-off runtime and requires explicit model/reviewer setup before binding',()=>{
  expect(runtime.createSalesLoopRuntime).toBeTypeOf('function');
  const factory=vi.fn(()=>async()=>({}));
  const disabled=runtime.createSalesLoopRuntime({env:{},companyId:'13105180',apiKey:'synthetic',createGenerator:factory});
  expect(disabled.enabled).toBe(false);expect(disabled.policy.available(admin)).toBe(false);expect(factory).not.toHaveBeenCalled();
  const enabled=runtime.createSalesLoopRuntime({env:{SDR_FOLLOWUP_PREPARATION_ENABLED:'true',SDR_FOLLOWUP_PREPARATION_MODEL:'explicit-model',SDR_FOLLOWUP_PREPARATION_REVIEWER_IDS:reviewer},companyId:'13105180',apiKey:'synthetic',createGenerator:factory});
  expect(enabled.enabled).toBe(true);expect(enabled.policy.available(admin)).toBe(true);expect(enabled.generate).toBeTypeOf('function');
 });
});
