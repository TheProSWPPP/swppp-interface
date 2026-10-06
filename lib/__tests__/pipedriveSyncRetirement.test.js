import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
vi.mock('../pipedriveClient.js', () => ({ listPersons: vi.fn(), listUsers: vi.fn(), listLeads: vi.fn(), getPerson: vi.fn(), updateLead: vi.fn() }));
vi.mock('../emailVerifyRefresh.js', () => ({ runVerificationPass: vi.fn() }));
vi.mock('../sdrDraftGenerator.js', async orig => ({ ...(await orig()), buildDraftFromLead: async ({ pipedriveLeadId, assignedUserId }) => ({ pipedrive_lead_id: pipedriveLeadId, assigned_user_id: assignedUserId }) }));
vi.mock('../sendRamp.js', async orig => ({ ...(await orig()), mailboxBounceHealth: async () => new Map() }));
import * as pd from '../pipedriveClient.js';
import { syncLeadState } from '../pipedriveSync.js';
import { verifyCrmLead } from '../sdrCrmGuard.js';
import { runAutoOutreach } from '../autoOutreach.js';

const db = reportingTestDb('crm_sync');
const page = (data, more = false, next = null) => ({ data, pagination: { more_items_in_collection: more, next_start: next } });
const lead = (id, extra = {}) => ({ id, title: `Project ${id}`, person_id: 1, is_archived: false, ...extra });
const opts = { lifecycleEnabled: true, companyId:'42' };

