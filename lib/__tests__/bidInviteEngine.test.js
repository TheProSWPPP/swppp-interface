import fs from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import {
  runBidInviteSequence, bidInviteMode, bidInviteConfig, liveRefusal, registerBidInviteExitHook, bidInviteSentToday, bidInviteStatus,
  renderPreviewHtml, lastOutbound,
} from '../bidInviteEngine.js';
import { exitHooks, resetExitHooksForTests } from '../replyExit.js';
import { setOutreachControl } from '../sdrOutreachControls.js';
import { resolveReplyProject } from '../sdrReplyContext.js';
import { mailboxSentTodayShared } from '../permitDrafts.js';

describe('switches', () => {
  it('BID_INVITE_SEQUENCE is off unless exactly dry_run or live', () => {
    expect(bidInviteMode({})).toBe('off');
    for (const v of ['', 'on', 'true', 'LIVEX', 'off']) expect(bidInviteMode({ BID_INVITE_SEQUENCE: v })).toBe('off');
    expect(bidInviteMode({ BID_INVITE_SEQUENCE: ' Dry_Run ' })).toBe('dry_run');
    expect(bidInviteMode({ BID_INVITE_SEQUENCE: 'live' })).toBe('live');
  });
  it('config defaults: 15 a mailbox a day, bids from 2026-09-01, empty pilot list', () => {
    expect(bidInviteConfig({})).toMatchObject({ mode: 'off', onlyLeads: [], perMailboxDay: 15, minBidDate: '2026-09-01' });
    expect(bidInviteConfig({ BID_INVITE_ONLY_LEADS: ' a, b ,,', BID_INVITE_PER_MAILBOX_DAY: '8', BID_INVITE_MIN_BID_DATE: '2026-10-01' }))
      .toMatchObject({ onlyLeads: ['a', 'b'], perMailboxDay: 8, minBidDate: '2026-10-01' });
  });
  it('live mode refuses without company, Pipedrive, Google OAuth or with customer suppression off', () => {
    const env = { SDR_CRM_COMPANY_ID: '1', PIPEDRIVE_API_TOKEN: 'x' };
    expect(liveRefusal(env, { gmailConfigured: true })).toBeNull();
    expect(liveRefusal({ ...env, SDR_CRM_COMPANY_ID: '' }, { gmailConfigured: true })).toMatch(/SDR_CRM_COMPANY_ID/);
    expect(liveRefusal({ SDR_CRM_COMPANY_ID: '1' }, { gmailConfigured: true })).toMatch(/PIPEDRIVE/);
    expect(liveRefusal(env, { gmailConfigured: false })).toMatch(/Google/);
    expect(liveRefusal({ ...env, SDR_SUPPRESS_CUSTOMERS: 'off' }, { gmailConfigured: true })).toMatch(/SUPPRESS/);
  });
  it('off = zero sends: no reads, no writes, no calls', async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    const gmail = { sendMail: vi.fn() };
    const r = await runBidInviteSequence(pool, { mode: 'off', gmail });
    expect(r.skipped).toBe('off');
    expect(pool.query).not.toHaveBeenCalled();
    expect(gmail.sendMail).not.toHaveBeenCalled();
    expect((await runBidInviteSequence(pool, {})).skipped).toBe('off');
  });
  it('the old before-bid clock is gone from the server and the new job only runs when switched on', () => {
    const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(server).not.toMatch(/process\.env\.BID_FOLLOWUP_ENABLED|runBidFollowUpClock/);
    expect(server).toMatch(/bidMode !== "off"/);
    expect(server).toMatch(/return rows\[0\]\.n \+ await bidInviteSentToday\(pool, mailboxId\);/);
  });
});

const db = reportingTestDb('bid_invite_engine');
const MIG = (f) => fs.readFileSync(new URL(`../../migrations/${f}`, import.meta.url), 'utf8');

