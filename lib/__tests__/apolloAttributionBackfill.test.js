import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { matchFactToSend, planAttributionBackfill, applyAttributionBackfill, summarizePlan, projectDealAttribution } from '../apolloAttributionBackfill.js';
import { storeSalesHistory } from '../pipedriveSalesHistory.js';

const send = (extra = {}) => ({ id: 's1', pipedrive_lead_id: 'lead-a', apollo_sequence_id: 'seq-lba', apollo_emailer_message_id: null,
  sent_at: '2026-09-01T12:00:00Z', enrolled_trigger: 'LBA', recipient_email: 'buyer@example.test', mailbox_email: 'rep@example.test', ...extra });
const fact = (extra = {}) => ({ provider_message_id: 'm1', campaign_id: 'seq-lba', prospect_email: 'buyer@example.test', mailbox_email: 'rep@example.test',
  occurred_at: '2026-09-02T12:00:00Z', ...extra });

describe('matching a stored Apollo message to one of our sends', () => {
  it('prefers Apollo receipts, then the latest enrollment before the message', () => {
    const sends = [send(), send({ id: 's2', pipedrive_lead_id: 'lead-b', sent_at: '2026-09-10T12:00:00Z' })];
    expect(matchFactToSend(fact(), sends)).toMatchObject({ status: 'verified', evidence: 'send:s1:campaign_recipient_mailbox_time' });
    expect(matchFactToSend(fact({ occurred_at: '2026-09-11T00:00:00Z' }), sends).send.id).toBe('s2');
    expect(matchFactToSend(fact({ occurred_at: '2026-09-11T00:00:00Z' }), [send({ apollo_emailer_message_id: 'm1' }), sends[1]]))
      .toMatchObject({ status: 'verified', evidence: 'send:s1:provider_receipt' });
  });
  it('never guesses between simultaneous enrollments, other mailboxes, other sequences or other addresses', () => {
    expect(matchFactToSend(fact(), [send(), send({ id: 's2', pipedrive_lead_id: 'lead-b' })])).toMatchObject({ status: 'ambiguous', reason: 'simultaneous_enrollments' });
    expect(matchFactToSend(fact({ mailbox_email: 'other@example.test' }), [send()])).toMatchObject({ status: 'ambiguous', reason: 'mailbox_mismatch' });
    expect(matchFactToSend(fact({ occurred_at: '2026-08-01T00:00:00Z' }), [send()])).toMatchObject({ status: 'ambiguous', reason: 'before_enrollment' });
    expect(matchFactToSend(fact({ campaign_id: 'seq-pb' }), [send()]).status).toBe('unmatched');
    expect(matchFactToSend(fact({ prospect_email: 'someone@example.test' }), [send()]).status).toBe('unmatched');
    expect(matchFactToSend(fact({ occurred_at: null }), [send()])).toMatchObject({ status: 'skipped', reason: 'not_sent' });
  });
});

