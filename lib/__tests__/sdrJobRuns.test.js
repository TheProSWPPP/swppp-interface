import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {withJobRun,safeErrorCategory,readJobHealth} from '../sdrJobRuns.js';
const db=reportingTestDb('jobs');const pool=db?.pool;
describe.skipIf(!pool)('durable app job lifecycle',()=>{
 beforeAll(async()=>{await db.setup();await pool.query(await readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql',import.meta.url),'utf8'));});
 beforeEach(async()=>{await pool.query('TRUNCATE sdr_job_runs');});afterAll(async()=>{await db.close();});
 it('records a genuinely complete empty run and explicit skipped hours separately',async()=>{
  await withJobRun(pool,{job:'crm',scope:'account'},async()=>({coverage:'complete',counts:{scanned:0},secret:'should-not-persist'}));
  await withJobRun(pool,{job:'enrollment',scope:'account'},async()=>({skipped:'outside_hours'}));
  const rows=(await pool.query('SELECT * FROM sdr_job_runs ORDER BY started_at')).rows;
  expect(rows.map(r=>r.status)).toEqual(['complete','skipped']);expect(rows.every(r=>r.finished_at)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('should-not-persist');expect(rows[0].counts.scanned).toBe(0);
 });
 it('records partial pages/cursor and categorizes failed requests without private error text',async()=>{
  await withJobRun(pool,{job:'apollo_poll',scope:'account'},async()=>({coverage:'partial',counts:{pages:26},errorCategory:'cursor_persistence_failed',cursor:{nextPage:27,token:'SECRET'}}));
  await expect(withJobRun(pool,{job:'gmail_watch',scope:'account'},async()=>{throw Object.assign(new Error('token=PRIVATE'),{status:429});})).rejects.toThrow();
  const rows=(await pool.query('SELECT * FROM sdr_job_runs ORDER BY started_at')).rows;
  expect(rows[0]).toMatchObject({status:'partial',error_category:'cursor_persistence_failed',cursor:{nextPage:27}});expect(rows[1]).toMatchObject({status:'failed',error_category:'rate_limit'});
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|SECRET/);
 });
 it('rejects concurrent execution and releases the lock after work throws',async()=>{
  let entered;const started=new Promise(r=>{entered=r;});let release;const blocked=new Promise(r=>{release=r;});
  const first=withJobRun(pool,{job:'gmail_watch',scope:'account'},async()=>{entered();await blocked;throw new Error('timeout');});
  const failure=expect(first).rejects.toThrow('timeout');await started;
  let touched=false;const second=await withJobRun(pool,{job:'gmail_watch',scope:'account'},async()=>{touched=true;});
  expect(second.skipped).toBe('concurrent_run');expect(touched).toBe(false);release();await failure;
  await withJobRun(pool,{job:'gmail_watch',scope:'account'},async()=>({coverage:'complete'}));
  expect((await pool.query("SELECT status FROM sdr_job_runs ORDER BY started_at")).rows.map(r=>r.status)).toEqual(['failed','skipped','complete']);
 });
 it('recovers a stale running receipt once the session lock is gone',async()=>{
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at) VALUES ('crm','account','running',NOW()-INTERVAL '1 day')");
  await withJobRun(pool,{job:'crm',scope:'account'},async()=>({coverage:'complete'}));
  expect((await pool.query("SELECT status,error_category FROM sdr_job_runs ORDER BY started_at")).rows[0]).toEqual({status:'failed',error_category:'interrupted'});
 });
 it('marks missed cadence even when the last attempt succeeded long ago',async()=>{
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at) VALUES ('crm','account','complete',NOW()-INTERVAL '2 days',NOW()-INTERVAL '2 days')");
  const health=await readJobHealth(pool,{visibleMailboxes:[],admin:true});expect(health.jobs.find(j=>j.job==='crm').state).toBe('late');
 });
 it('does not let repeated concurrent skips conceal a stuck running job',async()=>{
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,counts,finished_at) VALUES ('gmail_watch','account','running',NOW()-INTERVAL '1 day','{}',NULL),('gmail_watch','account','skipped',NOW(),'{\"concurrent_run\":1}',NOW())");
  const h=await readJobHealth(pool,{admin:true});expect(h.jobs.find(j=>j.job==='gmail_watch').state).toBe('late');
 });
 it('retains last complete evidence when a later attempt is partial',async()=>{
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at) VALUES ('crm','account','complete',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour'),('crm','account','partial',NOW(),NOW())");
  const h=await readJobHealth(pool,{admin:true});const job=h.jobs.find(j=>j.job==='crm');
  expect(job.lastComplete).not.toBeNull();expect(new Date(job.lastComplete).getTime()).toBeLessThan(new Date(job.lastFinished).getTime());
 });
 it('shows source-scoped collection health only to admins',async()=>{
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,counts,finished_at) VALUES ('conversation_sync','pipedrive:token-user:recent:sent','partial','{\"messages\":12}',NOW())");
  const admin=await readJobHealth(pool,{visibleMailboxes:[],admin:true});
  expect(admin.jobs.find(j=>j.scope==='pipedrive:token-user:recent:sent')).toMatchObject({job:'conversation_sync',state:'partial',counts:{messages:12}});
  const staff=await readJobHealth(pool,{visibleMailboxes:['rep@example.test'],admin:false});
  expect(JSON.stringify(staff)).not.toContain('token-user');
 });
 it('withholds global counts from reps and never returns another mailbox scope',async()=>{
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,counts,finished_at) VALUES ('crm','account','complete','{\"scanned\":7000}',NOW()),('gmail_watch','other@example.test','failed','{}',NOW())");
  const health=await readJobHealth(pool,{visibleMailboxes:['mine@example.test'],admin:false});
  expect(JSON.stringify(health)).not.toContain('7000');expect(JSON.stringify(health)).not.toContain('other@example.test');
 });
});
it('uses a bounded category rather than raw errors',()=>{expect(safeErrorCategory({status:401,message:'SECRET'})).toBe('authentication');expect(safeErrorCategory(new Error('SECRET'))).toBe('unexpected');});
