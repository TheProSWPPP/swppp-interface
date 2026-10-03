import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import * as poll from '../apolloEngagementPoll.js';
import * as budget from '../apolloMessageSearchBudget.js';
import * as apollo from '../apolloClient.js';
vi.mock('../apolloClient.js', () => ({ searchEmailerMessages: vi.fn(), getSequenceDetail: vi.fn() }));

const fixture = (page) => Array.from({ length: page < 34 ? 100 : 3 }, (_, i) => ({ id: `m-${(page-1)*100+i}` }));
const requestBudget = (limit = 100) => ({ remaining: () => limit, isRateLimited: () => false, recordCall: () => { limit--; }, noteRateLimit: (e) => ({ reason: 'apollo_429', retry_after_sec: e.retryAfterSec }) });
describe('Apollo sequence coverage', () => {
  it('observes the real end of 34 pages and all 3303 unique messages', async () => {
    const result = await poll.walkSequence({ sequenceId: 'lba', budget: requestBudget(), fetchPage: async ({ page }) => ({ emailer_messages: fixture(page) }) });
    expect(result.messages).toHaveLength(3303);
    expect(result).toMatchObject({ coverage: 'complete', endObserved: true, pages: 34, nextPage: null });
  });
  it('stops at the endpoint budget after page 26 without claiming completion', async () => {
    const result = await poll.walkSequence({ sequenceId: 'lba', budget: requestBudget(26), fetchPage: async ({ page }) => ({ emailer_messages: fixture(page) }) });
    expect(result).toMatchObject({ coverage: 'partial', endObserved: false, pages: 26, nextPage: 27, reason: 'budget_ceiling' });
  });
  it.each([{ status: 429, retryAfterSec: 3600 }, new Error('private provider failure')])('retains failed page three for retry', async (error) => {
    const result = await poll.walkSequence({ sequenceId: 'lba', budget: requestBudget(), fetchPage: async ({ page }) => { if (page === 3) throw error; return { emailer_messages: fixture(page) }; } });
    expect(result).toMatchObject({ coverage: 'partial', endObserved: false, pages: 2, nextPage: 3 });
    expect(JSON.stringify(result)).not.toContain('private provider failure');
  });
  it('a stalled read returns partial at the time budget without checkpointing', async () => {
    const result = await poll.walkSequence({ sequenceId: 'a', budget: requestBudget(), deadline: Date.now() + 10, fetchPage: () => new Promise(() => {}) });
    expect(result).toMatchObject({ coverage: 'partial', nextPage: 1, reason: 'time_budget' });
  });
  it('cannot treat malformed provider responses as a completed empty page', async () => {
    const result = await poll.walkSequence({ sequenceId: 'a', budget: requestBudget(), fetchPage: async () => ({}) });
    expect(result).toMatchObject({ coverage: 'partial', endObserved: false, nextPage: 1, reason: 'invalid_page' });
  });
  it('deduplicates IDs without mistaking a full duplicate page for the end', async () => {
    const result = await poll.walkSequence({ sequenceId: 'a', budget: requestBudget(), fetchPage: async ({ page }) => ({ emailer_messages: page <= 2 ? fixture(1) : [] }) });
    expect(result.messages).toHaveLength(100);
    expect(result.pages).toBe(3);
    expect(result.endObserved).toBe(true);
  });
  it('refuses to advance a cursor when page persistence fails', async () => {
    const result = await poll.walkSequence({ sequenceId: 'a', budget: requestBudget(), fetchPage: async () => ({ emailer_messages: fixture(1) }), persistPage: async () => { throw new Error('secret db body'); } });
    expect(result).toMatchObject({ nextPage: 1, coverage: 'partial', reason: 'persistence_failed', endObserved: false });
  });
  it('cannot mistake Apollo display-limit truncation for complete history', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ emailer_messages: fixture(1) });
    const result = await poll.walkSequence({ sequenceId: 'a', cursor: { nextPage: 500 }, budget: requestBudget(), fetchPage });
    expect(result).toMatchObject({ coverage: 'partial', endObserved: false, reason: 'provider_display_limit', nextPage: 501, pages: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it('does not call beyond the provider display limit after resuming', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ emailer_messages: [] });
    const result = await poll.walkSequence({ sequenceId: 'a', cursor: { nextPage: 501 }, budget: requestBudget(), fetchPage });
    expect(result).toMatchObject({ coverage: 'partial', endObserved: false, reason: 'provider_display_limit', pages: 0 });
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it('rejects malformed message rows rather than emitting undefined receipts', async () => {
    const result = await poll.walkSequence({ sequenceId: 'a', budget: requestBudget(), fetchPage: async () => ({ emailer_messages: [null] }) });
    expect(result).toMatchObject({ coverage: 'partial', endObserved: false, reason: 'invalid_page', nextPage: 1 });
  });
  it('requires every nonempty sequence result to observe its end', () => {
    expect(poll.fullSweepComplete([])).toBe(false);
    expect(poll.fullSweepComplete([{ coverage: 'complete', endObserved: true }, { coverage: 'partial', endObserved: false }])).toBe(false);
    expect(poll.fullSweepComplete([{ coverage: 'complete', endObserved: true }])).toBe(true);
  });
});