describe.skipIf(!db)('bid invite engine (Postgres)', () => {
  const pool = db?.pool;
  let MB = {};
  beforeAll(async () => {
    await db.setup();
    await pool.query(`
      CREATE TABLE sdr_mailboxes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, display_name text, daily_send_limit int NOT NULL DEFAULT 40,
        warmup_started_at timestamptz, warmup_status text NOT NULL DEFAULT 'ready', active boolean NOT NULL DEFAULT true, permit_signature text);
      CREATE TABLE sdr_inbox_accounts (mailbox_email text PRIMARY KEY, refresh_token text);
      CREATE TABLE sdr_lead_state (pipedrive_lead_id text PRIMARY KEY, pipedrive_person_id text, pipedrive_org_id text, person_name text, person_email text,
        lead_title text, bid_date date, crm_status text NOT NULL DEFAULT 'active', crm_company_id text, lead_origin text, sequence_started text,
        email_verify_status text, email_verified_at timestamptz, email_verified_value text, resolved_email text, email_flag text);
      CREATE TABLE sdr_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipedrive_lead_id text, contact_id_snapshot text, contact_email_snapshot text,
        status text, sent_at timestamptz, subject text, assigned_mailbox_id uuid, reject_reason text, updated_at timestamptz DEFAULT now());
      CREATE TABLE sdr_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid, pipedrive_lead_id text, apollo_sequence_id text, apollo_contact_id text,
        apollo_emailer_message_id text, step_status text, mailbox_id uuid, status text NOT NULL DEFAULT 'enrolled', sent_at timestamptz NOT NULL DEFAULT now(),
        next_send_at timestamptz, last_status_at timestamptz, updated_at timestamptz);
      CREATE TABLE sdr_message_facts (provider text NOT NULL, provider_message_id text NOT NULL, direction text NOT NULL, mailbox_email text NOT NULL, prospect_email text NOT NULL,
        campaign_id text, thread_id text, source_key text NOT NULL DEFAULT 'unknown', sequence_step int, occurred_at timestamptz, provider_status text, human_reply boolean,
        pipedrive_lead_id text, link_status text NOT NULL, link_evidence text, is_test boolean NOT NULL DEFAULT false, PRIMARY KEY (provider, provider_message_id));
      CREATE TABLE sdr_engagement_events (pipedrive_lead_id text, event_type text, occurred_at timestamptz);
      CREATE TABLE sdr_outreach_log (pipedrive_lead_id text NOT NULL, source text NOT NULL, sent_at timestamptz NOT NULL, sender_name text, sender_email text,
        subject text, external_ref text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (pipedrive_lead_id, source));
      CREATE TABLE permit_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, apollo_contact_id text);
      CREATE TABLE permit_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid, mailbox_id uuid, status text NOT NULL DEFAULT 'sent', sent_at timestamptz NOT NULL DEFAULT now());`);
    for (const f of ['2026-10-03-sdr-reply-actions.sql', '2026-11-03-sdr-reply-exit.sql', '2026-10-07-sdr-outreach-controls.sql',
      '2026-10-03-sdr-conversation-history.sql', '2026-11-03-bid-invite-sequence.sql']) await pool.query(MIG(f));
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    resetExitHooksForTests();
    await pool.query(`TRUNCATE bid_invite_sends, bid_invite_batches, bid_invite_leads, sdr_reply_actions, sdr_reply_messages, sdr_reply_exits,
      sdr_outreach_control_decisions, sdr_outreach_controls, sdr_lead_state, sdr_drafts, sdr_sends, sdr_message_facts, sdr_conversation_messages,
      sdr_outreach_log, sdr_reply_routes, sdr_inbox_accounts, permit_sends, permit_drafts CASCADE`);
    await pool.query('DELETE FROM sdr_mailboxes');
    MB = {};
    for (const [email, user, name] of [['dc@proswppp.co', 111, 'Derek Chinners'], ['jg@proswppp.co', 222, 'Josie Godfrey']]) {
      MB[email] = (await pool.query(`INSERT INTO sdr_mailboxes (email, display_name, permit_signature) VALUES ($1,$2,$3) RETURNING id`, [email, name, `Regards,\n${name}`])).rows[0].id;
      await pool.query(`INSERT INTO sdr_inbox_accounts VALUES ($1,'rt')`, [email]);
      await pool.query(`INSERT INTO sdr_reply_routes (mailbox_email, forward_to, pipedrive_user_id, verified_at) VALUES ($1,$2,$3,now())`, [email, email.replace('.co', '.com'), user]);
    }
  });

  // Tue 2026-11-03 16:10 Central: inside the afternoon window for a Texas GC.
  const NOW = new Date('2026-11-03T22:10:00Z');
  const lead = (id, { email = 'rodger@gc.test', bid = '2026-10-20', title = `Project ${id}`, name = 'Rodger Caffey', origin = 'Bid Invite: BuildingConnected',
    status = 'active', verified = 'valid', person = 'p1' } = {}) => pool.query(`INSERT INTO sdr_lead_state (pipedrive_lead_id, pipedrive_person_id, pipedrive_org_id, person_name,
      person_email, lead_title, bid_date, crm_status, crm_company_id, lead_origin, email_verify_status, email_verified_at, email_verified_value)
      VALUES ($1,$2,'9',$3,$4,$5,$6,$7,'co1',$8,$9,$10,$11)`, [id, person, name, email, title, bid, status, origin, verified, verified ? NOW : null, verified ? email : null]);
  const deps = (over = {}) => {
    const sent = [];
    const gmail = {
      sendMail: vi.fn(async (token, msg) => { sent.push(msg); return { id: `g${sent.length}`, threadId: msg.threadId || `t${sent.length}` }; }),
      getThread: vi.fn(async () => ({ messages: [] })),
    };
    const pd = {
      getLead: vi.fn(async (id) => ({ id, organization_id: 9, owner_id: 777, is_archived: false })),
      getOrganization: vi.fn(async (id) => ({ id, owner_id: { id: 111 }, address_admin_area_level_1: 'TX' })),
      getPerson: vi.fn(async () => ({ last_outgoing_mail_time: null, last_incoming_mail_time: null })),
      addNote: vi.fn(async () => ({ id: 1 })),
      addActivity: vi.fn(async () => ({ id: 55 })),
    };
    return {
      mode: 'live', gmail, pd, sent, getToken: vi.fn(async () => 'tok'), verifyEmail: vi.fn(async () => ({ ok: true, status: 'valid' })),
      isCustomerLead: vi.fn(async () => null), draftReply: vi.fn(async () => ({ decision: 'draft', body: 'Hey Rodger,\n\nGreat, send the plans over.\n\nRegards,' })),
      companyId: 'co1', perMailboxDay: 15, minBidDate: '2026-09-01', replyExitMode: () => 'off', now: NOW, ...over,
    };
  };
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const count = async (table) => Number((await one(`SELECT count(*) n FROM ${table}`)).n);

  it('dry run writes nothing: no claim, send, note, task, verification or row change', async () => {
    await lead('a', { verified: null });
    await lead('b', { email: 'kim@gc2.test', name: 'kim', bid: '2026-10-01' });
    const d = deps({ mode: 'dry_run' });
    const r = await runBidInviteSequence(pool, d);
    expect(r.samples).toHaveLength(2);
    expect(r.samples[0]).toMatchObject({ step: 'e1', to: expect.any(String), subject: expect.stringMatching(/SWPPP$/) });
    expect(r.samples.find((s) => s.to === 'rodger@gc.test').flags).toEqual(expect.arrayContaining(['would_verify', 'signature_not_on_page']));
    for (const t of ['bid_invite_leads', 'bid_invite_batches', 'bid_invite_sends', 'sdr_message_facts', 'sdr_outreach_log', 'sdr_outreach_controls']) expect(await count(t)).toBe(0);
    expect(d.gmail.sendMail).not.toHaveBeenCalled();
    expect(d.pd.addNote).not.toHaveBeenCalled();
    expect(d.pd.addActivity).not.toHaveBeenCalled();
    expect(d.verifyEmail).not.toHaveBeenCalled();
    expect((await one(`SELECT email_verify_status FROM sdr_lead_state WHERE pipedrive_lead_id='a'`)).email_verify_status).toBeNull();
    const html = renderPreviewHtml(r);
    expect(html).toContain("did y'all win");
    expect(html).toContain('not on the page Derek saw');
  });

  it('a future bid gets nothing before bid + 2 business days; a passed bid goes in the first window', async () => {
    await lead('fut', { bid: '2026-11-06', email: 'fut@gc.test' });
    let d = deps();
    await runBidInviteSequence(pool, d);
    expect(d.gmail.sendMail).not.toHaveBeenCalled();
    expect((await one(`SELECT state FROM bid_invite_leads WHERE pipedrive_lead_id='fut'`)).state).toBe('waiting');
    d = deps({ now: new Date('2026-11-09T13:20:00Z') }); // Monday: batched for Tuesday morning, not sent
    await runBidInviteSequence(pool, d);
    expect(d.gmail.sendMail).not.toHaveBeenCalled();
    const b = await one(`SELECT next_due_at FROM bid_invite_batches`);
    expect(+b.next_due_at).toBeGreaterThanOrEqual(+new Date('2026-11-10T12:30:00Z'));
    expect(+b.next_due_at).toBeLessThanOrEqual(+new Date('2026-11-10T13:15:00Z'));
    d = deps({ now: new Date('2026-11-10T13:20:00Z') });
    await runBidInviteSequence(pool, d);
    expect(d.gmail.sendMail).toHaveBeenCalledTimes(1);

    await lead('past', { bid: '2026-10-20', email: 'past@gc.test' });
    d = deps();
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toMatchObject({ to: 'past@gc.test', subject: 'Project past SWPPP', from: '"Josie Godfrey" <jg@proswppp.co>' });
    expect(d.sent[0].bodyText).toBe("Hey Rodger, did y'all win Project past SWPPP? You should have a bid from us on the SWPPP. Let us know when you need it.\n\nRegards,\nJosie Godfrey");
    expect(d.sent[0].messageId).toMatch(/^<bid-[0-9a-f-]+@proswppp\.co>$/);
  });

  it('a Saturday upload goes out Monday at 06:30 local', async () => {
    await lead('sat', { bid: '2026-10-01' });
    let d = deps({ now: new Date('2026-11-07T17:00:00Z') });
    await runBidInviteSequence(pool, d);
    expect(d.gmail.sendMail).not.toHaveBeenCalled();
    const b = await one(`SELECT next_due_at, timezone FROM bid_invite_batches`);
    expect(b.timezone).toBe('America/Chicago');
    expect(+b.next_due_at).toBeGreaterThanOrEqual(+new Date('2026-11-09T12:30:00Z'));
    expect(+b.next_due_at).toBeLessThanOrEqual(+new Date('2026-11-09T13:15:00Z'));
    d = deps({ now: new Date('2026-11-09T13:20:00Z') });
    await runBidInviteSequence(pool, d);
    expect(d.gmail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('several bids for one contact: one "Your recent bids" email naming 3, the 4th covered, no second email that day', async () => {
    await lead('l1', { bid: '2026-10-01', title: 'Zavala County Jail - Sitework' });
    await lead('l2', { bid: '2026-10-10', title: 'Fort Bend ISD Natatorium (Bid Package 2)' });
    await lead('l3', { bid: '2026-10-20', title: 'Wharton SWPPP' });
    await lead('l4', { bid: '2026-09-15', title: 'Bay City Clinic' });
    const d = deps();
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].subject).toBe('Your recent bids');
    expect(d.sent[0].bodyText.split('\n')[0]).toBe("Hey Rodger, did y'all win any of these? Wharton SWPPP, Fort Bend ISD Natatorium SWPPP, Zavala County Jail SWPPP. You should have SWPPP bids from us on each one. Let us know when you need us.");
    const b = await one(`SELECT lead_ids, named_lead_ids FROM bid_invite_batches`);
    expect(b.named_lead_ids).toEqual(['l3', 'l2', 'l1']);
    expect([...b.lead_ids].sort()).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(d.pd.addNote).toHaveBeenCalledTimes(4);
    const later = deps({ now: new Date('2026-11-03T23:00:00Z') });
    await runBidInviteSequence(pool, later);
    expect(later.gmail.sendMail).not.toHaveBeenCalled();
  });

  it('customer: Email 1 from the owner, then a task for the organization owner; Email 2 never sent', async () => {
    await lead('c1', { title: 'UTMB CLC Parking Lot, All Trades' });
    const d = deps({ isCustomerLead: vi.fn(async () => ({ reason: 'org_label', matchedOn: 'org' })) });
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].from).toBe('"Derek Chinners" <dc@proswppp.co>');
    const b = await one(`SELECT state, next_step, sender_reason, owner_task_activity_id, to_char(owner_task_due,'YYYY-MM-DD') due FROM bid_invite_batches`);
    expect(b).toMatchObject({ state: 'finished', next_step: null, sender_reason: 'customer_owner', owner_task_activity_id: '55', due: '2026-11-17' });
    const task = d.pd.addActivity.mock.calls[0][0];
    expect(task).toMatchObject({ leadId: 'c1', subject: 'Bid follow-up (customer): UTMB CLC Parking Lot SWPPP', type: 'task', userId: 111, strictAssignee: true, dueDate: '2026-11-17' });
    expect(task.note).toContain('READY TO SEND');
    expect(task.note).toContain('Hey Rodger, checking back on UTMB CLC Parking Lot SWPPP. If it went your way, we can have the SWPPP ready before you mobilize.');
    const later = deps({ now: new Date('2027-01-05T14:00:00Z'), isCustomerLead: vi.fn(async () => ({ reason: 'org_label' })) });
    await runBidInviteSequence(pool, later);
    expect(later.gmail.sendMail).not.toHaveBeenCalled();
    expect(later.pd.addActivity).not.toHaveBeenCalled();
  });

  it('customer check unavailable: nothing sent, the lead keeps waiting', async () => {
    await lead('u1');
    const d = deps({ isCustomerLead: vi.fn(async () => { throw Object.assign(new Error('crm'), { code: 'crm_unverified' }); }) });
    const r = await runBidInviteSequence(pool, d);
    expect(d.gmail.sendMail).not.toHaveBeenCalled();
    expect(await count('bid_invite_batches')).toBe(0);
    expect((await one(`SELECT state FROM bid_invite_leads`)).state).toBe('waiting');
    expect(r.coverage).toBe('partial');
  });

  it('non-customer: Email 2 at max(bid + 28, Email 1 + 14) in the Email 1 thread, then Email 3, then finished', async () => {
    await lead('n1', { bid: '2026-09-14', title: 'Hwy 59 Widening' });
    let d = deps();
    await runBidInviteSequence(pool, d);
    const e1 = d.sent[0];
    let b = await one(`SELECT * FROM bid_invite_batches`);
    expect(b.next_step).toBe('e2');
    expect(+b.next_due_at).toBeGreaterThanOrEqual(+new Date('2026-11-17T22:10:00Z'));
    // Not before then.
    d = deps({ now: new Date('2026-11-16T22:10:00Z') });
    await runBidInviteSequence(pool, d);
    expect(d.gmail.sendMail).not.toHaveBeenCalled();
    d = deps({ now: new Date(+b.next_due_at + 60000) });
    if (!(await import('../bidInvitePlan.js')).inSendWindow(d.now, 'America/Chicago')) d.now = (await import('../bidInvitePlan.js')).nextWindowSlot(d.now, 'America/Chicago');
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toMatchObject({ subject: 'Re: Hwy 59 Widening SWPPP', threadId: 't1', inReplyTo: e1.messageId, references: e1.messageId });
    expect(d.sent[0].bodyText.split('\n')[0]).toBe('Hey Rodger, checking back on Hwy 59 Widening SWPPP. If it went your way, we can have the SWPPP ready before you mobilize.');
    b = await one(`SELECT * FROM bid_invite_batches`);
    expect(b.next_step).toBe('e3');
    d = deps({ now: (await import('../bidInvitePlan.js')).nextWindowSlot(new Date(+b.next_due_at + 60000), 'America/Chicago') });
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].bodyText.split('\n')[0]).toBe('Hey Rodger, last note on Hwy 59 Widening SWPPP. If you won it, happy to get the SWPPP going. If it went another way, no worries.');
    expect(await one(`SELECT state, next_step FROM bid_invite_batches`)).toEqual({ state: 'finished', next_step: null });
    expect((await one(`SELECT state FROM bid_invite_leads`)).state).toBe('done');
    expect(await count('bid_invite_sends')).toBe(3);
  });

  describe('3-day rule across every source', () => {
    const pushedPast = async (d, at) => {
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(+(await one(`SELECT next_due_at FROM bid_invite_batches`)).next_due_at).toBeGreaterThanOrEqual(+at);
    };
    it('an Apollo email 2 days ago', async () => {
      await lead('t1');
      await pool.query(`INSERT INTO sdr_message_facts (provider, provider_message_id, direction, mailbox_email, prospect_email, occurred_at, provider_status, link_status)
        VALUES ('apollo','m1','out','mh@proswppp.co','rodger@gc.test',$1,'completed','unmatched')`, [new Date(+NOW - 2 * 86400000)]);
      await pushedPast(deps(), new Date(+NOW + 86400000));
    });
    it("a rep's own .com email synced from Pipedrive", async () => {
      await lead('t2');
      await pool.query(`INSERT INTO sdr_conversation_messages (provider, account_key, provider_message_id, from_address, to_addresses, occurred_at, direction)
        VALUES ('pipedrive','pd','x1','dc@proswppp.com','["Rodger <Rodger@gc.test>"]',$1,'out')`, [new Date(+NOW - 86400000)]);
      await pushedPast(deps(), new Date(+NOW + 2 * 86400000));
    });
    it("Pipedrive's last outgoing mail for the person", async () => {
      await lead('t3');
      const d = deps();
      d.pd.getPerson.mockResolvedValue({ last_outgoing_mail_time: '2026-11-02 15:00:00' });
      await pushedPast(d, new Date('2026-11-05T15:00:00Z'));
    });
    it('an Apollo step scheduled tomorrow', async () => {
      await lead('t4');
      const draft = (await one(`INSERT INTO sdr_drafts (pipedrive_lead_id, contact_email_snapshot, status) VALUES ('other','rodger@gc.test','sent') RETURNING id`)).id;
      await pool.query(`INSERT INTO sdr_sends (draft_id, pipedrive_lead_id, apollo_sequence_id, apollo_contact_id, status, sent_at, next_send_at, apollo_emailer_message_id)
        VALUES ($1,'other','seq','ac1','enrolled',$2,$3,'em1')`, [draft, new Date(+NOW - 10 * 86400000), new Date(+NOW + 86400000)]);
      await pushedPast(deps(), new Date(+NOW + 4 * 86400000));
    });
    it('lastOutbound reads our own bid emails too', async () => {
      expect(await lastOutbound(pool, { email: 'nobody@gc.test' })).toBeNull();
    });
  });

  describe('mailboxes and caps', () => {
    it('customer owner without a connected route falls back to rotation', async () => {
      await lead('r1');
      const d = deps({ isCustomerLead: vi.fn(async () => ({ reason: 'org_label' })) });
      d.pd.getOrganization.mockResolvedValue({ id: 9, owner_id: 999, address_admin_area_level_1: 'FL' });
      await runBidInviteSequence(pool, d);
      const b = await one(`SELECT sender_reason, timezone, owner_user_id FROM bid_invite_batches`);
      expect(b).toEqual({ sender_reason: 'rotation', timezone: 'America/New_York', owner_user_id: '999' });
    });
    it('the 16th bid email of the day from a mailbox waits; the shared cap counts cold sends too', async () => {
      await pool.query(`DELETE FROM sdr_inbox_accounts WHERE mailbox_email='dc@proswppp.co'`);
      const dummy = (await one(`INSERT INTO bid_invite_batches (contact_email, lead_ids, named_lead_ids, names, anchor_bid_date, customer, mailbox_id, state)
        VALUES ('x@y.test','{x}','{x}','{X SWPPP}','2026-10-01',false,$1,'finished') RETURNING id`, [MB['jg@proswppp.co']])).id;
      for (const step of ['e1', 'e2', 'e3']) await pool.query(`INSERT INTO bid_invite_sends (batch_id, step, mailbox_id, recipient_email, subject, body_text, rfc_message_id, status, sent_at)
        VALUES ($1,$2,$3,'x@y.test','s','b','<r>','sent',now())`, [dummy, step, MB['jg@proswppp.co']]);
      expect(await bidInviteSentToday(pool, MB['jg@proswppp.co'])).toBe(3);
      await lead('cap1');
      let d = deps({ perMailboxDay: 3 });
      let r = await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(r.counts.deferred_mailbox_bid_cap).toBe(1);
      d = deps({ perMailboxDay: 15, mailboxSentToday: async () => 40 });
      r = await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(r.counts.deferred_mailbox_shared_cap).toBe(1);
      // Permit's shared count includes bid emails as well.
      expect(await mailboxSentTodayShared(pool, MB['jg@proswppp.co'])).toBe(3);
    });
    it('batches no further ahead than about a day of sending capacity', async () => {
      await pool.query(`DELETE FROM sdr_inbox_accounts WHERE mailbox_email='dc@proswppp.co'`);
      for (const id of ['b1', 'b2', 'b3']) await lead(id, { email: `${id}@gc.test` });
      const r = await runBidInviteSequence(pool, deps({ perMailboxDay: 2 }));
      expect(r.counts.batches_created).toBe(2);
      expect((await pool.query(`SELECT count(*)::int n FROM bid_invite_leads WHERE state='waiting'`)).rows[0].n).toBe(1);
    });
    it('Email 2 never switches mailboxes: a disconnected mailbox holds the batch', async () => {
      await lead('h1', { bid: '2026-09-14' });
      await runBidInviteSequence(pool, deps());
      const b = await one(`SELECT b.*, m.email FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id`);
      await pool.query(`DELETE FROM sdr_inbox_accounts WHERE mailbox_email=$1`, [b.email]);
      const d = deps({ now: (await import('../bidInvitePlan.js')).nextWindowSlot(new Date(+b.next_due_at + 60000), 'America/Chicago') });
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(await one(`SELECT state, hold_reason FROM bid_invite_batches`)).toEqual({ state: 'held', hold_reason: 'sender_unavailable' });
    });
  });

  describe('holds', () => {
    it('a recipient hold or a lead hold stops it', async () => {
      await lead('o1');
      await setOutreachControl(pool, { companyId: 'co1', leadId: null, scope: { kind: 'recipient', id: 'rodger@gc.test' }, channel: 'email', reason: 'manual', contextHash: 'h',
        actor: { source: 'user', accountId: 'ivan' } });
      const d = deps();
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(await one(`SELECT state, hold_reason FROM bid_invite_batches`)).toEqual({ state: 'held', hold_reason: 'outreach_held' });
      await pool.query('TRUNCATE bid_invite_sends, bid_invite_batches, bid_invite_leads, sdr_outreach_control_decisions, sdr_outreach_controls CASCADE');
      await setOutreachControl(pool, { companyId: 'co1', leadId: 'o1', scope: { kind: 'lead', id: 'o1' }, reason: 'manual', contextHash: 'h2', actor: { source: 'user', accountId: 'ivan' } });
      const d2 = deps();
      await runBidInviteSequence(pool, d2);
      expect(d2.gmail.sendMail).not.toHaveBeenCalled();
    });
    it('the pilot list keeps unlisted leads waiting', async () => {
      await lead('in', { email: 'in@gc.test' });
      await lead('out', { email: 'out@gc.test' });
      const d = deps({ onlyLeads: ['in'] });
      await runBidInviteSequence(pool, d);
      expect(d.sent.map((m) => m.to)).toEqual(['in@gc.test']);
      expect((await one(`SELECT state FROM bid_invite_leads WHERE pipedrive_lead_id='out'`)).state).toBe('waiting');
    });
    it('an unverified address is checked first; an invalid one holds the batch', async () => {
      await lead('v1', { verified: null });
      const d = deps({ verifyEmail: vi.fn(async () => ({ ok: false, status: 'invalid' })) });
      await runBidInviteSequence(pool, d);
      expect(d.verifyEmail).toHaveBeenCalledWith('rodger@gc.test');
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(await one(`SELECT state, hold_reason FROM bid_invite_batches`)).toEqual({ state: 'held', hold_reason: 'email_invalid' });
      expect((await one(`SELECT email_verify_status FROM sdr_lead_state`)).email_verify_status).toBe('invalid');
    });
    it('missing email, bid date or usable name holds the lead; bids before the floor and non-bid leads are ignored; archived stops', async () => {
      await lead('x1', { email: 'na' });
      await lead('x2', { bid: null, email: 'x2@gc.test' });
      await lead('x3', { title: 'ALL TRADES', email: 'x3@gc.test' });
      await lead('x4', { bid: '2026-08-20', email: 'x4@gc.test' });
      await lead('x5', { origin: 'CMD', email: 'x5@gc.test' });
      await lead('x6', { email: 'x6@gc.test' });
      const d = deps();
      const r = await runBidInviteSequence(pool, d);
      expect(r.holds).toMatchObject({ no_email: 1, no_bid_date: 1, short_name_unusable: 1 });
      const ids = (await pool.query(`SELECT pipedrive_lead_id FROM bid_invite_leads ORDER BY 1`)).rows.map((x) => x.pipedrive_lead_id);
      expect(ids).toEqual(['x1', 'x2', 'x3', 'x6']);
      expect(d.sent.map((m) => m.to)).toEqual(['x6@gc.test']);
      await pool.query(`UPDATE sdr_lead_state SET crm_status='archived' WHERE pipedrive_lead_id='x2'`);
      await runBidInviteSequence(pool, deps());
      expect((await one(`SELECT state FROM bid_invite_leads WHERE pipedrive_lead_id='x2'`)).state).toBe('stopped');
    });
    it('a recent reply anywhere (180 days) holds it', async () => {
      await lead('rr');
      await pool.query(`INSERT INTO sdr_message_facts (provider, provider_message_id, direction, mailbox_email, prospect_email, occurred_at, human_reply, link_status)
        VALUES ('apollo','in1','in','dc@proswppp.co','rodger@gc.test',$1,true,'unmatched')`, [new Date(+NOW - 20 * 86400000)]);
      const d = deps();
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect((await one(`SELECT hold_reason FROM bid_invite_batches`)).hold_reason).toBe('recent_reply');
    });
  });

  describe('replies', () => {
    const sendFirst = async () => {
      await lead('q1', { title: 'Wharton SWPPP' });
      const d = deps();
      await runBidInviteSequence(pool, d);
      return { e1: d.sent[0], batch: await one(`SELECT b.*, lower(m.email) mailbox FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id`) };
    };
    const thread = (e1, msgs) => ({ messages: [{ id: 'g1', from: 'jg@proswppp.co', subject: e1.subject, lastOutbound: true, receivedAt: '2026-11-03T22:10:00Z', messageId: e1.messageId }, ...msgs] });
    it('a reply in the thread: replied, recipient hold, other sequences stopped, task with a drafted answer', async () => {
      const { e1, batch } = await sendFirst();
      const otherDraft = (await one(`INSERT INTO sdr_drafts (pipedrive_lead_id, contact_email_snapshot, contact_id_snapshot, status) VALUES ('cold1','rodger@gc.test','p1','sent') RETURNING id`)).id;
      await pool.query(`INSERT INTO sdr_sends (draft_id, pipedrive_lead_id, apollo_sequence_id, apollo_contact_id, status, apollo_emailer_message_id) VALUES ($1,'cold1','seqA','acA','sent','e')`, [otherDraft]);
      const d = deps({ now: new Date('2026-11-05T14:00:00Z') });
      d.gmail.getThread.mockResolvedValue(thread(e1, [{ id: 'r1', from: 'Rodger Caffey <rodger@gc.test>', subject: `Re: ${e1.subject}`, receivedAt: '2026-11-04T15:00:00Z',
        body: 'We got it, send over the SWPPP price.', messageId: '<reply-1@gc.test>' }]));
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(await one(`SELECT state, reply_source FROM bid_invite_batches`)).toEqual({ state: 'replied', reply_source: 'gmail_thread' });
      expect((await one(`SELECT state FROM bid_invite_leads`)).state).toBe('replied');
      const hold = await one(`SELECT scope_kind, scope_id, reason FROM sdr_outreach_controls`);
      expect(hold).toEqual({ scope_kind: 'recipient', scope_id: 'rodger@gc.test', reason: 'Replied to a bid invite follow-up: manual follow-up only' });
      const stop = await one(`SELECT kind, target_key, payload FROM sdr_reply_actions`);
      expect(stop.kind).toBe('stop_sequence');
      expect(stop.target_key).toMatch(/:seqA:acA$/);
      expect(stop.payload.leadId).toBe('cold1');
      expect(d.draftReply).toHaveBeenCalledWith(expect.objectContaining({ step: 'waiting', project: 'Wharton SWPPP' }));
      const task = d.pd.addActivity.mock.calls[0][0];
      expect(task.subject).toBe('Bid invite reply: Rodger Caffey on Wharton SWPPP');
      expect(task.userId).toBe(Number((await one(`SELECT pipedrive_user_id FROM sdr_reply_routes WHERE mailbox_email=$1`, [batch.mailbox])).pipedrive_user_id));
      expect(task.note).toContain('READY TO SEND');
      expect(task.note).toContain('Great, send the plans over.');
      expect(task.note).toContain('send over the SWPPP price');
      // Once per contact.
      const again = deps({ now: new Date('2026-11-06T14:00:00Z') });
      await runBidInviteSequence(pool, again);
      expect(again.pd.addActivity).not.toHaveBeenCalled();
      // A later run never sends Email 2.
      const e2 = deps({ now: new Date('2026-12-16T13:00:00Z') });
      await runBidInviteSequence(pool, e2);
      expect(e2.gmail.sendMail).not.toHaveBeenCalled();
    });
    it('with the reply exit switched on, an exit_person action is queued instead', async () => {
      const { e1 } = await sendFirst();
      const d = deps({ now: new Date('2026-11-05T14:00:00Z'), replyExitMode: () => 'live' });
      d.gmail.getThread.mockResolvedValue(thread(e1, [{ id: 'r1', from: 'rodger@gc.test', subject: 'Re: x', receivedAt: '2026-11-04T15:00:00Z', body: 'Yes we won it', messageId: '<reply-2@gc.test>' }]));
      await runBidInviteSequence(pool, d);
      const a = await one(`SELECT kind, target_key FROM sdr_reply_actions`);
      expect(a).toEqual({ kind: 'exit_person', target_key: 'exit:rodger@gc.test' });
    });
    it('a "Reply received" task already there: the draft goes on the lead as a note', async () => {
      const { e1 } = await sendFirst();
      await pool.query(`INSERT INTO sdr_reply_messages (provider_message_id, source, source_message_id, mailbox_email, received_at, link_status, reply_kind)
        VALUES ('m9','gmail','m9','jg@proswppp.co',now(),'verified','human')`);
      await pool.query(`INSERT INTO sdr_reply_actions (id, provider_message_id, mailbox_email, kind, target_key, payload, status)
        VALUES (gen_random_uuid(),'m9','jg@proswppp.co','create_task','q1:jg@proswppp.co','{"leadId":"q1"}','completed')`);
      const d = deps({ now: new Date('2026-11-05T14:00:00Z') });
      d.gmail.getThread.mockResolvedValue(thread(e1, [{ id: 'r1', from: 'rodger@gc.test', subject: 'Re: x', receivedAt: '2026-11-04T15:00:00Z', body: 'Who do I send plans to?', messageId: '<reply-3@gc.test>' }]));
      await runBidInviteSequence(pool, d);
      expect(d.pd.addActivity).not.toHaveBeenCalled();
      expect(d.pd.addNote.mock.calls.at(-1)[0].content).toContain('Prepared reply for the bid invite reply, copy and paste:');
    });
    it('an out-of-office does not count; a mailer-daemon message is a bounce', async () => {
      const { e1 } = await sendFirst();
      let d = deps({ now: new Date('2026-11-05T14:00:00Z') });
      d.gmail.getThread.mockResolvedValue(thread(e1, [{ id: 'r1', from: 'rodger@gc.test', subject: 'Automatic reply: Out of Office', receivedAt: '2026-11-04T15:00:00Z', body: 'I am out of the office until Monday.' }]));
      await runBidInviteSequence(pool, d);
      expect((await one(`SELECT state FROM bid_invite_batches`)).state).toBe('active');
      d = deps({ now: new Date('2026-11-05T14:00:00Z') });
      d.gmail.getThread.mockResolvedValue(thread(e1, [{ id: 'r2', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', receivedAt: '2026-11-04T15:00:00Z', body: 'Address not found' }]));
      await runBidInviteSequence(pool, d);
      expect((await one(`SELECT state FROM bid_invite_batches`)).state).toBe('bounced');
      expect(d.pd.addNote.mock.calls[0][0].content).toContain('bounced');
      expect(await count('sdr_outreach_controls')).toBe(0);
    });
    it('the exit hook: a reply anywhere closes open bid batches and waiting leads; a task follows only after an email went out', async () => {
      registerBidInviteExitHook(pool);
      const hook = exitHooks().find((h) => h.name === 'bid_invites');
      expect(hook).toBeTruthy();
      await sendFirst();
      await lead('w1', { email: 'other@gc.test', bid: '2026-11-20' });
      await runBidInviteSequence(pool, deps());
      expect(await hook.liveSequenceLeadIds(pool)).toEqual(['q1']);
      expect(await hook.preview({ emails: ['rodger@gc.test', 'other@gc.test'], leadIds: [], personIds: [] })).toEqual({ wouldCancel: 3 }); // the batch, its lead and the waiting lead
      expect(await hook.exit({ emails: ['rodger@gc.test', 'other@gc.test'], leadIds: [], personIds: [], now: new Date() })).toEqual({ cancelled: 3 });
      expect(await hook.exit({ emails: ['rodger@gc.test', 'other@gc.test'], leadIds: [], personIds: [], now: new Date() })).toEqual({ cancelled: 0 });
      expect((await one(`SELECT state FROM bid_invite_leads WHERE pipedrive_lead_id='w1'`)).state).toBe('replied');
      const d = deps({ now: new Date('2026-11-25T14:00:00Z') });
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(d.pd.addActivity).toHaveBeenCalledTimes(1);
      expect(d.pd.addActivity.mock.calls[0][0].note).toContain('the reply was recorded on another email or channel');
    });
  });

  describe('send failures', () => {
    it('a 4xx releases the claim and the next run retries', async () => {
      await lead('f1');
      const d = deps();
      d.gmail.sendMail.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400 }));
      await runBidInviteSequence(pool, d);
      expect(await count('bid_invite_sends')).toBe(0);
      expect((await one(`SELECT send_failures FROM bid_invite_batches`)).send_failures).toBe(1);
      const d2 = deps({ now: new Date(+NOW + 10 * 60000) });
      await runBidInviteSequence(pool, d2);
      expect(d2.gmail.sendMail).toHaveBeenCalledTimes(1);
      expect((await one(`SELECT status FROM bid_invite_sends`)).status).toBe('sent');
    });
    it('a timeout is uncertain: batch held, never resent', async () => {
      await lead('f2');
      const d = deps();
      d.gmail.sendMail.mockRejectedValueOnce(new Error('socket hang up'));
      await runBidInviteSequence(pool, d);
      expect((await one(`SELECT status FROM bid_invite_sends`)).status).toBe('uncertain');
      expect(await one(`SELECT state, hold_reason FROM bid_invite_batches`)).toEqual({ state: 'held', hold_reason: 'send_uncertain' });
      const d2 = deps({ now: new Date(+NOW + 10 * 60000) });
      await runBidInviteSequence(pool, d2);
      expect(d2.gmail.sendMail).not.toHaveBeenCalled();
    });
    it('two runs at once cannot both send: one run at a time, and one claim per step', async () => {
      await lead('f3');
      const a = deps(), b = deps();
      const [ra, rb] = await Promise.all([runBidInviteSequence(pool, a), runBidInviteSequence(pool, b)]);
      expect(a.gmail.sendMail.mock.calls.length + b.gmail.sendMail.mock.calls.length).toBe(1);
      expect([ra.skipped, rb.skipped].filter(Boolean).length).toBeLessThanOrEqual(1);
      const batch = await one(`SELECT id FROM bid_invite_batches`);
      await expect(pool.query(`INSERT INTO bid_invite_sends (batch_id, step, mailbox_id, recipient_email, subject, body_text, rfc_message_id, status)
        SELECT $1,'e1',mailbox_id,'x','s','b','<r>','claimed' FROM bid_invite_batches WHERE id=$1`, [batch.id])).rejects.toThrow(/duplicate key/);
    });
  });

  it('the message fact links a reply on the thread to the first named project', async () => {
    await lead('k1', { title: 'Katy Library' });
    await lead('k2', { title: 'Katy Fire Station', bid: '2026-10-25' });
    const d = deps();
    await runBidInviteSequence(pool, d);
    const e1 = d.sent[0];
    const fact = await one(`SELECT * FROM sdr_message_facts WHERE provider='gmail'`);
    expect(fact).toMatchObject({ direction: 'out', source_key: 'bid_invite', sequence_step: 1, provider_status: 'completed', pipedrive_lead_id: 'k2', link_status: 'verified' });
    expect(fact.link_evidence).toMatch(/^bid_invite_send:/);
    const mailbox = fact.mailbox_email;
    const thread = { id: 't1', messages: [{ id: 'g1', from: mailbox, to: 'rodger@gc.test', subject: e1.subject, lastOutbound: true, receivedAt: '2026-11-03T22:10:00Z', messageId: e1.messageId }] };
    const message = { id: 'r1', from: 'rodger@gc.test', subject: `Re: ${e1.subject}`, receivedAt: '2026-11-04T15:00:00Z', inReplyTo: e1.messageId, references: e1.messageId, messageId: '<x@gc.test>' };
    expect(await resolveReplyProject(pool, { mailbox, thread, message })).toMatchObject({ status: 'verified', leadId: 'k2' });
    const log = (await pool.query(`SELECT pipedrive_lead_id, source FROM sdr_outreach_log ORDER BY 1`)).rows;
    expect(log).toEqual([{ pipedrive_lead_id: 'k1', source: 'interface' }, { pipedrive_lead_id: 'k2', source: 'interface' }]);
  });

  it('status lists batches, holds and sends today', async () => {
    await lead('s1');
    await runBidInviteSequence(pool, deps());
    const s = await bidInviteStatus(pool);
    expect(s.schema).toBe(true);
    expect(s.batches).toEqual([{ state: 'active', next_step: 'e2', n: 1 }]);
  });
});
