import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import fs from 'node:fs/promises';
import { dispatchLinkedinAction } from '../sdrLinkedinOperations.js';
import { linkedinHash } from '../sdrLinkedinStore.js';

const url = process.env.SDR_TEST_DATABASE_URL;
if (!url) throw Error('SDR_TEST_DATABASE_URL required');
if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('local database required');
const schema = `linkedin_failures_${process.pid}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });

beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(await fs.readFile(new URL('../../migrations/2026-10-16-sdr-linkedin-channel.sql', import.meta.url), 'utf8'));
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

async function fixture(accountId, sourceIds, budget = 1) {
  const config = {
    timezone: 'America/Chicago', lateAcceptancePolicy: 'hold', followupDays: [3, 7],
    budgets: { invite: budget, dm: 0 }, copy: { dm1: 'A', followup1: 'B', followup2: 'C' },
    segments: ['AGC'], territories: ['Illinois'], sources: ['fixture'],
    candidateSourceIds: sourceIds, ownerIds: ['owner'], stopPolicy: 'any_inbound',
  };
  await pool.query("INSERT INTO sdr_linkedin_accounts(company_id,account_id,status,mode) VALUES('13105180',$1,'healthy','live')", [accountId]);
  const campaign = (await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id,status,approval_digest,cohort_digest,config,approved_by,approved_at,expires_at)
    VALUES('13105180',$1,'approved',$2,'cohort',$3,'owner',now(),now()+interval '1 day') RETURNING id`,
  [accountId, linkedinHash({ revision: 1, config, cohort: 'cohort' }), JSON.stringify(config)])).rows[0];
  const actions = [];
  for (const sourceId of sourceIds) {
    const candidate = (await pool.query(`INSERT INTO sdr_linkedin_candidates(company_id,account_id,source,source_id,profile_url,person_id,organization_id,owner_id,pipedrive_owner_id,provider_id,product,state,campaign_id,email_sequence_complete_at,email_unanswered)
      VALUES('13105180',$1,'fixture',$2,$3,$4,'org','owner','42',$5,'classic','reviewed',$6,now()-interval '1 day',true) RETURNING id`,
    [accountId, sourceId, `https://www.linkedin.com/in/${sourceId}/`, `person-${sourceId}`, `ACo-${sourceId}`, campaign.id])).rows[0];
    const action = (await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash)
      VALUES('13105180',$1,$2,$3,$4,1,'invite',$5,now()-interval '1 minute','hash') RETURNING id`,
    [accountId, candidate.id, `person-${sourceId}`, campaign.id, `invite-${sourceId}`])).rows[0];
    actions.push({ actionId: action.id, candidateId: candidate.id });
  }
  return actions;
}

const allow = async () => ({ allowed: true, contextHash: 'hash' });

describe('LinkedIn failure boundaries on isolated Postgres', () => {
  it('serializes two people against one account budget', async () => {
    const actions = await fixture('shared-budget', ['budget-one', 'budget-two']);
    let calls = 0;
    const client = { invite: async () => ({ outcome: 'confirmed', providerId: `invite-${++calls}` }) };
    const results = await Promise.all(actions.map(({ actionId }) => dispatchLinkedinAction({ pool, actionId, client, readFreshContext: allow, mode: 'live' })));
    expect(results.map(result => result.state).sort()).toEqual(['budget_exhausted', 'confirmed']);
    expect(calls).toBe(1);
  });

  it('holds a candidate changed before the network boundary', async () => {
    const [{ actionId, candidateId }] = await fixture('changed-candidate', ['changed-one']);
    let calls = 0;
    await pool.query("UPDATE sdr_linkedin_candidates SET state='held',hold_reason='inbound' WHERE id=$1", [candidateId]);
    const result = await dispatchLinkedinAction({ pool, actionId, mode: 'live', client: { invite: async () => { calls++; } }, readFreshContext: allow });
    expect(result.state).toBe('held');
    expect(calls).toBe(0);
  });

  it('keeps a transport exception uncertain across a second worker and restart', async () => {
    const [{ actionId }] = await fixture('unknown-result', ['unknown-one']);
    let calls = 0;
    const client = { invite: async () => { calls++; throw Error('transport lost after POST'); } };
    expect((await dispatchLinkedinAction({ pool, actionId, client, readFreshContext: allow, mode: 'live' })).state).toBe('uncertain_provider_result');
    expect((await dispatchLinkedinAction({ pool, actionId, client, readFreshContext: allow, mode: 'live' })).state).toBe('uncertain_provider_result');
    expect(calls).toBe(1);
    expect((await pool.query('SELECT network_started_at,request_hash FROM sdr_linkedin_actions WHERE id=$1', [actionId])).rows[0]).toMatchObject({ request_hash: expect.any(String) });
  });

  it('restricts the account after provider rate limit and blocks the next person', async () => {
    const actions = await fixture('provider-restricted', ['restricted-one', 'restricted-two'], 2);
    let calls = 0;
    const client = { invite: async () => { calls++; return { outcome: 'unknown', status: 429, reason: 'rate_limited' }; } };
    expect((await dispatchLinkedinAction({ pool, actionId: actions[0].actionId, client, readFreshContext: allow, mode: 'live' })).state).toBe('uncertain_provider_result');
    expect((await dispatchLinkedinAction({ pool, actionId: actions[1].actionId, client, readFreshContext: allow, mode: 'live' })).state).toBe('held');
    expect(calls).toBe(1);
    expect((await pool.query("SELECT status FROM sdr_linkedin_accounts WHERE account_id='provider-restricted'")).rows[0].status).toBe('restricted');
  });
});
