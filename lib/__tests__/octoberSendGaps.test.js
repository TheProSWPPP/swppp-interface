import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { reserveEnrollment, withProviderContactLock, advanceEnrollmentPhase, recordProviderSkip } from '../sdrProviderOperations.js';
import { reconcileOutcome, reconcileStuckSends } from '../sdrSendReconcile.js';
import { looksLikeEmail, verifyEmail } from '../emailVerify.js';
import { emailConfirmedValid } from '../autoOutreach.js';
import { needsVerify } from '../emailVerifyRefresh.js';

// October send gaps review, 2026-10-27.

describe('an address that is not an email is invalid without asking a provider', () => {
  it.each(['na', 'NA', '(555) 123-4567', 'John Smith', 'bids@', '@example.com', 'a b@example.com', ''])('%j', async value => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(looksLikeEmail(value)).toBe(false);
    expect(await verifyEmail(value)).toMatchObject({ ok: false, status: 'invalid', sub_status: 'not_an_email_address' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('a real address still looks like one', () => {
    for (const value of ['bids@example.com', ' Estimating@Example.co ', 'a.b+c@sub.example.org']) expect(looksLikeEmail(value)).toBe(true);
  });
  it('automation never treats "na" as a confirmed address, and the verification pass asks again', () => {
    const lead = { email_verified_value: 'na', email_verified_at: new Date(), email_verify_status: 'valid' };
    expect(emailConfirmedValid(lead, 'na')).toBe(false);
    const row = { status: 'clear', triggerType: 'PB', email: 'na', verifiedValue: 'na', verifiedAt: Date.now() - 86400000, now: Date.now() };
    expect(needsVerify({ ...row, verifyStatus: 'valid' })).toBe(true);
    expect(needsVerify({ ...row, verifyStatus: 'invalid' })).toBe(false);
  });
});

describe('what Apollo shows for a row still enrolled with no email', () => {
  const contact = statuses => ({ id: 'c', contact_campaign_statuses: statuses });
  it.each([
    [[], { status: 'failed', step: 'removed' }],
    [[{ emailer_campaign_id: 'other', status: 'active' }], { status: 'failed', step: 'removed' }],
    [[{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'Invalid MX record detected for the recipient domain. Email not sent to prevent delivery failures or spam reputation impact.' }], { status: 'failed', step: 'refused', mxRefusal: true }],
    [[{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'Contact email is likely to bounce. Not sent to protect your sender reputation.' }], { status: 'failed', step: 'refused', mxRefusal: false }],
    [[{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'bounced' }], { status: 'bounced', step: 'bounced' }],
    [[{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'spam blocked' }], { status: 'bounced', step: 'bounced' }],
    [[{ emailer_campaign_id: 'pb', status: 'finished' }], { status: 'failed', step: 'finished' }],
  ])('%j', (statuses, expected) => expect(reconcileOutcome(contact(statuses), 'pb')).toMatchObject({ action: 'update', ...expected }));
  it('leaves a live membership alone and an unreadable one unverified', () => {
    expect(reconcileOutcome(contact([{ emailer_campaign_id: 'pb', status: 'active' }]), 'pb')).toMatchObject({ action: 'leave' });
    expect(reconcileOutcome(contact([{ emailer_campaign_id: 'pb', status: 'paused' }]), 'pb')).toMatchObject({ action: 'leave' });
    expect(reconcileOutcome({ id: 'c' }, 'pb')).toMatchObject({ action: 'unverified' });
  });
});

const db = reportingTestDb('october_send_gaps');
describe.skipIf(!db)('stuck-enrollment reconciler and the membership guard (local Postgres)', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_email_snapshot text,status text,error_message text);
     CREATE TABLE sdr_sends(id text PRIMARY KEY,draft_id uuid,pipedrive_lead_id text,apollo_contact_id text,apollo_sequence_id text,apollo_emailer_message_id text,status text,step_status text,sent_at timestamptz,next_send_at timestamptz,last_status_at timestamptz,updated_at timestamptz);
     CREATE TABLE permit_sends(id text,apollo_contact_id text);
     CREATE TABLE sdr_settings(id int,contact_cooldown_days int);INSERT INTO sdr_settings VALUES(1,14);
     CREATE TABLE sdr_message_facts(provider text,direction text,provider_status text,prospect_email text,occurred_at timestamptz);
     CREATE TABLE sdr_engagement_events(pipedrive_lead_id text,event_type text);
     CREATE TABLE sdr_reply_messages(pipedrive_lead_id text);
     CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text)`);
    for (const file of ['2026-10-07-sdr-provider-operations.sql', '2026-10-10-sdr-enrollment-phases.sql', '2026-10-27-sdr-provider-skipped.sql', '2026-10-07-sdr-outreach-controls.sql', '2026-10-07-sdr-policy-rollout.sql'])
      await db.pool.query(await readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
  });
  afterAll(async () => await db.close());
  beforeEach(async () => { await db.pool.query('TRUNCATE sdr_policy_decisions,sdr_message_facts,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_provider_operations,sdr_provider_membership_observations,sdr_sends,sdr_drafts,sdr_engagement_events,sdr_reply_messages,sdr_outreach_log,permit_sends'); });

  const stuck = async (id, { days = 10, email = `${id}@example.test`, step = null } = {}) => {
    const draft = (await db.pool.query('INSERT INTO sdr_drafts(contact_email_snapshot,status) VALUES($1,\'sent\') RETURNING id', [email])).rows[0].id;
    await db.pool.query(`INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id,apollo_contact_id,apollo_sequence_id,status,step_status,sent_at)
      VALUES($1,$2,$3,$4,'pb','enrolled',$5,NOW()-make_interval(days=>$6::int))`, [id, draft, `lead-${id}`, `c-${id}`, step, days]);
  };
  const row = async id => (await db.pool.query('SELECT status,step_status FROM sdr_sends WHERE id=$1', [id])).rows[0];

  it('copies Apollo\'s status onto stuck rows and raises a rep task only for a false invalid-MX refusal', async () => {
    await stuck('removed'); await stuck('mx-real', { email: 'x@outlook-domain.test' }); await stuck('mx-dead', { email: 'x@nomail.test' });
    await stuck('likely'); await stuck('bounced'); await stuck('live'); await stuck('young', { days: 1 });
    await stuck('emailed'); await db.pool.query("INSERT INTO sdr_message_facts VALUES('apollo','out','completed','emailed@example.test',NOW()-interval '5 days')");
    const memberships = {
      'c-removed': [], 'c-live': [{ emailer_campaign_id: 'pb', status: 'active' }],
      'c-mx-real': [{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'Invalid MX record detected for the recipient domain.' }],
      'c-mx-dead': [{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'Invalid MX record detected for the recipient domain.' }],
      'c-likely': [{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'Contact email is likely to bounce. Not sent to protect your sender reputation.' }],
      'c-bounced': [{ emailer_campaign_id: 'pb', status: 'failed', inactive_reason: 'bounced' }],
    };
    const apollo = { getContact: vi.fn(async id => ({ id, contact_campaign_statuses: memberships[id] })) };
    const addActivity = vi.fn(async () => ({ id: 1 }));
    const resolveMx = vi.fn(async domain => domain === 'outlook-domain.test' ? [{ exchange: 'mx.outlook.test', priority: 1 }] : []);
    const stats = await reconcileStuckSends(db.pool, { apollo, addActivity, resolveMx });
    expect(stats).toMatchObject({ checked: 6, removed: 1, refused: 3, bounced: 1, left: 1, mxTasks: 1 });
    expect(await row('removed')).toEqual({ status: 'failed', step_status: 'removed' });
    expect(await row('mx-real')).toEqual({ status: 'failed', step_status: 'refused' });
    expect(await row('likely')).toEqual({ status: 'failed', step_status: 'refused' });
    expect(await row('bounced')).toEqual({ status: 'bounced', step_status: 'bounced' });
    expect(await row('live')).toEqual({ status: 'enrolled', step_status: null });
    expect(await row('young')).toEqual({ status: 'enrolled', step_status: null });
    expect(await row('emailed')).toEqual({ status: 'enrolled', step_status: null });
    expect(addActivity).toHaveBeenCalledTimes(1);
    expect(addActivity.mock.calls[0][0]).toMatchObject({ leadId: 'lead-mx-real', type: 'task' });
    // Rows left "enrolled" are the only ones read again; the task is never raised twice.
    apollo.getContact.mockClear(); addActivity.mockClear();
    expect(await reconcileStuckSends(db.pool, { apollo, addActivity, resolveMx })).toMatchObject({ checked: 1, left: 1, mxTasks: 0 });
    expect(addActivity).not.toHaveBeenCalled();
  });

  it('stops at an Apollo rate limit without changing the remaining rows', async () => {
    await stuck('a', { days: 20 }); await stuck('b', { days: 10 });
    const apollo = { getContact: vi.fn(async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); }) };
    expect(await reconcileStuckSends(db.pool, { apollo })).toMatchObject({ checked: 0, rateLimited: true });
    expect(apollo.getContact).toHaveBeenCalledTimes(1);
    expect(await row('a')).toEqual({ status: 'enrolled', step_status: null });
  });

  const context = { companyId: 'company', apolloContactId: 'contact', sequenceId: 'pb', leadId: 'lead-a', recipientEmail: 'buyer@example.test', technicalComplete: true };
  const fresh = { getContact: async () => ({ id: 'contact', contact_campaign_statuses: [] }) };
  it('an add Apollo explicitly skipped is closed and no longer blocks the next attempt', async () => {
    const draftId = (await db.pool.query("INSERT INTO sdr_drafts(status) VALUES('pending') RETURNING id")).rows[0].id;
    const fields = { personId: 'p', organizationId: 'o', projectRole: null, stage: 'Bid', trigger: 'PB', mailboxId: 'm', scheduledFor: null, overrideDecisionId: null, roleExceptionId: null, cadence: null, sourceRevision: '1', draftId: String(draftId), channel: 'email', serviceId: null };
    await withProviderContactLock(db.pool, 'contact', ['lead-a'], async client => {
      const reservation = await reserveEnrollment({ pool: client, apollo: fresh, context: { ...context, ...fields }, draftRevision: 1, actionId: 'first', enrollmentMode: 'sdr_draft_v1' });
      await advanceEnrollmentPhase({ pool: client, reservation, expectedPhase: 'reserved', nextPhase: 'fields_started' });
      await advanceEnrollmentPhase({ pool: client, reservation, expectedPhase: 'fields_started', nextPhase: 'fields_completed' });
      await advanceEnrollmentPhase({ pool: client, reservation, expectedPhase: 'fields_completed', nextPhase: 'add_started' });
      await recordProviderSkip({ pool: client, reservation, reason: 'contacts_with_job_change' });
    });
    expect((await db.pool.query('SELECT state,reason FROM sdr_provider_operations')).rows).toEqual([{ state: 'provider_skipped', reason: 'contacts_with_job_change' }]);
    expect((await reserveEnrollment({ pool: db.pool, apollo: fresh, context, draftRevision: 2, actionId: 'second' })).reservationId).toBeTruthy();
  });

  it('a legacy reservation whose draft failed with an explicit Apollo skip no longer blocks; an uncertain reply still does', async () => {
    const legacy = async error => {
      await db.pool.query('TRUNCATE sdr_provider_operations,sdr_provider_membership_observations,sdr_policy_decisions,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_drafts');
      const draftId = (await db.pool.query("INSERT INTO sdr_drafts(status,error_message) VALUES('failed',$1) RETURNING id", [error])).rows[0].id;
      await db.pool.query(`INSERT INTO sdr_provider_operations(id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,state,enrollment_phase)
        VALUES(gen_random_uuid(),gen_random_uuid()::text,'enroll','contact','pb','lead-a',$1,'old','reserved','add_started')`, [JSON.stringify({ draftId: String(draftId) })]);
    };
    await legacy('Apollo did not enroll the contact: contacts_with_job_change');
    expect((await reserveEnrollment({ pool: db.pool, apollo: fresh, context, draftRevision: 1, actionId: 'after-skip' })).reservationId).toBeTruthy();
    await legacy('Apollo did not enroll the contact: not added (Apollo returned no enrolled contact)');
    await expect(reserveEnrollment({ pool: db.pool, apollo: fresh, context, draftRevision: 1, actionId: 'after-uncertain' })).rejects.toMatchObject({ code: 'provider_operation_requires_review' });
    await legacy('Pipedrive unavailable');
    await expect(reserveEnrollment({ pool: db.pool, apollo: fresh, context, draftRevision: 1, actionId: 'after-other' })).rejects.toMatchObject({ code: 'provider_operation_requires_review' });
  });
});
