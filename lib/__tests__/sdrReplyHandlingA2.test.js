// A2 reply handling (system review 2026-10-26): replies to a rep's proswppp.com inbox,
// real Apollo stop on reply, task content/dedupe, unsubscribe hold, classifier health.
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { enqueueReplyActions, drainReplyActions, runReplyAction, backfillMissingReplyTasks } from '../sdrReplyActions.js';
import { collectPipedriveReplies, classifyPipedriveReply } from '../sdrPipedriveReplyIntake.js';
import { createReplyActionClients, isDepartureNotice } from '../inboxReplyWatch.js';
import { nextBusinessMorning, replyExcerpt, companyFrom } from '../sdrReplyTask.js';

describe('task helpers', () => {
  it.each([
    ['2026-10-19T12:00:00Z', '2026-10-19', '14:00'], // Monday 07:00 Chicago -> same day 09:00 (CDT = UTC-5)
    ['2026-10-19T19:00:00Z', '2026-10-20', '14:00'], // Monday 14:00 -> Tuesday
    ['2026-10-16T20:00:00Z', '2026-10-19', '14:00'], // Friday afternoon -> Monday
    ['2026-10-04T15:00:00Z', '2026-10-05', '14:00'], // Sunday -> Monday (12 tasks were due on Sun Oct 4)
    ['2026-11-06T22:00:00Z', '2026-11-09', '15:00'], // after DST ends: 09:00 CST = 15:00 UTC
  ])('next business morning in Chicago from %s', (now, dueDate, dueTime) => {
    expect(nextBusinessMorning(new Date(now))).toMatchObject({ dueDate, dueTime });
  });
  it('keeps the buyer\'s words and drops quoted history', () => {
    expect(replyExcerpt('Did you send me an estimate?\n\nOn Tue, Oct 13, 2026 at 9:00 AM Rep <rep@x.co> wrote:\n> Hi')).toBe('Did you send me an estimate?');
    expect(replyExcerpt('Yes\n> quoted\nThanks')).toBe('Yes\nThanks');
  });
  it('never puts a free-mail domain in the subject as a company', () => {
    expect(companyFrom({ email: 'creitmeyer@aol.com' })).toBe('company unknown');
    expect(companyFrom({ email: 'Jimmy <orbinj@concretestrategies.com>' })).toBe('concretestrategies.com');
    expect(companyFrom({ orgName: 'CLR Incorporated', email: 'x@aol.com' })).toBe('CLR Incorporated');
  });
  it.each([
    ['Automatic reply: 2 Br Rehabs - I-70 SWPPP', 'Jimmy Orbin no longer works for Concrete Strategies, for further correspondence contact Nick Caruso', true],
    ['Tom Mattlin Jr. has retired', '', true],
    ['Re: Erosion Control', 'This email is no longer being monitored. Please direct all inquiries to Mark Miller', true],
    ['Re: bid', 'We no longer work with outside SWPPP providers, we do it in house', false],
    ['Automatic reply', 'I am out of the office until Monday', false],
  ])('departure notice %s', (subject, text, expected) => expect(isDepartureNotice(subject, text)).toBe(expected));
});

