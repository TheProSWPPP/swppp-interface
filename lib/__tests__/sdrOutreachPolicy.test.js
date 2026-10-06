import {describe,it,expect} from 'vitest';
import * as policy from '../sdrOutreachPolicy.js';
const context={complete:true,companyId:'42',leadId:'lead-a',personId:'p1',organizationId:'o1',recipientEmail:'estimator@example.invalid',projectRole:'estimator',cadence:'standard',sourceRevision:'1',mailboxId:'m1',sequenceId:'s1',trigger:'AGC'};
describe('shared outreach policy',()=>{
 it('does not infer authority from equal organization IDs or matching email domains',()=>{
  expect(policy.evaluateOutreach({context,controls:[],affiliationEvidence:{status:'unknown'}})).toMatchObject({outcome:'review'});
 });
 it('allows reviewed external estimators but never bypasses a scoped hold',()=>{
  const args={context,controls:[],affiliationEvidence:{status:'reviewed',role:'estimator',contextHash:policy.outreachContextHash(context)},providerState:{status:'new'}};
  expect(policy.evaluateOutreach(args).outcome).toBe('allow');
  expect(policy.evaluateOutreach({...args,controls:[{reason:'call only'}],override:true}).outcome).toBe('hold');
  expect(policy.evaluateOutreach({...args,providerState:{status:'paused'}}).outcome).toBe('hold');
  expect(policy.evaluateOutreach({...args,context:{...context,personId:'p2'}}).outcome).toBe('review');
 });
 it('holds old contractor outreach without authorizing a replacement',()=>{
  expect(policy.evaluateTransition({oldContext:context,newContext:{...context,organizationId:'o2'},affiliationEvidence:{status:'confirmed_obsolete_recipient'},providerState:{ownership:'verified_own',status:'active'},controls:[]})).toEqual({sourceDisposition:'stop_owned',targetDisposition:'review'});
 });
 it('protects unknown sources, missing context, cleared trigger, future schedules and award-only intent',()=>{
  for(const override of [{complete:false},{trigger:null},{scheduledFor:'2999-01-01T00:00:00Z'},{cadence:'award_only',sequenceCadence:'standard'}]){
   const c={...context,...override};
   expect(policy.evaluateOutreach({context:c,controls:[],affiliationEvidence:{status:'reviewed',contextHash:policy.outreachContextHash(c)}}).outcome).not.toBe('allow');
  }
 });
});
