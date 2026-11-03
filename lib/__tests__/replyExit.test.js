import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import {
  replyExitMode, planMembershipExits, normalExitEmail, exitTargetKey, exitPersonEverywhere, exitIdentities,
  registerExitHook, exitHooks, resetExitHooksForTests, createExitPersonClient, enqueueExitOnly, hookLiveSequenceLeadIds, hookLiveSequenceLeads,
  backfillReplyExits, APOLLO_EXIT_DELAY_MS, requeueDryRunExits,
} from '../replyExit.js';
import { createReplyActionClients } from '../inboxReplyWatch.js';
import { runReplyAction, enqueueReplyActions, drainReplyActions } from '../sdrReplyActions.js';
import { recentReplyEmails, hasRecentReply } from '../recentReply.js';

const now = new Date('2026-11-03T15:00:00Z');
const membership = (campaign, status, extra = {}) => ({ emailer_campaign_id: campaign, status, emailer_campaign_contact_id: `m-${campaign}`, ...extra });

// In-memory Apollo: finish marks the membership finished; reads return copies.
function fakeApollo(contacts, { finishRefused = false, finishIgnored = false } = {}) {
  const state = structuredClone(contacts);
  const apollo = {
    state,
    getContact: vi.fn(async id => { if (!state[id]) throw Object.assign(new Error('nf'), { status: 404 }); return structuredClone(state[id]); }),
    findContactsByEmail: vi.fn(async email => Object.values(state).filter(c => c.email === email).map(c => structuredClone(c))),
    finishContactInSequence: vi.fn(async (campaign, id) => {
      if (finishRefused) throw Object.assign(new Error('refused'), { status: 422 });
      if (!finishIgnored) for (const s of state[id].contact_campaign_statuses) if (s.emailer_campaign_id === campaign) s.status = 'finished';
      return {};
    }),
  };
  return apollo;
}
// Pool double for the pure executor tests: no optional tables, no matching rows.
function fakePool() {
  const queries = [];
  const query = async (sql, params) => { queries.push({ sql, params }); return { rows: /to_regclass/.test(sql) ? [{ name: null }] : [], rowCount: 0 }; };
  return { queries, query, connect: async () => ({ query, release() {} }) };
}
const noLock = (_pool, _contact, _leads, work) => work();
const identities = extra => ({ emails: ['bill@gc.test'], leadIds: ['rx-lead-a'], personIds: ['p1'], contactIds: ['c1'], sendIds: [], linkedin: [], ...extra });
const pendingExit = { id: '00000000-0000-0000-0000-000000000001', kind: 'exit_person', status: 'pending', attempts: 0, retryAt: null, payload: {} };

afterEach(() => { vi.unstubAllEnvs(); resetExitHooksForTests(); });

describe('reply exit switches and identities', () => {
  it('defaults to off and accepts only the documented modes', () => {
    expect(replyExitMode({})).toBe('off');
    expect(replyExitMode({ SDR_REPLY_EXIT_MODE: 'dry_run' })).toBe('dry_run');
    expect(replyExitMode({ SDR_REPLY_EXIT_MODE: ' LIVE ' })).toBe('live');
    expect(replyExitMode({ SDR_REPLY_EXIT_MODE: 'true' })).toBe('off');
  });
  it('normalises the reply address and never treats our own mailboxes as the person', () => {
    expect(normalExitEmail('Bill Smith <Bill@GC.test>')).toBe('bill@gc.test');
    expect(normalExitEmail(' BILL@gc.test ')).toBe('bill@gc.test');
    expect(normalExitEmail('admin@proswppp.co')).toBeNull();
    expect(normalExitEmail('Derek <derek@proswppp.com>')).toBeNull();
    expect(normalExitEmail('not an address')).toBeNull();
    expect(exitTargetKey({ fromEmail: 'Bill <bill@gc.test>', leadId: 'rx-lead-a' })).toBe('exit:bill@gc.test');
    expect(exitTargetKey({ fromEmail: 'mf@proswppp.co', leadId: 'rx-lead-a' })).toBe('exit:lead:rx-lead-a');
    expect(exitTargetKey({})).toBeNull();
  });
});

describe('planMembershipExits', () => {
  it('keeps active and paused memberships and skips terminal ones', () => {
    const plan = planMembershipExits({ id: 'c1', contact_campaign_statuses: [membership('s1', 'active'), membership('s2', 'paused'),
      membership('s3', 'finished'), membership('s4', 'failed'), membership('s1', 'active')] });
    expect(plan.map(p => [p.campaignId, p.status])).toEqual([['s1', 'active'], ['s2', 'paused']]);
  });
  it.each([[null], [{}], [{ id: 'c1' }], [{ id: 'c1', contact_campaign_statuses: 'x' }], [{ id: 'c1', contact_campaign_statuses: [null] }],
    [{ id: 'c1', contact_campaign_statuses: [{ status: 'active' }] }]])('plans nothing for malformed contact %j', contact => {
    expect(planMembershipExits(contact)).toEqual([]);
  });
});

