import {describe,it,expect,vi} from 'vitest';
import {assertSendSafety} from '../sdrSendSafety.js';
import {hashDecisionContext} from '../sdrChangeJournal.js';
const draft={id:'d',revision:1,pipedrive_lead_id:'l',contact_id_snapshot:'p',org_id_snapshot:'o',contact_email_snapshot:'a@example.invalid',assigned_mailbox_id:'m',apollo_sequence_id:'s',trigger_type:'AGC'};
const context={draftId:'d',draftRevision:1,companyId:'42',leadId:'l',personId:'p',organizationId:'o',recipientEmail:'a@example.invalid',mailboxId:'m',sequenceId:'s',trigger:'AGC',stage:'AGC',cadence:'standard',projectRole:'estimator',complete:true,technicalComplete:true,businessReviewed:true};
draft.metadata={reviewed_outreach_context_hash:hashDecisionContext(context),sender_email:'rep@example.invalid',sender_provider_id:'sender'};
const make=()=>{
 const c={...context};c.reviewEvidence={status:'reviewed',contextHash:hashDecisionContext(c)};
 return {policyConfig:{companyId:'42',mode:'enforce',version:1,cohort:null},recordDecision:async()=>{},companyId:'42',readContext:async()=>c,readControls:async()=>[],getMailbox:async()=>({email:'rep@example.invalid',apollo_mailbox_id:'sender'}),getLead:async()=>({id:'l',is_archived:false,person_id:'p',organization_id:'o','7c1852c27664d1118f75660223a6af9e99d10f2c':'AGC'}),getPerson:async()=>({id:'p',email:[{value:'a@example.invalid',primary:true}]})};
};
describe('final send context',()=>{
 it('allows a technically valid first send outside the reviewed cohort without pretending business review',async()=>{
  const deps=make();deps.policyConfig.mode='observe';
  deps.readContext=async()=>({...context,complete:false,technicalComplete:true,businessReviewed:false,projectRole:null,cadence:'review',reviewEvidence:{status:'unknown'}});
  expect(await assertSendSafety({}, {...draft,metadata:{sender_email:'rep@example.invalid',sender_provider_id:'sender'}},deps)).toMatchObject({complete:false,technicalComplete:true,businessReviewed:false});
 });
 it('blocks a stale exact draft revision even in observation mode',async()=>{
  const deps=make();deps.policyConfig.mode='observe';
  await expect(assertSendSafety({}, {...draft,revision:0},deps)).rejects.toMatchObject({code:'draft_revision_changed'});
 });
 it('preserves the reviewed service through provider reservation',async()=>{
  const reviewed={...draft,metadata:{...draft.metadata,service_id:'inspection'}};
  expect(await assertSendSafety({},reviewed,make())).toMatchObject({serviceId:'inspection'});
 });
 it('allows only exact reviewed current identity and cadence',async()=>{expect(await assertSendSafety({},draft,make())).toMatchObject({complete:true});});
 it.each(['contact','email','stage','archive','read_failure'])('blocks %s changing after review without any provider write',async kind=>{
  const deps=make();
  if(kind==='contact')deps.getLead=async()=>({id:'l',is_archived:false,person_id:'changed',organization_id:'o'});
  if(kind==='email')deps.getPerson=async()=>({id:'p',email:[{value:'changed@example.invalid',primary:true}]});
  if(kind==='stage')deps.getLead=async()=>({id:'l',is_archived:false,person_id:'p',organization_id:'o','7c1852c27664d1118f75660223a6af9e99d10f2c':'CM'});
  if(kind==='archive')deps.getLead=async()=>({id:'l',is_archived:true});
  if(kind==='read_failure')deps.getPerson=async()=>{throw new Error('denied');};
  await expect(assertSendSafety({},draft,deps)).rejects.toMatchObject({status:409,preserveDraft:true});
 });
 it('does not let a generic override bypass a hold',async()=>{
  const deps=make();deps.readControls=async()=>[{id:'hold'}];
  await expect(assertSendSafety({},draft,{...deps,override:true})).rejects.toMatchObject({code:'outreach_held'});
 });
 it('blocks same-ID sender edits and reviews stale after stage/cadence changes',async()=>{
  const deps=make();deps.getMailbox=async()=>({email:'different@example.invalid',apollo_mailbox_id:'sender'});
  await expect(assertSendSafety({},draft,deps)).rejects.toMatchObject({code:'sender_context_changed'});
  await expect(assertSendSafety({},{...draft,metadata:{...draft.metadata,reviewed_outreach_context_hash:'old'}},make())).rejects.toMatchObject({code:'draft_review_context_changed'});
 });
 it('cannot claim an award-only cadence from draft metadata when provider has multiple steps',async()=>{
  const deps=make(),c={...context,cadence:'award_only'};c.reviewEvidence={status:'reviewed',contextHash:hashDecisionContext(c)};
  deps.readContext=async()=>c;deps.getSequence=async()=>({emailer_steps:[{type:'auto_email'},{type:'auto_email'}]});
  await expect(assertSendSafety({},draft,deps)).rejects.toMatchObject({code:'award_only_requires_matching_sequence'});
 });
});