const db = reportingTestDb('apollo_pagination');
const pool = db?.pool;
const sentAt = '2026-09-01T00:00:00Z';
const message = (extra = {}) => ({ id: 'out-1', contact_id: 'buyer', from_email: 'sender@example.test', to_email: 'buyer@example.test', emailer_campaign_id: 'campaign-a', campaign_position: 2, status: 'completed', created_at: '2026-09-02T00:00:00Z', completed_at: '2026-09-02T00:01:00Z', ...extra });
describe.skipIf(!pool)('Apollo polling SQL (local isolated schema)', () => {
  beforeAll(async () => {
    await db.setup();
    await pool.query(`CREATE TABLE sdr_settings(id integer PRIMARY KEY, engagement_backfill_done_at timestamptz, engagement_last_full_scan_at timestamptz);
      CREATE TABLE sdr_sends(id text PRIMARY KEY,draft_id text,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,apollo_emailer_message_id text,sent_at timestamptz,status text,current_step integer,total_steps integer,next_send_at timestamptz,step_status text,updated_at timestamptz)`);
    await pool.query(await readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../../migrations/2026-10-04-sdr-metric-evidence.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-apollo-cursors.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await db.close(); });
  beforeEach(async () => {
    poll._resetEngagementPollState(); vi.clearAllMocks();
    vi.stubEnv('APOLLO_API_KEY', 'test-only'); vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', 'true'); vi.stubEnv('SDR_REPORTING_INGEST_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ side_effect: 'backfill-recorded' }) }));
    await pool.query('TRUNCATE sdr_sends,sdr_settings,sdr_apollo_poll_state,sdr_message_facts');
    await pool.query('INSERT INTO sdr_settings(id) VALUES(1)');
    await pool.query("INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,sent_at,status) VALUES('send-a','project-a','campaign-a','buyer',$1,'enrolled')", [sentAt]);
    apollo.getSequenceDetail.mockResolvedValue({ emailer_steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] });
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message()] });
  });
  const run = (options = {}) => poll.pollEngagement(pool, { baseUrl: 'http://test.invalid', callbackSecret: 'test', ...options });
  it('resumes page 27 after a process restart, stamps only after page 34 and uses provider total steps', async () => {
    apollo.searchEmailerMessages.mockImplementation(async ({ page }) => ({ emailer_messages: fixture(page) }));
    const first = await run({ maxRequests: 26 });
    expect(first.coverage).toBe('partial');
    expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at).toBeNull();
    poll._resetEngagementPollState();
    const second = await run({ maxRequests: 26 });
    expect(second.coverage).toBe('complete');
    expect(second.scanned).toBe(703);
    expect(apollo.searchEmailerMessages.mock.calls[26][0].page).toBe(27);
    expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at).not.toBeNull();
  });
  it('cannot stamp a sweep after a network failure or 429', async () => {
    for (const error of [new Error('private raw provider data'), Object.assign(new Error('rate limit'), { status: 429, retryAfterSec: 3600 })]) {
      poll._resetEngagementPollState();
      apollo.searchEmailerMessages.mockImplementation(async ({ page }) => { if (page === 3) throw error; return { emailer_messages: fixture(page) }; });
      const result = await run();
      expect(result.coverage).toBe('partial');
      expect(result.cursor.sequences['campaign-a'].nextPage).toBe(3);
      expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at).toBeNull();
    }
    expect(budget.isRateLimited()).toBe(true);
  });
  it('legacy completed backfill keeps live replies enabled during repeated capped deep scans', async () => {
    vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', 'false');
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-07-28T07:16:21Z',engagement_last_full_scan_at='2026-09-06T08:56:20Z'");
    apollo.searchEmailerMessages.mockImplementation(async ({ page }) => ({ emailer_messages: [message({ id: `reply-page-${page}`, replied: true }), ...Array.from({ length: 99 }, (_, i) => ({ id: `fill-${page}-${i}` }))] }));
    for (let attempt = 0; attempt < 2; attempt++) {
      // Simulate the next deep attempt without enabling durable history.
      poll._resetEngagementPollState(); fetch.mockClear();
      const result = await run({ maxRequests: 2 });
      expect(result).toMatchObject({ tier: 'full', backfillMode: false, coverage: 'partial', apolloCalls: 2 });
      const events = fetch.mock.calls.map(([, args]) => JSON.parse(args.body));
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.backfill === false && e.type === 'email_replied')).toBe(true);
      expect(events.some((e) => e.emailer_message_id === 'reply-page-2')).toBe(true);
      expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at.toISOString()).toBe('2026-09-06T08:56:20.000Z');
      expect((await pool.query('SELECT count(*)::int n FROM sdr_apollo_poll_state')).rows[0].n).toBe(0);
    }
  });
  it('resumable reconciliation releases proven post-boundary sends while keeping old reply flags record-only after restart', async () => {
    const boundary = '2026-09-15T00:00:00Z';
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-07-28T00:00:00Z'");
    await pool.query("INSERT INTO sdr_apollo_poll_state(scope,state) VALUES('engagement',$1)", [JSON.stringify({ startedAt: boundary, historyVerified: false, sequences: { 'campaign-a': { nextPage: 1, endObserved: false, firstObservedAt: boundary } } })]);
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [
      message({ id: 'fresh-send-reply', campaign_position: 1, created_at: '2026-09-16T00:00:00Z', completed_at: '2026-09-16T00:01:00Z', replied: true }),
      message({ id: 'old-send-late-reply', replied: true, updated_at: new Date().toISOString() }),
      ...Array.from({ length: 98 }, (_, i) => ({ id: `filler-${i}` })),
    ] });
    for (let pass = 0; pass < 2; pass++) {
      poll._resetEngagementPollState(); fetch.mockClear();
      const result = await run({ maxRequests: 1 });
      expect(result.coverage).toBe('partial');
      const events = fetch.mock.calls.map(([, args]) => JSON.parse(args.body));
      expect(events.find(e => e.emailer_message_id === 'fresh-send-reply').backfill).toBe(false);
      expect(events.find(e => e.emailer_message_id === 'old-send-late-reply').backfill).toBe(true);
      expect((await pool.query('SELECT state FROM sdr_apollo_poll_state')).rows[0].state.sequences['campaign-a'].firstObservedAt).toBe(boundary);
    }
  });
  it('new-send proof excludes missing, future and failed timestamps and preserves initial global history guard', async () => {
    const boundary = '2026-09-15T00:00:00Z';
    const seed = async () => pool.query("INSERT INTO sdr_apollo_poll_state(scope,state) VALUES('engagement',$1) ON CONFLICT(scope) DO UPDATE SET state=EXCLUDED.state", [JSON.stringify({ startedAt: boundary, historyVerified: false, sequences: { 'campaign-a': { nextPage: 1, endObserved: false, firstObservedAt: boundary } } })]);
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-07-28T00:00:00Z'"); await seed();
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [
      message({ id: 'new-completed-old-created', campaign_position: 1, completed_at: '2026-09-16T00:00:00Z', replied: true }),
      message({ id: 'failed-timestamp', status: 'failed', completed_at: '2026-09-16T00:00:00Z', bounce: true }),
      message({ id: 'missing-completed', completed_at: null, replied: true }),
      message({ id: 'future-completed', completed_at: '2099-01-01T00:00:00Z', replied: true }),
    ] });
    await run();
    const events = fetch.mock.calls.map(([, args]) => JSON.parse(args.body));
    expect(events.find(e => e.emailer_message_id === 'new-completed-old-created').backfill).toBe(false);
    expect(events.filter(e => e.emailer_message_id !== 'new-completed-old-created').every(e => e.backfill)).toBe(true);
    await pool.query('UPDATE sdr_settings SET engagement_backfill_done_at=NULL'); await seed(); fetch.mockClear();
    await run();
    expect(fetch.mock.calls.map(([, args]) => JSON.parse(args.body)).every(e => e.backfill)).toBe(true);
  });
  it('persists the per-sequence observation boundary before reading or emitting provider events', async () => {
    let observedBoundary;
    apollo.getSequenceDetail.mockImplementation(async () => {
      const saved = (await pool.query('SELECT state FROM sdr_apollo_poll_state')).rows[0]?.state;
      observedBoundary = saved?.sequences['campaign-a'].firstObservedAt;
      return { emailer_steps: [{ id: 's1' }] };
    });
    await run();
    expect(apollo.getSequenceDetail).toHaveBeenCalled();
    expect(observedBoundary).toBeTruthy();
  });
  it('failed initial boundary persistence prevents provider reads and event emission', async () => {
    await pool.query(`CREATE FUNCTION reject_initial_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test cursor failure'; END $$;
      CREATE TRIGGER reject_initial_boundary BEFORE INSERT OR UPDATE ON sdr_apollo_poll_state FOR EACH ROW EXECUTE FUNCTION reject_initial_boundary()`);
    try {
      expect(await run()).toMatchObject({ coverage: 'partial', errorCategory: 'cursor_persistence_failed' });
      expect(apollo.searchEmailerMessages).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { await pool.query('DROP TRIGGER reject_initial_boundary ON sdr_apollo_poll_state; DROP FUNCTION reject_initial_boundary()'); }
  });
  it('shares the deep-call budget across six sequences and uses shallow checks between incomplete legacy deep attempts', async () => {
    vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', 'false');
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-07-28T00:00:00Z',engagement_last_full_scan_at='2026-09-06T00:00:00Z'");
    for (const id of ['b', 'c', 'd', 'e', 'f']) await pool.query("INSERT INTO sdr_sends(id,apollo_sequence_id,apollo_contact_id,sent_at,status) VALUES($1,$2,'buyer',$3,'enrolled')", [`send-${id}`, `campaign-${id}`, sentAt]);
    apollo.searchEmailerMessages.mockImplementation(async ({ campaignIds, page }) => ({ emailer_messages: Array.from({ length: 100 }, (_, i) => ({ id: `${campaignIds[0]}-${page}-${i}` })) }));
    const first = await run();
    expect(first).toMatchObject({ coverage: 'partial', apolloCalls: 50 });
    expect(new Set(apollo.searchEmailerMessages.mock.calls.filter(([q]) => q.page === 1).map(([q]) => q.campaignIds[0])).size).toBe(6);
    apollo.searchEmailerMessages.mockClear();
    const next = await run();
    expect(next).toMatchObject({ tier: 'shallow', coverage: 'partial', apolloCalls: 6 });
    expect(apollo.searchEmailerMessages.mock.calls.every(([q]) => q.page === 1)).toBe(true);
    expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at.toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });
  it.each([false, true])('rotates a one-call budget across every sequence, with resumable=%s', async (resumable) => {
    vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', String(resumable));
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-07-28T00:00:00Z',engagement_last_full_scan_at='2026-09-06T00:00:00Z'");
    for (const id of ['b', 'c', 'd', 'e', 'f']) await pool.query("INSERT INTO sdr_sends(id,apollo_sequence_id,apollo_contact_id,sent_at,status) VALUES($1,$2,'buyer',$3,'enrolled')", [`send-${id}`, `campaign-${id}`, sentAt]);
    apollo.searchEmailerMessages.mockImplementation(async ({ campaignIds, page }) => ({ emailer_messages: Array.from({ length: 100 }, (_, i) => ({ id: `${campaignIds[0]}-${page}-${i}` })) }));
    for (let pass = 0; pass < 6; pass++) {
      if (resumable) poll._resetEngagementPollState();
      expect((await run({ maxRequests: 1 })).coverage).toBe('partial');
    }
    expect(apollo.searchEmailerMessages).toHaveBeenCalledTimes(6);
    expect(new Set(apollo.searchEmailerMessages.mock.calls.map(([q]) => q.campaignIds[0])).size).toBe(6);
    expect(apollo.searchEmailerMessages.mock.calls.every(([q]) => q.page === 1)).toBe(true);
  });
  it('six incomplete legacy campaigns stay below the shared daily ceiling with three-hour deep attempts', async () => {
    vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', 'false');
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-07-28T00:00:00Z',engagement_last_full_scan_at='2026-09-06T00:00:00Z'");
    for (const id of ['b', 'c', 'd', 'e', 'f']) await pool.query("INSERT INTO sdr_sends(id,apollo_sequence_id,apollo_contact_id,sent_at,status) VALUES($1,$2,'buyer',$3,'enrolled')", [`send-${id}`, `campaign-${id}`, sentAt]);
    apollo.searchEmailerMessages.mockImplementation(async ({ campaignIds, page }) => ({ emailer_messages: Array.from({ length: 100 }, (_, i) => ({ id: `${campaignIds[0]}-${page}-${i}` })) }));
    const began = Date.now(); let simulatedNow = began;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => simulatedNow);
    try {
      for (let tick = 0; tick < 96; tick++) {
        simulatedNow = began + tick * 15 * 60 * 1000;
        expect((await run()).coverage).toBe('partial');
      }
      expect(apollo.searchEmailerMessages).toHaveBeenCalledTimes(928);
      expect(budget.snapshot().callsLast24h).toBe(928);
      expect(budget.snapshot().remaining).toBe(572);
    } finally { clock.mockRestore(); }
  }, 15_000);
  it('legacy scans with no backfill watermark still suppress historical side effects', async () => {
    vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', 'false');
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ replied: true })] });
    const result = await run();
    expect(result.backfillMode).toBe(true);
    expect(fetch.mock.calls.map(([, args]) => JSON.parse(args.body)).every((e) => e.backfill === true)).toBe(true);
  });
  it('a shallow 429 persists retry-after without discarding its completed history baseline', async () => {
    await run();
    apollo.searchEmailerMessages.mockRejectedValue(Object.assign(new Error('private limit'), { status: 429, retryAfterSec: 3600 }));
    const shallow = await run();
    expect(shallow.tier).toBe('shallow');
    poll._resetEngagementPollState();
    expect(await run()).toMatchObject({ skipped: 'retry_pending', nextRetryAt: shallow.nextRetryAt });
    expect((await pool.query('SELECT state FROM sdr_apollo_poll_state')).rows[0].state.completedAt).toBeTruthy();
  });
  it('newly encountered campaign B cannot inherit campaign A historical reconciliation', async () => {
    await run();
    await pool.query("INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,sent_at,status) VALUES('send-b','project-b','campaign-b','buyer',$1,'enrolled')", [sentAt]);
    fetch.mockClear();
    apollo.searchEmailerMessages.mockImplementation(async ({campaignIds,page}) => ({emailer_messages:campaignIds[0]==='campaign-b' ? (page===1 ? [message({id:'old-b',emailer_campaign_id:'campaign-b',replied:true}),...Array.from({length:99},(_,i)=>({id:`filler-b-${i}`}))] : []) : []}));
    const partial = await run({maxRequests:2});
    expect(partial.coverage).toBe('partial');
    const bEvents=fetch.mock.calls.map(([,args])=>JSON.parse(args.body)).filter(e=>e.sequence_id==='campaign-b');
    expect(bEvents.length).toBeGreaterThan(0);
    expect(bEvents.every(e=>e.backfill===true)).toBe(true);
    poll._resetEngagementPollState();
    await run();
    expect((await pool.query('SELECT state FROM sdr_apollo_poll_state')).rows[0].state.reconciledSequences['campaign-b']).toBe(true);
  });
  it('persists provider retry-after across a process restart', async () => {
    apollo.searchEmailerMessages.mockRejectedValue(Object.assign(new Error('private limit body'), { status: 429, retryAfterSec: 3600 }));
    const first = await run();
    expect(first.nextRetryAt).not.toBeNull();
    poll._resetEngagementPollState();
    expect(await run()).toMatchObject({ skipped: 'retry_pending', nextRetryAt: first.nextRetryAt });
    expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at).toBeNull();
  });
  it('step write failures do not stamp a complete sweep', async () => {
    await pool.query(`CREATE FUNCTION reject_steps() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test steps failure'; END $$;
      CREATE TRIGGER reject_steps BEFORE UPDATE ON sdr_sends FOR EACH ROW EXECUTE FUNCTION reject_steps()`);
    try {
      expect((await run()).coverage).toBe('partial');
      expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at).toBeNull();
    } finally { await pool.query('DROP TRIGGER reject_steps ON sdr_sends; DROP FUNCTION reject_steps()'); }
  });
  it('never updates campaign B from campaign A, never regresses completed, and records body-free outbound history', async () => {
    await pool.query("INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,sent_at,status,current_step,total_steps,step_status) VALUES('send-b','project-b','campaign-b','buyer',$1,'sent',3,3,'completed')", [sentAt]);
    apollo.searchEmailerMessages.mockImplementation(async ({ campaignIds }) => ({ emailer_messages: campaignIds[0] === 'campaign-a' ? [message({ replied: true, body: 'PRIVATE BODY' })] : [message({ id: 'b1', emailer_campaign_id: 'campaign-b', campaign_position: 1, status: 'scheduled', completed_at: null, due_at: '2026-10-10T00:00:00Z' })] }));
    await run();
    const rows = (await pool.query('SELECT id,current_step,total_steps,step_status FROM sdr_sends ORDER BY id')).rows;
    expect(rows).toEqual([{ id: 'send-a', current_step: 2, total_steps: 3, step_status: 'replied' }, { id: 'send-b', current_step: 3, total_steps: 3, step_status: 'completed' }]);
    const facts = (await pool.query('SELECT * FROM sdr_message_facts')).rows;
    expect(facts).toHaveLength(1); expect(facts[0]).toMatchObject({ direction: 'out', human_reply: null, pipedrive_lead_id: 'project-a' });
    expect(JSON.stringify(facts)).not.toContain('PRIVATE BODY');
    expect(fetch.mock.calls.every(([, args]) => JSON.parse(args.body).backfill === true)).toBe(true);
  });
  it('retains a newly observed touch receipt on the uniquely matched local enrollment', async () => {
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ emailer_touch_id: 'observed-touch' })] });
    await run();
    expect((await pool.query('SELECT apollo_enrollment_id FROM sdr_sends')).rows[0].apollo_enrollment_id).toBe('observed-touch');
  });
  it('a conflicting provider touch cannot overwrite a verified enrollment association', async () => {
    await pool.query("UPDATE sdr_sends SET apollo_enrollment_id='verified-touch'");
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ emailer_touch_id: 'other-touch' })] });
    const result = await run();
    expect(result.ambiguous).toBe(1);
    expect((await pool.query('SELECT apollo_enrollment_id,current_step FROM sdr_sends')).rows[0]).toEqual({ apollo_enrollment_id: 'verified-touch', current_step: null });
    expect((await pool.query('SELECT link_status FROM sdr_message_facts')).rows[0].link_status).toBe('ambiguous');
  });
  it('uses a retained enrollment receipt to resolve equal-time project enrollments', async () => {
    await pool.query("UPDATE sdr_sends SET apollo_enrollment_id='touch-a'");
    await pool.query("INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,sent_at,status,apollo_enrollment_id) VALUES('send-a2','project-a2','campaign-a','buyer',$1,'enrolled','touch-a2')", [sentAt]);
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ emailer_touch_id: 'touch-a2' })] });
    await run();
    expect((await pool.query('SELECT id,current_step FROM sdr_sends ORDER BY id')).rows).toEqual([{ id: 'send-a', current_step: null }, { id: 'send-a2', current_step: 2 }]);
    expect((await pool.query('SELECT pipedrive_lead_id FROM sdr_message_facts')).rows[0].pipedrive_lead_id).toBe('project-a2');
  });
  it('leaves two simultaneous projects explicitly ambiguous', async () => {
    await pool.query("INSERT INTO sdr_sends(id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,sent_at,status) VALUES('send-a2','project-a2','campaign-a','buyer',$1,'enrolled')", [sentAt]);
    const result = await run();
    expect(result.ambiguous).toBe(1);
    expect((await pool.query('SELECT current_step FROM sdr_sends')).rows.every((r) => r.current_step === null)).toBe(true);
    expect((await pool.query('SELECT link_status,pipedrive_lead_id FROM sdr_message_facts')).rows[0]).toEqual({ link_status: 'ambiguous', pipedrive_lead_id: null });
  });
  it('failed event emission cannot advance or close the full-scan timestamp', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'private body' }));
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ replied: true })] });
    const result = await run();
    expect(result.coverage).toBe('partial');
    expect(result.cursor.sequences['campaign-a'].nextPage).toBe(1);
    expect((await pool.query('SELECT engagement_last_full_scan_at,engagement_backfill_done_at FROM sdr_settings')).rows[0]).toEqual({ engagement_last_full_scan_at: null, engagement_backfill_done_at: null });
  });
  it('atomically rolls back full-scan timestamps if the completed cursor cannot persist', async () => {
    await pool.query(`CREATE FUNCTION reject_completed_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state ? 'completedAt' THEN RAISE EXCEPTION 'test completion write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_completed BEFORE INSERT OR UPDATE ON sdr_apollo_poll_state FOR EACH ROW EXECUTE FUNCTION reject_completed_cursor()`);
    try {
      expect((await run()).coverage).toBe('partial');
      expect((await pool.query('SELECT engagement_last_full_scan_at,engagement_backfill_done_at FROM sdr_settings')).rows[0]).toEqual({ engagement_last_full_scan_at: null, engagement_backfill_done_at: null });
    } finally { await pool.query('DROP TRIGGER reject_completed ON sdr_apollo_poll_state; DROP FUNCTION reject_completed_cursor()'); }
  });
  it('the first resumable sweep records legacy unobserved history without external sales effects', async () => {
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-09-06T00:00:00Z'");
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ replied: true })] });
    const result = await run();
    expect(result.backfillMode).toBe(true);
    expect(fetch.mock.calls.every(([, args]) => JSON.parse(args.body).backfill === true)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS count FROM sdr_message_facts')).rows[0].count).toBe(1);
    poll._resetEngagementPollState();
    const incremental = await run();
    expect(incremental.backfillMode).toBe(false);
  });
  it('a failed reporting write keeps its page pending', async () => {
    await pool.query(`CREATE FUNCTION reject_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test write failure'; END $$;
      CREATE TRIGGER reject_fact BEFORE INSERT ON sdr_message_facts FOR EACH ROW EXECUTE FUNCTION reject_fact()`);
    try {
      const result = await run();
      expect(result).toMatchObject({ coverage: 'partial', cursor: { sequences: { 'campaign-a': { nextPage: 1, reason: 'persistence_failed' } } } });
      expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at).toBeNull();
    } finally { await pool.query('DROP TRIGGER reject_fact ON sdr_message_facts; DROP FUNCTION reject_fact()'); }
  });
  it('a failed message with completed_at is not a sent step or completed sequence', async () => {
    const recent = new Date().toISOString();
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ campaign_position: 3, status: 'failed', completed_at: recent })] });
    await run();
    expect((await pool.query('SELECT current_step,total_steps,step_status FROM sdr_sends')).rows[0]).toEqual({ current_step: null, total_steps: 3, step_status: null });
    expect(fetch).not.toHaveBeenCalled();
    expect((await pool.query('SELECT provider_status FROM sdr_message_facts')).rows[0].provider_status).toBe('failed');
  });
  it('removes a superseded scheduled step when a higher position is completed', async () => {
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [message({ id: 's1', campaign_position: 1, status: 'scheduled', completed_at: null, due_at: '2026-09-03T00:00:00Z' }), message()] });
    await run();
    expect((await pool.query('SELECT current_step,next_send_at FROM sdr_sends')).rows[0]).toEqual({ current_step: 2, next_send_at: null });
  });
  it('terminal local reply status cannot remain scheduled after a poll', async () => {
    await pool.query("UPDATE sdr_sends SET status='replied',step_status='scheduled'");
    await run();
    expect((await pool.query('SELECT step_status,next_send_at FROM sdr_sends')).rows[0]).toEqual({ step_status: 'replied', next_send_at: null });
  });
  it('clears scheduled positions superseded on later pages and does not restore them on replay', async () => {
    const scheduled = message({ id: 'scheduled-old', campaign_position: 1, status: 'scheduled', completed_at: null, due_at: '2026-09-03T00:00:00Z' });
    apollo.searchEmailerMessages.mockImplementation(async ({ page }) => ({ emailer_messages: page === 1 ? [scheduled, ...Array.from({ length: 99 }, (_, i) => ({ id: `filler-${i}` }))] : [message()] }));
    await run();
    expect((await pool.query('SELECT next_send_at FROM sdr_sends')).rows[0].next_send_at).toBeNull();
    apollo.searchEmailerMessages.mockResolvedValue({ emailer_messages: [scheduled] });
    await run();
    expect((await pool.query('SELECT next_send_at FROM sdr_sends')).rows[0].next_send_at).toBeNull();
  });
  it('does not declare zero sequences complete', async () => {
    await pool.query('TRUNCATE sdr_sends');
    expect((await run()).coverage).toBe('partial');
    expect((await pool.query('SELECT engagement_last_full_scan_at FROM sdr_settings')).rows[0].engagement_last_full_scan_at).toBeNull();
  });
  it('opt-in durable deep scans keep newly reached legacy history record-only', async () => {
    vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', 'true'); vi.stubEnv('SDR_REPORTING_INGEST_ENABLED', 'false');
    await pool.query("UPDATE sdr_settings SET engagement_backfill_done_at='2026-09-06T00:00:00Z'");
    apollo.searchEmailerMessages.mockImplementation(async ({ page }) => ({ emailer_messages: page === 1 ? fixture(1) : [message({ replied: true })] }));
    await run();
    expect(fetch.mock.calls.every(([, args]) => JSON.parse(args.body).backfill === true)).toBe(true);
  });
  it('with both feature flags off works without the cursor/reporting migrations', async () => {
    vi.stubEnv('SDR_APOLLO_RESUMABLE_ENABLED', 'false'); vi.stubEnv('SDR_REPORTING_INGEST_ENABLED', 'false');
    await pool.query('ALTER TABLE sdr_apollo_poll_state RENAME TO absent_cursor; ALTER TABLE sdr_message_facts RENAME TO absent_facts');
    try { expect((await run()).coverage).toBe('complete'); } finally { await pool.query('ALTER TABLE absent_cursor RENAME TO sdr_apollo_poll_state; ALTER TABLE absent_facts RENAME TO sdr_message_facts'); }
  });
});