describe('exitPersonEverywhere (provider double)', () => {
  it('finishes every open sequence and takes the re-read as the receipt', async () => {
    const apollo = fakeApollo({ c1: { id: 'c1', email: 'bill@gc.test', contact_campaign_statuses: [membership('s1', 'active'), membership('s2', 'paused'), membership('s3', 'finished')] } });
    const receipt = await exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities(), mode: 'live', now, actionId: 'a1', lock: noLock, hookList: [] });
    expect(apollo.finishContactInSequence.mock.calls).toEqual([['s1', 'c1'], ['s2', 'c1']]);
    expect(apollo.getContact).toHaveBeenCalledTimes(2);
    expect(receipt).toMatchObject({ id: 'reply-exit:a1', finished: 2, contacts: 1 });
  });
  it('finds contacts this app never enrolled by exact email', async () => {
    const apollo = fakeApollo({ manual: { id: 'manual', email: 'bill@gc.test', contact_campaign_statuses: [membership('s9', 'active')] } });
    await exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities({ contactIds: [] }), mode: 'live', now, actionId: 'a1', lock: noLock, hookList: [] });
    expect(apollo.findContactsByEmail).toHaveBeenCalledWith('bill@gc.test');
    expect(apollo.finishContactInSequence).toHaveBeenCalledWith('s9', 'manual');
  });
  it('writes nothing to Apollo when every membership is already finished', async () => {
    const apollo = fakeApollo({ c1: { id: 'c1', email: 'x@gc.test', contact_campaign_statuses: [membership('s1', 'finished'), membership('s2', 'failed')] } });
    const receipt = await exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities(), mode: 'live', now, actionId: 'a1', lock: noLock, hookList: [] });
    expect(apollo.finishContactInSequence).not.toHaveBeenCalled();
    expect(apollo.getContact).toHaveBeenCalledTimes(1);
    expect(receipt.finished).toBe(0);
  });
  it('defers on a rate limit until Apollo says, without a hot retry or any write', async () => {
    const retryAt = new Date(+now + 3600000);
    const apollo = fakeApollo({});
    apollo.findContactsByEmail = vi.fn(async () => []);
    apollo.getContact = vi.fn(async () => { throw Object.assign(new Error('429'), { status: 429, retryAfterSec: 3600, retryAt }); });
    const result = await runReplyAction(pendingExit, { now, execute: () => exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities(), mode: 'live', now, actionId: 'a1', lock: noLock, hookList: [] }) });
    expect(result).toMatchObject({ status: 'failed', requiresReview: false, safeError: 'rate_limit', retryAt });
    expect(apollo.finishContactInSequence).not.toHaveBeenCalled();
  });
  it('does not complete when the write succeeded but the re-read still shows the membership active', async () => {
    const apollo = fakeApollo({ c1: { id: 'c1', email: 'x@gc.test', contact_campaign_statuses: [membership('s1', 'active')] } }, { finishIgnored: true });
    const result = await runReplyAction(pendingExit, { now, execute: () => exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities(), mode: 'live', now, actionId: 'a1', lock: noLock, hookList: [] }) });
    expect(result).toMatchObject({ status: 'failed', requiresReview: true, safeError: 'completion_uncertain', retryAt: null });
    expect(result.externalId).toBeFalsy();
    // Reconcile is read only: completed only once no membership of the person is open.
    const client = createExitPersonClient({ pool: fakePool(), apollo, mode: () => 'live' });
    const settle = () => runReplyAction(result, { now, execute: client.execute, reconcile: async action => {
      const found = await client.reconcile({ ...action, payload: { fromEmail: 'x@gc.test' } });
      return found.state === 'not_applied' ? { state: 'unknown' } : found;
    } });
    expect(await settle()).toMatchObject({ status: 'failed', safeError: 'completion_uncertain' });
    apollo.state.c1.contact_campaign_statuses[0].status = 'finished';
    expect(await settle()).toMatchObject({ status: 'completed', externalId: 'reply-exit:00000000-0000-0000-0000-000000000001' });
    expect(apollo.finishContactInSequence).toHaveBeenCalledTimes(1);
  });
  it('holds a refused write for review instead of retrying it', async () => {
    const apollo = fakeApollo({ c1: { id: 'c1', email: 'x@gc.test', contact_campaign_statuses: [membership('s1', 'active')] } }, { finishRefused: true });
    const result = await runReplyAction(pendingExit, { now, execute: () => exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities(), mode: 'live', now, actionId: 'a1', lock: noLock, hookList: [] }) });
    expect(result).toMatchObject({ status: 'failed', requiresReview: true, safeError: 'exit_review', retryAt: null });
  });
  it('dry run reads and plans but never finishes a membership or runs a live hook', async () => {
    const exit = vi.fn(), preview = vi.fn(async () => ({ wouldCancel: 1 }));
    const apollo = fakeApollo({ c1: { id: 'c1', email: 'bill@gc.test', contact_campaign_statuses: [membership('s1', 'active')] } });
    const receipt = await exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities(), mode: 'dry_run', now, actionId: 'a1', lock: noLock, hookList: [{ name: 'bid_invites', exit, preview }] });
    expect(apollo.finishContactInSequence).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({ mode: 'dry_run', contacts: 1, finished: 0 });
  });
  it('does nothing at all when the mode is off', async () => {
    const apollo = fakeApollo({ c1: { id: 'c1', contact_campaign_statuses: [membership('s1', 'active')] } });
    const pool = fakePool();
    expect(await exitPersonEverywhere({ pool, apollo, identities: identities(), mode: 'off', lock: noLock })).toEqual({ skipped: true, reason: 'no_action' });
    expect(apollo.getContact).not.toHaveBeenCalled();
    expect(pool.queries).toEqual([]);
    const client = createExitPersonClient({ pool, apollo, mode: () => 'off' });
    expect(await runReplyAction(pendingExit, { now, execute: client.execute })).toMatchObject({ status: 'skipped', safeError: 'no_action' });
  });
  it('runs every live hook once with the person and retries when one fails', async () => {
    const good = vi.fn(async () => ({ cancelled: 2 }));
    const bad = vi.fn(async () => { throw new Error('boom'); });
    const apollo = fakeApollo({});
    const run = hookList => exitPersonEverywhere({ pool: fakePool(), apollo, identities: identities({ contactIds: [] }), mode: 'live', now, actionId: 'a1', lock: noLock, hookList });
    await run([{ name: 'good', exit: good }]);
    expect(good).toHaveBeenCalledTimes(1);
    expect(good.mock.calls[0][0]).toMatchObject({ emails: ['bill@gc.test'], leadIds: ['rx-lead-a'], personIds: ['p1'], mode: 'live', now });
    const result = await runReplyAction(pendingExit, { now, execute: () => run([{ name: 'bad', exit: bad }]) });
    expect(result).toMatchObject({ status: 'failed', requiresReview: false, safeError: 'definite_failure' });
  });
});

