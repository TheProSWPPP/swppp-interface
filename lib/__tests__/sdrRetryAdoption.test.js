import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../sdrDraftGenerator.js',()=>({buildDraftFromLead:vi.fn()}));
import {adoptPendingAutomaticDrafts,expireStaleQueuedDrafts} from '../autoOutreach.js';
import {listDueEnrollmentRetries,retryableDraftAgeDays} from '../sdrEnrollmentRetry.js';

const db=reportingTestDb('retry_adoption');
const company='13105180';
const owner='10000000-0000-0000-0000-000000000001';
const mailbox='20000000-0000-0000-0000-000000000001';
const monday=new Date('2026-10-12T15:00:00Z'); // Chicago business hours
const day=86400000;
const sql=(name)=>readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
// A pending automatic draft on a lead whose address is fresh-valid, never sequenced, not held.
async function draft(id,{ageDays=7,now=monday,origin='machine',initiatedBy='automatic',verdict='valid',verifiedDays=3,crm='active'}={}) {
  const email=`${id}@example.test`;
  await db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,person_email,crm_status,crm_company_id,email_verify_status,email_verified_at,email_verified_value)
    VALUES($1,$2,$3,$4,$5,$6,$2)`,[id,email,crm,company,verdict,new Date(now.getTime()-verifiedDays*day)]);
  const {rows}=await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,contact_email_snapshot,status,content_origin,initiated_by,assigned_user_id,assigned_mailbox_id,created_at)
    VALUES($1,$2,'pending',$3,$4,$5,$6,$7) RETURNING id`,[id,email,origin,initiatedBy,owner,mailbox,new Date(now.getTime()-ageDays*day)]);
  return rows[0].id;
}
const receipts=async()=>(await db.pool.query(`SELECT d.pipedrive_lead_id AS lead,a.status,a.category,a.attempt_count FROM sdr_enrollment_attempts a
  JOIN sdr_drafts d ON d.id=a.draft_id ORDER BY 1`)).rows;