describe('provider stop review is re-read, not abandoned', () => {
  const now = new Date('2026-10-26T15:00:00Z');
  it('a stop held for provider review completes when Apollo now shows the membership finished', async () => {
    const action = { kind: 'stop_sequence', status: 'failed', attempts: 1, requiresReview: true, safeError: 'provider_stop_review', retryAt: null };
    const execute = vi.fn();
    const result = await runReplyAction(action, { execute, reconcile: async () => ({ state: 'completed', receipt: { id: 'membership-1' } }), now });
    expect(result).toMatchObject({ status: 'completed', externalId: 'membership-1' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('other kinds in review are still left to staff', async () => {
    const action = { kind: 'forward', status: 'failed', attempts: 1, requiresReview: true, safeError: 'provider_stop_review' };
    const reconcile = vi.fn();
    expect(await runReplyAction(action, { execute: vi.fn(), reconcile, now })).toBe(action);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

const db = reportingTestDb('reply_a2');
describe.skipIf(!db)('A2 reply handling (local Postgres)', () => {
  const now = new Date('2026-10-19T15:00:00Z');
  const account = 'pipedrive-account:a';
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_mailboxes(id text PRIMARY KEY,email text);
      CREATE TABLE sdr_drafts(id text PRIMARY KEY,contact_email_snapshot text);
      CREATE TABLE sdr_sends(id text PRIMARY KEY,draft_id text,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,mailbox_id text,status text,sent_at timestamptz,last_status_at timestamptz,updated_at timestamptz);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,person_email text,person_name text,lead_title text,sequence_started text,pipedrive_person_id text,pipedrive_org_id text);
      CREATE TABLE sdr_inbox_reply_log(gmail_message_id text PRIMARY KEY,from_addr text,pipedrive_lead_id text,intent text,created_at timestamptz DEFAULT now())`);
    for (const m of ['2026-10-03-sdr-reply-actions.sql', '2026-10-07-sdr-provider-operations.sql', '2026-10-07-sdr-outreach-controls.sql', '2026-10-03-sdr-conversation-history.sql', '2026-10-07-sdr-conversation-sync.sql'])
      await db.pool.query(await readFile(new URL(`../../migrations/${m}`, import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE sdr_reply_actions,sdr_reply_messages,sdr_reply_routes,sdr_sends,sdr_lead_state,sdr_mailboxes,sdr_drafts,sdr_conversation_messages,
      sdr_outreach_control_decisions,sdr_outreach_controls,sdr_provider_membership_observations,sdr_provider_operations,sdr_inbox_reply_log`);
    await db.pool.query(`INSERT INTO sdr_mailboxes VALUES ('mb-th','th@proswppp.co');
      INSERT INTO sdr_drafts VALUES ('d1','orbinj@concretestrategies.com');
      INSERT INTO sdr_sends VALUES ('send-1','d1','lead-i70','seq-a','contact-1','mb-th','enrolled','2026-10-09T15:28:37Z',NOW(),NOW());
      INSERT INTO sdr_lead_state VALUES ('lead-i70','orbinj@concretestrategies.com','Jimmy Orbin','2 Br Rehabs - I-70',NULL,'501','601');
      INSERT INTO sdr_reply_routes(mailbox_email,forward_to,pipedrive_user_id,verified_at) VALUES ('th@proswppp.co','th@proswppp.com',21352815,NOW())`);
  });
  const pdMessage = (id, extra = {}) => ({ id, subject: 'Re: 2 Br Rehabs - I-70 SWPPP', snippet: '', body: '<div>Can you resend the proposal?</div>',
    from: [{ email_address: 'orbinj@concretestrategies.com', name: 'Jimmy Orbin' }], ...extra });
  const inbound = async (id, at, extra = {}) => db.pool.query(`INSERT INTO sdr_conversation_messages(provider,account_key,provider_message_id,provider_thread_id,from_address,occurred_at,direction,pipedrive_lead_id,link_evidence)
    VALUES('pipedrive',$1,$2,$3,$4,$5,$6,$7,'pipedrive:explicit-thread-or-message-id')`,
  [account, id, extra.thread || 't-1', extra.from || 'Jimmy Orbin <orbinj@concretestrategies.com>', at, extra.direction || 'in', extra.lead === undefined ? 'lead-i70' : extra.lead]);

  it('turns a reply to the rep\'s .com inbox into a stop, a note and a task for the mailbox rep, once', async () => {
    await inbound('m-1', '2026-10-15T22:49:46Z');
    const pipedrive = { getMailMessage: vi.fn(async id => pdMessage(id)) };
    const classifyIntent = vi.fn(async () => ({ worth: true, label: 'question', reason: 'asks to resend proposal' }));
    const first = await collectPipedriveReplies(db.pool, { pipedrive, classifyIntent, now, enabled: true });
    expect(first.counts).toMatchObject({ candidates: 1, detected: 1 });
    const rows = (await db.pool.query('SELECT kind,target_key,status,payload FROM sdr_reply_actions ORDER BY kind')).rows;
    expect(rows.map(r => r.kind)).toEqual(['clear_sequence_flag', 'create_note', 'create_task', 'stop_sequence']); // no forward: it is already in the rep's inbox
    expect(rows.find(r => r.kind === 'create_task')).toMatchObject({ target_key: 'lead-i70:th@proswppp.co', payload: { userId: '21352815', source: 'pipedrive', account, fromEmail: 'orbinj@concretestrategies.com', intentReason: 'asks to resend proposal' } });
    expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('replied');
    expect((await db.pool.query('SELECT source,reply_kind,intent,link_status FROM sdr_reply_messages')).rows[0]).toEqual({ source: 'pipedrive', reply_kind: 'human', intent: 'question', link_status: 'verified' });
    const second = await collectPipedriveReplies(db.pool, { pipedrive, classifyIntent, now, enabled: true });
    expect(second.counts.candidates).toBe(0);
    expect(pipedrive.getMailMessage).toHaveBeenCalledTimes(1);
  });

  it('a "no longer works here" auto-reply stops the sequence and asks the rep to follow the replacement', async () => {
    await inbound('m-2', '2026-10-19T13:50:38Z');
    const pipedrive = { getMailMessage: async id => pdMessage(id, { subject: 'Automatic reply: 2 Br Rehabs - I-70 SWPPP', body: 'Jimmy Orbin no longer works for Concrete Strategies, contact Nick Caruso at CarusoN@ConcreteStrategies.com' }) };
    const classifyIntent = vi.fn();
    await collectPipedriveReplies(db.pool, { pipedrive, classifyIntent, now, enabled: true });
    expect(classifyIntent).not.toHaveBeenCalled();
    expect((await db.pool.query('SELECT reply_kind,intent FROM sdr_reply_messages')).rows[0]).toEqual({ reply_kind: 'bounce', intent: 'left_company' });
    expect((await db.pool.query('SELECT kind FROM sdr_reply_actions ORDER BY kind')).rows.map(r => r.kind)).toEqual(['clear_sequence_flag', 'create_note', 'create_task', 'stop_sequence']);
    expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('bounced');
  });

  it('ignores out-of-office, our own mail, unlinked mail, mail before the send and leads with no live send; records each it read once', async () => {
    await inbound('ooo', '2026-10-16T12:00:00Z');
    await inbound('ours', '2026-10-16T12:00:00Z', { from: 'Derek <dc@proswppp.com>' });
    await inbound('unlinked', '2026-10-16T12:00:00Z', { lead: null });
    await inbound('before', '2026-10-01T12:00:00Z');
    const pipedrive = { getMailMessage: vi.fn(async id => pdMessage(id, { subject: 'Automatic reply', body: 'I am out of the office until Monday.' })) };
    await collectPipedriveReplies(db.pool, { pipedrive, classifyIntent: vi.fn(), now, enabled: true });
    expect(pipedrive.getMailMessage.mock.calls.map(c => c[0])).toEqual(['ooo']);
    expect((await db.pool.query('SELECT provider_message_id,reply_kind FROM sdr_reply_messages')).rows).toEqual([{ provider_message_id: `pipedrive:${account}:ooo`, reply_kind: 'auto' }]);
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_actions')).rows[0].n).toBe(0);
    await db.pool.query("UPDATE sdr_sends SET status='replied'");
    await inbound('late', '2026-10-17T12:00:00Z');
    await collectPipedriveReplies(db.pool, { pipedrive, classifyIntent: vi.fn(), now, enabled: true });
    expect(pipedrive.getMailMessage).toHaveBeenCalledTimes(1);
  });

  it('counts an Outlook non-delivery only when it names the address this project is mailing', async () => {
    const c = { person_email: 'dboswell@kassbros.com', send_emails: ['wfolse@kassbros.com'], from_address: 'Microsoft Outlook <x@y.onmicrosoft.com>' };
    const ndr = to => ({ id: 1, subject: 'Undeliverable: Lakewood Dr Imp SWPPP', snippet: `Your message to ${to} couldn't be delivered.`, from: [] });
    expect(await classifyPipedriveReply(c, ndr('wfolse@kassbros.com'))).toMatchObject({ kind: 'bounce', label: 'bounce' });
    expect(await classifyPipedriveReply(c, ndr('someone@else.com'))).toMatchObject({ kind: 'auto', label: 'unrelated_bounce' });
  });

  it('dry run reads and classifies but writes nothing', async () => {
    await inbound('m-3', '2026-10-15T22:49:46Z');
    const r = await collectPipedriveReplies(db.pool, { pipedrive: { getMailMessage: async id => pdMessage(id) }, classifyIntent: async () => ({ worth: true, label: 'interested' }), now, enabled: true, dryRun: true });
    expect(r.decisions).toMatchObject([{ leadId: 'lead-i70', kind: 'human', label: 'interested', mailbox: 'th@proswppp.co' }]);
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_messages')).rows[0].n).toBe(0);
  });

  it('a Pipedrive-sourced task is skipped when staff already answered in that Pipedrive thread, and created with the real text otherwise', async () => {
    await inbound('m-4', '2026-10-15T22:49:46Z');
    await collectPipedriveReplies(db.pool, { pipedrive: { getMailMessage: async id => pdMessage(id) }, classifyIntent: async () => ({ worth: true, label: 'question' }), now, enabled: true });
    const task = (await db.pool.query("SELECT * FROM sdr_reply_actions WHERE kind='create_task'")).rows[0];
    const added = [];
    const pipedrive = { getMailMessage: async id => pdMessage(id), getOrganization: async () => ({ name: 'Concrete Strategies' }), addActivity: async a => { added.push(a); return { id: 77, user_id: 21352815 }; } };
    const clients = createReplyActionClients({ pool: db.pool, getToken: async () => { throw new Error('no gmail for pipedrive mail'); }, pipedrive, now: () => now });
    expect(await clients.create_task.execute({ ...task, payload: task.payload })).toEqual({ id: 77, assigneeId: 21352815 });
    expect(added[0]).toMatchObject({ leadId: 'lead-i70', subject: 'Reply received: Jimmy Orbin (Concrete Strategies) - 2 Br Rehabs - I-70', personId: 501, orgId: 601, userId: 21352815, dueDate: '2026-10-20', dueTime: '14:00' });
    expect(added[0].note).toContain('Can you resend the proposal?');
    await inbound('staff', '2026-10-19T21:15:47Z', { from: 'Derek <dc@proswppp.com>', direction: 'out' });
    expect(await clients.create_task.execute({ ...task, payload: task.payload })).toEqual({ skipped: true, reason: 'staff_replied' });
  });

  it('a Pipedrive-sourced stop needs the thread still linked to the project, then finishes only our enrollment', async () => {
    await inbound('m-5', '2026-10-15T22:49:46Z');
    await collectPipedriveReplies(db.pool, { pipedrive: { getMailMessage: async id => pdMessage(id) }, classifyIntent: async () => ({ worth: true, label: 'question' }), now, enabled: true });
    const stop = (await db.pool.query("SELECT * FROM sdr_reply_actions WHERE kind='stop_sequence'")).rows[0];
    let finished = false;
    const apollo = { getContact: vi.fn(async () => ({ id: 'contact-1', contact_campaign_statuses: [{ emailer_campaign_id: 'seq-a', id: 'mem-1', status: finished ? 'finished' : 'active', added_at: '2026-10-09T15:28:37.203Z' }] })),
      finishContactInSequence: vi.fn(async () => { finished = true; return {}; }) };
    const clients = createReplyActionClients({ pool: db.pool, getToken: async () => 'x', apollo });
    await db.pool.query("UPDATE sdr_conversation_messages SET pipedrive_lead_id='other-lead'");
    await expect(clients.stop_sequence.execute(stop)).rejects.toMatchObject({ replyContextReason: 'project_context_unverified' });
    expect(apollo.finishContactInSequence).not.toHaveBeenCalled();
    await db.pool.query("UPDATE sdr_conversation_messages SET pipedrive_lead_id='lead-i70'");
    expect(await clients.stop_sequence.execute(stop)).toMatchObject({ id: 'mem-1', membershipStatus: 'finished', via: 'mark_as_finished' });
    expect(apollo.finishContactInSequence).toHaveBeenCalledWith('seq-a', 'contact-1');
  });

  const gmailReply = extra => ({ messageId: 'rfc822:<a@buyer.test>', sourceMessageId: 'g-1', threadId: 'thread-1', mailbox: 'th@proswppp.co', receivedAt: '2026-10-05T15:45:59Z',
    leadLink: { status: 'verified', leadId: 'lead-i70' }, intent: { kind: 'human', label: 'interested', worth: true }, fromEmail: 'Buyer <orbinj@concretestrategies.com>', ...extra });
  it('one task per person and project when the same person writes twice within 30 minutes (37254/37255)', async () => {
    await enqueueReplyActions(db.pool, gmailReply());
    await db.pool.query("UPDATE sdr_sends SET status='enrolled'");
    await enqueueReplyActions(db.pool, gmailReply({ messageId: 'rfc822:<b@buyer.test>', sourceMessageId: 'g-2', receivedAt: '2026-10-05T15:46:16Z' }));
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='create_task'")).rows[0].n).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='forward'")).rows[0].n).toBe(1);
    // ...but the second message's live enrollment is still stopped
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='stop_sequence'")).rows[0].n).toBe(2);
    await enqueueReplyActions(db.pool, gmailReply({ messageId: 'rfc822:<c@buyer.test>', sourceMessageId: 'g-3', receivedAt: '2026-10-06T15:46:16Z' }));
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='create_task'")).rows[0].n).toBe(2);
  });

  it('an unsubscribe reply becomes a permanent hold on that address, once', async () => {
    vi.stubEnv('SDR_CRM_COMPANY_ID', '13105180');
    await enqueueReplyActions(db.pool, gmailReply({ intent: { kind: 'human', label: 'unsubscribe', worth: false } }));
    await enqueueReplyActions(db.pool, gmailReply({ messageId: 'rfc822:<again@buyer.test>', intent: { kind: 'human', label: 'unsubscribe', worth: false } }));
    const holds = (await db.pool.query('SELECT scope_kind,scope_id,lead_id,channel,status,review_after FROM sdr_outreach_controls')).rows;
    expect(holds).toEqual([{ scope_kind: 'recipient', scope_id: 'orbinj@concretestrategies.com', lead_id: null, channel: 'email', status: 'active', review_after: null }]);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind IN ('create_task','forward')")).rows[0].n).toBe(0);
  });

  it('keeps the classifier\'s failure reason on the review item', async () => {
    await enqueueReplyActions(db.pool, gmailReply({ intent: { kind: 'human', label: 'unknown', worth: true, reason: 'api-429' } }));
    expect((await db.pool.query("SELECT payload FROM sdr_reply_actions WHERE kind='match_lead'")).rows[0].payload).toMatchObject({ classifierReason: 'api-429' });
  });

  it('re-reads a provider-review stop after a day, and job health counts review backlog as expected, not failure', async () => {
    await enqueueReplyActions(db.pool, gmailReply({ intent: { kind: 'human', label: 'not_interested', worth: false } }));
    await db.pool.query("UPDATE sdr_reply_actions SET status='failed',requires_review=true,safe_error='provider_stop_review',updated_at=$1 WHERE kind='stop_sequence'", [new Date(+now - 3600000)]);
    await db.pool.query("UPDATE sdr_reply_actions SET status='completed',external_id='n',receipt_at=NOW() WHERE kind='create_note'");
    const reconcile = vi.fn(async () => ({ state: 'completed', receipt: { id: 'mem-1' } }));
    const clients = { stop_sequence: { execute: vi.fn(), reconcile } };
    const early = await drainReplyActions(db.pool, { clients, now, featureEnabled: true });
    expect(reconcile).not.toHaveBeenCalled();
    expect(early.coverage).toBe('complete');
    expect(early.counts).toMatchObject({ failed: 0, unresolved: 2, awaitingReview: 1 });
    const later = await drainReplyActions(db.pool, { clients, now: new Date(+now + 25 * 3600000), featureEnabled: true });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(later.counts.completed).toBe(1);
    expect((await db.pool.query("SELECT status,external_id FROM sdr_reply_actions WHERE kind='stop_sequence'")).rows[0]).toEqual({ status: 'completed', external_id: 'mem-1' });
  });

  it('backfill queues the missing task once, keeps routing as is, and dry run writes nothing', async () => {
    await enqueueReplyActions(db.pool, gmailReply({ receivedAt: '2026-10-16T15:47:12Z', intent: { kind: 'human', label: 'unknown', worth: true } }));
    await db.pool.query("DELETE FROM sdr_reply_actions WHERE kind='create_task'"); // the 10-15/16 shape: no task was ever queued
    await enqueueReplyActions(db.pool, gmailReply({ messageId: 'rfc822:<no@buyer.test>', receivedAt: '2026-10-16T16:00:00Z', intent: { kind: 'human', label: 'in_house', worth: false } }));
    const dry = await backfillMissingReplyTasks(db.pool, { now, dryRun: true });
    expect(dry.planned).toMatchObject([{ messageId: 'rfc822:<a@buyer.test>', target: 'lead-i70:th@proswppp.co', assignee: '21352815', project: '2 Br Rehabs - I-70' }]);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='create_task'")).rows[0].n).toBe(0);
    const applied = await backfillMissingReplyTasks(db.pool, { now, dryRun: false });
    expect(applied.planned[0].inserted).toBe(1);
    expect((await db.pool.query("SELECT target_key,status,payload->>'userId' AS user_id,payload->>'backfill' AS backfill FROM sdr_reply_actions WHERE kind='create_task'")).rows)
      .toEqual([{ target_key: 'lead-i70:th@proswppp.co', status: 'pending', user_id: '21352815', backfill: 'reply-tasks-2026-10-26' }]);
    expect((await backfillMissingReplyTasks(db.pool, { now, dryRun: false })).count).toBe(0);
  });
});
