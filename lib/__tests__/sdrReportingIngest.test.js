import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import { readFile } from 'node:fs/promises';
import { observeOutbound, observeInbound, syncDealFacts } from '../sdrReportingIngest.js';

const db=reportingTestDb('ingest');
const pool=db?.pool;
const outbound = { id: 'm1', from_email: ' REP-A@example.test ', to_email: 'Buyer@example.test', completed_at: '2026-09-01T15:00:00Z', status: 'completed', replied: true, emailer_campaign_id: 'agc', campaign_position: 1, body: 'PRIVATE BODY' };
const verified = { leadId: 'project-a', status: 'verified', evidence: 'enrollment:123', sourceKey: 'cmd' };
describe.skipIf(!pool)('reporting fact SQL integration (isolated test DB)', () => {
  beforeAll(async () => { await db.setup(); await pool.query(await readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql', import.meta.url), 'utf8')); await pool.query(await readFile(new URL('../../migrations/2026-10-04-sdr-metric-evidence.sql', import.meta.url), 'utf8')); await pool.query(await readFile(new URL('../../migrations/2026-10-05-sdr-test-exclusions.sql', import.meta.url), 'utf8')); });
  beforeEach(async () => { await pool.query('TRUNCATE sdr_message_facts, sdr_deal_facts, sdr_job_runs'); });
  afterAll(async () => { await db.close(); });
  it('retains confirmed test evidence across sparse refreshes and permits a reviewed correction',async()=>{
    await observeOutbound(pool,{...outbound,subject:'TEST - mail check'});
    await observeOutbound(pool,outbound);
    expect((await pool.query('SELECT is_test,test_evidence FROM sdr_message_facts')).rows[0]).toMatchObject({is_test:true,test_evidence:'apollo:m1:subject_test_prefix'});
    await observeOutbound(pool,outbound,{testReview:{recordId:'m1',isTest:false,evidence:'Reviewed source: legitimate project'}});
    await observeOutbound(pool,{...outbound,subject:'TEST - mail check'});
    expect((await pool.query('SELECT is_test FROM sdr_message_facts')).rows[0].is_test).toBe(false);
  });
  it('deduplicates provider identity, updates status, retains verified provenance and never synthesizes a reply', async () => {
    expect(await observeOutbound(pool, outbound, { leadLink: verified })).toEqual({ inserted: 1, updated: 0 });
    expect(await observeOutbound(pool, { ...outbound, status: 'failed' }, { leadLink: { status: 'ambiguous', leadId: 'project-b', sourceKey: 'api' } })).toEqual({ inserted: 0, updated: 1 });
    const { rows } = await pool.query('SELECT * FROM sdr_message_facts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', mailbox_email: 'rep-a@example.test', prospect_email: 'buyer@example.test', human_reply: null, link_status: 'verified', pipedrive_lead_id: 'project-a', source_key: 'cmd', provider_status: 'failed' });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE BODY');
  });
  it('stores missing outbound completion time as unknown', async () => {
    await observeOutbound(pool, { ...outbound, completed_at: null });
    expect((await pool.query('SELECT occurred_at FROM sdr_message_facts')).rows[0].occurred_at).toBeNull();
  });
  it('stores real inbound time and excludes automatic responders from human replies', async () => {
    await observeInbound(pool, { id: 'g1', from_email: outbound.to_email, internalDate: '1788274800000' }, { mailbox: 'rep-a@example.test', intent: 'automatic', leadLink: verified });
    const row = (await pool.query('SELECT * FROM sdr_message_facts')).rows[0];
    expect(row.human_reply).toBe(false);
    expect(row.direction).toBe('in');
    expect(row.occurred_at.toISOString()).toBe('2026-09-01T15:00:00.000Z');
  });
  it('preserves two projects as ambiguous instead of using an email guess', async () => {
    await observeOutbound(pool, outbound, { leadLink: { leadId: 'project-a', status: 'ambiguous', evidence: 'multiple_projects', sourceKey: 'cmd' } });
    expect((await pool.query('SELECT * FROM sdr_message_facts')).rows[0]).toMatchObject({ pipedrive_lead_id: null, link_status: 'ambiguous', source_key: 'unknown' });
  });
  it('upgrades unknown source evidence only when the verified project is unchanged', async () => {
    await observeOutbound(pool,{...outbound,provider_thread_id:'thread-1'},{leadLink:{...verified,sourceKey:'unknown'}});
    await observeOutbound(pool,outbound,{leadLink:verified});
    const row=(await pool.query('SELECT source_key,thread_id FROM sdr_message_facts')).rows[0];
    expect(row).toEqual({source_key:'cmd',thread_id:'thread-1'});
  });
  it('interprets Pipedrive bare timestamps as UTC rather than the host timezone',async()=>{
    await syncDealFacts(pool,[{id:1,currency:'USD',value:2000,status:'won',won_time:'2026-09-01 03:00:00'}]);
    expect((await pool.query('SELECT won_at FROM sdr_deal_facts')).rows[0].won_at.toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });
  it('keeps unknown quote mapping null and does not double-count a repeated deal', async () => {
    const deal = { id: 1, value: 2500, currency: 'USD', status: 'won', won_time: '2026-09-01T15:00:00Z', stage_id: 5 };
    await syncDealFacts(pool, [deal, deal]);
    expect((await pool.query('SELECT * FROM sdr_deal_facts')).rows).toMatchObject([{ pipedrive_deal_id: '1', qualified_quote: null, value: '2500', link_status: 'unmatched' }]);
  });
  it('does not infer a quote from a stage, deal date, or win date',async()=>{
    const deal={id:1,currency:'USD',value:2500,status:'open',stage_id:5,quote_created_at:'2026-09-02T15:00:00Z'};
    await syncDealFacts(pool,[deal],{quoteStageIds:[5]});
    await syncDealFacts(pool,[{...deal,status:'won',stage_id:6,won_time:'2026-09-10T15:00:00Z'}],{quoteStageIds:[5]});
    expect((await pool.query('SELECT qualified_quote,quote_created_at,quote_evidence FROM sdr_deal_facts')).rows[0]).toMatchObject({qualified_quote:null,quote_created_at:null,quote_evidence:null});
  });
  it('rejects an accepted quote ID without an actual quote timestamp',async()=>{
    await syncDealFacts(pool,[{id:1,currency:'USD',status:'won',won_time:'2026-09-10T15:00:00Z'}],{quoteEvidenceByDealId:{1:{source:'crm_quote',sourceId:'q1',dealId:'1',accepted:true}}});
    expect((await pool.query('SELECT qualified_quote,quote_created_at,quote_evidence FROM sdr_deal_facts')).rows[0]).toMatchObject({qualified_quote:null,quote_created_at:null,quote_evidence:null});
  });
  it('retains the earliest independently sourced quote across deal stage changes',async()=>{
    const deal={id:1,currency:'USD',value:2500,status:'open',stage_id:5,leadLink:verified};
    const evidence={source:'crm_quote',sourceId:'quote-1',dealId:'1',occurredAt:'2026-09-02T15:00:00Z',accepted:true};
    await syncDealFacts(pool,[deal],{quoteEvidenceByDealId:{1:evidence}});
    await syncDealFacts(pool,[{...deal,status:'won',stage_id:6,won_time:'2026-09-10T15:00:00Z'}]);
    await syncDealFacts(pool,[deal],{quoteEvidenceByDealId:{1:{...evidence,sourceId:'quote-2',occurredAt:'2026-09-04T15:00:00Z'}}});
    const row=(await pool.query('SELECT qualified_quote,quote_created_at,quote_evidence FROM sdr_deal_facts')).rows[0];
    expect(row.qualified_quote).toBe(true);
    expect(row.quote_created_at.toISOString()).toBe(evidence.occurredAt.replace('Z','.000Z'));
    expect(row.quote_evidence.sourceId).toBe('quote-1');
  });
  it('requires an accepted deal-specific quote identity and explicit outbound classification evidence',async()=>{
    await observeOutbound(pool,outbound,{leadLink:verified,outreachClassification:'sales_outreach'});
    expect((await pool.query('SELECT outreach_classification FROM sdr_message_facts')).rows[0].outreach_classification).toBe('unknown');
    await observeOutbound(pool,outbound,{leadLink:verified,outreachClassification:'sales_outreach',classificationEvidence:'apollo_message:m1'});
    expect((await pool.query('SELECT outreach_classification FROM sdr_message_facts')).rows[0].outreach_classification).toBe('sales_outreach');
    await syncDealFacts(pool,[{id:1,currency:'USD',status:'won',quote_created_at:'2026-09-02T15:00:00Z'}],{quoteEvidenceByDealId:{1:{source:'crm_quote',sourceId:'q1',dealId:'2',occurredAt:'2026-09-02T15:00:00Z',accepted:true}}});
    expect((await pool.query('SELECT qualified_quote FROM sdr_deal_facts')).rows[0].qualified_quote).toBeNull();
  });
  it('reapplies the additive migration without changing fact identity or relaxing classification checks',async()=>{
    await pool.query(await readFile(new URL('../../migrations/2026-10-04-sdr-metric-evidence.sql',import.meta.url),'utf8'));
    await observeOutbound(pool,outbound,{leadLink:verified});
    expect((await pool.query('SELECT COUNT(*)::int n FROM sdr_message_facts')).rows[0].n).toBe(1);
    await expect(pool.query("UPDATE sdr_message_facts SET outreach_classification='invalid'")).rejects.toMatchObject({code:'23514'});
  });
  it('upgrades an unknown deal source on the same verified project but rejects conflicting relinking',async()=>{
    const deal={id:1,currency:'USD',value:2500,status:'won',leadLink:{...verified,sourceKey:'unknown'}};
    await syncDealFacts(pool,[deal]);await syncDealFacts(pool,[{...deal,leadLink:verified}]);
    await syncDealFacts(pool,[{...deal,leadLink:{...verified,leadId:'project-b',sourceKey:'agc'}}]);
    expect((await pool.query('SELECT source,pipedrive_lead_id FROM sdr_deal_facts')).rows[0]).toEqual({source:'cmd',pipedrive_lead_id:'project-a'});
  });
});

it('rejects malformed identities before writing', async () => {
  const calls = [];
  const recordingPool = { query: async (...args) => { calls.push(args); return { rows: [{ inserted: true }] }; } };
  await expect(observeOutbound(recordingPool, { ...outbound, id: null })).rejects.toThrow('invalid_message');
  expect(calls).toHaveLength(0);
});
it('writes reporting facts only and removes body/header secrets from the payload', async () => {
  const calls = [];
  const recordingPool = { query: async (...args) => { calls.push(args); return { rows: [{ inserted: true }] }; } };
  await observeOutbound(recordingPool, outbound, { leadLink: verified });
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatch(/^INSERT INTO sdr_message_facts/);
  expect(JSON.stringify(calls)).not.toContain('PRIVATE BODY');
});
