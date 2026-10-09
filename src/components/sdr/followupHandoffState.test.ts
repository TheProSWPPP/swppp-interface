import {describe,it,expect} from 'vitest';
import type {HandoffApi,HandoffContentPreview,HandoffReceipt} from '../../lib/sdrFollowupHandoffApi';
import type {HandoffState} from './followupHandoffState';
import {createHandoffSession as createSession,handoffUnresolved} from './followupHandoffState';
const receipt:HandoffReceipt={id:'handoff-1',status:'confirmed',noteId:'201',readbackVerified:true,projectUrl:'https://proswpppllc.pipedrive.com/leads/inbox/lead-1',checkedAt:'2026-10-10T12:00:00Z',revision:4};
const preview:HandoffContentPreview={noteHtml:'Proposed subject:<br>A subject<br>Proposed message:<br>The whole message',previewToken:'preview-1',revision:4,leadId:'lead-1',content:{subject:'A subject',body:'The whole message'},owner:{id:'7',name:'Alex'},contact:{id:'8',name:'Sam',email:'sam@example.test'},checkedAt:'2026-10-10T12:00:00Z',replyCoverage:'unverified',requiresLatestConversationReview:true,publication:null};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
function setup(overrides:Partial<HandoffApi>={},current=()=>true){
 const writes:unknown[]=[];let state:HandoffState={phase:'loading',preview:null,receipt:null,attempted:false,error:''};
 const api:HandoffApi={preview:async()=>preview,publish:async(leadId,input)=>{writes.push({leadId,...input});return receipt;},reconcile:async()=>receipt,...overrides};
 expect(createSession).toBeTypeOf('function');
 const session=createSession({leadId:'lead-1',expectedRevision:4,contextToken:'context-4'},api,current,next=>{state=next;});
 return {session,writes,state:()=>state};
}
describe('Pipedrive note handoff session',()=>{
 it('requires explicit conversation review before publishing the saved revision',async()=>{
  const {session,state,writes}=setup();await session.load();await session.publish(false);
  expect(state().phase).toBe('preview');expect(writes).toEqual([]);
  await session.publish(true);
  expect(writes).toEqual([{leadId:'lead-1',expectedRevision:4,contextToken:'context-4',previewToken:'preview-1',latestConversationReviewed:true}]);
  expect(state().receipt).toEqual(receipt);
 });
 it('locks duplicate confirmation while a provider result is pending',async()=>{
  const pending=deferred<HandoffReceipt>();let count=0;
  const {session,state}=setup({publish:async()=>{count++;return pending.promise;}});await session.load();
  const first=session.publish(true);await session.publish(true);
  expect(count).toBe(1);expect(state().phase).toBe('publishing');pending.resolve(receipt);await first;
  expect(state().receipt?.readbackVerified).toBe(true);
 });
 it('recovers ambiguous publication with reads and never repeats the write',async()=>{
  let reads=0,writes=0,reconciles=0;
  const {session,state}=setup({preview:async()=>({...preview,publication:reads++?{...receipt,status:'uncertain',readbackVerified:false}:null}),publish:async()=>{writes++;throw new Error('Lost response');},reconcile:async()=>{reconciles++;return receipt;}});
  await session.load();await session.publish(true);expect(state().attempted).toBe(true);expect(state().phase).toBe('receipt');
  await session.publish(true);await session.check();
  expect(writes).toBe(1);expect(reconciles).toBe(1);expect(state().receipt).toEqual(receipt);
 });
 it('cannot republish an existing unverified receipt',async()=>{
  const {session,state,writes}=setup({preview:async()=>({...preview,publication:{...receipt,readbackVerified:false}})});
  await session.load();await session.publish(true);expect(writes).toEqual([]);expect(state().phase).toBe('receipt');
 });
 it('drops late preview results when disposed and prevents further writes',async()=>{
  const pending=deferred<HandoffContentPreview>();const {session,state,writes}=setup({preview:async()=>pending.promise});
  const request=session.load();session.dispose();pending.resolve(preview);await request;await session.publish(true);
  expect(state().preview).toBeNull();expect(writes).toEqual([]);
 });
 it('refuses writes when the authenticated session changes after preview',async()=>{
  let current=true;const {session,writes}=setup({},()=>current);await session.load();current=false;await session.publish(true);expect(writes).toEqual([]);
 });
 it('keeps recovery read-only when no publication receipt can be established',async()=>{
  let writes=0;const {session,state}=setup({publish:async()=>{writes++;throw new Error('network');}});
  await session.load();await session.publish(true);await session.check();await session.publish(true);
  expect(writes).toBe(1);expect(state().phase).toBe('receipt');expect(state().error).toBeTruthy();
 });
});

it('unlocks editing after a definite no-write receipt',async()=>{
 const {session,state}=setup({preview:async()=>({publication:{...receipt,status:'not_attempted',readbackVerified:false,reason:'preview_expired'},revision:4,replyCoverage:'unverified',requiresLatestConversationReview:true})});await session.load();expect(handoffUnresolved(state())).toBe(false);
});

it('invalidates expired preflight authorization without claiming an uncertain write',async()=>{
 const {session,state}=setup({publish:async()=>{throw Object.assign(new Error('preview_expired'),{status:409});}});await session.load();await session.publish(true);
 expect(state().phase).toBe('error');expect(state().attempted).toBe(false);expect(state().preview).toBeNull();expect(handoffUnresolved(state())).toBe(false);
});
it('does not offer repeated preview retries while the handoff service is unavailable',async()=>{
 const {session,state}=setup({preview:async()=>{throw Object.assign(new Error('handoff_unavailable'),{status:503});}});await session.load();expect(state().retryable).toBe(false);
});
it('recovers an older unresolved revision by its receipt ID after reopening',async()=>{
 const requested:string[]=[];
 const {session,state}=setup({preview:async()=>({revision:3,publication:{...receipt,revision:3,status:'uncertain',readbackVerified:false},replyCoverage:'unverified',requiresLatestConversationReview:true}),reconcile:async(_lead,id)=>{requested.push(id);return {...receipt,revision:3};}});
 await session.load();await session.check();expect(requested).toEqual(['handoff-1']);expect(state().receipt?.revision).toBe(3);expect(state().receipt?.readbackVerified).toBe(true);
});