describe.skipIf(!db)('pending automatic drafts get a retry receipt instead of silently expiring',()=>{
  beforeAll(async()=>{
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,contact_email_snapshot text,
        status text,initiated_by text,assigned_user_id uuid,assigned_mailbox_id uuid,metadata jsonb,sent_at timestamptz,created_at timestamptz DEFAULT NOW(),
        updated_at timestamptz,reject_reason text);
      CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid,pipedrive_lead_id text,status text);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,person_email text,crm_status text,crm_company_id text,
        email_verify_status text,email_verified_at timestamptz,email_verified_value text);
      CREATE TABLE sdr_inbox_reply_log(from_addr text,created_at timestamptz DEFAULT NOW());
      CREATE TABLE sdr_message_facts(provider text,direction text,prospect_email text,human_reply boolean,occurred_at timestamptz DEFAULT NOW())`);
    for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql','2026-10-03-sdr-enrollment-retry.sql','2026-10-09-sdr-approval-observations.sql'])
      await db.pool.query(await sql(file));
  });
  afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
  beforeEach(async()=>{
    vi.stubEnv('SDR_ENROLLMENT_RETRY_ENABLED','true');vi.stubEnv('SDR_CRM_COMPANY_ID',company);vi.stubEnv('SDR_CRM_LIFECYCLE_ENABLED','true');
    await db.pool.query(`TRUNCATE sdr_enrollment_attempts,sdr_approval_observations,sdr_outreach_control_decisions,sdr_outreach_controls,
      sdr_draft_approvals,sdr_sends,sdr_drafts,sdr_lead_state,sdr_inbox_reply_log,sdr_message_facts`);
  });

  it('adopts only drafts the send path would not refuse for a locally visible reason, once',async()=>{
    await draft('sendable');
    await draft('waited_for_capacity');
    await draft('customer');
    await draft('sequenced_before');
    await draft('apollo_sent_before');
    await draft('soft',{verdict:'catch_all'});
    await draft('stale_verdict',{verifiedDays:91});
    await draft('replied');
    await draft('held');
    await draft('approved');
    await draft('too_old',{ageDays:15});
    await draft('archived',{crm:'archived'});
    await draft('switch',{initiatedBy:'auto-switch',origin:'unknown'});
    await draft('unknown_origin',{origin:'unknown'});
    const id=async lead=>(await db.pool.query('SELECT id FROM sdr_drafts WHERE pipedrive_lead_id=$1',[lead])).rows[0].id;
    const observe=async(lead,code,status)=>db.pool.query(`INSERT INTO sdr_approval_observations VALUES(gen_random_uuid(),$1,$2,'machine',NOW(),$3,$4,$5,'http_refusal',1)`,
      [company,await id(lead),status,code,code==='daily_cap_reached'?'capacity':'history']);
    await observe('waited_for_capacity','daily_cap_reached',429);
    await observe('customer','existing_customer',409);
    await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,contact_email_snapshot,status,created_at) VALUES('other_project','sequenced_before@example.test','sent',NOW()-interval '40 days')`);
    await db.pool.query(`INSERT INTO sdr_sends(draft_id,pipedrive_lead_id,status) SELECT id,'other_project','sent' FROM sdr_drafts WHERE pipedrive_lead_id='other_project'`);
    await db.pool.query(`INSERT INTO sdr_message_facts(provider,direction,prospect_email) VALUES('apollo','out','APOLLO_SENT_BEFORE@example.test')`);
    await db.pool.query(`INSERT INTO sdr_message_facts(provider,direction,prospect_email,human_reply) VALUES('gmail','in','replied@example.test',true)`);
    await db.pool.query(`INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id)
      VALUES($1,'held','lead','held','email','review','h','{}','staff')`,[company]);
    await db.pool.query(`INSERT INTO sdr_draft_approvals(draft_id,revision,context_hash,subject,body,context,actor) VALUES($1,1,'h','s','b','{}','{}')`,[await id('approved')]);

    expect(await adoptPendingAutomaticDrafts(db.pool,{now:monday})).toEqual({adopted:2});
    expect(await receipts()).toEqual([
      {lead:'sendable',status:'pending',category:'adopted',attempt_count:0},
      {lead:'waited_for_capacity',status:'pending',category:'adopted',attempt_count:0},
    ]);
    expect(await adoptPendingAutomaticDrafts(db.pool,{now:monday})).toEqual({adopted:0});
    // The existing claim path now picks them up, in business hours, with a lease.
    const claimed=await listDueEnrollmentRetries(db.pool,{now:monday,limit:25});
    expect(claimed.map(row=>row.status)).toEqual(['running','running']);
    expect(claimed.every(row=>row.lease_token&&row.origin==='auto')).toBe(true);
  });

  it('does nothing while enrollment retry is off',async()=>{
    vi.stubEnv('SDR_ENROLLMENT_RETRY_ENABLED','false');
    await draft('sendable');
    expect(await adoptPendingAutomaticDrafts(db.pool,{now:monday})).toMatchObject({skipped:'disabled',adopted:0});
    expect(await receipts()).toEqual([]);
  });

  it('keeps a draft with a scheduled retry until the send gate would refuse its age',async()=>{
    const now=new Date();
    const scheduled=await draft('scheduled',{ageDays:14.5,now});
    const unscheduled=await draft('unscheduled',{ageDays:14.5,now});
    const tooOld=await draft('too_old',{ageDays:15.2,now});
    for(const id of [scheduled,tooOld])await db.pool.query(`INSERT INTO sdr_enrollment_attempts(draft_id,origin,status,category,attempt_count,first_attempt_at,last_attempt_at,next_retry_at)
      VALUES($1,'auto','pending','capacity',1,NOW(),NOW(),NOW()+interval '1 hour')`,[id]);
    expect(await expireStaleQueuedDrafts(db.pool,{companyId:company})).toBe(2);
    const status=async id=>(await db.pool.query('SELECT status FROM sdr_drafts WHERE id=$1',[id])).rows[0].status;
    expect([await status(scheduled),await status(unscheduled),await status(tooOld)]).toEqual(['pending','rejected','rejected']);
    // With retry off, expiry behaves as before.
    vi.stubEnv('SDR_ENROLLMENT_RETRY_ENABLED','false');
    expect(await expireStaleQueuedDrafts(db.pool,{companyId:company})).toBe(1);
  });

  it('claims a retry while the send gate still accepts the draft age, not after',async()=>{
    expect(retryableDraftAgeDays()).toBe(15);
    const young=await draft('young',{ageDays:14.5});
    const old=await draft('old',{ageDays:15});
    for(const id of [young,old])await db.pool.query(`INSERT INTO sdr_enrollment_attempts(draft_id,origin,status,category,attempt_count,first_attempt_at,last_attempt_at,next_retry_at)
      VALUES($1,'auto','pending','capacity',1,$2,$2,$2)`,[id,monday]);
    const claimed=await listDueEnrollmentRetries(db.pool,{now:monday});
    expect(claimed.map(row=>row.draft_id)).toEqual([young]);
    expect(await receipts()).toEqual([
      {lead:'old',status:'review',category:'draft_expired',attempt_count:1},
      {lead:'young',status:'running',category:'capacity',attempt_count:1},
    ]);
  });
});