describe('exit hook registry', () => {
  it('validates hooks and returns an unregister function', async () => {
    expect(() => registerExitHook('', () => {})).toThrow('exit_hook_name_required');
    expect(() => registerExitHook('x', {})).toThrow('exit_hook_function_required');
    expect(() => registerExitHook('x', { exit() {}, preview: 1 })).toThrow('exit_hook_preview_invalid');
    const off = registerExitHook('bid_invites', { exit: async () => ({ cancelled: 0 }), liveSequenceLeadIds: async () => ['lead-9', 'lead-9'] });
    registerExitHook('broken', { exit: async () => ({}), liveSequenceLeadIds: async () => { throw new Error('x'); } });
    expect(exitHooks().map(h => h.name)).toEqual(['bid_invites', 'broken']);
    expect(await hookLiveSequenceLeadIds({})).toEqual(['lead-9']);
    off();
    expect(exitHooks().map(h => h.name)).toEqual(['broken']);
  });
  it('scoped live-sequence leads carry the address and the first email time; an incomplete entry licenses nothing', async () => {
    resetExitHooksForTests();
    registerExitHook('plain', { exit: async () => ({}), liveSequenceLeadIds: async () => ['lead-1'] });
    registerExitHook('scoped', { exit: async () => ({}), liveSequenceLeads: async () => [
      { leadId: 'lead-2', email: ' Bob@GC.test ', since: '2026-11-03T22:10:00Z' },
      { leadId: 'lead-3', email: null, since: '2026-11-03T22:10:00Z' },
      { leadId: 'lead-4', email: 'x@gc.test', since: null },
    ] });
    registerExitHook('broken', { exit: async () => ({}), liveSequenceLeads: async () => { throw new Error('x'); } });
    expect(await hookLiveSequenceLeads({})).toEqual([
      { leadId: 'lead-1', email: null, since: null },
      { leadId: 'lead-2', email: 'bob@gc.test', since: '2026-11-03T22:10:00.000Z' },
    ]);
    expect(() => registerExitHook('bad', { exit() {}, liveSequenceLeads: 1 })).toThrow('exit_hook_liveSequenceLeads_invalid');
    resetExitHooksForTests();
  });
});

