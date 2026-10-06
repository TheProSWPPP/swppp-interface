import {expect,it,vi,beforeAll,afterAll,beforeEach,describe} from 'vitest';
import {readFile} from 'node:fs/promises';
import {refreshRetryDraft} from '../sdrRetryDraftRefresh.js';
import {recordDraftApproval} from '../sdrDraftRevision.js';
import {reportingTestDb} from './reportingTestDb.js';
const id='10000000-0000-0000-0000-000000000001';
const draft={id,status:'pending',pipedrive_lead_id:'lead',trigger_type:'LBA',contact_id_snapshot:'1',contact_email_snapshot:'a@example.test',org_id_snapshot:'2',assigned_mailbox_id:'m',assigned_user_id:'u',apollo_sequence_id:'c',metadata:{project_stage:'LBA'},revision:1,subject:'Reviewed',body:'Reviewed body'};
it('does not regenerate approved copy without an exact receipt',async()=>{
 const pool={query:vi.fn().mockResolvedValueOnce({rows:[{...draft,status:'approved'}]}).mockResolvedValue({rows:[]})};const build=vi.fn();
 expect(await refreshRetryDraft(pool,id,{build})).toEqual({allowed:false,code:'approval_missing'});expect(build).not.toHaveBeenCalled();
});
it('does not adopt unknown-origin pending copy',async()=>{
 const pool={query:vi.fn().mockResolvedValueOnce({rows:[draft]}).mockResolvedValue({rows:[]})};const build=vi.fn();
 expect(await refreshRetryDraft(pool,id,{build})).toEqual({allowed:false,code:'draft_origin_unknown'});expect(build).not.toHaveBeenCalled();
});
const db=reportingTestDb('retry_refresh');
describe.skipIf(!db)('Postgres retry revision protection',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY,status text,sent_at timestamptz,updated_at timestamptz,subject text,body text,metadata jsonb,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,assigned_mailbox_id text,assigned_user_id text,apollo_sequence_id text,pipedrive_lead_id text,scheduled_for timestamptz,approved_at timestamptz,approved_by text);CREATE TABLE sdr_sends(draft_id uuid)`);await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-draft-revisions.sql',import.meta.url),'utf8'));});
 afterAll(async()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_draft_approvals,sdr_sends,sdr_drafts');await db.pool.query(`INSERT INTO sdr_drafts(id,status,metadata,contact_id_snapshot,contact_email_snapshot,org_id_snapshot,trigger_type,assigned_mailbox_id,assigned_user_id,apollo_sequence_id,pipedrive_lead_id,content_origin,subject,body) VALUES($1,'pending','{"project_stage":"LBA"}','1','a@example.test','2','LBA','m','u','c','lead','machine','Reviewed','Reviewed body')`,[id]);});
 const get=async()=>(await db.pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[id])).rows[0];
 const build=async()=>({...draft,subject:'fresh',body:'fresh'});
 it('regenerates only proven machine copy and advances its revision',async()=>{expect(await refreshRetryDraft(db.pool,id,{build})).toEqual({allowed:true});expect(await get()).toMatchObject({revision:'2',body:'fresh'});});
 it.each(['contact_email_snapshot','contact_id_snapshot','org_id_snapshot','trigger_type','assigned_mailbox_id','apollo_sequence_id'])('holds changed %s without mutation',async key=>{
  const original=await get();expect((await refreshRetryDraft(db.pool,id,{build:async()=>({...await build(),[key]:'changed'})})).allowed).toBe(false);expect(await get()).toEqual(original);
 });
 it('preserves a staff edit made while generation waits',async()=>{
  expect(await refreshRetryDraft(db.pool,id,{build:async()=>{await db.pool.query("UPDATE sdr_drafts SET body='human edit',status='edited' WHERE id=$1",[id]);return build();}})).toEqual({allowed:false,code:'draft_stale'});
  expect((await get()).body).toBe('human edit');
 });
 it.each(['pending','approved'])('retries reviewed %s copy exactly without invoking generator',async status=>{
  await db.pool.query('UPDATE sdr_drafts SET status=$2 WHERE id=$1',[id,status]);const original=await get();await recordDraftApproval(db.pool,original,{sub:'rep'});const generator=vi.fn();
  expect(await refreshRetryDraft(db.pool,id,{build:generator})).toEqual({allowed:true});expect(generator).not.toHaveBeenCalled();expect(await get()).toEqual(original);
 });
 it('does not enroll a future schedule during retry',async()=>{
  await db.pool.query("UPDATE sdr_drafts SET scheduled_for='2099-01-01' WHERE id=$1",[id]);const generator=vi.fn();
  expect(await refreshRetryDraft(db.pool,id,{build:generator})).toEqual({allowed:false,code:'scheduled_for_future'});expect(generator).not.toHaveBeenCalled();
 });
});
