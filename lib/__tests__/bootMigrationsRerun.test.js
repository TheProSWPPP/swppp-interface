import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';

// 2026-10-27: every boot re-runs the protection migrations in server.js order. The 10-10 file
// re-added the provider-operation state check without 'provider_skipped' (added 10-27), so the
// first boot after a provider_skipped row existed crashed with a check violation (app down).
const db=reportingTestDb('boot_migrations_rerun');
const source=await readFile(new URL('../../server.js',import.meta.url),'utf8');
const list=JSON.parse(source.match(/for\(const migration of (\[[^\]]+\])\) \{/)[1].replaceAll("'",'"'));
const providerFiles=list.filter(f=>['2026-10-07-sdr-provider-operations.sql','2026-10-10-sdr-enrollment-phases.sql','2026-10-27-sdr-provider-skipped.sql'].includes(f));
const run=async()=>{for(const file of providerFiles)await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));};
describe.skipIf(!db)('boot migrations re-run over live provider states',()=>{
 beforeAll(async()=>{await db.setup();});
 afterAll(async()=>db.close());
 it('re-runs in boot order with every provider operation state present',async()=>{
  expect(providerFiles).toHaveLength(3);
  await run();
  await db.pool.query(`INSERT INTO sdr_provider_operations(id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,state,reason)
   VALUES(gen_random_uuid(),'k1','enroll','c','s','l','{}','a','provider_skipped','contacts_with_job_change')`);
  await expect(run()).resolves.toBeUndefined();
  expect((await db.pool.query("SELECT state FROM sdr_provider_operations")).rows).toEqual([{state:'provider_skipped'}]);
 });
});
