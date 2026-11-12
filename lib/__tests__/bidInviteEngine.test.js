import fs from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import {
  runBidInviteSequence, bidInviteMode, bidInviteConfig, liveRefusal, registerBidInviteExitHook, bidInviteSentToday, bidInviteStatus,
  renderPreviewHtml, lastOutbound, bidInviteExit, liveSendBlock, projectAddresses,
} from '../bidInviteEngine.js';
import { exitHooks, resetExitHooksForTests, registerExitHook } from '../replyExit.js';
import { registerLinkedinExitHook, holdLinkedinForExit } from '../linkedinExitHook.js';
import { setOutreachControl } from '../sdrOutreachControls.js';
import { resolveReplyProject } from '../sdrReplyContext.js';
import { mailboxSentTodayShared } from '../permitDrafts.js';
import { selectPipedriveReplyCandidates } from '../sdrPipedriveReplyIntake.js';
import { enqueueReplyActions } from '../sdrReplyActions.js';
import { recentBidInviteSendAt } from '../lastOutbound.js';

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
  it('live sends only with the reply exit live; dry_run and off are never blocked; the server says so at startup and on every run', () => {
    expect(liveSendBlock({ BID_INVITE_SEQUENCE: 'live' })).toMatch(/^SDR_REPLY_EXIT_MODE is off, not live/);
    expect(liveSendBlock({ BID_INVITE_SEQUENCE: 'live', SDR_REPLY_EXIT_MODE: 'dry_run' })).toMatch(/is dry_run, not live/);
    expect(liveSendBlock({ BID_INVITE_SEQUENCE: 'live', SDR_REPLY_EXIT_MODE: 'live' })).toBeNull();
    expect(liveSendBlock({ BID_INVITE_SEQUENCE: 'dry_run' })).toBeNull();
    expect(liveSendBlock({})).toBeNull();
    const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(server).toMatch(/const bidSendBlock = bidInviteLiveSendBlock\(\);\n\s+if \(bidSendBlock\) console\.error\("\[bid-invites\] live mode will not send:", bidSendBlock\);/);
    expect(server).toMatch(/reason: r\.reason \|\| null/);
  });
  it('project addresses: a slow Pipedrive read gives null at the deadline and stops new reads, but a lead already read this run keeps its address', async () => {
    const ADDRESS = '8315f83413b4d585f9d3009fbbfc054f1a82386b';
    const getLead = vi.fn((id) => (id === 'slow' ? new Promise(() => {}) : Promise.resolve({ id, [ADDRESS]: `${id} City, AL` })));
    const ctx = { deps: { pd: { getLead }, addressLookupMs: 20 }, leadCache: new Map([['cached', Promise.resolve({ id: 'cached', [ADDRESS]: 'Mobile, AL' })]]) };
    expect(await projectAddresses(ctx, ['fresh'])).toEqual(['fresh City, AL']);
    expect(await projectAddresses(ctx, ['slow'])).toEqual([null]);
    expect(ctx.leadCache.has('slow')).toBe(false);
    expect(await projectAddresses(ctx, ['cached', 'fresh', 'new'])).toEqual(['Mobile, AL', 'fresh City, AL', null]);
    expect(getLead.mock.calls.map((c) => c[0])).toEqual(['fresh', 'slow']);
    // A failed read is null and does not switch the reads off.
    const failing = { deps: { pd: { getLead: vi.fn(async (id) => { if (id === 'bad') throw new Error('down'); return { [ADDRESS]: 'Macon, GA' }; }) } }, leadCache: new Map() };
    expect(await projectAddresses(failing, ['bad', 'ok'])).toEqual([null, 'Macon, GA']);
    expect(await projectAddresses({ deps: {}, leadCache: new Map() }, ['x'])).toEqual([null]);
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
      CREATE TABLE sdr_inbox_accounts (mailbox_email text PRIMARY KEY, refresh_token text, last_error text);
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
    status = 'active', verified = 'valid', person = 'p1', org = '9' } = {}) => pool.query(`INSERT INTO sdr_lead_state (pipedrive_lead_id, pipedrive_person_id, pipedrive_org_id, person_name,
      person_email, lead_title, bid_date, crm_status, crm_company_id, lead_origin, email_verify_status, email_verified_at, email_verified_value)
      VALUES ($1,$2,$12,$3,$4,$5,$6,$7,'co1',$8,$9,$10,$11)`, [id, person, name, email, title, bid, status, origin, verified, verified ? NOW : null, verified ? email : null, org]);
  const deps = (over = {}) => {
    const sent = [];
    const gmail = {
      sendMail: vi.fn(async (token, msg) => { sent.push(msg); return { id: `g${sent.length}`, threadId: msg.threadId || `t${sent.length}` }; }),
      getThread: vi.fn(async () => ({ messages: [] })),
    };
    const pd = {
      // One Pipedrive organization per contact address (the one-email-a-company-a-day rule).
      getLead: vi.fn(async (id) => ({ id, organization_id: `org-${(await one('SELECT person_email FROM sdr_lead_state WHERE pipedrive_lead_id=$1', [id]))?.person_email}`, owner_id: 777, is_archived: false })),
      getOrganization: vi.fn(async (id) => ({ id, owner_id: { id: 111 }, address_admin_area_level_1: 'TX' })),
      getPerson: vi.fn(async () => ({ last_outgoing_mail_time: null, last_incoming_mail_time: null })),
      addNote: vi.fn(async () => ({ id: 1 })),
      addActivity: vi.fn(async () => ({ id: 55 })),
    };
    return {
      mode: 'live', gmail, pd, sent, getToken: vi.fn(async () => 'tok'), verifyEmail: vi.fn(async () => ({ ok: true, status: 'valid' })),
      isCustomerLead: vi.fn(async () => null), draftReply: vi.fn(async () => ({ decision: 'draft', body: 'Hey Rodger,\n\nGreat, send the plans over.\n\nRegards,' })),
      companyId: 'co1', perMailboxDay: 15, minBidDate: '2026-09-01', replyExitMode: () => 'live', now: NOW, ...over,
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
    expect(r.samples.find((s) => s.to === 'rodger@gc.test').flags).toEqual(expect.arrayContaining(['would_verify']));
    for (const t of ['bid_invite_leads', 'bid_invite_batches', 'bid_invite_sends', 'sdr_message_facts', 'sdr_outreach_log', 'sdr_outreach_controls']) expect(await count(t)).toBe(0);
    expect(d.gmail.sendMail).not.toHaveBeenCalled();
    expect(d.pd.addNote).not.toHaveBeenCalled();
    expect(d.pd.addActivity).not.toHaveBeenCalled();
    expect(d.verifyEmail).not.toHaveBeenCalled();
    expect((await one(`SELECT email_verify_status FROM sdr_lead_state WHERE pipedrive_lead_id='a'`)).email_verify_status).toBeNull();
    const html = renderPreviewHtml(r);
    expect(html).toContain("did y'all win");
    expect(html).toContain('We appreciate it.');
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
    expect(d.sent[0]).toMatchObject({ to: 'past@gc.test', subject: 'Project Past SWPPP', from: '"Josie Godfrey" <jg@proswppp.co>' });
    expect(d.sent[0].bodyText).toBe("Rodger, did y'all win this Project Past?\n\nYou should have a bid from us on the SWPPP.\n\nIf everything looks good on it, just let us know how quick you need it.\n\nWe appreciate it.\n\nRegards,\nJosie Godfrey");
    expect(d.sent[0].messageId).toMatch(/^<bid-[0-9a-f-]+@proswppp\.co>$/);
  });
  it("the project's address in Pipedrive gives the city and the state's own term; a blank or odd one gives neither", async () => {
    const ADDRESS = '8315f83413b4d585f9d3009fbbfc054f1a82386b';
    await lead('al1', { bid: '2026-10-20', email: 'al@gc.test', title: 'Tuscaloosa Fire Station 4, All Trades' });
    const d = deps();
    const base = d.pd.getLead;
    d.pd.getLead = vi.fn(async (id) => ({ ...(await base(id)), [ADDRESS]: 'NORTHPORT, AL' }));
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].subject).toBe('Tuscaloosa Fire Station 4 CBMPP');
    expect(d.sent[0].bodyText.split('\n\n').slice(0, 2)).toEqual(["Rodger, did y'all win this Tuscaloosa Fire Station 4 over in Northport?", 'You should have a bid from us on the CBMPP.']);
    expect((await one(`SELECT first_subject FROM bid_invite_batches WHERE contact_email='al@gc.test'`)).first_subject).toBe('Tuscaloosa Fire Station 4 CBMPP');

    await lead('odd', { bid: '2026-10-20', email: 'odd@gc.test', title: 'Port Or Harbor Rehab', name: 'Kim Lee', person: 'p2' });
    const dry = deps({ mode: 'dry_run' });
    const base2 = dry.pd.getLead;
    dry.pd.getLead = vi.fn(async (id) => ({ ...(await base2(id)), [ADDRESS]: 'somewhere in or near the port' }));
    const r = await runBidInviteSequence(pool, dry);
    const odd = r.samples.find((x) => x.to === 'odd@gc.test');
    expect(odd.subject).toBe('Port Or Harbor Rehab SWPPP');
    expect(odd.bodyText.split('\n\n').slice(0, 2)).toEqual(["Kim, did y'all win this Port Or Harbor Rehab?", 'You should have a bid from us on the SWPPP.']);

    // A Pipedrive read that never comes back at send time: the email goes at the deadline, without a
    // city, and the rest of the run stops asking.
    await pool.query(`DELETE FROM sdr_lead_state WHERE pipedrive_lead_id='odd'`);
    await lead('slow', { bid: '2026-10-20', email: 'slow@gc.test', title: 'Mobile Clinic', person: 'p3' });
    const first = deps({ now: new Date('2026-11-03T13:10:00Z') }); // batched for the next morning, not sent
    await runBidInviteSequence(pool, first);
    expect(first.sent).toHaveLength(0);
    const hung = deps({ addressLookupMs: 30, now: new Date('2026-11-04T13:20:00Z') }); // the next morning's window
    hung.pd.getLead = vi.fn(() => new Promise(() => {}));
    const started = Date.now();
    await runBidInviteSequence(pool, hung);
    expect(Date.now() - started).toBeLessThan(3000);
    const slow = hung.sent.find((m) => m.to === 'slow@gc.test');
    expect(slow.bodyText.startsWith("Rodger, did y'all win this Mobile Clinic?\n\nYou should have a bid from us on the SWPPP.")).toBe(true);
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

  it('several bids for one contact: one "Your recent bids" email naming 3, the 4th counted as "and 1 more", no second email that day', async () => {
    await lead('l1', { bid: '2026-10-01', title: 'Zavala County Jail - Sitework' });
    await lead('l2', { bid: '2026-10-10', title: 'Fort Bend ISD Natatorium (Bid Package 2)' });
    await lead('l3', { bid: '2026-10-20', title: 'Wharton SWPPP' });
    await lead('l4', { bid: '2026-09-15', title: 'Bay City Clinic' });
    const d = deps();
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].subject).toBe('Your recent bids');
    expect(d.sent[0].bodyText.split('\n\n').slice(0, 3)).toEqual(["Rodger, did y'all win any of these?", 'Wharton, Fort Bend ISD Natatorium, Zavala County Jail and 1 more.', 'You should have a bid from us on each one.']);
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
    expect(task.note).toContain('Rodger, checking back on this UTMB CLC Parking Lot.');
    expect(task.note).toContain('If it went your way, we can have the SWPPP ready before you mobilize.');
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
    await lead('n1', { bid: '2026-10-06', title: 'Hwy 59 Widening' });
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
    expect(d.sent[0].bodyText.split('\n\n').slice(0, 2)).toEqual(['Rodger, checking back on this Hwy 59 Widening.', 'If it went your way, we can have the SWPPP ready before you mobilize.']);
    b = await one(`SELECT * FROM bid_invite_batches`);
    expect(b.next_step).toBe('e3');
    d = deps({ now: (await import('../bidInvitePlan.js')).nextWindowSlot(new Date(+b.next_due_at + 60000), 'America/Chicago') });
    await runBidInviteSequence(pool, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].bodyText.split('\n\n').slice(0, 2)).toEqual(['Rodger, last one on this Hwy 59 Widening.', "If you won it, let's get the SWPPP going. If not, we'll get 'em on the next one."]);
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
    it('a reply in the thread: replied, recipient hold, the cross-sequence exit queued at the reply time, task with a drafted answer', async () => {
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
      // One exit_person for Rodger (every Apollo membership, seqA included), stamped with when he wrote.
      expect((await pool.query(`SELECT kind FROM sdr_reply_actions`)).rows.map((r) => r.kind)).toEqual(['exit_person']);
      const exit = await one(`SELECT target_key, payload, provider_message_id FROM sdr_reply_actions`);
      expect(exit.target_key).toBe('exit:rodger@gc.test');
      expect(exit.payload).toMatchObject({ replyAt: '2026-11-04T15:00:00.000Z', fromEmail: 'rodger@gc.test', source: 'bid_invite', exitLeadId: 'q1' });
      expect(exit.provider_message_id).toBe('<reply-1@gc.test>');
      // No stop_sequence without a thread, and no second "human" reply row: only the exit trigger.
      expect((await pool.query(`SELECT reply_kind, source FROM sdr_reply_messages`)).rows).toEqual([{ reply_kind: 'exit_signal', source: 'bid_invite' }]);
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
    it('live refuses to send unless the reply exit is live: nothing read or written, the due batches counted as held', async () => {
      await sendFirst();
      await pool.query(`UPDATE bid_invite_batches SET next_due_at=$1`, [new Date('2026-11-05T13:00:00Z')]);
      for (const exitMode of ['off', 'dry_run']) {
        const d = deps({ now: new Date('2026-11-05T14:00:00Z'), replyExitMode: () => exitMode });
        const r = await runBidInviteSequence(pool, d);
        expect(r.skipped).toBe('reply_exit_not_live');
        expect(r.reason).toMatch(/SDR_REPLY_EXIT_MODE is .*not live/);
        expect(r.holds).toEqual({ reply_exit_not_live: 1 });
        expect(d.gmail.sendMail).not.toHaveBeenCalled();
        expect(d.gmail.getThread).not.toHaveBeenCalled();
        expect(d.pd.getLead).not.toHaveBeenCalled();
      }
      // dry_run is unaffected.
      const dry = await runBidInviteSequence(pool, deps({ mode: 'dry_run', now: new Date('2026-11-05T14:00:00Z'), replyExitMode: () => 'off' }));
      expect(dry.skipped).toBeUndefined();
      expect(dry.samples.length).toBeGreaterThan(0);
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
      const e1At = (await one(`SELECT min(sent_at) t FROM bid_invite_sends`)).t;
      expect(await hook.liveSequenceLeads(pool)).toEqual([{ leadId: 'q1', email: 'rodger@gc.test', since: e1At }]);
      // A colleague's exit carries Rodger's project and person: it matches nothing here.
      expect(await hook.preview({ emails: ['colleague@gc.test'], leadIds: ['q1', 'w1'], personIds: ['p1'] })).toEqual({ wouldCancel: 0 });
      expect(await hook.exit({ emails: ['colleague@gc.test'], leadIds: ['q1', 'w1'], personIds: ['p1'], now: new Date() })).toEqual({ cancelled: 0 });
      expect(await hook.preview({ emails: ['rodger@gc.test', 'other@gc.test'], leadIds: [], personIds: [] })).toEqual({ wouldCancel: 3 }); // the batch, its lead and the waiting lead
      expect(await hook.exit({ emails: ['rodger@gc.test', 'other@gc.test'], leadIds: [], personIds: [], now: new Date() })).toEqual({ cancelled: 3 });
      expect(await hook.exit({ emails: ['rodger@gc.test', 'other@gc.test'], leadIds: [], personIds: [], now: new Date() })).toEqual({ cancelled: 0 });
      expect((await one(`SELECT state FROM bid_invite_leads WHERE pipedrive_lead_id='w1'`)).state).toBe('replied');
      const d = deps({ now: new Date('2026-11-25T14:00:00Z') });
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      // The reply was elsewhere (nothing from them in our thread): it has its own handling, no bid task.
      expect(d.pd.addActivity).not.toHaveBeenCalled();
      expect((await one(`SELECT reply_task_activity_id FROM bid_invite_batches`)).reply_task_activity_id).toBe('reply_elsewhere');
    });
  });

  describe('QA fixes', () => {
    const plan = () => import('../bidInvitePlan.js');
    const firstSend = async (id = 'q1', opts = {}) => {
      await lead(id, { title: 'Wharton SWPPP', ...opts });
      const d = deps();
      await runBidInviteSequence(pool, d);
      return { d, e1: d.sent[0], batch: await one(`SELECT b.*, lower(m.email) mailbox FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id ORDER BY created_at DESC LIMIT 1`) };
    };
    const noActionTaken = async (d) => {
      expect(await count('sdr_outreach_controls')).toBe(0);
      expect(await count('sdr_reply_actions')).toBe(0);
      expect(d.pd.addActivity).not.toHaveBeenCalled();
    };

    it('1. synced .com mail the Pipedrive intake has not classified yet only pauses the batch a week: no hold, no exit, no task', async () => {
      const { batch } = await firstSend();
      await pool.query(`INSERT INTO sdr_conversation_messages (provider, account_key, provider_message_id, from_address, occurred_at, direction)
        VALUES ('pipedrive','pd','in1','Rodger <rodger@gc.test>','2026-11-14T15:00:00Z','in')`);
      const d = deps({ now: new Date('2026-11-16T14:00:00Z') });
      const r = await runBidInviteSequence(pool, d);
      expect(r.counts.paused_contact_wrote).toBe(1);
      const b = await one(`SELECT state, next_due_at, pause_reason FROM bid_invite_batches WHERE id=$1`, [batch.id]);
      expect(b.state).toBe('active');
      expect(b.pause_reason).toBe('pipedrive_mail');
      expect(+b.next_due_at).toBeGreaterThanOrEqual(+new Date('2026-11-21T15:00:00Z'));
      await noActionTaken(d);
    });
    it('1. Pipedrive "last email received", a colleague\'s copied mail and mail from before our first email only pause or do nothing', async () => {
      const { batch } = await firstSend();
      const ledger = (id, from, at) => pool.query(`INSERT INTO sdr_reply_messages (provider_message_id, source, source_message_id, mailbox_email, received_at, link_status, reply_kind, from_email, pipedrive_lead_id)
        VALUES ($1,'pipedrive',$1,'dc@proswppp.com',$3,'verified','human',$2,'q1')`, [id, from, at]);
      await ledger('pd-colleague', 'katie@katie-gc.test', '2026-11-09T15:00:00Z');
      await ledger('pd-old', 'rodger@gc.test', '2026-11-02T15:00:00Z');
      const d = deps({ now: new Date('2026-11-12T14:00:00Z') });
      d.pd.getPerson.mockResolvedValue({ last_incoming_mail_time: '2026-11-11 15:00:00' });
      await runBidInviteSequence(pool, d);
      const b = await one(`SELECT state, next_due_at FROM bid_invite_batches WHERE id=$1`, [batch.id]);
      expect(b.state).toBe('active');
      expect(+b.next_due_at).toBeGreaterThanOrEqual(+new Date('2026-11-18T15:00:00Z'));
      await noActionTaken(d);
    });
    it('1 + 2. the contact writes to the rep\'s .com inbox after our first email (intake-classified, same address): replied, hold, exit at the reply time, task with a draft', async () => {
      const { batch } = await firstSend();
      await pool.query(`INSERT INTO sdr_reply_messages (provider_message_id, source, source_message_id, mailbox_email, received_at, link_status, reply_kind, from_email, pipedrive_lead_id)
        VALUES ('pipedrive:pd:777','pipedrive','777','dc@proswppp.com','2026-11-09T15:00:00Z','verified','human','rodger@gc.test','other-lead')`);
      const d = deps({ now: new Date('2026-11-12T14:00:00Z') });
      d.pd.getMailMessage = vi.fn(async () => ({ id: 777, subject: 'RE: Wharton', body: '<p>We got Wharton, who do I send plans to?</p>', from: [{ email_address: 'rodger@gc.test', name: 'Rodger Caffey' }] }));
      const r = await runBidInviteSequence(pool, d);
      expect(r.counts.replied).toBe(1);
      expect(await one(`SELECT state, reply_source, reply_detected_at FROM bid_invite_batches WHERE id=$1`, [batch.id]))
        .toEqual({ state: 'replied', reply_source: 'pipedrive_reply', reply_detected_at: new Date('2026-11-09T15:00:00Z') });
      expect(await one(`SELECT scope_id, reason FROM sdr_outreach_controls`)).toEqual({ scope_id: 'rodger@gc.test', reason: 'Replied to a bid invite follow-up: manual follow-up only' });
      // The intake already recorded this reply (and queues its own exit): no second trigger.
      expect(r.counts.exit_already_recorded).toBe(1);
      expect(await count('sdr_reply_actions')).toBe(0);
      expect(d.pd.getMailMessage).toHaveBeenCalledWith('777', { includeBody: true });
      const task = d.pd.addActivity.mock.calls[0][0];
      expect(task.subject).toBe('Bid invite reply: Rodger Caffey on Wharton SWPPP');
      expect(task.note).toContain('who do I send plans to?');
      expect(task.note).toContain('READY TO SEND');
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
    });
    it('1. a reply logged for our .co mailbox counts; an auto-reply in that log does not', async () => {
      const { batch } = await firstSend();
      await pool.query(`CREATE TABLE IF NOT EXISTS sdr_inbox_reply_log (gmail_message_id text PRIMARY KEY, thread_id text, mailbox_email text, from_addr text, created_at timestamptz)`);
      await pool.query(`INSERT INTO sdr_inbox_reply_log VALUES ('a1','t1',$1,'[auto] rodger@gc.test','2026-11-04T15:00:00Z')`, [batch.mailbox]);
      await pool.query(`INSERT INTO sdr_inbox_reply_log VALUES ('a2','t9','th@proswppp.co','rodger@gc.test','2026-11-04T15:00:00Z')`);
      let d = deps({ now: new Date('2026-11-05T14:00:00Z') });
      await runBidInviteSequence(pool, d);
      expect((await one(`SELECT state FROM bid_invite_batches`)).state).toBe('active');
      await pool.query(`INSERT INTO sdr_inbox_reply_log VALUES ('a3','t1',$1,'Rodger <rodger@gc.test>','2026-11-04T16:00:00Z')`, [batch.mailbox]);
      d = deps({ now: new Date('2026-11-05T14:30:00Z') });
      await runBidInviteSequence(pool, d);
      expect(await one(`SELECT state, reply_source FROM bid_invite_batches`)).toEqual({ state: 'replied', reply_source: 'inbox_log' });
      await pool.query(`DROP TABLE sdr_inbox_reply_log`);
    });
    it('1. a finished customer batch is never reopened by mail to the rep', async () => {
      await lead('cu1');
      await runBidInviteSequence(pool, deps({ isCustomerLead: vi.fn(async () => ({ reason: 'org_label' })) }));
      await pool.query(`INSERT INTO sdr_conversation_messages (provider, account_key, provider_message_id, from_address, occurred_at, direction)
        VALUES ('pipedrive','pd','in2','rodger@gc.test','2026-11-10T15:00:00Z','in')`);
      const d = deps({ now: new Date('2026-11-12T14:00:00Z') });
      d.pd.getPerson.mockResolvedValue({ last_incoming_mail_time: '2026-11-11 15:00:00' });
      await runBidInviteSequence(pool, d);
      expect((await one(`SELECT state FROM bid_invite_batches`)).state).toBe('finished');
      expect(d.pd.getPerson).not.toHaveBeenCalled();
      expect(d.gmail.getThread).not.toHaveBeenCalled();
      await noActionTaken(d);
    });
    it('1 + #125. our own exit_signal rows never re-trigger reply handling; other channels only pause', async () => {
      await lead('q1', { title: 'Wharton SWPPP' });
      let d = deps();
      await runBidInviteSequence(pool, d);
      const e1 = d.sent[0];
      d = deps({ now: new Date('2026-11-05T14:00:00Z'), replyExitMode: () => 'live' });
      d.gmail.getThread.mockResolvedValue({ messages: [{ id: 'g1', from: 'jg@proswppp.co', lastOutbound: true, receivedAt: '2026-11-03T22:10:00Z', messageId: e1.messageId },
        { id: 'r1', from: 'rodger@gc.test', subject: 'Re: x', receivedAt: '2026-11-04T15:00:00Z', body: 'Yes we won it', messageId: '<reply-loop@gc.test>' }] });
      await runBidInviteSequence(pool, d);
      expect((await one(`SELECT reply_kind, source FROM sdr_reply_messages`))).toEqual({ reply_kind: 'exit_signal', source: 'bid_invite' });
      expect(d.pd.addActivity).toHaveBeenCalledTimes(1);
      // A new bid for the same contact later: the exit row is not a new reply (no second task),
      // and the address stays on manual follow-up.
      await lead('q2', { title: 'Katy Library', bid: '2026-11-20' });
      const later = deps({ now: new Date('2026-11-25T14:00:00Z') });
      await runBidInviteSequence(pool, later);
      expect(later.pd.addActivity).not.toHaveBeenCalled();
      expect(later.gmail.sendMail).not.toHaveBeenCalled();
      // The new batch is held (the address is on manual follow-up), not handled as a second reply.
      expect(await one(`SELECT state, hold_reason, reply_detected_at FROM bid_invite_batches WHERE 'q2'=ANY(lead_ids)`)).toEqual({ state: 'held', hold_reason: 'outreach_held', reply_detected_at: null });
      // Without the recipient hold, the exit row still reads as a recent reply (hasRecentReply, #125): held, not re-handled.
      await pool.query(`TRUNCATE sdr_outreach_control_decisions, sdr_outreach_controls CASCADE`);
      await pool.query(`UPDATE bid_invite_batches SET state='active', hold_reason=NULL WHERE 'q2'=ANY(lead_ids)`);
      const again = deps({ now: new Date('2026-11-25T14:30:00Z') });
      await runBidInviteSequence(pool, again);
      expect(again.pd.addActivity).not.toHaveBeenCalled();
      expect(await one(`SELECT state, hold_reason FROM bid_invite_batches WHERE 'q2'=ANY(lead_ids)`)).toEqual({ state: 'held', hold_reason: 'recent_reply' });
    });
    it('1 + #125. an exit_signal from another channel (LinkedIn) pauses an open batch', async () => {
      const { batch } = await firstSend();
      await pool.query(`INSERT INTO sdr_reply_messages (provider_message_id, source, source_message_id, mailbox_email, received_at, link_status, reply_kind, from_email)
        VALUES ('li1','linkedin','li1','linkedin','2026-11-14T15:00:00Z','unlinked','exit_signal','rodger@gc.test')`);
      await runBidInviteSequence(pool, deps({ now: new Date('2026-11-16T14:00:00Z'), hasRecentReply: async () => false }));
      expect(await one(`SELECT state, pause_reason FROM bid_invite_batches WHERE id=$1`, [batch.id])).toEqual({ state: 'active', pause_reason: 'exit_signal:linkedin' });
    });

    it('2. a revoked Gmail grant: Email 1 moves to another mailbox, Email 2 is held, /status shows it', async () => {
      await lead('n1', { email: 'one@gc.test', bid: '2026-09-14' });
      await runBidInviteSequence(pool, deps());
      const X = (await one(`SELECT lower(m.email) email FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id`)).email;
      const other = X === 'dc@proswppp.co' ? 'jg@proswppp.co' : 'dc@proswppp.co';
      // A second contact batched on the same mailbox (Saturday: not sent yet).
      await lead('n2', { email: 'two@gc.test' });
      await pool.query(`UPDATE sdr_inbox_accounts SET refresh_token=NULL WHERE mailbox_email=$1`, [other]);
      await runBidInviteSequence(pool, deps({ now: new Date('2026-11-07T17:00:00Z') }));
      await pool.query(`UPDATE sdr_inbox_accounts SET refresh_token='rt' WHERE mailbox_email=$1`, [other]);
      expect((await one(`SELECT lower(m.email) email FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id WHERE contact_email='two@gc.test'`)).email).toBe(X);
      const { nextWindowSlot } = await plan();
      const b1 = await one(`SELECT next_due_at FROM bid_invite_batches WHERE contact_email='one@gc.test'`);
      const revoked = Object.assign(new Error('token refresh failed: invalid_grant'), { needsReconnect: true, oauthError: 'invalid_grant' });
      const d = deps({ now: nextWindowSlot(new Date(+b1.next_due_at + 60000), 'America/Chicago'),
        getToken: vi.fn(async (m) => { if (m === X) throw revoked; return 'tok'; }) });
      const r = await runBidInviteSequence(pool, d);
      expect(r.counts.mailbox_needs_reconnect).toBe(1);
      expect(await one(`SELECT state, hold_reason FROM bid_invite_batches WHERE contact_email='one@gc.test'`)).toEqual({ state: 'held', hold_reason: 'sender_unavailable' });
      expect((await one(`SELECT lower(m.email) email FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id WHERE contact_email='two@gc.test'`)).email).toBe(other);
      expect(d.sent.map((m) => [m.to, m.from.replace(/.*</, '').replace('>', '')])).toEqual([['two@gc.test', other]]);
      const s = await bidInviteStatus(pool);
      expect(s.mailboxesNeedingReconnect).toEqual([{ mailbox_email: X, last_error: 'needs_reconnect: invalid_grant', held_batches: 1 }]);
    });

    it('3. a claimed or uncertain send counts for the 3-day rule from its claim time; stale claims show on /status and hold the batch', async () => {
      const dummy = (await one(`INSERT INTO bid_invite_batches (contact_email, lead_ids, named_lead_ids, names, anchor_bid_date, customer, mailbox_id, state)
        VALUES ('rodger@gc.test','{z}','{z}','{Z SWPPP}','2026-10-01',false,$1,'held') RETURNING id`, [MB['dc@proswppp.co']])).id;
      await pool.query(`INSERT INTO bid_invite_sends (batch_id, step, mailbox_id, recipient_email, subject, body_text, rfc_message_id, status, claimed_at)
        VALUES ($1,'e1',$2,'rodger@gc.test','s','b','<r>','uncertain',$3)`, [dummy, MB['dc@proswppp.co'], new Date(+NOW - 86400000)]);
      expect(+(await lastOutbound(pool, { email: 'rodger@gc.test' }))).toBe(+NOW - 86400000);
      await pool.query(`UPDATE bid_invite_sends SET status='claimed', claimed_at=now() - interval '1 hour'`);
      expect((await bidInviteStatus(pool)).staleClaims).toHaveLength(1);
      // A batch that finds its own claim already there is held for a person, never sent twice.
      await lead('cl1', { email: 'c@gc.test' });
      await runBidInviteSequence(pool, deps({ now: new Date('2026-11-07T17:00:00Z') })); // Saturday: batched, not sent
      const b = await one(`SELECT id FROM bid_invite_batches WHERE contact_email='c@gc.test'`);
      await pool.query(`INSERT INTO bid_invite_sends (batch_id, step, mailbox_id, recipient_email, subject, body_text, rfc_message_id, status, claimed_at)
        SELECT id,'e1',mailbox_id,'c@gc.test','s','b','<r2>','claimed','2026-11-05T12:00:00Z' FROM bid_invite_batches WHERE id=$1`, [b.id]);
      const d = deps({ now: new Date('2026-11-09T13:20:00Z') });
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(await one(`SELECT state, hold_reason FROM bid_invite_batches WHERE id=$1`, [b.id])).toEqual({ state: 'held', hold_reason: 'send_uncertain' });
    });

    it('4. a changed contact address leaves the batch: no "Hey Katie" to Rodger, Katie gets her own Email 1', async () => {
      await lead('k1', { bid: '2026-10-20', title: 'Katy Library' });
      await lead('k2', { bid: '2026-10-10', title: 'Katy Fire Station' });
      await runBidInviteSequence(pool, deps({ now: new Date('2026-11-07T17:00:00Z') })); // Saturday: batched, not sent
      await pool.query(`UPDATE sdr_lead_state SET person_email='katie@katie-gc.test', person_name='Katie Caffey', email_verified_value='katie@katie-gc.test' WHERE pipedrive_lead_id='k1'`);
      const d = deps({ now: new Date('2026-11-09T13:20:00Z') });
      await runBidInviteSequence(pool, d);
      const toRodger = d.sent.filter((m) => m.to === 'rodger@gc.test');
      expect(toRodger).toHaveLength(1);
      expect(toRodger[0].subject).toBe('Katy Fire Station SWPPP');
      expect(toRodger[0].bodyText).toMatch(/^Rodger, did y'all win this Katy Fire Station\?/);
      expect(toRodger[0].bodyText).not.toContain('Katie');
      expect(await one(`SELECT lead_ids FROM bid_invite_batches WHERE contact_email='rodger@gc.test'`)).toEqual({ lead_ids: ['k2'] });
      const k1 = await one(`SELECT state, contact_email FROM bid_invite_leads WHERE pipedrive_lead_id='k1'`);
      expect(k1.contact_email).toBe('katie@katie-gc.test');
      expect(['waiting', 'batched']).toContain(k1.state);
      const katie = deps({ now: new Date('2026-11-09T14:00:00Z') });
      await runBidInviteSequence(pool, katie);
      expect(katie.sent.map((m) => [m.to, m.bodyText.split(',')[0]])).toEqual([['katie@katie-gc.test', 'Katie']]);
    });

    it('5. a postponed bid never gets Email 1 early; a grouped lead waits for its own bid + 2 business days', async () => {
      await lead('p1', { bid: '2026-10-20' });
      await runBidInviteSequence(pool, deps({ now: new Date('2026-11-07T17:00:00Z') }));
      await pool.query(`UPDATE sdr_lead_state SET bid_date='2026-11-20' WHERE pipedrive_lead_id='p1'`);
      const d = deps({ now: new Date('2026-11-09T13:20:00Z') });
      await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(await one(`SELECT state, stop_reason FROM bid_invite_batches`)).toEqual({ state: 'stopped', stop_reason: 'leads_changed' });
      expect((await one(`SELECT state FROM bid_invite_leads`)).state).toBe('waiting');
      // Grouped: bids on Monday and Tuesday are one email, sent no earlier than Thursday (Tuesday + 2 business days).
      await pool.query('TRUNCATE bid_invite_sends, bid_invite_batches, bid_invite_leads, sdr_lead_state CASCADE');
      await lead('g1', { bid: '2026-11-09' });
      await lead('g2', { bid: '2026-11-10', title: 'Second Job' });
      await runBidInviteSequence(pool, deps({ now: new Date('2026-11-09T13:20:00Z') })); // first seen Monday
      const wed = deps({ now: new Date('2026-11-11T07:00:00Z') });
      await runBidInviteSequence(pool, wed);
      expect(wed.gmail.sendMail).not.toHaveBeenCalled();
      const b = await one(`SELECT lead_ids, next_due_at FROM bid_invite_batches`);
      expect([...b.lead_ids].sort()).toEqual(['g1', 'g2']);
      expect(+b.next_due_at).toBeGreaterThanOrEqual(+new Date('2026-11-12T12:30:00Z'));
      const wedMorning = deps({ now: new Date('2026-11-11T13:20:00Z') });
      await runBidInviteSequence(pool, wedMorning);
      expect(wedMorning.gmail.sendMail).not.toHaveBeenCalled();
    });

    it('6. odd contact names and ALL-CAPS titles render cleanly', async () => {
      await lead('n1', { name: 'Smith, John', title: 'UTMB CLC PARKING LOT, ALL TRADES' });
      await lead('n2', { name: 'Estimating Department', email: 'est@est-gc.test', title: 'TXDOT US 59 WIDENING' });
      const d = deps();
      await runBidInviteSequence(pool, d);
      const byTo = Object.fromEntries(d.sent.map((m) => [m.to, m]));
      expect(byTo['rodger@gc.test'].subject).toBe('UTMB CLC Parking Lot SWPPP');
      expect(byTo['rodger@gc.test'].bodyText).toMatch(/^John, did y'all win this UTMB CLC Parking Lot\?/);
      expect(byTo['est@est-gc.test'].bodyText).toMatch(/^Did y'all win this TxDOT US 59 Widening\?/);
    });

    it('7. batching stops when a day of capacity is already waiting, at night too', async () => {
      await pool.query(`DELETE FROM sdr_inbox_accounts WHERE mailbox_email='dc@proswppp.co'`);
      for (const id of ['b1', 'b2', 'b3']) await lead(id, { email: `${id}@gc.test` });
      const night = new Date('2026-11-04T05:00:00Z'); // 23:00 Central: nothing sends, batches would pile up
      let r = await runBidInviteSequence(pool, deps({ now: night, perMailboxDay: 2 }));
      expect(r.counts.batches_created).toBe(2);
      r = await runBidInviteSequence(pool, deps({ now: new Date(+night + 10 * 60000), perMailboxDay: 2 }));
      expect(r.counts.batches_created || 0).toBe(0);
      expect(r.counts.batching_paused_backlog).toBe(2);
    });

    it('9. reply checks are bounded per run; a bounce blocks the address for later bids; the owner task is not created twice', async () => {
      await lead('a1', { email: 'a@gc.test' });
      await lead('a2', { email: 'b@b-gc.test' });
      await runBidInviteSequence(pool, deps());
      let d = deps({ now: new Date('2026-11-05T14:00:00Z'), replyChecksPerRun: 1 });
      await runBidInviteSequence(pool, d);
      expect(d.gmail.getThread).toHaveBeenCalledTimes(1);
      d = deps({ now: new Date('2026-11-05T14:10:00Z'), replyChecksPerRun: 1 });
      d.gmail.getThread.mockResolvedValue({ messages: [{ id: 'x', from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', receivedAt: '2026-11-04T15:00:00Z', body: 'not found' }] });
      await runBidInviteSequence(pool, d);
      const bounced = await one(`SELECT contact_email FROM bid_invite_batches WHERE state='bounced'`);
      expect(bounced).toBeTruthy();
      const deadLead = bounced.contact_email === 'a@gc.test' ? 'a1' : 'a2';
      expect((await one(`SELECT email_verify_status FROM sdr_lead_state WHERE pipedrive_lead_id=$1`, [deadLead])).email_verify_status).toBe('invalid');
      await lead('a3', { email: bounced.contact_email, title: 'Later Job' });
      const later = deps({ now: new Date('2026-11-10T14:00:00Z'), verifyEmail: vi.fn(async () => ({ ok: true, status: 'valid' })) });
      await runBidInviteSequence(pool, later);
      expect(later.gmail.sendMail.mock.calls.map((c) => c[1].to)).not.toContain(bounced.contact_email);

      await pool.query('TRUNCATE bid_invite_sends, bid_invite_batches, bid_invite_leads, sdr_lead_state CASCADE');
      await lead('c1');
      const first = deps({ isCustomerLead: vi.fn(async () => ({ reason: 'org_label' })) });
      first.pd.addActivity.mockRejectedValueOnce(new Error('socket hang up'));
      await runBidInviteSequence(pool, first);
      const note = first.pd.addActivity.mock.calls[0][0].note;
      expect(note).toMatch(/Ref: bid-invite-task /);
      const retry = deps({ now: new Date(+NOW + 600000) });
      retry.pd.listActivities = vi.fn(async () => [{ id: 991, note }]);
      await runBidInviteSequence(pool, retry);
      expect(retry.pd.addActivity).not.toHaveBeenCalled();
      expect((await one(`SELECT owner_task_activity_id FROM bid_invite_batches`)).owner_task_activity_id).toBe('991');
    });

    it('10. switch-on order: newest bid first', async () => {
      await pool.query(`DELETE FROM sdr_inbox_accounts WHERE mailbox_email='dc@proswppp.co'`);
      await lead('old', { email: 'old@gc.test', bid: '2026-09-05' });
      await lead('new', { email: 'new@gc.test', bid: '2026-10-30' });
      await lead('mid', { email: 'mid@gc.test', bid: '2026-10-01' });
      const d = deps({ maxNewBatches: 2 });
      await runBidInviteSequence(pool, d);
      expect(d.sent.map((m) => m.to)).toEqual(['new@gc.test']);
      expect((await pool.query(`SELECT contact_email FROM bid_invite_batches ORDER BY anchor_bid_date DESC`)).rows.map((r) => r.contact_email)).toEqual(['new@gc.test', 'mid@gc.test']);
    });

    it('a reply we detect runs every other registered exit hook (LinkedIn lanes) right away, whatever the reply-exit mode', async () => {
      registerBidInviteExitHook(pool);
      const linkedin = vi.fn(async () => ({ cancelled: 2 }));
      registerExitHook('linkedin_prospect_lanes', { exit: linkedin });
      await lead('q1', { title: 'Wharton SWPPP' });
      let d = deps();
      await runBidInviteSequence(pool, d);
      const e1 = d.sent[0];
      d = deps({ now: new Date('2026-11-05T14:00:00Z') });
      d.gmail.getThread.mockResolvedValue({ messages: [{ id: 'g1', from: 'jg@proswppp.co', lastOutbound: true, receivedAt: '2026-11-03T22:10:00Z', messageId: e1.messageId },
        { id: 'r1', from: 'rodger@gc.test', subject: 'Re: x', receivedAt: '2026-11-04T15:00:00Z', body: 'Send it over', messageId: '<li-r@gc.test>' }] });
      const r = await runBidInviteSequence(pool, d);
      expect(linkedin).toHaveBeenCalledTimes(1);
      expect(linkedin.mock.calls[0][0]).toMatchObject({ emails: ['rodger@gc.test'], leadIds: ['q1'], mode: 'live' });
      expect(r.counts.exit_hook_linkedin_prospect_lanes).toBe(2);
    });
    it('the LinkedIn exit hook is inert before the LinkedIn prospect migration and never throws', async () => {
      registerLinkedinExitHook(pool, { companyId: 'co1' });
      const hook = exitHooks().find((h) => h.name === 'linkedin_prospect_lanes');
      expect(await hook.exit({ emails: ['rodger@gc.test'] })).toEqual({ cancelled: 0 });
      expect(await holdLinkedinForExit(pool, { companyId: null, emails: ['x@y.test'] })).toEqual({ cancelled: 0 });
    });
    describe('final QA', () => {
      const raceCase = async (change) => {
        await lead('r1', { verified: null }); // unverified: verifyEmail runs after the checks, before the claim
        const d = deps({ verifyEmail: vi.fn(async () => { await change(); return { ok: true, status: 'valid' }; }) });
        const r = await runBidInviteSequence(pool, d);
        expect(d.gmail.sendMail).not.toHaveBeenCalled();
        expect(r.counts.claim_refused_state_changed).toBe(1);
        expect(await count('bid_invite_sends')).toBe(0);
      };
      it('1. a reply exit landing between the checks and the claim stops the send', async () => {
        await raceCase(() => bidInviteExit(pool, { emails: ['rodger@gc.test'], leadIds: [], personIds: [] }));
      });
      it('1. a contact change landing between the checks and the claim stops the send', async () => {
        await raceCase(() => pool.query(`UPDATE sdr_lead_state SET person_email='katie@katie-gc.test' WHERE pipedrive_lead_id='r1'`));
      });
      it('1. a recipient hold or a recorded reply landing in that window stops the send', async () => {
        await raceCase(() => setOutreachControl(pool, { companyId: 'co1', leadId: null, scope: { kind: 'recipient', id: 'rodger@gc.test' }, channel: 'email',
          reason: 'manual', contextHash: 'race', actor: { source: 'user', accountId: 'ivan' } }));
        await pool.query('TRUNCATE bid_invite_sends, bid_invite_batches, bid_invite_leads, sdr_lead_state, sdr_outreach_control_decisions, sdr_outreach_controls CASCADE');
        await raceCase(() => pool.query(`INSERT INTO sdr_reply_messages (provider_message_id, source, source_message_id, mailbox_email, received_at, link_status, reply_kind, from_email)
          VALUES ('race1','gmail','race1','dc@proswppp.co',now(),'unlinked','human','rodger@gc.test')`));
      });
      it('2. the preview can be limited to batches due within a day (pilot pick)', async () => {
        await lead('due', { email: 'due@gc.test', bid: '2026-10-01' });
        await lead('later', { email: 'later@gc.test', bid: '2026-11-20' });
        const all = await runBidInviteSequence(pool, deps({ mode: 'dry_run', preview: true, limit: 10 }));
        expect(all.samples.map((x) => x.to)).toEqual(['later@gc.test', 'due@gc.test']); // newest bid first
        const due = await runBidInviteSequence(pool, deps({ mode: 'dry_run', preview: true, limit: 10, dueWithinDay: true }));
        expect(due.samples.map((x) => x.to)).toEqual(['due@gc.test']);
      });
      it('3. a paused mailbox leaves its batches waiting; a revoked one only acts on steps due within a day; a reconnected one is released', async () => {
        await lead('h1', { bid: '2026-10-06' });
        await runBidInviteSequence(pool, deps());
        const b = await one(`SELECT b.id, b.next_due_at, lower(m.email) email, b.mailbox_id FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id`);
        const { nextWindowSlot } = await plan();
        const dueAt = nextWindowSlot(new Date(+b.next_due_at + 60000), 'America/Chicago');
        await pool.query(`UPDATE sdr_mailboxes SET warmup_status='paused' WHERE id=$1`, [b.mailbox_id]);
        let r = await runBidInviteSequence(pool, deps({ now: dueAt }));
        expect(r.counts.deferred_mailbox_paused).toBe(1);
        expect((await one(`SELECT state FROM bid_invite_batches`)).state).toBe('active');
        await pool.query(`UPDATE sdr_mailboxes SET warmup_status='ready' WHERE id=$1`, [b.mailbox_id]);
        // Revoked a week before Email 2 is due: nothing is held yet.
        const revoked = Object.assign(new Error('invalid_grant'), { needsReconnect: true, oauthError: 'invalid_grant' });
        const early = new Date(+b.next_due_at - 7 * 86400000);
        r = await runBidInviteSequence(pool, deps({ now: early, getToken: vi.fn(async (m) => { if (m === b.email) throw revoked; return 'tok'; }) }));
        expect((await one(`SELECT state FROM bid_invite_batches`)).state).toBe('active');
        // Revoked when it is due: held. Reconnected: released and sent.
        await runBidInviteSequence(pool, deps({ now: dueAt, getToken: vi.fn(async (m) => { if (m === b.email) throw revoked; return 'tok'; }) }));
        expect(await one(`SELECT state, hold_reason FROM bid_invite_batches`)).toEqual({ state: 'held', hold_reason: 'sender_unavailable' });
        await pool.query(`UPDATE sdr_inbox_accounts SET last_error=NULL WHERE mailbox_email=$1`, [b.email]);
        const back = deps({ now: new Date(+dueAt + 10 * 60000) });
        r = await runBidInviteSequence(pool, back);
        expect(r.counts.released_sender_back).toBe(1);
        expect(back.sent).toHaveLength(1);
        expect(back.sent[0].bodyText).toMatch(/^Rodger, checking back on/);
      });
      it('4. with checks rationed, the batch about to send is checked first', async () => {
        await lead('c1', { email: 'one@gc.test', bid: '2026-09-14' });
        await lead('c2', { email: 'two@two-gc.test', bid: '2026-09-14' });
        await runBidInviteSequence(pool, deps());
        await runBidInviteSequence(pool, deps({ now: new Date(+NOW + 10 * 60000) }));
        const rows = (await pool.query(`SELECT id, contact_email, gmail_thread_id FROM bid_invite_batches ORDER BY created_at`)).rows;
        expect(rows.every((x) => x.gmail_thread_id)).toBe(true);
        const soon = new Date('2026-11-20T13:00:00Z');
        await pool.query(`UPDATE bid_invite_batches SET next_due_at=$2 WHERE id=$1`, [rows[1].id, soon]);
        await pool.query(`UPDATE bid_invite_batches SET next_due_at=$2, reply_checked_at=NULL WHERE id=$1`, [rows[0].id, new Date('2026-12-30T13:00:00Z')]);
        await pool.query(`UPDATE bid_invite_batches SET reply_checked_at=now() WHERE id=$1`, [rows[1].id]); // checked recently, still first
        const d = deps({ now: new Date(+soon - 5 * 60000), replyChecksPerRun: 1 });
        await runBidInviteSequence(pool, d);
        expect(d.gmail.getThread.mock.calls.map((c) => c[1])).toEqual([rows[1].gmail_thread_id]);
      });
    });

    it('8. cold metrics leave bid invite emails out; the volume watch counts the mailbox total and shows them apart', async () => {
      await pool.query(`CREATE OR REPLACE VIEW sdr_reporting_messages AS SELECT * FROM sdr_message_facts WHERE NOT is_test`);
      const { coldOnly } = await import('../sdrMetrics.js');
      const { dailySentByMailbox } = await import('../sdrVolumeWatch.js');
      for (const [id, provider, key] of [['a1', 'apollo', 'agc'], ['g1', 'gmail', 'bid_invite'], ['g2', 'gmail', 'bid_invite']])
        await pool.query(`INSERT INTO sdr_message_facts (provider, provider_message_id, direction, mailbox_email, prospect_email, source_key, sequence_step, occurred_at, provider_status, link_status)
          VALUES ($1,$2,'out','jg@proswppp.co','x@gc.test',$3,1,now(),'completed','unmatched')`, [provider, id, key]);
      const sql = coldOnly(`SELECT count(*)::int n FROM sdr_reporting_messages WHERE ($5::text IS NULL OR source_key=$5) AND coalesce($1::text,$2::text,$3::text,$4::text) IS NULL`);
      expect((await pool.query(sql, [null, null, null, null, null])).rows[0].n).toBe(1);
      expect((await pool.query(sql, [null, null, null, null, 'bid_invite'])).rows[0].n).toBe(2);
      const { rows } = await dailySentByMailbox(pool, { env: { SDR_REPORTING_INGEST_ENABLED: 'true' } });
      // The mailbox total (what the dip and stall rules compare) and the cold and bid parts.
      expect(rows.map((r) => ({ sent: r.sent, cold_sent: r.cold_sent, bid_sent: r.bid_sent }))).toEqual([{ sent: 3, cold_sent: 1, bid_sent: 2 }]);
      await pool.query(`DROP VIEW sdr_reporting_messages`);
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

  describe('go-live review fixes (2026-11-03)', () => {
    const sendQ1 = async () => {
      await lead('q1', { title: 'Wharton SWPPP' });
      const d = deps();
      await runBidInviteSequence(pool, d);
      return { e1: d.sent[0], batch: await one(`SELECT b.*, lower(m.email) mailbox FROM bid_invite_batches b JOIN sdr_mailboxes m ON m.id=b.mailbox_id`) };
    };
    const synced = (id, from, at, leadId = 'q1') => pool.query(`INSERT INTO sdr_conversation_messages (provider, account_key, provider_message_id, from_address, occurred_at,
      direction, pipedrive_lead_id, link_evidence) VALUES ('pipedrive','pd',$1,$2,$3,'in',$4,'pipedrive-thread')`, [id, from, at, leadId]);

    it('1. Pipedrive intake on a bid lead: only the contact\'s own mail after our first bid email is a candidate', async () => {
      registerBidInviteExitHook(pool);
      await lead('q1', { title: 'Wharton SWPPP', bid: '2026-11-20' });
      await synced('early', 'Rodger <rodger@gc.test>', '2026-11-04T16:00:00Z');
      // No bid email yet: nothing on this lead is a reply to us.
      expect(await selectPipedriveReplyCandidates(pool, { now: new Date('2026-11-05T14:00:00Z') })).toEqual([]);
      await pool.query('TRUNCATE sdr_conversation_messages, bid_invite_leads, sdr_lead_state CASCADE');
      await sendQ1();
      await synced('old', 'Rodger <rodger@gc.test>', '2026-11-02T15:00:00Z');
      await synced('colleague', 'Katie <katie@katie-gc.test>', '2026-11-04T15:00:00Z');
      await synced('reply', 'Rodger Caffey <Rodger@GC.test>', '2026-11-04T16:00:00Z');
      const rows = await selectPipedriveReplyCandidates(pool, { now: new Date('2026-11-05T14:00:00Z') });
      expect(rows.map((r) => r.provider_message_id)).toEqual(['reply']);
      resetExitHooksForTests();
      expect(await selectPipedriveReplyCandidates(pool, { now: new Date('2026-11-05T14:00:00Z') })).toEqual([]);
    });

    it('2. a .com reply the intake recorded closes the batch through the exit; the next pass still holds the contact and drafts the answer', async () => {
      registerBidInviteExitHook(pool);
      const { batch } = await sendQ1();
      await pool.query(`INSERT INTO sdr_reply_messages (provider_message_id, source, source_message_id, mailbox_email, received_at, link_status, reply_kind, from_email, pipedrive_lead_id)
        VALUES ('pipedrive:pd:778','pipedrive','778','dc@proswppp.com','2026-11-06T15:00:00Z','verified','human','rodger@gc.test','q1')`);
      await bidInviteExit(pool, { emails: ['rodger@gc.test'], now: new Date('2026-11-06T15:05:00Z') });
      expect((await one(`SELECT reply_source FROM bid_invite_batches WHERE id=$1`, [batch.id])).reply_source).toBe('reply_exit');
      const d = deps({ now: new Date('2026-11-06T16:00:00Z') });
      d.pd.getMailMessage = vi.fn(async () => ({ id: 778, subject: 'RE: Wharton', body: 'We won it. Send the SWPPP quote.' }));
      await runBidInviteSequence(pool, d);
      expect(await one(`SELECT scope_id FROM sdr_outreach_controls`)).toEqual({ scope_id: 'rodger@gc.test' });
      expect(d.pd.addActivity).toHaveBeenCalledTimes(1);
      expect(d.pd.addActivity.mock.calls[0][0].note).toContain('Send the SWPPP quote.');
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
    });

    it('2. the bid engine catches a Gmail reply before the inbox watch: the watch adds no second exit for that person', async () => {
      const { e1 } = await sendQ1();
      const d = deps({ now: new Date('2026-11-05T14:00:00Z') });
      d.gmail.getThread.mockResolvedValue({ messages: [{ id: 'g1', from: 'jg@proswppp.co', lastOutbound: true, receivedAt: '2026-11-03T22:10:00Z', messageId: e1.messageId },
        { id: 'r1', from: 'rodger@gc.test', subject: 'Re: x', receivedAt: '2026-11-04T15:00:00Z', body: 'Yes we won it', messageId: '<first-catch@gc.test>' }] });
      await runBidInviteSequence(pool, d);
      const exits = async () => (await pool.query(`SELECT provider_message_id FROM sdr_reply_actions WHERE kind='exit_person' ORDER BY created_at`)).rows.map((r) => r.provider_message_id);
      expect(await exits()).toEqual(['<first-catch@gc.test>']);
      vi.stubEnv('SDR_REPLY_EXIT_MODE', 'live');
      try {
        const watch = (id, at) => enqueueReplyActions(pool, { messageId: id, source: 'gmail', mailbox: 'jg@proswppp.co', receivedAt: at, fromEmail: 'Rodger <rodger@gc.test>',
          threadId: 't1', leadLink: { status: 'verified', leadId: 'q1', evidence: 'thread' }, intent: { kind: 'human', label: 'interested', worth: true } });
        await watch('gmail-r1', '2026-11-04T15:00:05Z');
        expect(await exits()).toEqual(['<first-catch@gc.test>']);
        // A new reply two days later is a new exit.
        await watch('gmail-r2', '2026-11-06T15:00:00Z');
        expect(await exits()).toEqual(['<first-catch@gc.test>', 'gmail-r2']);
      } finally { vi.unstubAllEnvs(); }
    });

    it('12. the cold enrolment guard still sees a bid email from 2 days ago after the bid lead is archived; 4 days ago it does not', async () => {
      await sendQ1();
      await pool.query(`UPDATE sdr_lead_state SET crm_status='archived', lead_origin='Website'`);
      const { bidInviteLeadFor } = await import('../bidInviteGuard.js');
      expect(await bidInviteLeadFor(pool, { emails: ['rodger@gc.test'] })).toBeNull();
      expect(await recentBidInviteSendAt(pool, { email: ' Rodger@GC.test ', now: new Date('2026-11-05T22:00:00Z') })).toEqual(NOW);
      expect(await recentBidInviteSendAt(pool, { email: 'rodger@gc.test', now: new Date('2026-11-07T22:20:00Z') })).toBeNull();
      expect(await recentBidInviteSendAt(pool, { email: 'someone@else.test', now: NOW })).toBeNull();
    });

    it('2. /status and the run say why live sends nothing while the reply exit is not live', async () => {
      await sendQ1();
      const s = await bidInviteStatus(pool, { env: { BID_INVITE_SEQUENCE: 'live', SDR_REPLY_EXIT_MODE: 'dry_run' } });
      expect(s.sendBlocked).toMatch(/SDR_REPLY_EXIT_MODE is dry_run, not live/);
      expect((await bidInviteStatus(pool, { env: { BID_INVITE_SEQUENCE: 'live', SDR_REPLY_EXIT_MODE: 'live' } })).sendBlocked).toBeNull();
      expect((await bidInviteStatus(pool, { env: { BID_INVITE_SEQUENCE: 'dry_run' } })).sendBlocked).toBeNull();
    });

    it('5. one bid email per company a Chicago day, across mailboxes: same organization or same company domain waits a day; personal mail does not', async () => {
      await lead('j1', { email: 'ann@james.test', name: 'Ann Lee' });
      await lead('j2', { email: 'bo@james.test', name: 'Bo Diaz', bid: '2026-10-19' });
      const sameOrg = (over = {}) => { const d = deps(over); d.pd.getLead = vi.fn(async (id) => ({ id, organization_id: 501, owner_id: 777, is_archived: false })); return d; };
      const d = sameOrg();
      const r = await runBidInviteSequence(pool, d);
      expect(d.sent.map((m) => m.to)).toEqual(['ann@james.test']);
      expect(r.counts.pushed_company_daily_limit).toBe(1);
      const waiting = await one(`SELECT next_due_at FROM bid_invite_batches WHERE contact_email='bo@james.test'`);
      expect(+waiting.next_due_at).toBeGreaterThanOrEqual(+new Date('2026-11-04T12:30:00Z'));
      expect(+waiting.next_due_at).toBeLessThanOrEqual(+new Date('2026-11-04T13:15:00Z'));
      const later = sameOrg({ now: new Date('2026-11-03T23:20:00Z') });
      await runBidInviteSequence(pool, later);
      expect(later.gmail.sendMail).not.toHaveBeenCalled();
      const tomorrow = sameOrg({ now: new Date(+waiting.next_due_at + 60000) });
      await runBidInviteSequence(pool, tomorrow);
      expect(tomorrow.sent.map((m) => m.to)).toEqual(['bo@james.test']);

      // No organization: the email domain is the company. Personal mail domains never are.
      await pool.query('TRUNCATE bid_invite_sends, bid_invite_batches, bid_invite_leads, sdr_lead_state CASCADE');
      for (const [id, email] of [['d1', 'ann@smith.test'], ['d2', 'bo@smith.test'], ['g1', 'ann.lee@gmail.com'], ['g2', 'bo.diaz@gmail.com']]) await lead(id, { email, org: null });
      const noOrg = deps();
      noOrg.pd.getLead = vi.fn(async (id) => ({ id, organization_id: null, owner_id: 777, is_archived: false }));
      await pool.query(`INSERT INTO sdr_mailboxes (email, display_name) VALUES ('th@proswppp.co','Third'), ('fo@proswppp.co','Fourth')`);
      for (const email of ['th@proswppp.co', 'fo@proswppp.co']) {
        await pool.query(`INSERT INTO sdr_inbox_accounts VALUES ($1,'rt')`, [email]);
        await pool.query(`INSERT INTO sdr_reply_routes (mailbox_email, forward_to, pipedrive_user_id, verified_at) VALUES ($1,$2,333,now())`, [email, email.replace('.co', '.com')]);
      }
      await runBidInviteSequence(pool, noOrg);
      const to = noOrg.sent.map((m) => m.to).sort();
      expect(to.filter((t) => t.endsWith('@smith.test'))).toHaveLength(1);
      expect(to.filter((t) => t.endsWith('@gmail.com'))).toEqual(['ann.lee@gmail.com', 'bo.diaz@gmail.com']);

      // One batch with an organization, one without it, same company domain: one company.
      await pool.query('TRUNCATE bid_invite_sends, bid_invite_batches, bid_invite_leads, sdr_lead_state CASCADE');
      await lead('x1', { email: 'ann@mixed.test', org: null });
      await lead('x2', { email: 'bo@mixed.test', org: null, bid: '2026-10-19' });
      const mixed = deps();
      mixed.pd.getLead = vi.fn(async (id) => ({ id, organization_id: id === 'x1' ? 777 : null, owner_id: 777, is_archived: false }));
      const rm = await runBidInviteSequence(pool, mixed);
      expect(mixed.sent.map((m) => m.to)).toEqual(['ann@mixed.test']);
      expect(rm.counts.pushed_company_daily_limit).toBe(1);
      expect((await pool.query(`SELECT contact_email, pipedrive_org_id FROM bid_invite_batches ORDER BY contact_email`)).rows)
        .toEqual([{ contact_email: 'ann@mixed.test', pipedrive_org_id: '777' }, { contact_email: 'bo@mixed.test', pipedrive_org_id: null }]);
    });

    it('5. dry run flags a second sample to the same company on the same day', async () => {
      await lead('j1', { email: 'ann@james.test', name: 'Ann Lee' });
      await lead('j2', { email: 'bo@james.test', name: 'Bo Diaz' });
      const d = deps({ mode: 'dry_run' });
      d.pd.getLead = vi.fn(async (id) => ({ id, organization_id: 501, owner_id: 777, is_archived: false }));
      const r = await runBidInviteSequence(pool, d);
      expect(r.samples.filter((s) => s.flags.includes('company_emailed_that_day'))).toHaveLength(1);
      expect(renderPreviewHtml(r)).toContain('only one a company a day');
    });

    it('6. a contact with 5 bids: 3 named plus "and 2 more", flagged in the dry run; all 5 marked done only after that email says so', async () => {
      for (const [id, bid, title] of [['m1', '2026-10-01', 'Zavala County Jail'], ['m2', '2026-10-02', 'Fort Bend Natatorium'], ['m3', '2026-10-03', 'Wharton Clinic'],
        ['m4', '2026-10-04', 'Katy Library'], ['m5', '2026-10-05', 'Bay City Fire Station']]) await lead(id, { bid, title });
      const dry = await runBidInviteSequence(pool, deps({ mode: 'dry_run' }));
      expect(dry.samples[0].bodyText.split('\n\n').slice(0, 2)).toEqual(["Rodger, did y'all win any of these?", 'Bay City Fire Station, Katy Library, Wharton Clinic and 2 more.']);
      expect(dry.samples[0].flags).toContain('more_projects_wording_not_on_page');
      expect(dry.samples[0].more).toBe(2);
      expect(dry.counts.samples_flagged_wording).toBe(1);
      expect(renderPreviewHtml(dry)).toContain('counted in "and 2 more"');
      const d = deps();
      await runBidInviteSequence(pool, d);
      expect(d.sent[0].bodyText).toContain('Wharton Clinic and 2 more.');
      expect(d.pd.addNote).toHaveBeenCalledTimes(5);
    });

    it('7. old bids: Email 2 skipped when it cannot go by bid + 56, Email 3 kept only by bid + 70; the dry run says so', async () => {
      await lead('o1', { email: 'fifty@gc.test', bid: '2026-09-14' });
      await lead('o2', { email: 'sixtythree@other-gc.test', bid: '2026-09-01' });
      const dry = await runBidInviteSequence(pool, deps({ mode: 'dry_run' }));
      const flagsFor = (to) => dry.samples.find((s) => s.to === to).flags;
      expect(flagsFor('fifty@gc.test')).toContain('e2_skipped_bid_too_old');
      expect(flagsFor('fifty@gc.test')).not.toContain('e3_skipped_bid_too_old');
      expect(flagsFor('sixtythree@other-gc.test')).toEqual(expect.arrayContaining(['e2_skipped_bid_too_old', 'e3_skipped_bid_too_old']));
      expect(renderPreviewHtml(dry)).toContain("Derek's window is 4 to 6 weeks");
      const d = deps();
      const r = await runBidInviteSequence(pool, d);
      expect(d.sent).toHaveLength(2);
      expect(r.counts.skipped_e2_bid_too_old).toBe(2);
      expect(r.counts.skipped_e3_bid_too_old).toBe(1);
      expect(await one(`SELECT state, next_step FROM bid_invite_batches WHERE contact_email='fifty@gc.test'`)).toEqual({ state: 'active', next_step: 'e3' });
      expect(await one(`SELECT state, next_step FROM bid_invite_batches WHERE contact_email='sixtythree@other-gc.test'`)).toEqual({ state: 'finished', next_step: null });
      expect((await one(`SELECT state FROM bid_invite_leads WHERE pipedrive_lead_id='o2'`)).state).toBe('done');
    });

    it('7. an Email 2 held back past bid + 56 (a pause) is skipped at send time and Email 3 follows inside bid + 70', async () => {
      await lead('w1', { bid: '2026-10-06', title: 'Hwy 59 Widening' });
      await runBidInviteSequence(pool, deps());
      // Pushed to Wed Dec 2 (bid + 57) by a pause.
      await pool.query(`UPDATE bid_invite_batches SET next_due_at='2026-12-02T12:30:00Z'`);
      const d = deps({ now: new Date('2026-12-02T12:40:00Z') });
      const r = await runBidInviteSequence(pool, d);
      expect(d.gmail.sendMail).not.toHaveBeenCalled();
      expect(r.counts.skipped_e2_bid_too_old).toBe(1);
      const b = await one(`SELECT state, next_step, next_due_at FROM bid_invite_batches`);
      expect(b).toMatchObject({ state: 'active', next_step: 'e3' });
      const e3 = deps({ now: new Date(+b.next_due_at + 60000) });
      await runBidInviteSequence(pool, e3);
      expect(e3.sent).toHaveLength(1);
      expect(e3.sent[0].bodyText).toMatch(/^Rodger, last one on this Hwy 59 Widening\./);
      expect(await one(`SELECT state FROM bid_invite_batches`)).toEqual({ state: 'finished' });
    });

    it('9. no state on the company: the contact phone area code sets the time zone, else Central', async () => {
      await lead('t1', { email: 'la@gc.test' });
      await lead('t2', { email: 'none@gc.test', person: 'p2' });
      const d = deps({ mode: 'dry_run' });
      d.pd.getOrganization = vi.fn(async (id) => ({ id, owner_id: { id: 111 }, address_admin_area_level_1: null }));
      d.pd.getPerson = vi.fn(async (id) => (id === 'p1' ? { phone: [{ value: '555-0100', primary: false }, { value: '(213) 555-0100', primary: true }] } : { phone: [] }));
      const r = await runBidInviteSequence(pool, d);
      const la = r.samples.find((s) => s.to === 'la@gc.test');
      expect(la.timezone).toBe('America/Los_Angeles');
      expect(la.flags).toContain('time_zone_from_phone_area_code');
      expect(r.samples.find((s) => s.to === 'none@gc.test').timezone).toBe('America/Chicago');
      // A company state wins over the phone.
      const withState = deps({ mode: 'dry_run' });
      withState.pd.getPerson = vi.fn(async () => ({ phone: [{ value: '(213) 555-0100', primary: true }] }));
      expect((await runBidInviteSequence(pool, withState)).samples.every((s) => s.timezone === 'America/Chicago')).toBe(true);
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
