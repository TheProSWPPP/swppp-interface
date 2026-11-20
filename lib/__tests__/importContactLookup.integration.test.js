import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { companyWebsiteDomain, ensureContactLookups, importContactLookup } from '../importContactLookup.js';

const url=process.env.SDR_TEST_DATABASE_URL;
if (!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw Error('Local test database required');
const admin=new pg.Pool({connectionString:url});
const schema='lookup_'+randomUUID().replaceAll('-','');
const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema});
beforeAll(async()=>{await admin.query('CREATE SCHEMA '+schema);await ensureContactLookups(pool);});
afterAll(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
const context={stage:'LBA',held:false,sequence:false,customer:false,email:'',domain:'builder.test',personId:4,orgId:2};
function fixture(changes={}, verdict='skipped', balance=0) {
  const id=randomUUID();
  const deps={readContext:vi.fn(async()=>({...context,...changes})), holds:vi.fn(async()=>false),
    verdict:vi.fn(async()=>verdict),creditBalance:vi.fn(async()=>balance)};
  return {id,deps,run:(input={})=>importContactLookup(pool,{lead_id:id,...input},deps)};
}
it.each([['https://www.Builder.test/tx','builder.test'],['builder.test','builder.test'],['name@gmail.com',null],['https://www.linkedin.com/company/example',null],
  ['127.0.0.1',null],['localhost',null],['ftp://builder.test',null],['https://real.test@bad.test',null],['mail.google.com',null],['',null]])('uses trusted website host %s', (s,d)=>expect(companyWebsiteDomain(s)).toBe(d));
it.each([['valid','verified_address'],['soft','uncertain_address'],['skipped','verification_pending']])('preserves current address with verdict %s',async(v,expected)=>{
  const {run,deps}=fixture({email:'estimator@builder.test'},v);
  expect(await run()).toMatchObject({lookup_status:expected});expect(deps.creditBalance).not.toHaveBeenCalled();
});
it('records the credit hold, then rechecks on the same lead when credits return',async()=>{
  const {run,deps}=fixture({email:'bad@builder.test'},'hard_fail');
  expect(await run()).toMatchObject({lookup_status:'waiting_for_credits'});
  deps.creditBalance.mockResolvedValue(3);
  const r=await run({protection:'skipped_recent'});expect(r).toMatchObject({lookup_status:'ready_for_lookup',company_domain:'builder.test'});
  expect(await run({lookup_status:'candidate_review',attempt_id:r.attempt_id})).toMatchObject({lookup_status:'candidate_review'});
  expect(await run()).toMatchObject({lookup_status:'candidate_review'});expect(deps.creditBalance).toHaveBeenCalledTimes(2);
});
it('does not release an uncertain or unacknowledged paid lookup on a repeated request',async()=>{
  const {run}=fixture({},'skipped',8);
  const results=await Promise.all([run(),run()]);
  expect(results.map(r=>r.lookup_status).sort()).toEqual(['lookup_uncertain','ready_for_lookup']);
  const id=results.find(r=>r.attempt_id).attempt_id;
  await run({attempt_id:id,lookup_status:'lookup_uncertain'});
  expect(await run({force:true})).toMatchObject({lookup_status:'lookup_uncertain'});
  await expect(run({attempt_id:randomUUID(),lookup_status:'no_match'})).rejects.toThrow(/mismatch/);
});
it('finishing one attempt is idempotent and cannot change the recorded result',async()=>{
  const {run}=fixture({},'skipped',8);const {attempt_id}=await run();
  await run({attempt_id,lookup_status:'no_match'});await run({attempt_id,lookup_status:'no_match'});
  await expect(run({attempt_id,lookup_status:'candidate_review'})).rejects.toThrow(/already recorded/);
});
it('honors sequence, customer and staff holds before any credit lookup',async()=>{
  const {run,deps}=fixture({customer:true});
  const r=await run();expect(r.lookup_status).toBe('customer_review');
  await expect(run({attempt_id:r.attempt_id,lookup_status:'no_match'})).rejects.toThrow(/branch/);
  await run({attempt_id:r.attempt_id,lookup_status:'customer_review'});
  deps.readContext.mockResolvedValue({...context,sequence:true});expect((await run({force:true})).lookup_status).toBe('sequence_active');
  deps.holds.mockResolvedValue(true);expect((await run()).lookup_status).toBe('outreach_held');
  expect(deps.creditBalance).not.toHaveBeenCalled();
});
it('keeps missing evidence retryable and does not present provider outages as zero credits',async()=>{
  const {run,deps}=fixture({domain:null});expect((await run()).lookup_status).toBe('missing_domain');
  deps.readContext.mockResolvedValue(context);deps.creditBalance.mockRejectedValue(Error('timeout'));
  expect((await run()).lookup_status).toBe('lookup_unavailable');
});

it('checks current address evidence and caller customer protection before reusing a no-match',async()=>{
  for (const outcome of ['verified_address','customer_review']) {
    const {run,deps}=fixture({email:'estimator@builder.test'},'hard_fail',8);
    const {attempt_id}=await run();
    await run({attempt_id,lookup_status:'no_match'});
    if (outcome==='verified_address') deps.verdict.mockResolvedValue('valid');
    expect((await run(outcome==='customer_review'?{protection:'customer'}:{})).lookup_status).toBe(outcome);
    expect(deps.creditBalance).toHaveBeenCalledTimes(1);
  }
});
