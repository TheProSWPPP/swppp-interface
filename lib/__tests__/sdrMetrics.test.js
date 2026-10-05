import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import { readFile } from 'node:fs/promises';
import { buildMetrics, rate } from '../sdrMetrics.js';
import { observeOutbound, observeInbound, syncDealFacts } from '../sdrReportingIngest.js';
const now = new Date('2026-11-05T12:00:00Z');
const window = { from: '2026-09-01', to: '2026-10-01', timezone: 'America/Chicago', provisional: false };
const options = { window, visibleMailboxes: ['rep-a@example.test'], now, includeCompanySales: true };
const db=reportingTestDb('metrics');
const pool=db?.pool;
const link = { leadId: 'p1', status: 'verified', evidence: 'message:1', sourceKey: 'cmd' };
async function send(id, overrides = {}, leadLink=link) {
  await observeOutbound(pool, { id, from_email: 'rep-a@example.test', to_email: 'a@example.test', completed_at: '2026-09-02T15:00:00Z', status: 'completed', campaign_position: 1, ...overrides }, { leadLink,
    outreachClassification:'sales_outreach',classificationEvidence:`apollo_message:${id}` });
}
async function reply(id, intent, overrides = {}, leadLink=link) {
  await observeInbound(pool, { id, from_email: 'a@example.test', received_at: '2026-09-04T15:00:00Z', reply_to_id: 'm1', ...overrides }, { mailbox: 'rep-a@example.test', intent, leadLink });
}
async function coverage(status = 'complete') {
  const accepted=(await pool.query("SELECT provider||':'||provider_message_id AS id FROM sdr_message_facts WHERE mailbox_email='rep-a@example.test' AND direction='out' AND provider_status='completed' AND sequence_step=1 AND outreach_classification='sales_outreach' ORDER BY id")).rows.map(row=>row.id);
  const acceptedQuotes=(await pool.query("SELECT pipedrive_deal_id AS id FROM sdr_deal_facts WHERE quote_evidence IS NOT NULL ORDER BY id")).rows.map(row=>row.id);
  for (const job of ['apollo_messages', 'gmail_messages']) await pool.query(`INSERT INTO sdr_job_runs(job,scope,status,finished_at,counts)
    VALUES ($1,'rep-a@example.test',$2,$3,$4)`, [job, status, now, { from: '2026-01-01', to: '2026-11-05', history_complete: true, all_sequences: true,
      ...(job==='apollo_messages'?{accepted_first_touch_ids:accepted,cohort_reconciled:true}: {}) }]);
  await pool.query(`INSERT INTO sdr_job_runs(job,scope,status,finished_at,counts) VALUES ('pipedrive_deals','company',$1,$2,$3)`, [status, now, { from: '2026-01-01', to: '2026-11-05',quote_evidence_reconciled:true,accepted_quote_ids:acceptedQuotes }]);
}
it('separates zero denominator from incomplete evidence', () => {
  expect(rate(0, 0, true)).toMatchObject({ value: null, denominator: 0, reason: 'no_denominator' });
  expect(rate(0, 10, false)).toMatchObject({ value: null, state: 'unavailable' });
  expect(rate(1, 20, true).value).toBe(.05);
});
it('denies empty scopes without issuing queries', async () => {
  const result = await buildMetrics({ query() { throw new Error('must not query'); } }, { ...options, visibleMailboxes: [] });
  expect(result.observation_cutoff).toBeNull();
  expect(result.senders).toEqual([]);
  expect(result.metrics.messages_completed.value).toBeNull();
});
describe.skipIf(!pool)('aggregate SQL integration', () => {
  beforeAll(async () => { await db.setup(); await pool.query(await readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql', import.meta.url), 'utf8')); await pool.query(await readFile(new URL('../../migrations/2026-10-04-sdr-metric-evidence.sql', import.meta.url), 'utf8')); await pool.query(await readFile(new URL('../../migrations/2026-10-05-sdr-test-exclusions.sql', import.meta.url), 'utf8')); });
  beforeEach(async () => { await pool.query('TRUNCATE sdr_message_facts, sdr_deal_facts, sdr_job_runs'); });
  afterAll(async () => { await db.close(); });
  it('excludes marked tests from every sales and message breakdown while retaining the facts', async()=>{
    await send('m1');await send('test-message',{subject:'[TEST] validation'});
    await syncDealFacts(pool,[{id:91,title:'[TEST] validation',currency:'USD',value:999999,status:'won',won_time:'2026-09-10T15:00:00Z'},
      {id:92,title:'Soil testing services',currency:'USD',value:2500,status:'won',won_time:'2026-09-10T15:00:00Z'}]);await coverage();
    const result=await buildMetrics(pool,options);
    expect(result.metrics.messages_completed.value).toBe(1);
    expect(result.metrics.company_won_deals.value).toBe(1);
    expect(result.metrics.company_won_booked_value.value).toBe(2500);
    expect(result.activity.reduce((n,x)=>n+x.company_won_deals,0)).toBe(1);
    expect(result.sequences.reduce((n,x)=>n+x.metrics.messages_completed.value,0)).toBe(0);
    expect(result.test_data).toMatchObject({excluded_messages:1,excluded_deals:1});
    expect((await pool.query('SELECT count(*)::int n FROM sdr_deal_facts')).rows[0].n).toBe(2);
  });
  it('removes confirmed test identities from accepted cohorts without accepting missing real identities',async()=>{
    await send('m1');await send('test-message',{subject:'[TEST] validation',to_email:'test@example.test'});await reply('r1','interested');
    const deals=[{id:91,title:'[TEST] validation',currency:'USD',value:999999,status:'won',won_time:'2026-09-10T15:00:00Z'},
      {id:92,title:'Real project',currency:'USD',value:2500,status:'won',won_time:'2026-09-10T15:00:00Z'}];
    await syncDealFacts(pool,deals.map(d=>({...d,leadLink:link})),{quoteEvidenceByDealId:Object.fromEntries(deals.map(d=>[d.id,{source:'crm_quote',sourceId:`q${d.id}`,dealId:String(d.id),occurredAt:'2026-09-05T15:00:00Z',accepted:true}]))});await coverage();
    const {metrics}=await buildMetrics(pool,options);
    expect(metrics.human_reply_rate).toMatchObject({value:1,denominator:1,state:'available'});
    expect(metrics.quote_close_rate).toMatchObject({value:1,denominator:1,state:'available'});
    await pool.query(`UPDATE sdr_job_runs SET counts=jsonb_set(counts,'{accepted_first_touch_ids}',(counts->'accepted_first_touch_ids') || '["apollo:missing"]'::jsonb) WHERE job='apollo_messages'`);
    await pool.query(`UPDATE sdr_job_runs SET counts=jsonb_set(counts,'{accepted_quote_ids}',(counts->'accepted_quote_ids') || '["missing"]'::jsonb) WHERE job='pipedrive_deals'`);
    const incomplete=(await buildMetrics(pool,options)).metrics;
    expect(incomplete.human_reply_rate).toMatchObject({state:'unavailable',reason:'cohort_reconciliation_missing'});
    expect(incomplete.quote_close_rate).toMatchObject({state:'unavailable',reason:'qualified_quote_mapping_missing'});
  });
  it('returns known USD win counts for accurate monthly weighted averages',async()=>{
    await syncDealFacts(pool,[{id:81,currency:'USD',value:1000,status:'won',won_time:'2026-09-10T15:00:00Z'},
      {id:82,currency:'EUR',value:9000,status:'won',won_time:'2026-09-10T15:00:00Z'},
      {id:83,currency:'USD',value:null,status:'won',won_time:'2026-09-10T15:00:00Z'}]);await coverage();
    const result=await buildMetrics(pool,options);
    expect(result.activity.find(x=>x.date==='2026-09-10')).toMatchObject({company_won_deals:3,company_valued_wins:1,company_won_booked_value:1000});
  });
  it('does not certify all email history from receipts that omit sequence coverage proof', async () => {
    await send('m1'); await reply('r1','negative'); await coverage();
    await pool.query("UPDATE sdr_job_runs SET counts=counts-'all_sequences' WHERE job='apollo_messages'");
    const result=await buildMetrics(pool,options);
    expect(result.metrics.messages_completed).toMatchObject({value:1,state:'partial'});
    expect(result.metrics.human_reply_rate).toMatchObject({value:null,state:'unavailable'});
    expect(result.coverage.provider_messages.state).not.toBe('available');
    expect(result.freshness.state).not.toBe('fresh');
  });
  it('counts real messages and one contacted/replied person across repeated enrollments', async () => {
    await send('m1'); await send('m2'); await send('m3', { campaign_position: 2 });
    await reply('r1', 'negative'); await reply('r2', 'automatic'); await coverage();
    const result = await buildMetrics(pool, options);
    expect(result.observation_cutoff).toBe(now.toISOString());
    const { metrics } = result;
    expect(metrics.messages_completed.value).toBe(3);
    expect(metrics.contacts_reached.value).toBe(1);
    expect(metrics.human_reply_rate).toMatchObject({ value: 1, numerator: 1, denominator: 1, state: 'available' });
    expect(metrics.positive_reply_rate.value).toBe(0);
    expect(metrics.followups_completed.value).toBe(1);
    expect(metrics.duplicate_rate.value).toBeNull();
  });
  it('does not certify reply conversion from warmup, unknown classification, or absent accepted IDs',async()=>{
    await send('m1');await reply('r1','interested');await coverage();
    await send('warm',{id:'warm',to_email:'warm@example.test'});
    await pool.query("UPDATE sdr_message_facts SET outreach_classification='warmup' WHERE provider_message_id='warm'");
    await observeOutbound(pool,{id:'unknown',from_email:'rep-a@example.test',to_email:'unknown@example.test',status:'completed',completed_at:'2026-09-03T15:00:00Z',campaign_position:1},{leadLink:link});
    const result=await buildMetrics(pool,options);
    expect(result.metrics.human_reply_rate).toMatchObject({value:null,state:'unavailable',reason:'outreach_classification_incomplete'});
    await pool.query("DELETE FROM sdr_message_facts WHERE provider_message_id='unknown'");
    expect((await buildMetrics(pool,options)).metrics.human_reply_rate).toMatchObject({numerator:1,denominator:1,value:1});
    await pool.query("UPDATE sdr_job_runs SET counts=counts-'accepted_first_touch_ids' WHERE job='apollo_messages'");
    expect((await buildMetrics(pool,options)).metrics.human_reply_rate).toMatchObject({value:null,state:'unavailable',reason:'cohort_reconciliation_missing'});
  });
  it('keeps a later cohort unavailable when earlier first-touch history is unclassified',async()=>{
    await observeOutbound(pool,{id:'old-unknown',from_email:'rep-a@example.test',to_email:'a@example.test',status:'completed',completed_at:'2026-08-01T15:00:00Z',campaign_position:1},{leadLink:link});
    await send('m1');await reply('r1','interested');
    await syncDealFacts(pool,[{id:1,currency:'USD',status:'won',won_time:'2026-09-10T15:00:00Z',leadLink:link}]);await coverage();
    const {metrics}=await buildMetrics(pool,options);
    expect(metrics.human_reply_rate).toMatchObject({state:'unavailable',reason:'outreach_classification_incomplete'});
    expect(metrics.contact_to_win_rate.state).toBe('unavailable');
  });
  it('keeps a September reply to an August first touch out of the September conversion cohort', async () => {
    await send('m1', { completed_at: '2026-08-25T15:00:00Z' }); await send('m2'); await reply('r1', 'interested'); await coverage();
    const { metrics } = await buildMetrics(pool, options);
    expect(metrics.human_replies_received.value).toBe(1);
    expect(metrics.human_reply_rate).toMatchObject({ numerator: 0, denominator: 0, value: null });
  });
  it('excludes late/earlier, automatic and unlinked inbound messages', async () => {
    await send('m1');
    await reply('early', 'interested', { received_at: '2026-09-01T15:00:00Z' });
    await reply('late', 'interested', { received_at: '2026-10-04T15:00:00Z' });
    await reply('auto', 'automatic');
    await reply('unlinked', 'interested', { reply_to_id: null }); await coverage();
    expect((await buildMetrics(pool, options)).metrics.human_reply_rate.value).toBe(0);
  });
  it('marks incomplete paging and immature reply/sales cohorts rather than returning final conversion', async () => {
    await send('m1'); await reply('r1', 'interested'); await coverage('partial');
    const partial = await buildMetrics(pool, options);
    expect(partial.metrics.messages_completed.state).toBe('partial');
    expect(partial.metrics.human_reply_rate.value).toBeNull();
    await coverage();
    await pool.query("UPDATE sdr_job_runs SET finished_at='2026-09-15T10:00:00Z', counts=counts || '{\"to\":\"2026-09-15\"}'::jsonb");
    const young = await buildMetrics(pool, { ...options, window: { ...window, to: '2026-09-10' }, now: new Date('2026-09-15T12:00:00Z') });
    expect(young.metrics.human_reply_rate.state).toBe('partial');
    expect(young.metrics.contact_to_win_rate.state).toBe('partial');
  });
  it('never includes another mailbox in totals, deals or source counts', async () => {
    await send('m1'); await send('private', { from_email: 'other@example.test', to_email: 'private@example.test' }); await coverage();
    const result = await buildMetrics(pool, { ...options, includeCompanySales: false });
    expect(result.metrics.messages_completed.value).toBe(1);
    expect(result.senders.map(s => s.mailbox)).toEqual(['rep-a@example.test']);
    expect(result.metrics.company_won_booked_value.value).toBeNull();
  });
  it('does not claim zero replies when a human reply cannot be linked to a contacted message', async () => {
    await send('m1'); await reply('r1','interested',{ reply_to_id:null }); await coverage();
    const result = await buildMetrics(pool,options);
    expect(result.metrics.human_reply_rate.state).toBe('partial');
    expect(result.coverage.reply_links).toMatchObject({ numerator:0,denominator:1,value:0 });
  });
  it('treats empty fully covered message windows as real zero', async () => {
    await coverage();
    const result=await buildMetrics(pool,options);
    expect(result.metrics.messages_completed).toMatchObject({ value:0,state:'available' });
    expect(result.metrics.human_reply_rate.reason).toBe('no_denominator');
  });
  it('preserves the weighted average and separates unknown value and currency', async () => {
    const values = [1000, 2000, 3000, 10000];
    const deals = values.map((value, i) => ({ id: i + 1, currency: 'USD', value, status: 'won', won_time: '2026-09-10T15:00:00Z' }));
    await syncDealFacts(pool, [...deals, deals[0], { ...deals[0], id: 5, currency: 'EUR', value: 99999 }, { ...deals[0], id: 6, value: null }]); await coverage();
    const { metrics } = await buildMetrics(pool, options);
    expect(metrics.company_won_booked_value.value).toBe(16000);
    expect(metrics.company_average_won_deal_value.value).toBeCloseTo(4000);
    expect(metrics.company_average_won_deal_value.denominator).toBe(4);
    expect(metrics.company_average_won_deal_value.state).toBe('partial');
    expect(metrics.won_booked_value.value).toBeNull();
  });
  it('calculates monthly and quarterly totals by unique USD deal ID', async () => {
    const september = [1000, 1500, 3500].map((value, i) => ({
      id: i + 1, currency: 'USD', value,
      status: 'won', won_time: '2026-09-10T15:00:00Z',
    }));
    const earlier = [750, 1250, 2000, 3000, 4000].map((value, i) => ({
      id: i + 4, currency: 'USD', value,
      status: 'won', won_time: '2026-08-10T15:00:00Z',
    }));
    await syncDealFacts(pool, [...september, ...earlier, september[0],
      { id: 9, currency: 'EUR', value: 90000, status: 'won', won_time: '2026-09-10T15:00:00Z' },
      { id: 10, currency: 'USD', value: null, status: 'won', won_time: '2026-09-10T15:00:00Z' },
    ]);
    await coverage();
    const septemberMetrics = (await buildMetrics(pool, options)).metrics;
    const quarterMetrics = (await buildMetrics(pool, {
      ...options, window: { ...window, from: '2026-07-01' },
    })).metrics;
    expect(septemberMetrics.company_won_booked_value.value).toBe(6000);
    expect(septemberMetrics.company_average_won_deal_value).toMatchObject({
      numerator: 6000, denominator: 3,
    });
    expect(quarterMetrics.company_won_booked_value.value).toBe(17000);
    expect(quarterMetrics.company_average_won_deal_value).toMatchObject({
      numerator: 17000, denominator: 8,
    });
  });
  it('counts each linked win once and only verified quotes in close rate', async () => {
    await send('m1'); await send('m2');
    const base = { currency: 'USD', value: 2500, quote_created_at: '2026-09-05T15:00:00Z', stage_id: 5, leadLink: link };
    await syncDealFacts(pool, [{ ...base, id: 1, status: 'won', won_time: '2026-09-08T15:00:00Z' }, { ...base, id: 2, status: 'lost' }, { ...base, id: 3, status: 'open' }, { ...base, id: 4, status: 'won', leadLink: null, won_time: '2026-09-08T15:00:00Z' }], { quoteStageIds: [5],quoteEvidenceByDealId:Object.fromEntries([1,2,3,4].map(id=>[id,{source:'crm_quote',sourceId:`q${id}`,dealId:String(id),occurredAt:'2026-09-05T15:00:00Z',accepted:true}])) }); await coverage();
    const { metrics } = await buildMetrics(pool, options);
    expect(metrics.won_booked_value.value).toBe(2500);
    expect(metrics.quote_close_rate).toMatchObject({ numerator: 1, denominator: 2, value: .5 });
    expect(metrics.unresolved_quotes.value).toBe(1);
  });
  it('keeps quote close unavailable until independent deal IDs are accepted, then counts a later win in quote cohort',async()=>{
    await send('m1');
    const evidence=id=>({source:'pipedrive_mail',sourceId:`mail-${id}`,dealId:String(id),occurredAt:'2026-09-05T15:00:00Z',accepted:true});
    await syncDealFacts(pool,[
      {id:1,currency:'USD',status:'won',won_time:'2026-10-10T15:00:00Z',leadLink:link},
      {id:2,currency:'USD',status:'open',leadLink:link},
      {id:3,currency:'USD',status:'won',won_time:'2026-09-08T15:00:00Z'},
    ],{quoteEvidenceByDealId:{1:evidence(1),2:evidence(2),3:evidence(3)}});
    await coverage();
    await pool.query("UPDATE sdr_job_runs SET counts=counts-'accepted_quote_ids' WHERE job='pipedrive_deals'");
    expect((await buildMetrics(pool,options)).metrics.quote_close_rate.state).toBe('unavailable');
    await pool.query("UPDATE sdr_job_runs SET counts=counts || '{\"accepted_quote_ids\":[\"1\",\"2\",\"3\"]}'::jsonb WHERE job='pipedrive_deals'");
    const {metrics}=await buildMetrics(pool,options);
    expect(metrics.quote_close_rate).toMatchObject({numerator:1,denominator:1,value:1});
    expect(metrics.unresolved_quotes.value).toBe(1);
  });
  it('does not show a conversion for an ambiguous first-touch project even with a coverage receipt',async()=>{
    await send('ambiguous',{}, {leadId:'p1',status:'ambiguous',evidence:'shared_address',sourceKey:'cmd'});
    await coverage();
    expect((await buildMetrics(pool,options)).metrics.human_reply_rate).toMatchObject({state:'unavailable',reason:'identity_reconciliation_missing'});
  });
  it('does not credit CMD conversion for a reply explicitly tied to another source and project',async()=>{
    const other={...link,leadId:'p2',sourceKey:'agc'};
    await send('m1'); await send('m2',{completed_at:'2026-09-03T15:00:00Z'},other);
    await reply('r2','interested',{reply_to_id:'m2'},other);await coverage();
    const result=await buildMetrics(pool,{...options,source:'cmd'});
    expect(result.metrics.human_reply_rate.value).toBe(0);
    expect(result.metrics.positive_reply_rate.value).toBe(0);
  });
  it('keeps a new verified project in September while deduplicating repeated enrollment for that project',async()=>{
    const second={...link,leadId:'p2'};
    await send('old',{completed_at:'2026-08-01T15:00:00Z'});
    await send('new',{},second);await send('repeat',{},second);
    await reply('r2','interested',{reply_to_id:'new'},second);
    await syncDealFacts(pool,[{id:1,currency:'USD',value:2500,status:'won',won_time:'2026-09-10T15:00:00Z',leadLink:second}]);await coverage();
    const result=await buildMetrics(pool,options);
    expect(result.metrics.contact_to_win_rate).toMatchObject({numerator:1,denominator:1,value:1});
    expect(result.metrics.human_reply_rate).toMatchObject({numerator:1,denominator:1,value:1});
  });
  it('requires independently complete inbox history before reporting a zero inbound event count',async()=>{
    await send('m1');await coverage();await pool.query("DELETE FROM sdr_job_runs WHERE job='gmail_messages'");
    expect((await buildMetrics(pool,options)).metrics.human_replies_received).toMatchObject({value:null,state:'unavailable'});
  });
  it('requires the full sales horizon and exposes old deal collection in freshness and attention',async()=>{
    await send('m1');await coverage();
    await pool.query("UPDATE sdr_job_runs SET finished_at='2026-10-01T12:00:00Z',counts=counts || '{\"to\":\"2026-10-01\"}'::jsonb WHERE job='pipedrive_deals'");
    const result=await buildMetrics(pool,options);
    expect(result.metrics.contact_to_win_rate.state).toBe('unavailable');
    expect(result.freshness.state).toBe('stale');
    expect(result.attention.map(item=>item.kind)).toContain('deal_coverage_incomplete');
  });
  it('filters sequences without moving a repeated first touch into a new cohort',async()=>{
    await send('old',{emailer_campaign_id:'old',completed_at:'2026-08-15T15:00:00Z'});
    await send('m1',{emailer_campaign_id:'new'});await send('m2',{emailer_campaign_id:'other',to_email:'b@example.test'});
    await reply('r1','interested',{reply_to_id:'m1'});await coverage();
    const result=await buildMetrics(pool,{...options,sequence:'new'});
    expect(result.metrics.messages_completed.value).toBe(1);
    expect(result.metrics.human_reply_rate.denominator).toBe(0);
    expect(result.sequences.map(row=>row.id)).toEqual(['new','other']);
    expect(result.sequences.find(row=>row.id==='new').metrics.human_reply_rate.state).toBe('unavailable');
    expect(result.activity.reduce((sum,row)=>sum+row.messages_completed,0)).toBe(1);
  });
  it('attributes campaign-less Gmail reply events using their exact outbound receipt',async()=>{
    await send('m1',{emailer_campaign_id:'target',thread_id:'shared'});
    await send('m2',{emailer_campaign_id:'other',thread_id:'shared',campaign_position:2});
    await reply('r1','interested',{reply_to_id:'m1',thread_id:'shared'});await coverage();
    const target=await buildMetrics(pool,{...options,sequence:'target'});
    expect(target.metrics.human_replies_received).toMatchObject({value:1,state:'available'});
    expect(target.activity.reduce((sum,row)=>sum+row.human_replies_received,0)).toBe(1);
    const other=await buildMetrics(pool,{...options,sequence:'other'});
    expect(other.metrics.human_replies_received.value).toBe(0);
    expect(other.metrics.human_reply_rate.denominator).toBe(0);
  });
  it('leaves an ambiguous multi-sequence thread out of filtered reply events',async()=>{
    await send('m1',{emailer_campaign_id:'target',thread_id:'shared'});
    await send('m2',{emailer_campaign_id:'other',thread_id:'shared',campaign_position:2});
    await reply('r1','interested',{reply_to_id:null,thread_id:'shared'});await coverage();
    const result=await buildMetrics(pool,{...options,sequence:'target'});
    expect(result.metrics.human_replies_received).toMatchObject({value:0,state:'partial',reason:'reply_links_missing'});
    expect(result.metrics.human_reply_rate).toMatchObject({value:null,state:'unavailable',reason:'reply_links_missing'});
    expect(result.metrics.positive_reply_rate.value).toBeNull();
    expect((await buildMetrics(pool,options)).metrics.human_replies_received.value).toBe(1);
  });
  it('separates all-company sales from outreach filters and preserves weighted averages',async()=>{
    await send('m1',{emailer_campaign_id:'target'});await coverage();
    await syncDealFacts(pool,[{id:1,currency:'USD',value:1000,status:'won',won_time:'2026-09-08T15:00:00Z'},
      {id:2,currency:'USD',value:3000,status:'won',won_time:'2026-09-09T15:00:00Z'}]);
    const result=await buildMetrics(pool,{...options,source:'missing',sequence:'target'});
    expect(result.metrics.messages_completed.value).toBe(0);
    expect(result.metrics.company_won_deals.value).toBe(2);
    expect(result.metrics.company_average_won_deal_value).toMatchObject({value:2000,numerator:4000,denominator:2});
    expect(result.activity.reduce((sum,row)=>sum+row.company_won_deals,0)).toBe(2);
    expect(result.activity.reduce((sum,row)=>sum+row.company_won_booked_value,0)).toBe(4000);
    expect(result.metrics.open_rate).toMatchObject({value:null,state:'unavailable',reason:'open_tracking_unverified'});
    expect(result.metrics.spam_rate).toMatchObject({value:null,state:'unavailable',reason:'spam_placement_unverified'});
  });
  it('counts provider bounce and spam flags independently of full-history rates',async()=>{
    await send('b',{status:'bounced',bounced:true});await send('s',{status:'spam_blocked',spam_blocked:true});
    const result=await buildMetrics(pool,options);
    expect(result.metrics.bounce_rate.state).toBe('unavailable');
    expect(result.metrics.bounce_events).toMatchObject({value:1,state:'partial'});
    expect(result.metrics.spam_blocked_events).toMatchObject({value:1,state:'partial'});
    expect(result.activity.length).toBe(30);
    expect(result.activity[0].date).toBe('2026-09-01');
    expect(result.activity.at(-1).date).toBe('2026-09-30');
    expect(result.metrics.company_won_deals.value).toBeNull();
    expect(result.activity.every(day=>day.company_won_deals===null && day.company_won_booked_value===null)).toBe(true);
  });
  it('shows stale scan timestamps and unknowns on older schema', async () => {
    await coverage();
    await pool.query("UPDATE sdr_job_runs SET finished_at='2026-10-01T12:00:00Z'");
    expect((await buildMetrics(pool, options)).freshness.state).toBe('stale');
    const emptyPool = { async query() { const error = new Error('table missing'); error.code = '42P01'; throw error; } };
    expect((await buildMetrics(emptyPool, options)).metrics.messages_completed).toMatchObject({ value: null, reason: 'reporting_not_initialized' });
  });
});

it('leaves observation cutoff unknown when reporting schema is unavailable', async () => {
  const result = await buildMetrics({query: async () => {throw Object.assign(new Error('missing'),{code:'42P01'});}},options);
  expect(result.observation_cutoff).toBeNull();
});
