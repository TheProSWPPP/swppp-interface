import {describe,it,expect,beforeAll,afterAll,beforeEach} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {checkViewedDraft,draftContextHash,mutateViewedDraft,refreshViewedDraft,recordDraftApproval,checkApprovedDraft,checkDraftSchedule} from '../sdrDraftRevision.js';
const id='10000000-0000-0000-0000-000000000001';
const seed={id,revision:5,status:'pending',subject:'Reviewed',body:'Original copy',pipedrive_lead_id:'lead',contact_id_snapshot:'1',contact_email_snapshot:'a@example.test',assigned_mailbox_id:'sender',apollo_sequence_id:'sequence',metadata:{project_stage:'Bid',cadence:'award_only'}};
const viewed=d=>({expectedRevision:d.revision,expectedContextHash:draftContextHash(d)});
it('rejects missing and stale viewed revisions before approval',()=>{
 expect(checkViewedDraft({draft:seed})).toMatchObject({allowed:false});
 expect(checkViewedDraft({draft:{...seed,revision:6},...viewed(seed)})).toMatchObject({allowed:false});
 expect(checkViewedDraft({draft:seed,...viewed(seed)})).toEqual({allowed:true});
});
it.each(['contact_email_snapshot','assigned_mailbox_id','apollo_sequence_id','scheduled_for'])('rejects changed %s even if revision was reused',key=>{
 const value=key==='scheduled_for'?'2026-12-01T00:00:00Z':'changed';
 expect(checkViewedDraft({draft:{...seed,[key]:value},...viewed(seed)}).allowed).toBe(false);
});
it('blocks future schedules irrespective of generic override',()=>{
 expect(checkDraftSchedule({...seed,scheduled_for:'2099-01-01T00:00:00Z'},{override:true})).toMatchObject({allowed:false,code:'scheduled_for_future'});
});
const db=reportingTestDb('draft_revision');
describe.skipIf(!db)('revision commit races',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY,pipedrive_lead_id text,status text,sent_at timestamptz,subject text,body text,updated_at timestamptz,metadata jsonb,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,pipedrive_contact_id text,pipedrive_org_id text,assigned_mailbox_id text,assigned_user_id text,apollo_sequence_id text,trigger_type text,scheduled_for timestamptz,approved_at timestamptz,approved_by text,reject_reason text);CREATE TABLE sdr_sends(draft_id uuid)`);
  await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-draft-revisions.sql',import.meta.url),'utf8'));
 });
 afterAll(async()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_draft_approvals,sdr_sends,sdr_drafts');await db.pool.query(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,status,subject,body,metadata) VALUES($1,'lead','pending','Reviewed','Original copy','{}')`,[id]);});
 const get=async()=>(await db.pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[id])).rows[0];
 it.each(['edit','reject','send','reassign'])('preserves %s during a deferred remote refresh',async change=>{
  const original=await get();let release,started;
  const ready=new Promise(r=>{started=r});const wait=new Promise(r=>{release=r});
  const refreshing=refreshViewedDraft(db.pool,{draft:original,...viewed(original),build:async()=>{started();await wait;return {...original,subject:'Generated',body:'Generated'};}});
  await ready;
  if(change==='send') {await db.pool.query("UPDATE sdr_drafts SET status='sent',sent_at=NOW() WHERE id=$1",[id]);await db.pool.query('INSERT INTO sdr_sends VALUES($1)',[id]);}
  else await mutateViewedDraft(db.pool,{draft:original,...viewed(original),fields:change==='reject'?{status:'rejected'}:change==='reassign'?{assigned_user_id:'other',status:'edited'}:{body:'New staff copy',status:'edited'}});
  const newer=await get();release();
  await expect(refreshing).rejects.toMatchObject({status:409});
  expect(await get()).toEqual(newer);
 });
 it('rejects two-user saves against one revision',async()=>{
  const original=await get();
  const results=await Promise.allSettled(['one','two'].map(body=>mutateViewedDraft(db.pool,{draft:original,...viewed(original),fields:{body,status:'edited'}})));
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect((await get()).revision).toBe('2');
 });
 it('keeps an exact approval receipt and invalidates it after a new edit',async()=>{
  const original=await get();await recordDraftApproval(db.pool,original,{sub:'rep',machine:false});
  expect(await checkApprovedDraft(db.pool,original)).toEqual({allowed:true});
  await mutateViewedDraft(db.pool,{draft:original,...viewed(original),fields:{body:'New',status:'edited'}});
  expect((await checkApprovedDraft(db.pool,await get())).allowed).toBe(false);
  const receipt=(await db.pool.query('SELECT * FROM sdr_draft_approvals')).rows[0];expect(receipt.body).toBe('Original copy');
 });
 it('enforces sent artifact immutability at the database boundary',async()=>{
  await db.pool.query("UPDATE sdr_drafts SET status='sent',sent_at=NOW() WHERE id=$1",[id]);const sent=await get();
  await expect(db.pool.query("UPDATE sdr_drafts SET body='overwrite' WHERE id=$1",[id])).rejects.toThrow();
  expect(await get()).toEqual(sent);
 });
});
it.each(['sender_email','sender_provider_id'])('invalidates a viewed approval when sender identity %s changes in place',key=>{
 const original={...seed,metadata:{...seed.metadata,sender_email:'sender@example.test',sender_provider_id:'mailbox-provider'}};
 const changed={...original,metadata:{...original.metadata,[key]:'other'}};
 expect(checkViewedDraft({draft:changed,...viewed(original)})).toEqual({allowed:false,code:'draft_stale'});
});