const db = reportingTestDb('apollo_attribution_backfill');
const pool = db?.pool;
describe.skipIf(!pool)('attribution backfill against a local schema', () => {
  beforeAll(async () => {
    await db.setup();
    await pool.query(`CREATE TABLE sdr_mailboxes(id text PRIMARY KEY,email text);
      CREATE TABLE sdr_drafts(id text PRIMARY KEY,trigger_type text,contact_email_snapshot text);
      CREATE TABLE sdr_sends(id text PRIMARY KEY,draft_id text,pipedrive_lead_id text,apollo_sequence_id text,apollo_emailer_message_id text,
        mailbox_id text,sent_at timestamptz,enrolled_trigger text);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,lead_title text)`);
    for (const file of ['2026-10-02-sdr-reporting.sql', '2026-10-04-sdr-metric-evidence.sql', '2026-10-05-sdr-test-exclusions.sql'])
      await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE sdr_mailboxes,sdr_drafts,sdr_sends,sdr_lead_state,sdr_message_facts,sdr_deal_facts,sdr_job_runs');
    await pool.query("INSERT INTO sdr_mailboxes VALUES('mb1','Rep@Example.test')");
    await pool.query("INSERT INTO sdr_drafts VALUES('d1','LBA',' Buyer@Example.test'),('d2',NULL,'buyer@example.test'),('d3','PB','other@example.test')");
    await pool.query(`INSERT INTO sdr_sends VALUES('s1','d1','lead-a','seq-lba',NULL,'mb1','2026-09-01T12:00:00Z',NULL),
      ('s2','d2','lead-b','seq-pb',NULL,'mb1','2026-09-01T12:00:00Z','PB'),
      ('s3','d3','lead-c','seq-pb',NULL,'mb1','2026-09-01T12:00:00Z','PB'),('s4','d3','lead-d','seq-pb',NULL,'mb1','2026-09-01T12:00:00Z','PB')`);
    await pool.query("INSERT INTO sdr_lead_state VALUES('lead-a','Riverbend Plaza')");
    const row = (id, extra) => ({ provider_message_id: id, campaign_id: 'seq-lba', prospect_email: 'buyer@example.test', mailbox_email: 'rep@example.test',
      occurred_at: '2026-09-02T12:00:00Z', provider_status: 'completed', link_status: 'unmatched', pipedrive_lead_id: null, link_evidence: null,
      source_key: 'unknown', outreach_classification: 'unknown', classification_evidence: null, ...extra });
    for (const r of [
      row('unlinked-a'),
      row('unlinked-b', { campaign_id: 'seq-pb' }),
      row('linked-no-source', { link_status: 'verified', pipedrive_lead_id: 'lead-a', link_evidence: 'sdr_send:s1:legacy', outreach_classification: 'sales_outreach', classification_evidence: 'approved_sdr_draft:d1' }),
      row('linked-elsewhere', { link_status: 'verified', pipedrive_lead_id: 'reviewed-lead', link_evidence: 'review:owner' }),
      row('ambiguous', { link_status: 'ambiguous' }),
      row('two-projects', { campaign_id: 'seq-pb', prospect_email: 'other@example.test' }),
      row('permit', { campaign_id: 'seq-permit' }),
      row('scheduled', { occurred_at: null, provider_status: 'scheduled' }),
    ]) {
      await pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,campaign_id,occurred_at,provider_status,
        link_status,pipedrive_lead_id,link_evidence,source_key,outreach_classification,classification_evidence)
        VALUES('apollo',$1,'out',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [r.provider_message_id, r.mailbox_email, r.prospect_email, r.campaign_id, r.occurred_at,
        r.provider_status, r.link_status, r.pipedrive_lead_id, r.link_evidence, r.source_key, r.outreach_classification, r.classification_evidence]);
    }
  });
  const facts = async () => Object.fromEntries((await pool.query(`SELECT provider_message_id,link_status,pipedrive_lead_id,link_evidence,source_key,
    outreach_classification,classification_evidence,observed_at FROM sdr_message_facts`)).rows.map((r) => [r.provider_message_id, r]));

  it('plans inside a read-only transaction, links only exact matches and is a no-op the second time', async () => {
    const client = await pool.connect();
    let plan;
    try { await client.query('BEGIN READ ONLY'); plan = await planAttributionBackfill(client, { env: {} }); await client.query('ROLLBACK'); }
    finally { client.release(); }
    expect(plan.links.map((c) => c.id).sort()).toEqual(['unlinked-a', 'unlinked-b']);
    expect(plan.sources.map((c) => c.id)).toEqual(['linked-no-source']);
    expect(summarizePlan(plan)).toMatchObject({ wouldLink: 2, wouldFillSource: 1, projectsLinked: 2,
      bySequenceMonth: { 'seq-lba (LBA)': { '2026-09': 1 }, 'seq-pb (PB)': { '2026-09': 1 } },
      skipped: { 'verified:different_project_kept': 1, 'unmatched:simultaneous_enrollments': 1, 'unmatched:unmatched': 1, 'unmatched:not_sent': 1 } });
    const before = await facts();
    expect(await applyAttributionBackfill(pool, plan)).toEqual({ linked: 2, sourced: 1 });
    const after = await facts();
    expect(after['unlinked-a']).toMatchObject({ link_status: 'verified', pipedrive_lead_id: 'lead-a', link_evidence: 'send:s1:campaign_recipient_mailbox_time',
      source_key: 'LBA', outreach_classification: 'sales_outreach', classification_evidence: 'sdr_send:s1:apollo_sequence:seq-lba' });
    expect(after['unlinked-b']).toMatchObject({ pipedrive_lead_id: 'lead-b', source_key: 'PB' });
    expect(after['linked-no-source']).toMatchObject({ source_key: 'LBA', link_evidence: 'sdr_send:s1:legacy', classification_evidence: 'approved_sdr_draft:d1' });
    for (const id of ['linked-elsewhere', 'ambiguous', 'two-projects', 'permit', 'scheduled']) expect(after[id]).toEqual(before[id]);
    expect(after['unlinked-a'].observed_at).toEqual(before['unlinked-a'].observed_at);
    const again = await planAttributionBackfill(pool, { env: {} });
    expect([again.links.length, again.sources.length]).toEqual([0, 0]);
    expect(await applyAttributionBackfill(pool, plan)).toEqual({ linked: 0, sourced: 0 });
  });
  it('projects which won deals the next sales sync attributes, using the sync rule itself', async () => {
    await pool.query(`INSERT INTO sdr_deal_facts(pipedrive_deal_id,pipedrive_lead_id,link_status,link_evidence,source,currency,value,status,won_at)
      VALUES('7','lead-a','verified','pipedrive:deal:7:source_lead_id:lead-a','unknown','USD',2500,'won','2026-09-20T15:00:00Z'),
            ('8','lead-z','verified','pipedrive:deal:8:source_lead_id:lead-z','unknown','USD',900,'won','2026-09-20T15:00:00Z'),
            ('9','lead-b','verified','pipedrive:deal:9:source_lead_id:lead-b','unknown','USD',100,'open',NULL)`);
    const plan = await planAttributionBackfill(pool, { env: {} });
    const projection = await projectDealAttribution(pool, plan);
    expect(projection).toMatchObject({ wonDealsWithProjectLink: 2, attributedBefore: 0, attributedAfter: 1 });
    expect(projection.deals.find((d) => d.dealId === '7')).toMatchObject({ title: 'Riverbend Plaza', sourceBefore: 'unknown', sourceAfter: 'LBA' });
    expect(projection.openDealsWithSourceIfWonNow.map((d) => [d.dealId, d.sourceAfter])).toEqual([['9', 'PB']]);
    // The real sync agrees once the backfill is applied.
    await applyAttributionBackfill(pool, plan);
    await storeSalesHistory(pool, { deals: [{ id: 7, title: 'Riverbend Plaza', currency: 'USD', value: 2500, status: 'won', won_time: '2026-09-20T15:00:00Z', source_lead_id: 'lead-a' }],
      checkedAt: '2026-10-26T12:00:00Z', counts: { history_complete: true, company_scope_accepted: true, includes_archived: true } });
    expect((await pool.query("SELECT source FROM sdr_deal_facts WHERE pipedrive_deal_id='7'")).rows[0].source).toBe('LBA');
  });
});
