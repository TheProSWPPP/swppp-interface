import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
vi.mock('../pipedriveClient.js', async orig => ({ ...(await orig()), listPersons: vi.fn(), listUsers: vi.fn(), listLeads: vi.fn(), getPerson: vi.fn(), updateLead: vi.fn() }));
vi.mock('../emailVerifyRefresh.js', () => ({ runVerificationPass: vi.fn() }));
import * as pd from '../pipedriveClient.js';
import { syncLeadState } from '../pipedriveSync.js';
import { setOutreachControl } from '../sdrOutreachControls.js';
import { releaseSettledSwapHolds, UNKNOWN_OUTCOME_HOLD } from '../sdrCompanySwap.js';

// The hold the company swap leaves on a lead lifts once the real sync has read that lead from
// Pipedrive after the attempt. These run the real sync against Postgres: what counts is the
// read stamp the sync writes, not one a test assigns.
const db = reportingTestDb('swap_hold_release');
const COMPANY = '42';
const page = (data, more = false, next = null) => ({ data, pagination: { more_items_in_collection: more, next_start: next } });
const lead = (id, extra = {}) => ({ id, title: `Project ${id}`, person_id: 1, is_archived: false, ...extra });
const opts = { lifecycleEnabled: true, companyId: COMPANY };
const ACTOR = { source: 'service', accountId: 'company-swap', execution: 'automatic', ownership: 'matched_own_receipt' };

describe.skipIf(!db)('company swap hold release against the real sync (local Postgres)', () => {
  const q = (text, params) => db.pool.query(text, params);
  const hold = () => setOutreachControl(db.pool, { companyId: COMPANY, leadId: 'seen', scope: { kind: 'lead', id: 'seen' }, channel: null,
    reason: UNKNOWN_OUTCOME_HOLD, contextHash: 'h', actor: ACTOR });
  // A hold placed `minutes` ago: nothing here waits out the settle time.
  const heldFor = async minutes => { await hold(); await q('UPDATE sdr_outreach_controls SET created_at = created_at - make_interval(mins => $1::int)', [minutes]); };
  const release = () => releaseSettledSwapHolds(db.pool, { companyId: COMPANY });
  const active = async () => (await q("SELECT 1 FROM sdr_outreach_controls WHERE status = 'active'")).rowCount;
  const sync = () => syncLeadState(db.pool, opts);
  // This machine's clock runs ten minutes ahead of the database.
  const fastClock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 10 * 60 * 1000); };

  beforeAll(async () => {
    await db.setup();
    await q(`CREATE TABLE sdr_lead_state (
      pipedrive_lead_id text PRIMARY KEY, pipedrive_person_id text, person_name text, person_email text,
      last_outgoing_mail_time timestamptz, email_messages_count int, last_activity_date date,
      lowbid_flag boolean DEFAULT false, sequence_started text, project_stage text, trigger_type text,
      lead_title text, outreach_status text DEFAULT 'clear', bid_date date, start_date date,
      owner_name text, lead_score double precision, project_value double precision, pipedrive_org_id text,
      trigger_override text, synced_at timestamptz DEFAULT NOW(),
      email_verify_status text, email_verified_at timestamptz, email_verified_value text, lead_origin text)`);
    for (const file of ['2026-10-03-sdr-crm-lifecycle.sql', '2026-10-05-sdr-crm-observations.sql', '2026-10-07-sdr-manual-protection.sql', '2026-10-07-sdr-outreach-controls.sql']) {
      await q(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    vi.resetAllMocks();
    await q('TRUNCATE sdr_lead_state, sdr_crm_snapshots');
    await q('TRUNCATE sdr_outreach_controls CASCADE');
    pd.listUsers.mockResolvedValue([]);
    pd.listPersons.mockResolvedValue(page([{ id: 1, name: 'Estimator', email: [{ value: 'est@example.com', primary: true }] }]));
    pd.listLeads.mockResolvedValue(page([lead('seen')]));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('the sync stamps its read start from the database clock, whatever this machine says', async () => {
    fastClock();
    expect(await sync()).toMatchObject({ upserted: 1 });
    const { rows } = await q(`SELECT crm_source_read_started_at <= clock_timestamp() AS not_ahead,
        crm_source_read_started_at > clock_timestamp() - INTERVAL '1 minute' AS recent,
        crm_person_source_read_started_at = crm_source_read_started_at AS same_stamp
      FROM sdr_lead_state WHERE pipedrive_lead_id = 'seen'`);
    expect(rows[0]).toEqual({ not_ahead: true, recent: true, same_stamp: true });
  });

  it('a read from before the attempt cannot lift the hold, even on a fast clock with the next sync skipping the lead', async () => {
    fastClock();
    await sync();                       // reads the lead, a moment before the swap attempt
    await hold();                       // the attempt: the lead is held
    pd.listLeads.mockResolvedValue(page([lead('other')]));
    await sync();                       // the next pass does not see the lead
    expect(await release()).toEqual({ released: 0 });
    expect(await active()).toBe(1);
  });

  it('a sync that reads the lead straight after the attempt is too soon', async () => {
    await hold();
    await sync();
    expect(await release()).toEqual({ released: 0 });
    expect(await active()).toBe(1);
  });

  it('a sync that reads the lead after the settle time lifts the hold', async () => {
    await heldFor(6);
    expect(await release()).toEqual({ released: 0 });   // not read since the attempt
    await sync();
    expect(await release()).toEqual({ released: 1 });
    expect(await active()).toBe(0);
    expect((await q('SELECT decision FROM sdr_outreach_control_decisions ORDER BY version')).rows.map(r => r.decision)).toEqual(['hold', 'release']);
  });

  it('a pass that skips the lead, or cannot read its contact, leaves the hold', async () => {
    // Read ten minutes ago, held six minutes ago.
    await sync();
    await q("UPDATE sdr_lead_state SET crm_source_read_started_at = crm_source_read_started_at - INTERVAL '10 minutes', crm_person_source_read_started_at = crm_person_source_read_started_at - INTERVAL '10 minutes'");
    await heldFor(6);
    // The lead is not in the listing.
    pd.listLeads.mockResolvedValue(page([lead('other')]));
    await sync();
    expect(await release()).toEqual({ released: 0 });
    // The lead is listed with a contact the sync cannot read.
    pd.listLeads.mockResolvedValue(page([lead('seen', { person_id: 77 })]));
    pd.getPerson.mockRejectedValue(new Error('Pipedrive unreachable'));
    await sync();
    expect(await release()).toEqual({ released: 0 });
    // The listing fails outright.
    pd.listLeads.mockRejectedValue(new Error('Pipedrive unreachable'));
    await sync();
    expect(await release()).toEqual({ released: 0 });
    expect(await active()).toBe(1);
  });
});