const db = reportingTestDb('reply_exit');
describe.skipIf(!db)('reply exit (local Postgres)', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY, pipedrive_person_id text, person_email text, lead_title text, sequence_started text);
      CREATE TABLE sdr_drafts(id uuid PRIMARY KEY, pipedrive_lead_id text, contact_id_snapshot text, contact_email_snapshot text, status text, sent_at timestamptz, reject_reason text, updated_at timestamptz DEFAULT now());
      CREATE TABLE sdr_sends(id uuid PRIMARY KEY, draft_id uuid, pipedrive_lead_id text, apollo_sequence_id text, apollo_contact_id text, status text, sent_at timestamptz DEFAULT now(), last_status_at timestamptz, updated_at timestamptz);
      CREATE TABLE sdr_linkedin_links(company_id text, account_id text, candidate_id uuid, person_id text, lead_id text, verified_email text, apollo_contact_id text, status text DEFAULT 'verified', created_at timestamptz DEFAULT now());
      CREATE TABLE sdr_linkedin_candidates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text, account_id text, person_id text, state text, hold_reason text, revision int DEFAULT 1);
      CREATE TABLE sdr_linkedin_actions(company_id text, account_id text, person_id text, state text);
      CREATE TABLE sdr_message_facts(provider text, provider_message_id text, direction text, prospect_email text, human_reply boolean, occurred_at timestamptz);`);
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-reply-actions.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-11-03-sdr-reply-exit.sql', import.meta.url), 'utf8'));
    // Re-applying is a no-op.
    await db.pool.query(await readFile(new URL('../../migrations/2026-11-03-sdr-reply-exit.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  const D = n => `00000000-0000-0000-0000-00000000000${n}`;
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE sdr_reply_exits, sdr_reply_actions, sdr_reply_messages, sdr_reply_routes, sdr_sends, sdr_drafts, sdr_lead_state,
      sdr_linkedin_links, sdr_linkedin_candidates, sdr_linkedin_actions, sdr_message_facts`);
    // Same person (Pipedrive person p1) on two projects, each live in its own sequence, plus a
    // queued draft for a third project; an unrelated person on rx-lead-z.
    await db.pool.query(`INSERT INTO sdr_lead_state VALUES ('rx-lead-a','p1','bill@gc.test','Project A',NULL),('rx-lead-b','p1','bill@gc.test','Project B',NULL),
      ('rx-lead-c','p1','bill@gc.test','Project C',NULL),('rx-lead-z','p9','zed@other.test','Project Z',NULL)`);
    await db.pool.query(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,contact_id_snapshot,contact_email_snapshot,status) VALUES
      ('${D(1)}','rx-lead-a','p1','bill@gc.test','sent'),('${D(2)}','rx-lead-b','p1','bill@gc.test','sent'),('${D(3)}','rx-lead-c','p1','bill@gc.test','pending'),
      ('${D(4)}','rx-lead-z','p9','zed@other.test','pending'),('${D(5)}','rx-lead-z','p9','zed@other.test','sent')`);
    await db.pool.query(`INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,status) VALUES
      ('${D(6)}','${D(1)}','rx-lead-a','seq-agc','c1','enrolled'),('${D(7)}','${D(2)}','rx-lead-b','seq-lba','c1','sent'),('${D(8)}','${D(5)}','rx-lead-z','seq-agc','cz','enrolled')`);
    await db.pool.query("INSERT INTO sdr_reply_routes(mailbox_email, forward_to, pipedrive_user_id, verified_at) VALUES ('rep@proswppp.co','derek@proswppp.com',7,NOW())");
    await db.pool.query(`INSERT INTO sdr_linkedin_links(company_id,account_id,person_id,lead_id,verified_email) VALUES ('co','acct','li-1','rx-lead-a','bill@gc.test');
      INSERT INTO sdr_linkedin_candidates(company_id,account_id,person_id,state) VALUES ('co','acct','li-1','pending'),('co','acct','li-9','pending');
      INSERT INTO sdr_linkedin_actions VALUES ('co','acct','li-1','pending'),('co','acct','li-9','pending')`);
  });
  const reply = extra => ({ messageId: 'rfc822:<r1@gc.test>', sourceMessageId: 'g1', threadId: 't1', mailbox: 'rep@proswppp.co', receivedAt: now,
    fromEmail: 'Bill <Bill@gc.test>', leadLink: { status: 'verified', leadId: 'rx-lead-a' }, intent: { kind: 'human', label: 'interested', worth: true }, ...extra });
  const apolloState = () => fakeApollo({
    c1: { id: 'c1', email: 'bill@gc.test', contact_campaign_statuses: [membership('seq-agc', 'active'), membership('seq-lba', 'active'), membership('seq-manual', 'paused')] },
    cz: { id: 'cz', email: 'zed@other.test', contact_campaign_statuses: [membership('seq-agc', 'active')] },
  });
  const drainExit = apollo => drainReplyActions(db.pool, { featureEnabled: true, now, clients: { exit_person: createExitPersonClient({ pool: db.pool, apollo, now: () => now }) } });
  const kinds = async () => (await db.pool.query('SELECT kind, target_key FROM sdr_reply_actions ORDER BY kind, target_key')).rows;

  it('leaves the action list unchanged with the mode off and still stores the sender', async () => {
    await enqueueReplyActions(db.pool, reply());
    expect((await kinds()).map(k => k.kind)).toEqual(['clear_sequence_flag', 'create_note', 'create_task', 'forward', 'stop_sequence']);
    expect((await db.pool.query('SELECT from_email FROM sdr_reply_messages')).rows[0].from_email).toBe('bill@gc.test');
  });
  it('a reply on project A exits the same person from project B, every sequence, and cancels queued drafts', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueReplyActions(db.pool, reply());
    expect((await kinds()).filter(k => k.kind === 'exit_person')).toEqual([{ kind: 'exit_person', target_key: 'exit:bill@gc.test' }]);
    // The project's own stop marks rx-lead-a replied; rx-lead-b is only reached by the exit.
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE pipedrive_lead_id='rx-lead-b'")).rows[0].status).toBe('sent');
    const apollo = apolloState();
    const result = await drainExit(apollo);
    expect(result.counts).toMatchObject({ completed: 1, failed: 0 });
    expect(apollo.finishContactInSequence.mock.calls.sort()).toEqual([['seq-agc', 'c1'], ['seq-lba', 'c1'], ['seq-manual', 'c1']]);
    expect(apollo.state.cz.contact_campaign_statuses[0].status).toBe('active');
    const sends = Object.fromEntries((await db.pool.query('SELECT pipedrive_lead_id, status FROM sdr_sends')).rows.map(r => [r.pipedrive_lead_id, r.status]));
    expect(sends).toEqual({ 'rx-lead-a': 'replied', 'rx-lead-b': 'replied', 'rx-lead-z': 'enrolled' });
    const drafts = Object.fromEntries((await db.pool.query('SELECT pipedrive_lead_id, status, reject_reason FROM sdr_drafts WHERE status<>\'sent\'')).rows.map(r => [r.pipedrive_lead_id, [r.status, r.reject_reason]]));
    expect(drafts).toEqual({ 'rx-lead-c': ['cancelled', 'reply_exit'], 'rx-lead-z': ['pending', null] });
    // LinkedIn work for the same person is held; another person's is untouched.
    expect((await db.pool.query('SELECT person_id, state, hold_reason FROM sdr_linkedin_candidates ORDER BY person_id')).rows)
      .toEqual([{ person_id: 'li-1', state: 'held', hold_reason: 'email_reply' }, { person_id: 'li-9', state: 'pending', hold_reason: null }]);
    expect((await db.pool.query('SELECT person_id, state FROM sdr_linkedin_actions ORDER BY person_id')).rows.map(r => r.state)).toEqual(['cancelled', 'pending']);
    const record = (await db.pool.query('SELECT mode, identities, outcome FROM sdr_reply_exits')).rows[0];
    expect(record.mode).toBe('live');
    expect(record.identities.leadIds).toEqual(['rx-lead-a', 'rx-lead-b', 'rx-lead-c']);
    expect(record.outcome.finished).toHaveLength(3);
  });
  it('is idempotent: the same reply again adds nothing and a second drain writes nothing', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueReplyActions(db.pool, reply());
    const apollo = apolloState();
    await drainExit(apollo);
    const before = (await db.pool.query('SELECT count(*)::int n FROM sdr_reply_actions')).rows[0].n;
    expect(await enqueueReplyActions(db.pool, reply())).toMatchObject({ detected: 0, enqueued: 0 });
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_actions')).rows[0].n).toBe(before);
    const again = await drainExit(apollo);
    expect(again.counts.attempted).toBe(0);
    expect(apollo.finishContactInSequence).toHaveBeenCalledTimes(3);
  });
  it('an unlinked reply still exits the person by address', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueReplyActions(db.pool, reply({ leadLink: { status: 'unlinked' } }));
    expect((await kinds()).filter(k => k.kind === 'exit_person')).toEqual([{ kind: 'exit_person', target_key: 'exit:bill@gc.test' }]);
    const apollo = apolloState();
    await drainExit(apollo);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_sends WHERE status='replied'")).rows[0].n).toBe(2);
  });
  it('does not exit on an out-of-office or a bounce', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueReplyActions(db.pool, reply({ intent: { kind: 'auto', label: 'auto' } }));
    await enqueueReplyActions(db.pool, reply({ messageId: 'rfc822:<b1@gc.test>', intent: { kind: 'bounce', label: 'bounce' } }));
    expect((await kinds()).filter(k => k.kind === 'exit_person')).toEqual([]);
  });
  it('dry run records the plan and changes nothing', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'dry_run');
    await enqueueReplyActions(db.pool, reply());
    const apollo = apolloState();
    await drainExit(apollo);
    expect(apollo.finishContactInSequence).not.toHaveBeenCalled();
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE pipedrive_lead_id='rx-lead-b'")).rows[0].status).toBe('sent');
    expect((await db.pool.query("SELECT status FROM sdr_drafts WHERE pipedrive_lead_id='rx-lead-c'")).rows[0].status).toBe('pending');
    const record = (await db.pool.query('SELECT mode, plan FROM sdr_reply_exits')).rows[0];
    expect(record.mode).toBe('dry_run');
    expect(record.plan.contacts[0].open.map(m => m.campaignId)).toEqual(['seq-agc', 'seq-lba', 'seq-manual']);
    expect(record.plan.drafts).toHaveLength(1);
    expect(record.plan.linkedin).toEqual({ candidates: 1, actions: 1 });
  });
  it('calls a registered hook once with the person', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    const exit = vi.fn(async () => ({ cancelled: 1 }));
    registerExitHook('bid_invites', { exit });
    await enqueueReplyActions(db.pool, reply());
    await drainExit(apolloState());
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0][0]).toMatchObject({ emails: ['bill@gc.test'], personIds: ['p1'], mode: 'live' });
    expect(exit.mock.calls[0][0].leadIds).toEqual(['rx-lead-a', 'rx-lead-b', 'rx-lead-c']);
  });
  it('exits only the sender: a colleague on the thread is not the project person', async () => {
    const colleague = await exitIdentities(db.pool, { fromEmail: 'colleague@gc.test', leadId: 'rx-lead-a' });
    expect(colleague).toMatchObject({ emails: ['colleague@gc.test'], leadIds: ['rx-lead-a'], personIds: [], contactIds: [], sendIds: [] });
    const bill = await exitIdentities(db.pool, { fromEmail: 'Bill@gc.test', leadId: 'rx-lead-a' });
    expect(bill).toMatchObject({ emails: ['bill@gc.test'], leadIds: ['rx-lead-a', 'rx-lead-b', 'rx-lead-c'], personIds: ['p1'], contactIds: ['c1'] });
    expect(bill.linkedin).toEqual([{ companyId: 'co', accountId: 'acct', personId: 'li-1' }]);
  });
  it('a reply from the new contact never exits the old one (contact changed on the project)', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    // rx-lead-a's contact is now Alice; its live send still goes to Bill (c1).
    await db.pool.query("UPDATE sdr_lead_state SET pipedrive_person_id='p2', person_email='alice@gc.test' WHERE pipedrive_lead_id='rx-lead-a'");
    await enqueueReplyActions(db.pool, reply({ fromEmail: 'Alice <alice@gc.test>' }));
    const apollo = apolloState();
    await drainExit(apollo);
    expect(apollo.finishContactInSequence).not.toHaveBeenCalled();
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE pipedrive_lead_id='rx-lead-b'")).rows[0].status).toBe('sent');
    expect((await db.pool.query("SELECT status FROM sdr_drafts WHERE pipedrive_lead_id='rx-lead-c'")).rows[0].status).toBe('pending');
  });
  it('a reply from our own mailbox exits nobody', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueReplyActions(db.pool, reply({ fromEmail: 'mf@proswppp.co' }));
    expect((await kinds()).filter(k => k.kind === 'exit_person')).toEqual([]);
  });
  it('dry-run exits run for real once the mode is live', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'dry_run');
    await enqueueReplyActions(db.pool, reply());
    const apollo = apolloState();
    await drainExit(apollo);
    expect((await db.pool.query("SELECT status, external_id FROM sdr_reply_actions WHERE kind='exit_person'")).rows[0]).toMatchObject({ status: 'completed', external_id: expect.stringMatching(/^reply-exit-dry:/) });
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    const result = await drainExit(apollo);
    expect(result.counts).toMatchObject({ completed: 1 });
    expect(apollo.finishContactInSequence).toHaveBeenCalledTimes(3);
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE pipedrive_lead_id='rx-lead-b'")).rows[0].status).toBe('replied');
    expect((await db.pool.query('SELECT mode FROM sdr_reply_exits')).rows[0].mode).toBe('live');
    expect((await drainExit(apollo)).counts.attempted).toBe(0);
  });
  it('mode off leaves queued exits untouched; a backfill covers replies from before the switch', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'off');
    expect(createReplyActionClients({ pool: db.pool, getToken: async () => 't' })).not.toHaveProperty('exit_person');
    await enqueueReplyActions(db.pool, reply());
    expect((await kinds()).filter(k => k.kind === 'exit_person')).toEqual([]);
    const plan = await backfillReplyExits(db.pool, { days: 30, now: new Date(+now + 86400000) });
    expect(plan).toMatchObject({ dryRun: true, count: 1, planned: [{ fromEmail: 'bill@gc.test', leadId: 'rx-lead-a', target: 'exit:bill@gc.test' }] });
    expect((await kinds()).filter(k => k.kind === 'exit_person')).toEqual([]);
    await backfillReplyExits(db.pool, { days: 30, now: new Date(+now + 86400000), dryRun: false });
    expect((await backfillReplyExits(db.pool, { days: 30, now: new Date(+now + 86400000) })).count).toBe(0);
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    expect(createReplyActionClients({ pool: db.pool, getToken: async () => 't' })).toHaveProperty('exit_person');
    const apollo = apolloState();
    await drainExit(apollo);
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE pipedrive_lead_id='rx-lead-b'")).rows[0].status).toBe('replied');
  });
  it('one bad contact never blocks the rest: 422 is absent, a 500 is recorded and retried, local rows always change', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueReplyActions(db.pool, reply());
    const apollo = apolloState();
    apollo.state.stale = { id: 'stale', email: 'bill@gc.test', contact_campaign_statuses: [] };
    apollo.state.broken = { id: 'broken', email: 'bill@gc.test', contact_campaign_statuses: [] };
    const read = apollo.getContact.getMockImplementation();
    apollo.getContact.mockImplementation(async id => {
      if (id === 'stale') throw Object.assign(new Error('gone'), { status: 422 });
      if (id === 'broken') throw Object.assign(new Error('boom'), { status: 500 });
      return read(id);
    });
    const result = await drainExit(apollo);
    expect(result.counts).toMatchObject({ deferred: 1, completed: 0 });
    expect(apollo.finishContactInSequence).toHaveBeenCalledTimes(3);
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE pipedrive_lead_id='rx-lead-b'")).rows[0].status).toBe('replied');
    expect((await db.pool.query("SELECT status FROM sdr_drafts WHERE pipedrive_lead_id='rx-lead-c'")).rows[0].status).toBe('cancelled');
    expect((await db.pool.query("SELECT status, safe_error, requires_review FROM sdr_reply_actions WHERE kind='exit_person'")).rows[0])
      .toEqual({ status: 'failed', safe_error: 'definite_failure', requires_review: false });
    const outcome = (await db.pool.query('SELECT outcome FROM sdr_reply_exits')).rows[0].outcome;
    expect(outcome.skippedContacts).toEqual([{ contactId: 'stale', reason: 'contact_absent' }]);
    expect(outcome.contactErrors).toEqual([{ contactId: 'broken', step: 'contact_read', status: 500 }]);
  });
  it('records an Apollo-only reply as an exit trigger that readers of inbox replies never see', async () => {
    const input = { messageId: 'apollo:ev-1', source: 'apollo', mailbox: 'rep@proswppp.co', receivedAt: now, leadId: 'rx-lead-a', fromEmail: 'bill@gc.test',
      threadId: 'chat-9', intent: 'apollo_detected', providerEventAt: '2026-10-30T10:00:00Z', mode: 'live' };
    expect(await enqueueExitOnly(db.pool, { ...input, mode: 'off' })).toEqual({ skipped: 'disabled' });
    expect(await enqueueExitOnly(db.pool, input)).toEqual({ detected: 1, enqueued: 1 });
    expect(await enqueueExitOnly(db.pool, input)).toEqual({ detected: 0, enqueued: 0 });
    const row = (await db.pool.query('SELECT reply_kind, pipedrive_lead_id, thread_id, link_status, from_email, received_at FROM sdr_reply_messages')).rows[0];
    expect(row).toMatchObject({ reply_kind: 'exit_signal', pipedrive_lead_id: null, thread_id: null, link_status: 'unlinked', from_email: 'bill@gc.test' });
    expect(+row.received_at).toBe(+now);
    const action = (await db.pool.query("SELECT target_key, payload, retry_at FROM sdr_reply_actions WHERE kind='exit_person'")).rows[0];
    expect(action).toMatchObject({ target_key: 'exit:bill@gc.test', payload: { exitLeadId: 'rx-lead-a', sourceThreadId: 'chat-9', providerEventAt: '2026-10-30T10:00:00Z' } });
    expect(action.payload).not.toHaveProperty('leadId');
    expect(+action.retry_at).toBe(+now + APOLLO_EXIT_DELAY_MS);
    // Not an inbox reply: the 180-day fence waits until the Apollo exit has actually run live.
    expect(await hasRecentReply(db.pool, 'bill@gc.test')).toBe(false);
    await db.pool.query('TRUNCATE sdr_reply_actions, sdr_reply_messages');
    await enqueueReplyActions(db.pool, reply());
    expect(await enqueueExitOnly(db.pool, input)).toEqual({ skipped: 'reply_already_recorded' });
  });
  it('never exits on an Apollo "reply" the inbox classified as out-of-office, before or after', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    const input = { messageId: 'apollo:ev-2', source: 'apollo', mailbox: 'rep@proswppp.co', receivedAt: now, fromEmail: 'bill@gc.test', mode: 'live' };
    // Inbox first: the Apollo trigger is not recorded at all.
    await enqueueReplyActions(db.pool, reply({ messageId: 'rfc822:<ooo1@gc.test>', intent: { kind: 'auto', label: 'auto' } }));
    expect(await enqueueExitOnly(db.pool, input)).toEqual({ skipped: 'classified_automatic' });
    // Apollo first: it waits, then the inbox classifies the message as automatic, so it is skipped.
    await db.pool.query('TRUNCATE sdr_reply_actions, sdr_reply_messages');
    expect(await enqueueExitOnly(db.pool, input)).toEqual({ detected: 1, enqueued: 1 });
    const apollo = apolloState();
    expect((await drainExit(apollo)).counts.attempted).toBe(0);
    await enqueueReplyActions(db.pool, reply({ messageId: 'rfc822:<ooo2@gc.test>', intent: { kind: 'auto', label: 'auto' } }));
    const later = new Date(+now + APOLLO_EXIT_DELAY_MS + 60000);
    await drainReplyActions(db.pool, { featureEnabled: true, now: later, clients: { exit_person: createExitPersonClient({ pool: db.pool, apollo, now: () => later }) } });
    expect((await db.pool.query("SELECT status, safe_error FROM sdr_reply_actions WHERE kind='exit_person'")).rows[0]).toEqual({ status: 'skipped', safe_error: 'no_action' });
    expect(apollo.getContact).not.toHaveBeenCalled();
    expect(await hasRecentReply(db.pool, 'bill@gc.test')).toBe(false);
  });
  it('an Apollo-only reply with no inbox copy exits the person after the delay and then fences them', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueExitOnly(db.pool, { messageId: 'apollo:ev-3', source: 'apollo', mailbox: 'apollo', receivedAt: now, fromEmail: 'bill@gc.test', mode: 'live' });
    const apollo = apolloState();
    const later = new Date(+now + APOLLO_EXIT_DELAY_MS + 60000);
    const result = await drainReplyActions(db.pool, { featureEnabled: true, now: later, clients: { exit_person: createExitPersonClient({ pool: db.pool, apollo, now: () => later }) } });
    expect(result.counts.completed).toBe(1);
    expect(apollo.finishContactInSequence).toHaveBeenCalledTimes(3);
    expect(await hasRecentReply(db.pool, 'bill@gc.test')).toBe(true);
  });
  it('the 180-day fence reads human senders and non-Apollo exit triggers, and ignores auto-replies', async () => {
    await enqueueReplyActions(db.pool, reply());
    await enqueueReplyActions(db.pool, reply({ messageId: 'rfc822:<ooo@x.test>', fromEmail: 'ooo@x.test', leadLink: { status: 'unlinked' }, intent: { kind: 'auto', label: 'auto' } }));
    await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,link_status,reply_kind,from_email)
      VALUES ('old','gmail','old','rep@proswppp.co',NOW()-INTERVAL '200 days','unlinked','human','old@x.test')`);
    await enqueueExitOnly(db.pool, { messageId: 'bid:1', source: 'bid_invite', mailbox: 'rep@proswppp.co', receivedAt: new Date(), fromEmail: 'estimator@bid.test', mode: 'live' });
    expect([...await recentReplyEmails(db.pool)].sort()).toEqual(['bill@gc.test', 'estimator@bid.test']);
    expect(await hasRecentReply(db.pool, 'BILL@gc.test')).toBe(true);
    expect(await hasRecentReply(db.pool, 'ooo@x.test')).toBe(false);
    expect(await hasRecentReply(db.pool, 'old@x.test')).toBe(false);
  });
  it('stores the reply time and never finishes a membership a rep added after the reply', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'dry_run');
    await enqueueReplyActions(db.pool, reply());
    expect((await db.pool.query("SELECT payload->>'replyAt' AS at FROM sdr_reply_actions WHERE kind='exit_person'")).rows[0].at).toBe(now.toISOString());
    const apollo = apolloState();
    await drainExit(apollo);
    // After reading the reply, the rep re-enrolled Bill in seq-lba on purpose.
    apollo.state.c1.contact_campaign_statuses = [membership('seq-agc', 'active', { added_at: '2026-10-20T15:00:00Z' }),
      membership('seq-lba', 'active', { added_at: new Date(+now + 2 * 86400000).toISOString() }), membership('seq-manual', 'paused')];
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    const later = new Date(+now + 3 * 86400000);
    const result = await drainReplyActions(db.pool, { featureEnabled: true, now: later, clients: { exit_person: createExitPersonClient({ pool: db.pool, apollo, now: () => later }) } });
    expect(result.counts.completed).toBe(1);
    expect(apollo.finishContactInSequence.mock.calls.sort()).toEqual([['seq-agc', 'c1'], ['seq-manual', 'c1']]);
    expect(apollo.state.c1.contact_campaign_statuses.find(s => s.emailer_campaign_id === 'seq-lba').status).toBe('active');
    expect((await db.pool.query('SELECT plan FROM sdr_reply_exits')).rows[0].plan.contacts[0].reEnrolledAfterReply).toEqual(['seq-lba']);
  });
  it('re-runs dry-run exits for replies from the last 14 days only', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'dry_run');
    await enqueueReplyActions(db.pool, reply());
    await drainExit(apolloState());
    await db.pool.query("UPDATE sdr_reply_actions SET created_at=$1 WHERE kind='exit_person'", [new Date(+now - 20 * 86400000)]);
    expect(await requeueDryRunExits(db.pool, { now })).toBe(0);
    await db.pool.query("UPDATE sdr_reply_actions SET created_at=$1 WHERE kind='exit_person'", [new Date(+now - 13 * 86400000)]);
    expect(await requeueDryRunExits(db.pool, { now })).toBe(1);
    expect((await db.pool.query("SELECT status, payload->>'requeued' AS r FROM sdr_reply_actions WHERE kind='exit_person'")).rows[0]).toEqual({ status: 'pending', r: 'true' });
  });
  it('runs re-queued and backfilled exits after fresh reply work', async () => {
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    await enqueueReplyActions(db.pool, reply());
    await db.pool.query("UPDATE sdr_reply_actions SET payload=payload||'{\"requeued\":true}'::jsonb WHERE kind='exit_person'");
    const order = [];
    const exit = createExitPersonClient({ pool: db.pool, apollo: apolloState(), now: () => now });
    const clients = { exit_person: { ...exit, execute: async a => { order.push('exit_person'); return exit.execute(a); } },
      forward: async () => { order.push('forward'); return { id: 'f1' }; }, create_note: async () => { order.push('create_note'); return { id: 'n1' }; } };
    await drainReplyActions(db.pool, { featureEnabled: true, now, limit: 2, clients });
    expect([...order].sort()).toEqual(['create_note', 'forward']);
    await drainReplyActions(db.pool, { featureEnabled: true, now, limit: 2, clients });
    expect(order.at(-1)).toBe('exit_person');
    // A fresh exit still goes first.
    await db.pool.query('TRUNCATE sdr_reply_actions, sdr_reply_messages CASCADE');
    await enqueueReplyActions(db.pool, reply({ messageId: 'rfc822:<r2@gc.test>' }));
    order.length = 0;
    await drainReplyActions(db.pool, { featureEnabled: true, now, limit: 1, clients });
    expect(order).toEqual(['exit_person']);
  });
  it('a pending Apollo trigger never blocks a LinkedIn or bid-invite exit; a live-exited one does', async () => {
    const apolloInput = { messageId: 'apollo:ev-4', source: 'apollo', mailbox: 'rep@proswppp.co', receivedAt: now, fromEmail: 'bill@gc.test', mode: 'live' };
    const bid = { messageId: 'bid:9', source: 'bid_invite', mailbox: 'rep@proswppp.co', receivedAt: new Date(+now + 600000), fromEmail: 'bill@gc.test', mode: 'live' };
    await enqueueExitOnly(db.pool, apolloInput);
    expect(await enqueueExitOnly(db.pool, bid)).toEqual({ detected: 1, enqueued: 1 });
    // The Apollo one, when it runs, defers to the bid exit.
    vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
    const apollo = apolloState();
    const later = new Date(+now + APOLLO_EXIT_DELAY_MS + 60000);
    await drainReplyActions(db.pool, { featureEnabled: true, now: later, clients: { exit_person: createExitPersonClient({ pool: db.pool, apollo, now: () => later }) } });
    const rows = Object.fromEntries((await db.pool.query("SELECT provider_message_id, status, safe_error FROM sdr_reply_actions WHERE kind='exit_person'")).rows.map(r => [r.provider_message_id, [r.status, r.safe_error]]));
    expect(rows).toEqual({ 'bid:9': ['completed', null], 'apollo:ev-4': ['skipped', 'duplicate'] });
    // Once an Apollo trigger has exited live, a later bid reply from the same address is a duplicate.
    await db.pool.query('TRUNCATE sdr_reply_actions, sdr_reply_messages CASCADE');
    await enqueueExitOnly(db.pool, apolloInput);
    await drainReplyActions(db.pool, { featureEnabled: true, now: later, clients: { exit_person: createExitPersonClient({ pool: db.pool, apollo, now: () => later }) } });
    expect(await enqueueExitOnly(db.pool, bid)).toEqual({ skipped: 'reply_already_recorded' });
  });
  it('cancels an Apollo trigger as automatic only for the same mailbox and day', async () => {
    const auto = extra => enqueueReplyActions(db.pool, reply({ messageId: `rfc822:<auto-${Math.random()}@gc.test>`, intent: { kind: 'auto', label: 'auto' }, ...extra }));
    const input = { messageId: 'apollo:ev-5', source: 'apollo', mailbox: 'rep@proswppp.co', receivedAt: now, fromEmail: 'bill@gc.test', mode: 'live' };
    await auto({ mailbox: 'other@proswppp.co' });
    await auto({ receivedAt: new Date(+now - 2 * 86400000) });
    expect(await enqueueExitOnly(db.pool, input)).toEqual({ detected: 1, enqueued: 1 });
    await db.pool.query("DELETE FROM sdr_reply_actions WHERE provider_message_id='apollo:ev-5'");
    await db.pool.query("DELETE FROM sdr_reply_messages WHERE provider_message_id='apollo:ev-5'");
    await auto({ receivedAt: new Date(+now - 3600000) });
    expect(await enqueueExitOnly(db.pool, input)).toEqual({ skipped: 'classified_automatic' });
    // With no mailbox from Apollo, the address and day decide.
    expect(await enqueueExitOnly(db.pool, { ...input, messageId: 'apollo:ev-6', mailbox: 'apollo' })).toEqual({ skipped: 'classified_automatic' });
  });
});
