import {describe,it,expect} from 'vitest';
import {stageInvitationMailPreview} from '../sdrInvitationMailPreview.js';

const source={provider:'pipedrive',accountId:'mail-1',threadId:12,messageId:34,recordedMessageTime:'2026-10-13T15:27:42Z',subject:'Library: Invitation to bid on Library (General Conditions)',bodySha256:'abc',invitationSourceLinks:[{label:'View in Procore',url:'https://us02.procore.com/bid/1'}]};
const entry={label:'Invitation A',platform:'Procore',classification:'real_project_invitation',currentStatus:'unknown',submissionState:'unknown',due:[{date:'2026-10-21',time:'02:00 pm',timezone:null,meaning:'printed Bid Due'}],source};
const register={companyId:'13105180',entries:[entry]};

describe('reviewed Pipedrive invitation mail preview',()=>{
 it('keeps a future printed deadline separate from verified open status and commercial evidence',()=>{
  const result=stageInvitationMailPreview({register,companyId:'13105180',asOf:'2026-10-19T12:00:00Z'});
  expect(result.candidates[0]).toMatchObject({key:'13105180:pipedrive:mail-1:34',projectTitle:source.subject,platform:'Procore',printedDeadlineReview:'future_printed_deadline',currentOpen:'unverified',submission:'unknown',quote:{sent:'unknown'},crmMatch:{status:'unresolved'},websiteOrderMatch:{status:'unresolved'},estimator:null});
  expect(result.counts).toMatchObject({sourceMessages:1,uniqueCandidates:1,confirmedOpen:0});
 });
 it('deduplicates repeated message identity but holds changed source facts',()=>{
  const repeat=stageInvitationMailPreview({register:{...register,entries:[entry,{...entry,label:'Repeat'}]},companyId:'13105180',asOf:'2026-10-19T12:00:00Z'});
  expect(repeat.candidates).toHaveLength(1);
  const conflict=stageInvitationMailPreview({register:{...register,entries:[entry,{...entry,source:{...source,subject:'Other project'}}]},companyId:'13105180',asOf:'2026-10-19T12:00:00Z'});
  expect(conflict.candidates[0]).toMatchObject({sourceConflict:true,currentOpen:'unverified',crmMatch:{status:'unresolved'}});
  const linkConflict=stageInvitationMailPreview({register:{...register,entries:[entry,{...entry,source:{...source,invitationSourceLinks:[{label:'View in Procore',url:'https://us02.procore.com/bid/2'}]}}]},companyId:'13105180',asOf:'2026-10-19T12:00:00Z'});
  expect(linkConflict.candidates[0].sourceConflict).toBe(true);
 });
 it('keeps conflicting submission dates and unrelated milestones out of an operational due date',()=>{
  const result=stageInvitationMailPreview({register:{...register,entries:[{...entry,due:[{date:'2026-10-20',meaning:'structured date label in invitation'},{date:'2026-10-26',meaning:'submission deadline in prose'},{date:'2027-12-01',meaning:'substantial-completion milestone, not bid deadline'}]}]},companyId:'13105180',asOf:'2026-10-19T12:00:00Z'});
  expect(result.candidates[0]).toMatchObject({printedDeadlineReview:'conflicting_printed_deadlines',governingDeadline:null,currentOpen:'unverified'});
  expect(result.candidates[0].printedDates).toHaveLength(3);
 });
 it('does not call an unzoned same-day printed due time future',()=>{
  const result=stageInvitationMailPreview({register:{...register,entries:[{...entry,due:[{date:'2026-10-19',time:'10:00 am',timezone:null,meaning:'printed Bid Due'}]}]},companyId:'13105180',asOf:'2026-10-19T17:00:00Z'});
  expect(result.candidates[0]).toMatchObject({printedDeadlineReview:'same_day_printed_deadline',governingDeadline:null,currentOpen:'unverified'});
 });
 it('rejects a different company and malformed identity instead of staging another client',()=>{
  expect(()=>stageInvitationMailPreview({register,companyId:'other',asOf:'2026-10-19T12:00:00Z'})).toThrow('company_scope_mismatch');
  expect(()=>stageInvitationMailPreview({register:{...register,entries:[{...entry,source:{...source,messageId:null}}]},companyId:'13105180',asOf:'2026-10-19T12:00:00Z'})).toThrow('invalid_message_identity');
 });
 it('excludes a marketing-only message from the invited-bid cohort',()=>{
  const result=stageInvitationMailPreview({register:{...register,entries:[{...entry,classification:'marketing_only',marketingOnly:true}]},companyId:'13105180',asOf:'2026-10-19T12:00:00Z'});
  expect(result.candidates).toHaveLength(0);
  expect(result.counts).toMatchObject({sourceMessages:1,uniqueCandidates:0,excluded:1});
 });
});
