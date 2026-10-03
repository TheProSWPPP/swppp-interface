import {expect,it,vi} from 'vitest';
import {refreshRetryDraft} from '../sdrRetryDraftRefresh.js';
import {beforeAll,afterAll,describe} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
const draft={id:'d',status:'pending',pipedrive_lead_id:'lead',trigger_type:'LBA',contact_id_snapshot:1,contact_email_snapshot:'a@example.test',org_id_snapshot:2,assigned_mailbox_id:'m',assigned_user_id:'u',apollo_sequence_id:'c',metadata:{project_stage:'LBA'},updated_at:new Date()};
function fixtures(change={}) { const row={...draft,...change};const query=vi.fn().mockResolvedValueOnce({rows:[row]}).mockResolvedValue({rowCount:1});const build=vi.fn().mockResolvedValue({...draft,subject:'Fresh subject',body:'Fresh copy'});return {pool:{query},build}; }
it('rebuilds unchanged automatic copy against current project state with a conditional write',async()=>{const f=fixtures();expect(await refreshRetryDraft(f.pool,'d',{build:f.build})).toEqual({allowed:true});expect(f.build.mock.calls[0][0].triggerType).toBeUndefined();expect(f.pool.query.mock.calls[1][1]).toContain('Fresh copy');expect(f.pool.query.mock.calls[1][0]).toContain('updated_at=$5');});
it.each(['contact_email_snapshot','contact_id_snapshot','org_id_snapshot','trigger_type','assigned_mailbox_id'])('holds changed %s for review without updating/sending',async(key)=>{const f=fixtures();f.build.mockResolvedValue({...draft,[key]:'changed'});expect((await refreshRetryDraft(f.pool,'d',{build:f.build})).allowed).toBe(false);expect(f.pool.query).toHaveBeenCalledTimes(1);});
it('retains human edits and completed sends',async()=>{for(const change of [{status:'edited'},{sent_at:new Date()}]) {const f=fixtures(change);expect((await refreshRetryDraft(f.pool,'d',{build:f.build})).allowed).toBe(false);expect(f.build).not.toHaveBeenCalled();}});
it('holds stage changes and concurrent edits for review',async()=>{const f=fixtures();f.build.mockResolvedValue({...draft,metadata:{project_stage:'AGC'}});expect((await refreshRetryDraft(f.pool,'d',{build:f.build})).allowed).toBe(false);const g=fixtures();g.pool.query.mockResolvedValueOnce({rowCount:0});expect((await refreshRetryDraft(g.pool,'d',{build:g.build})).allowed).toBe(false);});
const db=reportingTestDb('retry_refresh');
describe.skipIf(!db)('Postgres refresh version guard',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_drafts(id text PRIMARY KEY,status text,sent_at timestamptz,updated_at timestamptz,subject text,body text,metadata jsonb,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,assigned_mailbox_id text,assigned_user_id text,apollo_sequence_id text,pipedrive_lead_id text);CREATE TABLE sdr_sends(draft_id text)`);});
 afterAll(async()=>db.close());
 it('accepts unchanged microsecond precision versions and rejects a later edit',async()=>{
  await db.pool.query(`INSERT INTO sdr_drafts(id,status,updated_at,metadata,contact_id_snapshot,contact_email_snapshot,org_id_snapshot,trigger_type,assigned_mailbox_id) VALUES('d','pending','2026-10-03T01:00:00.123456Z','{"project_stage":"LBA"}','1','a@example.test','2','LBA','m')`);
  const build=async()=>({...draft,subject:'fresh',body:'fresh'});
  expect(await refreshRetryDraft(db.pool,'d',{build})).toEqual({allowed:true});
  const editDuringBuild=async()=>{await db.pool.query("UPDATE sdr_drafts SET updated_at=NOW(),body='human edit' WHERE id='d'");return build();};
  expect(await refreshRetryDraft(db.pool,'d',{build:editDuringBuild})).toEqual({allowed:false,code:'draft_stale'});
  expect((await db.pool.query("SELECT body FROM sdr_drafts WHERE id='d'")).rows[0].body).toBe('human edit');
 });
});