describe.skipIf(!db)('CRM lifecycle reconciliation (local Postgres)', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_lead_state (
      pipedrive_lead_id text PRIMARY KEY, pipedrive_person_id text, person_name text, person_email text,
      last_outgoing_mail_time timestamptz, email_messages_count int, last_activity_date date,
      lowbid_flag boolean DEFAULT false, sequence_started text, project_stage text, trigger_type text,
      lead_title text, outreach_status text DEFAULT 'clear', bid_date date, start_date date,
      owner_name text, lead_score double precision, project_value double precision, pipedrive_org_id text,
      trigger_override text, synced_at timestamptz DEFAULT NOW())`);
    await db.pool.query(`CREATE TABLE sdr_drafts(id text, pipedrive_lead_id text, assigned_user_id text,
      assigned_mailbox_id text, status text, initiated_by text, created_at timestamptz, error_message text);
      CREATE TABLE sdr_sends(pipedrive_lead_id text);
      CREATE TABLE sdr_outreach_log(pipedrive_lead_id text, sent_at timestamptz)`);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    vi.resetAllMocks();
    await db.pool.query('TRUNCATE sdr_lead_state');
    await db.pool.query('TRUNCATE sdr_drafts, sdr_sends, sdr_outreach_log');
    await db.pool.query('ALTER TABLE sdr_lead_state DROP COLUMN IF EXISTS crm_status, DROP COLUMN IF EXISTS crm_sync_generation, DROP COLUMN IF EXISTS crm_last_seen_at, DROP COLUMN IF EXISTS crm_status_checked_at');
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-crm-lifecycle.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-manual-protection.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-outreach-controls.sql', import.meta.url), 'utf8'));
    await db.pool.query('TRUNCATE sdr_crm_snapshots');
    await db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id, crm_status, person_email, last_outgoing_mail_time) VALUES
      ('unseen','active','old@example.com','2026-09-25T00:00:00Z'),('old-unknown','unknown',NULL,NULL),('old-archive','archived',NULL,NULL)`);
    pd.listUsers.mockResolvedValue([]);
    pd.listPersons.mockResolvedValue(page([{ id: 1, name: 'Estimator', email: [{ value: 'est@example.com', primary: true }] }]));
    pd.listLeads.mockResolvedValue(page([lead('seen')]));
  });

  it('a delayed batch cannot replace a newer observed contact or local override', async()=>{
    await db.pool.query("UPDATE sdr_lead_state SET trigger_override='AGC',trigger_type='AGC' WHERE pipedrive_lead_id='unseen'");
    pd.listLeads.mockImplementation(async()=>{
      await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,source_read_started_at)
        VALUES('42','lead','unseen','{"id":"unseen","person_id":2,"organization_id":3,"7c1852c27664d1118f75660223a6af9e99d10f2c":"PB"}','2026-10-07T15:00:00Z',clock_timestamp())`);
      return page([lead('unseen',{update_time:'2026-10-07T14:00:00Z',organization_id:4})]);
    });
    await syncLeadState(db.pool,opts);
    expect((await db.pool.query("SELECT pipedrive_person_id,pipedrive_org_id,trigger_type,trigger_override,project_stage FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0]).toEqual({pipedrive_person_id:'2',pipedrive_org_id:'3',trigger_type:'AGC',trigger_override:'AGC',project_stage:'PB'});
  });
  it('a stale person page cannot overwrite a newer same-person email observation',async()=>{
    await db.pool.query("UPDATE sdr_lead_state SET pipedrive_person_id='1',crm_company_id='42' WHERE pipedrive_lead_id='unseen'");
    pd.listLeads.mockImplementation(async()=>{
      await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,source_read_started_at)
        VALUES('42','person','1','{"id":1,"email":[{"value":"new@example.test","primary":true}]}','2026-10-07T15:00:00Z',clock_timestamp())`);
      return page([lead('unseen',{update_time:'2026-10-07T16:00:00Z'})]);
    });
    await syncLeadState(db.pool,opts);
    expect((await db.pool.query("SELECT person_email FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0].person_email).toBe('new@example.test');
  });
  it('completes three pages of leads and persons and retains missing historical rows', async () => {
    pd.listPersons.mockImplementation(async ({ start }) => start === 0 ? page([{ id: 1 }], true, 500) : start === 500 ? page([{ id: 2 }], true, 1000) : page([{ id: 3 }]));
    pd.listLeads.mockImplementation(async ({ start }) => start === 0 ? page([lead('a')], true, 100) : start === 100 ? page([lead('b')], true, 200) : page([lead('c')]));
    const result = await syncLeadState(db.pool, opts);
    expect(result).toMatchObject({ coverage: 'complete', scanned: 3, upserted: 3, retired: 2, missing: 2, endObserved: { leads: true, persons: true }, pages: { leads: 3, persons: 3 } });
    const { rows } = await db.pool.query('SELECT * FROM sdr_lead_state ORDER BY pipedrive_lead_id');
    expect(rows).toHaveLength(6);
    expect(rows.filter(r => r.crm_status === 'active').map(r => r.pipedrive_lead_id)).toEqual(['a', 'b', 'c']);
    expect(rows.find(r => r.pipedrive_lead_id === 'unseen')).toMatchObject({ crm_status: 'missing', person_email: 'old@example.com' });
    expect(rows.find(r => r.pipedrive_lead_id === 'old-archive').crm_status).toBe('archived');
    expect(rows.find(r => r.pipedrive_lead_id === 'a').crm_sync_generation).toBe(result.generation);
  });

  it.each(['page error', 'cap', 'missing pagination', 'invalid cursor'])('does not retire unseen rows after a lead %s', async kind => {
    pd.listLeads.mockImplementation(async ({ start }) => {
      if (start) throw Object.assign(new Error('private provider body'), { status: 429 });
      if (kind === 'missing pagination') return { data: [lead('seen')], pagination: {} };
      return page([lead('seen')], true, kind === 'invalid cursor' ? 0 : 100);
    });
    const result = await syncLeadState(db.pool, { ...opts, maxLeadPages: kind === 'cap' ? 1 : 3 });
    expect(result).toMatchObject({ coverage: 'partial', retired: 0, missing: 0, endObserved: { leads: false } });
    expect(JSON.stringify(result)).not.toContain('private provider body');
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0].crm_status).toBe('active');
  });

  it('the default person sweep reaches a linked contact beyond 30000 without individual fallback', async () => {
    pd.listPersons.mockImplementation(async ({ start }) => start < 35000
      ? page(Array.from({ length: 500 }, (_, i) => ({ id: start + i + 1 })), true, start + 500)
      : page([{ id: 35001, email: [{ value: 'late-contact@example.test', primary: true }] }]));
    pd.listLeads.mockResolvedValue(page([lead('late-lead', { person_id: 35001 })]));
    const result = await syncLeadState(db.pool, { lifecycleEnabled: false });
    expect(result).toMatchObject({ coverage: 'complete', personFetchFallbacks: 0, endObserved: { leads: true, persons: true }, pages: { leads: 1, persons: 71 } });
    expect((await db.pool.query("SELECT person_email FROM sdr_lead_state WHERE pipedrive_lead_id='late-lead'")).rows[0].person_email).toBe('late-contact@example.test');
  });

  it.each(['error', 'cap'])('does not retire after person sweep %s even with complete leads', async kind => {
    pd.listPersons.mockImplementation(async ({ start }) => { if (start) throw new Error('timeout'); return page([{ id: 1 }], true, 500); });
    const result = await syncLeadState(db.pool, { ...opts, maxPersonPages: kind === 'cap' ? 1 : 3 });
    expect(result).toMatchObject({ coverage: 'partial', retired: 0, endObserved: { leads: true, persons: false } });
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0].crm_status).toBe('active');
  });

  it('preserves contact suppression evidence when person fallback fails', async () => {
    pd.listPersons.mockResolvedValue(page([]));
    pd.getPerson.mockRejectedValue(new Error('timeout'));
    pd.listLeads.mockResolvedValue(page([lead('unseen')]));
    const result = await syncLeadState(db.pool, opts);
    expect(result).toMatchObject({ coverage: 'partial', retired: 0 });
    expect((await db.pool.query("SELECT person_email, last_outgoing_mail_time FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0]).toMatchObject({ person_email: 'old@example.com', last_outgoing_mail_time: new Date('2026-09-25T00:00:00Z') });
  });

  it('records explicit archived status and restores it on the next confirmed active observation', async () => {
    pd.listLeads.mockResolvedValue(page([lead('seen', { is_archived: true })]));
    await syncLeadState(db.pool, opts);
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='seen'")).rows[0].crm_status).toBe('archived');
    pd.listLeads.mockResolvedValue(page([lead('seen')]));
    await syncLeadState(db.pool, opts);
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='seen'")).rows[0].crm_status).toBe('active');
  });

  it('runs with the feature disabled on the unmigrated schema', async () => {
    await db.pool.query('ALTER TABLE sdr_lead_state DROP COLUMN crm_status, DROP COLUMN crm_sync_generation, DROP COLUMN crm_last_seen_at, DROP COLUMN crm_status_checked_at');
    const result = await syncLeadState(db.pool, { lifecycleEnabled: false });
    expect(result).toMatchObject({ coverage: 'complete', upserted: 1, retired: 0 });
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_lead_state')).rows[0].n).toBe(4);
  });

  it('preserves a later direct check when the full snapshot does not include that lead', async () => {
    pd.listLeads.mockImplementation(async () => {
      await verifyCrmLead('unseen', { pool: db.pool, ...opts, getLead: async () => lead('unseen') });
      return page([lead('seen')]);
    });
    const result = await syncLeadState(db.pool, opts);
    expect(result.missing).toBe(1);
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0].crm_status).toBe('active');
  });

  it.each([
    [{ id: 'unseen', is_archived: true }, 'archived', 'crm_archived'],
    [null, 'missing', 'crm_missing'],
    [{ id: 'unseen', is_archived: false }, 'active', null],
  ])('persists only the directly checked lifecycle status %s', async (record, status, reason) => {
    const result = await verifyCrmLead('unseen', { pool: db.pool, ...opts, getLead: async () => record });
    expect(result.reason).toBe(reason);
    const { rows } = await db.pool.query("SELECT * FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'");
    expect(rows[0].crm_status).toBe(status);
    expect(rows[0].crm_status_checked_at).toBeInstanceOf(Date);
    expect(rows[0].person_email).toBe('old@example.com');
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='old-archive'")).rows[0].crm_status).toBe('archived');
  });

  it('persists unknown on API failure without deleting history', async () => {
    await verifyCrmLead('unseen', { pool: db.pool, ...opts, getLead: async () => { throw Object.assign(new Error('secret'), { status: 403 }); } });
    expect((await db.pool.query("SELECT crm_status, person_email FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0]).toEqual({ crm_status: 'unknown', person_email: 'old@example.com' });
  });

  it('does not adopt historical auto-switch drafts even on confirmed active mirror leads', async () => {
    await db.pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,crm_status) VALUES ('old-missing','missing')");
    await db.pool.query("UPDATE sdr_lead_state SET start_date=CURRENT_DATE+1, trigger_type='LBA'");
    await db.pool.query(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,assigned_user_id,assigned_mailbox_id,status,initiated_by,created_at)
      SELECT 'resume-'||pipedrive_lead_id,pipedrive_lead_id,'u-1','mb-1','pending','auto-switch',NOW() FROM sdr_lead_state`);
    const inserts = [];
    const pool = { async connect(){const client=await db.pool.connect();return {query:(sql,params)=>sql.includes('INSERT INTO sdr_drafts')?this.query(sql,params):client.query(sql,params),release:()=>client.release()};},async query(sql, params) {
      if(sql.includes('FROM sdr_settings')) return { rows: [{ auto_outreach_enabled: true, auto_outreach_mode: 'send' }] };
      if(sql.includes('FROM sdr_mailboxes')) return { rows: [{ id: 'mb-1', owner_user_id: 'u-1', daily_send_limit: 5, warmup_started_at: null }] };
      if(sql.includes('INSERT INTO sdr_drafts')) { inserts.push(params[0]); return { rows: [{ id: params[0], assigned_user_id: 'u-1' }] }; }
      return db.pool.query(sql, params);
    } };
    let result = await runAutoOutreach(pool, { companyId:'42', lifecycleEnabled: true, mailboxSentToday: async () => 0 });
    expect(result.createdDrafts).toEqual([]);
    await db.pool.query('TRUNCATE sdr_drafts');
    result = await runAutoOutreach(pool, { companyId:'42', lifecycleEnabled: true, mailboxSentToday: async () => 0 });
    expect(result.created).toBe(1);
    expect(inserts).toEqual(['unseen']);
  });

  it('keeps malformed archive evidence unknown and prevents missing reconciliation', async () => {
    pd.listLeads.mockResolvedValue(page([lead('seen', { is_archived: 'true' })]));
    const result = await syncLeadState(db.pool, opts);
    expect(result).toMatchObject({ coverage: 'partial', retired: 0, errorCategory: 'crm_lead_status_invalid' });
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='seen'")).rows[0].crm_status).toBe('unknown');
    expect((await db.pool.query("SELECT crm_status FROM sdr_lead_state WHERE pipedrive_lead_id='unseen'")).rows[0].crm_status).toBe('active');
  });
});
