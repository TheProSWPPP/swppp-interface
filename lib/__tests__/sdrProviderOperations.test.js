import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { acquireLeadLock } from '../sdrAccess.js';
import { setOutreachControl } from '../sdrOutreachControls.js';
import { reportingTestDb } from './reportingTestDb.js';
import { assessMembership, stopOwnedEnrollment, reconcileProviderOperation, withProviderContactLock, reserveEnrollment, recordEnrollmentReceipt } from '../sdrProviderOperations.js';
const expected = { contactId:'contact',campaignId:'campaign',membershipId:'generation-a',addedAt:'2026-10-01T00:00:00Z',sendId:'send-a',leadId:'lead-a' };
const contact = (overrides={}) => ({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'campaign',id:'generation-a',added_at:'2026-10-01T00:00:00Z',status:'active',...overrides}]});
describe('membership generation evidence',()=>{
 it('supersedes an old project stop when a new generation reused the campaign',()=>expect(assessMembership(expected,contact({id:'generation-b'}))).toMatchObject({status:'superseded'}));
 it('detects a reused same-lead membership through added_at without a membership ID',()=>expect(assessMembership({...expected,membershipId:null},contact({id:null,added_at:'2026-10-02T00:00:00Z'}))).toMatchObject({status:'superseded'}));
 it.each(['finished','failed'])('accepts Apollo %s status as the stop receipt',status=>expect(assessMembership(expected,contact({status,inactive_reason:'replied'}))).toMatchObject({status:'confirmed',reason:`membership_${status}`,receipt:{id:'generation-a',membershipStatus:status,inactiveReason:'replied'}}));
 it('accepts finished/failed even without generation proof: nothing sends again',()=>expect(assessMembership({...expected,membershipId:null,addedAt:null},contact({status:'finished'}))).toMatchObject({status:'confirmed'}));
 it('absence is not a stop receipt',()=>expect(assessMembership(expected,{id:'contact',contact_campaign_statuses:[]})).toMatchObject({status:'protected_external_state',reason:'membership_absent'}));
 it.each(['active','paused'])('an open %s membership proven ours is reported as owned, not removed',status=>expect(assessMembership(expected,contact({status}))).toMatchObject({status:'owned_open',reason:`membership_${status}`}));
 it('unknown generation cannot claim ownership',()=>expect(assessMembership({...expected,membershipId:null,addedAt:null},contact())).toMatchObject({reason:'generation_unverified'}));
 it('proves ownership from our send time when Apollo added the contact within two minutes of it',()=>{
  const e={...expected,membershipId:null,addedAt:null};
  expect(assessMembership(e,contact({id:null,added_at:'2026-10-01T00:00:01.300Z'}),{ownedSentAt:'2026-10-01T00:00:00Z'})).toMatchObject({status:'owned_open'});
  expect(assessMembership(e,contact({id:null,added_at:'2026-10-01T00:10:00Z'}),{ownedSentAt:'2026-10-01T00:00:00Z'})).toMatchObject({status:'protected_external_state',reason:'generation_unverified'});
  expect(assessMembership(e,contact({id:null,added_at:'2026-09-20T00:00:00Z'}),{ownedSentAt:'2026-10-01T00:00:00Z'})).toMatchObject({reason:'generation_unverified'});
 });
});
const db=reportingTestDb('provider_operations');
describe.skipIf(!db)('durable provider operations',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query('CREATE TABLE sdr_sends(id text,pipedrive_lead_id text,apollo_contact_id text,apollo_sequence_id text,status text,sent_at timestamptz);CREATE TABLE permit_sends(id text,apollo_contact_id text);CREATE TABLE sdr_settings(id int,contact_cooldown_days int);INSERT INTO sdr_settings VALUES(1,14);CREATE TABLE sdr_message_facts(provider text,direction text,provider_status text,prospect_email text,occurred_at timestamptz)');await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-provider-operations.sql',import.meta.url),'utf8'));await db.pool.query(await readFile(new URL('../../migrations/2026-10-10-sdr-enrollment-phases.sql',import.meta.url),'utf8'));await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-outreach-controls.sql',import.meta.url),'utf8'));await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-policy-rollout.sql',import.meta.url),'utf8'));});
 afterAll(async()=>await db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_policy_decisions,sdr_message_facts,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_provider_operations,sdr_provider_membership_observations,sdr_sends');await db.pool.query("INSERT INTO sdr_sends VALUES ('send-a','lead-a','contact','campaign','enrolled',NOW())");});
 it('persists one logical stop, makes zero broad removals, keeps an explicit review reason',async()=>{
  const apollo={getContact:vi.fn(async()=>contact()),removeContactsFromSequence:vi.fn()};
  const a=await stopOwnedEnrollment({pool:db.pool,apollo,expected,actionId:'stop-a'});
  const b=await stopOwnedEnrollment({pool:db.pool,apollo,expected,actionId:'stop-a'});
  expect(a).toMatchObject({status:'protected_external_state',receipt:null});expect(a.operationId).toBe(b.operationId);expect(apollo.removeContactsFromSequence).not.toHaveBeenCalled();
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_provider_operations')).rows[0].n).toBe(1);
 });
 const legacy={...expected,membershipId:null,addedAt:null};
 const owned=(status='active',added_at=null)=>async()=>({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'campaign',id:'m1',status,added_at:added_at || (sentAt).toISOString()}]});
 let sentAt;
 const setSentAt=async()=>{sentAt=(await db.pool.query("SELECT sent_at FROM sdr_sends WHERE id='send-a'")).rows[0].sent_at;};
 it('a reply stop marks only our proven enrollment finished and takes Apollo\'s finished status as the receipt',async()=>{
  await setSentAt();
  let finished=false;
  const apollo={getContact:vi.fn(async()=>({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'campaign',id:'m1',status:finished?'finished':'active',inactive_reason:finished?'manually finished':null,added_at:new Date(+sentAt+900).toISOString()}]})),
   finishContactInSequence:vi.fn(async()=>{finished=true;return {entity_progress_job:{id:'job'}};}),removeContactsFromSequence:vi.fn()};
  const result=await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'reply-stop:1',allowRemoval:true});
  expect(apollo.finishContactInSequence).toHaveBeenCalledTimes(1);expect(apollo.finishContactInSequence).toHaveBeenCalledWith('campaign','contact');
  expect(apollo.removeContactsFromSequence).not.toHaveBeenCalled();
  expect(result).toMatchObject({status:'confirmed',reason:'stopped_by_app',receipt:{id:'m1',membershipStatus:'finished',via:'mark_as_finished'}});
  expect((await db.pool.query('SELECT state,receipt FROM sdr_provider_operations')).rows[0]).toMatchObject({state:'confirmed',receipt:{id:'m1',via:'mark_as_finished'}});
  // A confirmed stop is never read or written again.
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'reply-stop:1',allowRemoval:true})).toMatchObject({status:'confirmed'});
  expect(apollo.getContact).toHaveBeenCalledTimes(2);expect(apollo.finishContactInSequence).toHaveBeenCalledTimes(1);
 });
 it('never writes without allowRemoval (auto-switch, verification, provider events stay inspect-only)',async()=>{
  await setSentAt();
  const apollo={getContact:vi.fn(owned()),finishContactInSequence:vi.fn(),removeContactsFromSequence:vi.fn()};
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'auto-switch:send-a'})).toMatchObject({status:'protected_external_state',reason:'conditional_generation_stop_unverified'});
  expect(apollo.finishContactInSequence).not.toHaveBeenCalled();expect(apollo.removeContactsFromSequence).not.toHaveBeenCalled();
 });
 it('never writes to a membership someone else added (added long after or before our send)',async()=>{
  await setSentAt();
  const apollo={getContact:vi.fn(owned('active',new Date(+sentAt+3*86400000).toISOString())),finishContactInSequence:vi.fn()};
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'reply-stop:x',allowRemoval:true})).toMatchObject({status:'protected_external_state',reason:'generation_unverified'});
  expect(apollo.finishContactInSequence).not.toHaveBeenCalled();
 });
 it('does not claim a stop until Apollo shows it finished',async()=>{
  await setSentAt();
  const apollo={getContact:vi.fn(owned()),finishContactInSequence:vi.fn(async()=>({}))};
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'reply-stop:y',allowRemoval:true})).toMatchObject({status:'unresolved',reason:'stop_requested_awaiting_receipt',receipt:null});
 });
 it('keeps a provider write rate limit as a retryable deferral',async()=>{
  await setSentAt();
  const apollo={getContact:vi.fn(owned()),finishContactInSequence:vi.fn(async()=>{throw Object.assign(new Error('limited'),{status:429,retryAfterSec:600});})};
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'reply-stop:z',allowRemoval:true})).toMatchObject({status:'unresolved',reason:'stop_rate_limited',retryAfterSec:600});
 });
 it('reads a protected stop at most once a day instead of every run',async()=>{
  await setSentAt();
  const apollo={getContact:vi.fn(owned('active',new Date(+sentAt+3*86400000).toISOString()))};
  for (let i=0;i<5;i++) expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'auto-switch:send-a'})).toMatchObject({status:'protected_external_state',reason:'generation_unverified'});
  expect(apollo.getContact).toHaveBeenCalledTimes(1);
  await db.pool.query("UPDATE sdr_provider_membership_observations SET observed_at=NOW()-INTERVAL '25 hours'");
  await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'auto-switch:send-a'});
  expect(apollo.getContact).toHaveBeenCalledTimes(2);
 });
 it('a reply stop is not held back by an inspect-only result its removal can change',async()=>{
  await setSentAt();
  let finished=false;
  const apollo={getContact:vi.fn(async()=>({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'campaign',id:'m1',status:finished?'finished':'active',added_at:sentAt.toISOString()}]})),finishContactInSequence:vi.fn(async()=>{finished=true;})};
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'auto-switch:send-a'})).toMatchObject({reason:'conditional_generation_stop_unverified'});
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected:legacy,actionId:'reply-stop:1',allowRemoval:true})).toMatchObject({status:'confirmed'});
 });
 it('old stop cannot affect a newer send of the same lead',async()=>{
  await db.pool.query("INSERT INTO sdr_sends VALUES ('send-b','lead-a','contact','campaign','enrolled',NOW())");
  const apollo={getContact:async()=>contact(),removeContactsFromSequence:vi.fn()};
  expect(await stopOwnedEnrollment({pool:db.pool,apollo,expected,actionId:'stop-a'})).toMatchObject({status:'superseded'});expect(apollo.removeContactsFromSequence).not.toHaveBeenCalled();
 });
 it('unknown response reconciles without retrying mutation or inventing stopped from absence',async()=>{
  const result=await stopOwnedEnrollment({pool:db.pool,apollo:{getContact:async()=>{throw Error('timeout');}},expected,actionId:'stop-a'});
  expect(result.status).toBe('unresolved');
  const apollo={getContact:async()=>({id:'contact',contact_campaign_statuses:[]}),removeContactsFromSequence:vi.fn()};
  expect(await reconcileProviderOperation({pool:db.pool,apollo,operationId:result.operationId})).toMatchObject({status:'protected_external_state',receipt:null});expect(apollo.removeContactsFromSequence).not.toHaveBeenCalled();
 });
 it('preserves contact-read rate limits as read failures rather than uncertain mutations',async()=>{
  const result=await stopOwnedEnrollment({pool:db.pool,apollo:{getContact:async()=>{throw Object.assign(new Error('private'),{status:429,retryAfterSec:86400});}},expected,actionId:'quota-stop'});
  expect(result).toMatchObject({status:'unresolved',reason:'membership_rate_limited',retryAfterSec:86400,receipt:null});
  expect((await db.pool.query('SELECT state,reason FROM sdr_provider_operations')).rows[0]).toEqual({state:'unresolved',reason:'membership_rate_limited'});
 });
 it('reserves one fresh contact but refuses a paused or removed prior enrollment before copy writes',async()=>{
  const context={companyId:'company',apolloContactId:'new-contact',sequenceId:'campaign',leadId:'lead-new',recipientEmail:'recipient@example.test',complete:false,technicalComplete:true};
  const apollo={getContact:async()=>({id:'new-contact',contact_campaign_statuses:[]})};
  const args={pool:db.pool,apollo,context,draftRevision:1,actionId:'enroll-1'};
  const first=await reserveEnrollment(args);expect(first.reservationId).toBeTruthy();
  await expect(reserveEnrollment(args)).rejects.toMatchObject({code:'provider_operation_requires_review'});
  await recordEnrollmentReceipt({pool:db.pool,reservationId:first.reservationId,receipt:{id:'generation-new',contactId:'new-contact',campaignId:'campaign'}});
  expect((await db.pool.query('SELECT state FROM sdr_provider_operations WHERE id=$1',[first.reservationId])).rows[0].state).toBe('confirmed');
  await expect(reserveEnrollment({...args,actionId:'enroll-2',context:{...context,leadId:'other-new-lead',apolloContactId:'contact'},apollo:{getContact:async()=>({id:'contact',contact_campaign_statuses:[]})}})).rejects.toMatchObject({code:'external_membership_requires_review'});
 });
 it('retains exact bigint revision in reservation storage and dependency evidence',async()=>{
  const revision='9007199254740993';
  const result=await reserveEnrollment({pool:db.pool,apollo:{getContact:async()=>({id:'bigint-contact',contact_campaign_statuses:[]})},context:{companyId:'company',apolloContactId:'bigint-contact',sequenceId:'campaign',leadId:'bigint-lead',technicalComplete:true},draftRevision:revision,actionId:'bigint'});
  const row=(await db.pool.query('SELECT draft_revision,expected_membership FROM sdr_provider_operations WHERE id=$1',[result.reservationId])).rows[0];
  expect(row.draft_revision).toBe(revision);expect(row.expected_membership.draftRevision).toBe(revision);
 });
 it('records the provider reservation result separately from preflight, including blocked retry',async()=>{
  const context={companyId:'company',apolloContactId:'fresh-audit',sequenceId:'campaign',leadId:'audit-lead',technicalComplete:true,
   policyRollout:{config:{companyId:'company',mode:'observe',version:1,cohort:null},actionKey:'draft:audited:1'}};
  const args={pool:db.pool,apollo:{getContact:async()=>({id:'fresh-audit',contact_campaign_statuses:[]})},context,draftRevision:1,actionId:'audit'};
  await reserveEnrollment(args);
  await expect(reserveEnrollment(args)).rejects.toMatchObject({code:'provider_operation_requires_review'});
  const decisions=(await db.pool.query('SELECT phase,actual_outcome,actual_reasons FROM sdr_policy_decisions ORDER BY created_at')).rows;
  expect(decisions).toEqual([{phase:'provider_reservation',actual_outcome:'allow',actual_reasons:[]},{phase:'provider_reservation',actual_outcome:'hold',actual_reasons:['provider_operation_requires_review']}]);
 });
 it('requires explicit technical completeness and never treats a business-complete flag as provider permission',async()=>{
  await expect(reserveEnrollment({pool:db.pool,apollo:{getContact:async()=>{throw Error('must not read');}},context:{companyId:'company',apolloContactId:'fresh',sequenceId:'campaign',leadId:'new',complete:true},draftRevision:1,actionId:'invalid'})).rejects.toMatchObject({code:'provider_context_incomplete'});
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_provider_operations')).rows[0].n).toBe(0);
 });
 it('rejects all visible memberships and held contexts before reservation',async()=>{
  const args={pool:db.pool,apollo:{getContact:async()=>contact({status:'paused'})},context:{companyId:'company',apolloContactId:'contact',sequenceId:'campaign',leadId:'lead-new',technicalComplete:true},draftRevision:1,actionId:'enroll-new'};
  await expect(reserveEnrollment(args)).rejects.toMatchObject({code:'external_membership_requires_review'});
  await setOutreachControl(db.pool,{companyId:'company',leadId:'lead-new',scope:{kind:'lead',id:'lead-new'},reason:'staff pause',contextHash:'hash',actor:{accountId:'rep'}});
  await expect(reserveEnrollment(args)).rejects.toMatchObject({code:'outreach_held'});
 });
 it('keeps an unresolved stop attached to its project when a different recipient is proposed',async()=>{
  await stopOwnedEnrollment({pool:db.pool,apollo:{getContact:async()=>contact()},expected,actionId:'stop-before-replacement'});
  await expect(reserveEnrollment({pool:db.pool,apollo:{getContact:async()=>({id:'new-contact',contact_campaign_statuses:[]})},context:{companyId:'company',apolloContactId:'new-contact',sequenceId:'new-campaign',leadId:'lead-a',technicalComplete:true},draftRevision:2,actionId:'replace'})).rejects.toMatchObject({code:'provider_operation_requires_review'});
 });
 it('keeps the project held after an unexplained provider pause even when the contact changes',async()=>{
  const context={companyId:'company',apolloContactId:'paused-contact',sequenceId:'campaign',leadId:'held-lead',recipientEmail:'paused@example.test',technicalComplete:true};
  await expect(reserveEnrollment({pool:db.pool,apollo:{getContact:async()=>({id:'paused-contact',contact_campaign_statuses:[{emailer_campaign_id:'campaign',status:'paused'}]})},context,draftRevision:1,actionId:'paused'})).rejects.toMatchObject({code:'external_membership_requires_review'});
  await expect(reserveEnrollment({pool:db.pool,apollo:{getContact:async()=>({id:'replacement',contact_campaign_statuses:[]})},context:{...context,apolloContactId:'replacement',recipientEmail:'new@example.test'},draftRevision:2,actionId:'replacement'})).rejects.toMatchObject({code:'outreach_held'});
 });
 it('blocks shared copy when completed-message history is recent even without a local send',async()=>{
  await db.pool.query("INSERT INTO sdr_message_facts VALUES ('apollo','out','completed','recent@example.test',now())");
  await expect(reserveEnrollment({pool:db.pool,apollo:{getContact:async()=>({id:'fresh',contact_campaign_statuses:[]})},context:{companyId:'company',apolloContactId:'fresh',leadId:'fresh-lead',recipientEmail:'recent@example.test',sequenceId:'campaign',technicalComplete:true},draftRevision:1,actionId:'recent'})).rejects.toMatchObject({code:'contact_cooldown'});
 });
 it('serializes concurrent reservations for different projects sharing a fresh provider contact',async()=>{
  const apollo={getContact:async()=>{await new Promise(r=>setTimeout(r,25));return {id:'fresh',contact_campaign_statuses:[]};}};
  const context={companyId:'company',apolloContactId:'fresh',sequenceId:'campaign',technicalComplete:true};
  const attempts=await Promise.allSettled(['a','b'].map(leadId=>reserveEnrollment({pool:db.pool,apollo,context:{...context,leadId},draftRevision:1,actionId:leadId})));
  expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
  expect(attempts.filter(a=>a.status==='rejected')[0].reason.code).toBe('provider_operation_requires_review');
 });
 it('reconciles a crash after possible enrollment acceptance without issuing an add or replay',async()=>{
  const args={pool:db.pool,apollo:{getContact:async()=>({id:'new',contact_campaign_statuses:[]})},context:{companyId:'company',apolloContactId:'new',sequenceId:'campaign',leadId:'new-lead',technicalComplete:true},draftRevision:2,actionId:'crash'};
  const reservation=await reserveEnrollment(args);
  const apollo={getContact:async()=>({id:'new',contact_campaign_statuses:[{id:'new-generation',emailer_campaign_id:'campaign',status:'active'}]}),addContactsToSequence:vi.fn(),removeContactsFromSequence:vi.fn()};
  expect(await reconcileProviderOperation({pool:db.pool,apollo,operationId:reservation.reservationId})).toMatchObject({status:'unresolved',receipt:null});
  await expect(reserveEnrollment({...args,apollo})).rejects.toMatchObject({code:'provider_operation_requires_review'});
  expect(apollo.addContactsToSequence).not.toHaveBeenCalled();expect(apollo.removeContactsFromSequence).not.toHaveBeenCalled();
 });
 it('blocks provider entry until an in-flight global recipient hold commits',async()=>{
  const writer=await db.pool.connect();await writer.query('BEGIN');await acquireLeadLock(writer,'outreach-global-controls');
  let entered=false;const provider=withProviderContactLock(db.pool,'contact',['lead-a'],async()=>{entered=true;});
  await new Promise(r=>setTimeout(r,25));const beforeCommit=entered;
  await writer.query('COMMIT');writer.release();await provider;expect(beforeCommit).toBe(false);expect(entered).toBe(true);
 });
 it('session lead lock blocks existing transaction-based draft writers',async()=>{
  let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  const operation=withProviderContactLock(db.pool,'contact',['lead-a'],async()=>{entered();await hold;});
  await ready;const draft=await db.pool.connect();await draft.query('BEGIN');
  const edit=acquireLeadLock(draft,'lead-a');
  expect(await Promise.race([edit.then(()=>true),new Promise(r=>setTimeout(()=>r(false),25))])).toBe(false);
  release();await operation;await edit;await draft.query('ROLLBACK');draft.release();
 });
 it('serializes separate workers on the provider contact before touching project fields',async()=>{
  const order=[];let release;const barrier=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);
  const a=withProviderContactLock(db.pool,'contact',['lead-b','lead-a'],async()=>{order.push('a');entered();await barrier;order.push('a-done');});
  await ready;const b=withProviderContactLock(db.pool,'contact',['lead-c'],async()=>order.push('b'));
  await new Promise(r=>setTimeout(r,30));expect(order).toEqual(['a']);release();await Promise.all([a,b]);expect(order).toEqual(['a','a-done','b']);
 });
});
