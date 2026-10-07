import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { runReplyAction, enqueueReplyActions, drainReplyActions } from '../sdrReplyActions.js';
import { acquireLeadLock } from '../sdrAccess.js';
const now = new Date('2026-10-05T15:00:00Z');
const pending = kind => ({ kind, status: 'pending', attempts: 0, retryAt: null, externalId: null });

describe('independent reply actions', () => {
  it('records handled work as skipped without fabricating a send receipt',async()=>{
    const result=await runReplyAction(pending('forward'),{execute:async()=>({skipped:true,reason:'staff_replied'}),now});
    expect(result).toMatchObject({status:'skipped',externalId:null,receiptAt:null,safeError:'staff_replied',requiresReview:false,retryAt:null});
  });
  it('preserves a safe context review reason when later outbound authorship is uncertain',async()=>{
    const result=await runReplyAction(pending('forward'),{execute:async()=>{throw Object.assign(new Error('private message'),{permanent:true,definiteFailure:true,replyContextReason:'later_outbound_unverified'});},now});
    expect(result).toMatchObject({status:'failed',requiresReview:true,safeError:'later_outbound_unverified',retryAt:null});
  });
  it('retries a definitely failed CRM task without forwarding twice', async () => {
    const forward = vi.fn(async () => ({ id: 'forward-1' }));
    const createTask = vi.fn().mockRejectedValueOnce(Object.assign(new Error('private body'), { status: 429 })).mockResolvedValue({ id: 'task-1' });
    let f = await runReplyAction(pending('forward'), { execute: forward, now });
    let t = await runReplyAction(pending('create_task'), { execute: createTask, now });
    f = await runReplyAction(f, { execute: forward, now: new Date(+now + 5 * 60000) });
    t = await runReplyAction(t, { execute: createTask, now: new Date(+now + 5 * 60000) });
    expect(f).toMatchObject({ status: 'completed', externalId: 'forward-1' });
    expect(t).toMatchObject({ status: 'completed', externalId: 'task-1', attempts: 2 });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledTimes(2);
  });
  it('does not resend a forward with uncertain timeout completion', async () => {
    const execute = vi.fn(async () => { throw Object.assign(new Error('token=private'), { code: 'ETIMEDOUT' }); });
    const failed = await runReplyAction(pending('forward'), { execute, now });
    expect(failed).toMatchObject({ status: 'failed', requiresReview: true, safeError: 'completion_uncertain', retryAt: null });
    expect(JSON.stringify(failed)).not.toContain('private');
    expect(await runReplyAction(failed, { execute, now: new Date(+now + 60000) })).toEqual(failed);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('accepts a reconciled receipt without making a second external write', async () => {
    const execute = vi.fn();
    const action = { ...pending('forward'), status: 'failed', requiresReview: true, safeError: 'completion_uncertain', attempts: 1 };
    const result = await runReplyAction(action, { execute, reconcile: async () => ({ state: 'completed', receipt: { id: 'observed-forward' } }), now });
    expect(result).toMatchObject({ status: 'completed', externalId: 'observed-forward', attempts: 1, requiresReview: false });
    expect(execute).not.toHaveBeenCalled();
  });
  it('honours not-yet-due retry and stops after five definite failures', async () => {
    const execute = vi.fn(async () => { throw Object.assign(new Error('failed before writing'), { definiteFailure: true }); });
    let action = pending('create_task');
    let at = now;
    for (const delay of [1, 5, 30, 120]) {
      action = await runReplyAction(action, { execute, now: at });
      expect(action.retryAt).toEqual(new Date(+at + delay * 60000));
      const deferred = await runReplyAction(action, { execute, now: at });
      expect(deferred).toEqual(action);
      at = action.retryAt;
    }
    action = await runReplyAction(action, { execute, now: at });
    expect(action).toMatchObject({ attempts: 5, status: 'failed', retryAt: null, requiresReview: true, safeError: 'attempts_exhausted' });
    expect(execute).toHaveBeenCalledTimes(5);
  });
  it('keeps authentication failure in review rather than retrying forever', async () => {
    const result = await runReplyAction(pending('forward'), { execute: async () => { throw Object.assign(new Error('secret'), { status: 401 }); }, now });
    expect(result).toMatchObject({ safeError: 'authentication', requiresReview: true, retryAt: null });
  });
  it('does not claim a missing provider receipt as completion', async () => {
    expect(await runReplyAction(pending('create_task'), { execute: async () => ({}), now })).toMatchObject({ status: 'failed', requiresReview: true, safeError: 'completion_uncertain' });
  });
  it('does not exceed the attempt cap after reconciling definite non-completion', async () => {
    const execute = vi.fn();
    const action = { ...pending('forward'),status:'failed',attempts:5,requiresReview:true,safeError:'completion_uncertain' };
    expect(await runReplyAction(action,{execute,reconcile:async()=>({state:'not_applied'}),now})).toMatchObject({requiresReview:true,safeError:'attempts_exhausted',attempts:5});
    expect(execute).not.toHaveBeenCalled();
  });
});

const db = reportingTestDb('reply_actions');
describe.skipIf(!db)('durable reply receipts (local Postgres)', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_sends(id text PRIMARY KEY, pipedrive_lead_id text, apollo_sequence_id text, apollo_contact_id text, status text, last_status_at timestamptz, updated_at timestamptz);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY, person_email text, lead_title text,sequence_started text)`);
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-reply-actions.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE sdr_reply_actions, sdr_reply_messages, sdr_reply_routes, sdr_inbox_watch_cursors, sdr_sends, sdr_lead_state');
    await db.pool.query("INSERT INTO sdr_sends VALUES ('send-1','lead-a','seq-a','contact-a','enrolled',NOW(),NOW())");
    await db.pool.query("INSERT INTO sdr_lead_state VALUES ('lead-a','buyer@example.test','Project A','2026-10-05T14:00:00Z')");
    await db.pool.query("INSERT INTO sdr_reply_routes(mailbox_email, forward_to, pipedrive_user_id, verified_at) VALUES ('rep@example.test','real@example.test',7,NOW())");
  });
  const message = extra => ({ messageId: 'rfc822:<reply@example.test>', sourceMessageId: 'gmail-1', threadId: 'thread-1', mailbox: 'rep@example.test', receivedAt: now,
    leadLink: { status: 'verified', leadId: 'lead-a' }, intent: { kind: 'human', label: 'interested', worth: true }, ...extra });

  it('dedups Gmail/Apollo observations by verified inbound identity and targets', async () => {
    await enqueueReplyActions(db.pool, message());
    await enqueueReplyActions(db.pool, message({ source: 'apollo', sourceMessageId: 'apollo-inbound' }));
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_messages')).rows[0].n).toBe(1);
    expect((await db.pool.query('SELECT kind FROM sdr_reply_actions ORDER BY kind')).rows.map(r => r.kind)).toEqual(['clear_sequence_flag','create_note', 'create_task', 'forward', 'stop_sequence']);
  });
  it('stops a negative human reply but does not forward or create a rep task', async () => {
    await enqueueReplyActions(db.pool, message({ intent: { kind: 'human', label: 'unsubscribe', worth: false } }));
    expect((await db.pool.query('SELECT kind FROM sdr_reply_actions ORDER BY kind')).rows.map(r => r.kind)).toEqual(['clear_sequence_flag','create_note', 'stop_sequence']);
  });
  it.each(['ambiguous', 'unlinked'])('keeps %s matching in durable review', async status => {
    await enqueueReplyActions(db.pool, message({ leadLink: { status, candidates: ['lead-a', 'lead-b'] } }));
    const rows=(await db.pool.query('SELECT kind,requires_review,safe_error,payload FROM sdr_reply_actions ORDER BY kind')).rows;
    expect(rows.map(({kind,requires_review,safe_error})=>({kind,requires_review,safe_error}))).toEqual([{kind:'forward',requires_review:false,safe_error:null},{kind:'match_lead',requires_review:true,safe_error:'lead_'+status}]);
    expect(rows[0].payload).toMatchObject({leadId:null,forwardTo:'real@example.test',projectReviewRequired:true});
    expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('enrolled');
  });
  it('requires explicitly verified routing even for admin/pm/sr aliases', async () => {
    await enqueueReplyActions(db.pool, message({ mailbox: 'pm@example.test' }));
    const { rows } = await db.pool.query("SELECT kind,requires_review,safe_error FROM sdr_reply_actions WHERE kind IN ('forward','create_task') ORDER BY kind");
    expect(rows).toEqual([{ kind: 'create_task', requires_review: true, safe_error: 'routing_unverified' }, { kind: 'forward', requires_review: true, safe_error: 'routing_unverified' }]);
  });
  it('records actual independent action receipts, not local replied status as provider removal', async () => {
    await enqueueReplyActions(db.pool, message());
    const counts = { stop: 0, forward: 0, task: 0, note: 0, clear:0 };
    const clients = {
      stop_sequence: async () => { counts.stop++; if(counts.stop === 1) throw Object.assign(new Error('limited'), { status: 429 }); return { id: 'provider-stop' }; },
      forward: async () => { counts.forward++; return { id: 'gmail-forward' }; },
      create_task: async () => { counts.task++; if(counts.task === 1) throw Object.assign(new Error('not applied'), { definiteFailure: true }); return { id: 'pd-task' }; },
      create_note: async () => { counts.note++; return { id: 'pd-note' }; },
      clear_sequence_flag:async()=>{counts.clear++;return {id:'pd-clear'};},
    };
    await drainReplyActions(db.pool, { clients, now, featureEnabled: true });
    await drainReplyActions(db.pool, { clients, now: new Date(+now + 5 * 60000), featureEnabled: true });
    expect(counts).toEqual({ stop: 2, forward: 1, task: 2, note: 1, clear:1 });
    const { rows } = await db.pool.query('SELECT kind,status,external_id,receipt_at FROM sdr_reply_actions ORDER BY kind');
    expect(rows.map(r => r.status)).toEqual(['completed','completed','completed','completed','completed']);
    expect(rows.map(r => r.external_id)).toEqual(['pd-clear','pd-note','pd-task','gmail-forward','provider-stop']);
    expect(rows.every(r => r.receipt_at instanceof Date)).toBe(true);
  });
  it('does not duplicate external work across simultaneous drainers', async () => {
    await enqueueReplyActions(db.pool, message({ intent: { kind: 'human', worth: false, label: 'no_action' } }));
    const ids = [];
    const execute = async action => { ids.push(action.id); return { id: action.id }; };
    await Promise.all([drainReplyActions(db.pool, { clients: { stop_sequence: execute, create_note: execute }, featureEnabled: true, now }), drainReplyActions(db.pool, { clients: { stop_sequence: execute, create_note: execute }, featureEnabled: true, now })]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
  it('keeps interrupted leased writes in review without resending them', async () => {
    await enqueueReplyActions(db.pool, message());
    await db.pool.query("UPDATE sdr_reply_actions SET status='running',lease_until=$1 WHERE kind='forward'", [new Date(+now - 1)]);
    const forward = vi.fn();
    await drainReplyActions(db.pool, { featureEnabled: true, now, clients: { forward } });
    expect(forward).not.toHaveBeenCalled();
    expect((await db.pool.query("SELECT status,requires_review,safe_error FROM sdr_reply_actions WHERE kind='forward'")).rows[0]).toEqual({ status: 'failed', requires_review: true, safe_error: 'completion_uncertain' });
  });
  it('makes a disabled drainer safe before migration', async () => {
    expect(await drainReplyActions({ query: () => { throw new Error('must not query'); } }, { featureEnabled: false })).toEqual({ skipped: 'disabled' });
  });
  it('does not remove a historical terminal send on a new observation', async () => {
    await db.pool.query("UPDATE sdr_sends SET status='replied'");
    await enqueueReplyActions(db.pool,message());
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='stop_sequence'")).rows[0].n).toBe(0);
  });
  it('uses the same advisory lock as the current send path', async () => {
    const sender = await db.pool.connect();
    await sender.query('BEGIN');
    await acquireLeadLock(sender,'lead-a');
    const enqueue = enqueueReplyActions(db.pool,message());
    try {
      expect(await Promise.race([enqueue.then(()=> 'completed'),new Promise(resolve=>setTimeout(()=>resolve('blocked'),30))])).toBe('blocked');
      await sender.query("INSERT INTO sdr_sends VALUES ('concurrent-send','lead-a','seq-new','contact-new','enrolled',NOW(),NOW())");
    } finally { await sender.query('COMMIT'); sender.release(); }
    await enqueue;
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_messages')).rows[0].n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='stop_sequence'")).rows[0].n).toBe(2);
  });
  it('retains distinct send generations when contact and campaign were reused',async()=>{
    const prior=(await db.pool.query('SELECT * FROM sdr_sends LIMIT 1')).rows[0];
    await db.pool.query("INSERT INTO sdr_sends VALUES ('reused-generation',$1,$2,$3,'enrolled',NOW(),NOW())",[prior.pipedrive_lead_id,prior.apollo_sequence_id,prior.apollo_contact_id]);
    await enqueueReplyActions(db.pool,message());
    expect((await db.pool.query("SELECT payload->>'sendId' id FROM sdr_reply_actions WHERE kind='stop_sequence'")).rows).toHaveLength(2);
  });
  it('queues flag clearing independently and waits for every frozen stop receipt without consuming attempts', async () => {
    await enqueueReplyActions(db.pool,message());
    const clear = vi.fn(async()=>({id:'lead-a'}));
    await drainReplyActions(db.pool,{featureEnabled:true,now,clients:{clear_sequence_flag:clear}});
    expect((await db.pool.query("SELECT status,attempts FROM sdr_reply_actions WHERE kind='clear_sequence_flag'")).rows).toEqual([{status:'pending',attempts:0}]);
    expect(clear).not.toHaveBeenCalled();
    await db.pool.query("UPDATE sdr_reply_actions SET status='completed',external_id='contact-a',receipt_at=$1 WHERE kind='stop_sequence'",[now]);
    await drainReplyActions(db.pool,{featureEnabled:true,now:new Date(+now+60000),clients:{clear_sequence_flag:clear}});
    expect(clear).toHaveBeenCalledTimes(1);
    expect((await db.pool.query("SELECT status,attempts,external_id FROM sdr_reply_actions WHERE kind='clear_sequence_flag'")).rows[0]).toEqual({status:'completed',attempts:1,external_id:'lead-a'});
  });
  it('does not treat a deleted or unresolved dependency as a completed stop', async () => {
    await enqueueReplyActions(db.pool,message());
    await db.pool.query("DELETE FROM sdr_reply_actions WHERE kind='stop_sequence'");
    const clear = vi.fn();
    await drainReplyActions(db.pool,{featureEnabled:true,now,clients:{clear_sequence_flag:clear}});
    expect(clear).not.toHaveBeenCalled();
    expect((await db.pool.query("SELECT status,attempts FROM sdr_reply_actions WHERE kind='clear_sequence_flag'")).rows).toEqual([{status:'pending',attempts:0}]);
  });
  it('gives a new pending stop priority over old uncertain forward reconciliation',async()=>{
    await enqueueReplyActions(db.pool,message());
    await db.pool.query("UPDATE sdr_reply_actions SET status='completed',external_id='done',receipt_at=$1 WHERE kind<>'forward'",[now]);
    await db.pool.query("UPDATE sdr_reply_actions SET status='failed',requires_review=true,safe_error='completion_uncertain',updated_at=$1 WHERE kind='forward'",[new Date(+now-60000)]);
    await db.pool.query("UPDATE sdr_sends SET status='enrolled'");
    await enqueueReplyActions(db.pool,message({messageId:'rfc822:<new-reply@example.test>'}));
    const stop=vi.fn(async()=>({id:'contact-a'}));const reconcile=vi.fn(async()=>({state:'unknown'}));
    await drainReplyActions(db.pool,{featureEnabled:true,now:new Date(+now+60000),limit:1,clients:{stop_sequence:stop,forward:{execute:vi.fn(),reconcile}}});
    expect(stop).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