describe('enrollment mapping evidence', () => {
  const rows = [
    { id: 'a1', apollo_sequence_id: 'a', apollo_contact_id: 'contact', sent_at: '2026-09-01T00:00:00Z', apollo_emailer_message_id: 'receipt-a1' },
    { id: 'a2', apollo_sequence_id: 'a', apollo_contact_id: 'contact', sent_at: '2026-09-10T00:00:00Z' },
    { id: 'b1', apollo_sequence_id: 'b', apollo_contact_id: 'contact', sent_at: '2026-09-01T00:00:00Z' },
  ];
  it('selects campaign plus the actual enrollment time interval', () => {
    expect(poll.resolveMessageSend({ id: 'm1', contact_id: 'contact', created_at: '2026-09-03T00:00:00Z' }, 'a', rows).send.id).toBe('a1');
    expect(poll.resolveMessageSend({ id: 'm2', contact_id: 'contact', created_at: '2026-09-12T00:00:00Z' }, 'a', rows).send.id).toBe('a2');
  });
  it('retains a provider receipt association without fabricating a timestamp', () => {
    expect(poll.resolveMessageSend({ id: 'receipt-a1', contact_id: 'contact' }, 'a', rows).send.id).toBe('a1');
    expect(poll.resolveMessageSend({ id: 'unknown', contact_id: 'contact' }, 'a', rows).status).toBe('ambiguous');
  });
});
