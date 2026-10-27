import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../emailVerify.js',async original=>({...await original(),verifyEnabled:()=>true,remainingCredits:async()=>1000,
  verifyEmail:vi.fn(async()=>({ok:true,status:'valid'}))}));
import {verifyEmail} from '../emailVerify.js';
import {runVerificationPass,FAILED_DRAFT_BACKOFF_DAYS as VERIFY_BACKOFF} from '../emailVerifyRefresh.js';
import {FAILED_DRAFT_BACKOFF_DAYS as SELECT_BACKOFF} from '../autoOutreach.js';

const db=reportingTestDb('verify_pass_candidates');
// Columns default to a lead the automatic selector could pick once its address verifies.
const lead=(id,over={})=>{
  const row={outreach_status:'clear',last_outgoing_mail_time:null,crm_status:'active',crm_company_id:'42',trigger_type:'LBA',
    start_date_offset:5,lead_score:10,email_verify_status:null,email_verified_days:null,...over};
  return db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,pipedrive_org_id,person_email,outreach_status,
    last_outgoing_mail_time,crm_status,crm_company_id,trigger_type,start_date,lead_score,email_verify_status,email_verified_at,email_verified_value)
    VALUES($1,'p','o',$2,$3,$4,$5,$6,$7,CURRENT_DATE+$8::int,$9,$10,CASE WHEN $11::int IS NULL THEN NULL ELSE NOW()-make_interval(days=>$11::int) END,
      CASE WHEN $11::int IS NULL THEN NULL ELSE $2 END)`,
  [id,`${id}@example.test`,row.outreach_status,row.last_outgoing_mail_time,row.crm_status,row.crm_company_id,row.trigger_type,
    row.start_date_offset,row.lead_score,row.email_verify_status,row.email_verified_days]);
};
const verified=()=>verifyEmail.mock.calls.map(([email])=>email.split('@')[0]).sort();

describe.skipIf(!db)('verification pass spends credits only on leads the selector could pick',()=>{
  beforeAll(async()=>{
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_settings(id int,auto_min_score float8,recontact_after_days int,start_date_grace_days int);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,
        outreach_status text,last_outgoing_mail_time timestamptz,crm_status text,crm_company_id text,trigger_type text,start_date date,
        lead_score float8,email_verify_status text,email_verified_at timestamptz,email_verified_value text,resolved_email text,email_flag text,
        email_soft_rechecked_at timestamptz,lead_origin text);
      CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,status text,created_at timestamptz DEFAULT NOW(),
        reject_reason text,content_origin text,initiated_by text,contact_email_snapshot text,contact_id_snapshot text);
      CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,draft_id uuid,status text,step_status text,
        apollo_emailer_message_id text,apollo_contact_id text,apollo_sequence_id text,enrolled_person_id text);
      CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,sent_at timestamptz,source text);
      CREATE TABLE sdr_inbox_reply_log(from_addr text,created_at timestamptz DEFAULT NOW());
      CREATE TABLE sdr_engagement_events(pipedrive_lead_id text,event_type text);
      CREATE TABLE sdr_reply_messages(pipedrive_lead_id text,reply_kind text);
      CREATE TABLE sdr_draft_approvals(draft_id uuid,actor jsonb);
      CREATE TABLE sdr_message_facts(provider text DEFAULT 'apollo',direction text,prospect_email text,human_reply boolean,occurred_at timestamptz)`);
  });
  afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
  beforeEach(async()=>{
    vi.stubEnv('SDR_CRM_COMPANY_ID','42');vi.stubEnv('SDR_CRM_LIFECYCLE_ENABLED','true');
    verifyEmail.mockReset().mockResolvedValue({ok:true,status:'valid'});
    await db.pool.query('TRUNCATE sdr_settings,sdr_lead_state,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_inbox_reply_log,sdr_message_facts,sdr_engagement_events,sdr_reply_messages');
    await db.pool.query('INSERT INTO sdr_settings VALUES(1,NULL,30,30)');
  });

  it('skips leads the selector can never pick and includes contacted_stale leads past the recontact window',async()=>{
    await lead('eligible');
    await lead('stale_past_window',{outreach_status:'contacted_stale',last_outgoing_mail_time:new Date(Date.now()-40*86400000)});
    await lead('stale_in_window',{outreach_status:'contacted_stale',last_outgoing_mail_time:new Date(Date.now()-10*86400000)});
    await lead('recent',{outreach_status:'contacted_recent'});
    await lead('archived',{crm_status:'archived'});
    await lead('other_company',{crm_company_id:'99'});
    await lead('started_long_ago',{start_date_offset:-31});
    await lead('within_grace',{start_date_offset:-29});
    await lead('no_trigger',{trigger_type:null});
    await lead('rejected');await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status) VALUES('rejected','rejected')");
    await lead('pending');await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status) VALUES('pending','pending')");
    await lead('failed_recent');await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status,created_at) VALUES('failed_recent','failed',NOW()-interval '20 days')");
    await lead('failed_old');await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status,created_at) VALUES('failed_old','failed',NOW()-interval '31 days')");
    await lead('sent');await db.pool.query("INSERT INTO sdr_sends(pipedrive_lead_id) VALUES('sent')");
    await lead('logged');await db.pool.query("INSERT INTO sdr_outreach_log VALUES('logged',NOW()-interval '5 days','pipedrive')");
    await lead('replied');await db.pool.query("INSERT INTO sdr_message_facts(direction,prospect_email,human_reply,occurred_at) VALUES('in','replied@example.test',true,NOW())");
    await lead('fresh_verdict',{email_verify_status:'valid',email_verified_days:10});
    await lead('stale_verdict',{email_verify_status:'valid',email_verified_days:120});
    await runVerificationPass(db.pool,{limit:100});
    expect(verified()).toEqual(['eligible','failed_old','stale_past_window','stale_verdict','within_grace']);
  });

  // 2026-10-27: 160 Oct-import leads had never been verified and 234 sat on a catch-all/unknown
  // verdict. The pass skipped every lead with a send row or a rejected draft, so leads whose only
  // history was a send that never delivered or a draft that only aged out (both pickable since
  // PR #112) never got a verdict, and a soft verdict was never asked again for 90 days.
  it('verifies leads whose only history is an undelivered send or an aged-out draft, like the selector',async()=>{
    await lead('removed');
    const d=(await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status,contact_email_snapshot,content_origin,initiated_by) VALUES('removed','sent','removed@example.test','machine','automatic') RETURNING id")).rows[0];
    await db.pool.query("INSERT INTO sdr_sends(pipedrive_lead_id,draft_id,status,apollo_contact_id,apollo_sequence_id) VALUES('removed',$1,'failed','c1','seq')",[d.id]);
    await lead('aged_out');await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,status,reject_reason,content_origin,initiated_by) VALUES('aged_out','rejected','auto: expired unapproved after 14 days','machine','automatic')`);
    await lead('delivered');
    const e=(await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status,contact_email_snapshot) VALUES('delivered','sent','delivered@example.test') RETURNING id")).rows[0];
    await db.pool.query("INSERT INTO sdr_sends(pipedrive_lead_id,draft_id,status) VALUES('delivered',$1,'failed')",[e.id]);
    await db.pool.query("INSERT INTO sdr_message_facts(direction,prospect_email) VALUES('out','delivered@example.test')");
    await lead('bid',{});await db.pool.query("UPDATE sdr_lead_state SET lead_origin='Bid Invite: BuildingConnected' WHERE pipedrive_lead_id='bid'");
    await runVerificationPass(db.pool,{limit:100});
    expect(verified()).toEqual(['aged_out','removed']);
  });

  it('rechecks a soft verdict once after a week; automation still needs a valid verdict',async()=>{
    verifyEmail.mockResolvedValue({ok:true,status:'valid'});
    await lead('soft_old',{email_verify_status:'soft',email_verified_days:10});
    await lead('catchall_raw',{email_verify_status:'catchall',email_verified_days:20});
    await lead('soft_young',{email_verify_status:'soft',email_verified_days:3});
    await lead('soft_done',{email_verify_status:'soft',email_verified_days:10});
    await db.pool.query("UPDATE sdr_lead_state SET email_soft_rechecked_at=email_verified_at+interval '1 minute' WHERE pipedrive_lead_id='soft_done'");
    await lead('valid_young',{email_verify_status:'valid',email_verified_days:10});
    const stats=await runVerificationPass(db.pool,{limit:100});
    expect(verified()).toEqual(['catchall_raw','soft_old']);
    expect(stats).toMatchObject({softRechecked:2,softNowValid:2});
    const rows=(await db.pool.query("SELECT pipedrive_lead_id,email_verify_status,email_soft_rechecked_at>=email_verified_at stamped FROM sdr_lead_state WHERE pipedrive_lead_id IN ('soft_old','catchall_raw') ORDER BY 1")).rows;
    expect(rows).toEqual([{pipedrive_lead_id:'catchall_raw',email_verify_status:'valid',stamped:true},{pipedrive_lead_id:'soft_old',email_verify_status:'valid',stamped:true}]);
    // A second pass does not ask again.
    verifyEmail.mockClear();
    await db.pool.query("UPDATE sdr_lead_state SET email_verify_status='soft',email_verified_at=NOW()-interval '10 days',email_soft_rechecked_at=NOW()-interval '1 day' WHERE pipedrive_lead_id='soft_old'");
    await runVerificationPass(db.pool,{limit:100});
    expect(verified()).toEqual([]);
  });

  it('keeps the cached verdict when the verifier gives no answer, so a soft address never turns valid by default',async()=>{
    verifyEmail.mockResolvedValue({ok:true,skipped:true});
    await lead('soft_old',{email_verify_status:'soft',email_verified_days:10});
    await lead('never');
    const stats=await runVerificationPass(db.pool,{limit:100});
    expect(stats).toMatchObject({checked:2,noVerdict:2,verified:0,softRechecked:0});
    const rows=(await db.pool.query("SELECT pipedrive_lead_id,email_verify_status,email_soft_rechecked_at FROM sdr_lead_state ORDER BY 1")).rows;
    expect(rows).toEqual([{pipedrive_lead_id:'never',email_verify_status:null,email_soft_rechecked_at:null},{pipedrive_lead_id:'soft_old',email_verify_status:'soft',email_soft_rechecked_at:null}]);
  });

  it('applies the limit after the eligibility filter, so the limit is spent on real candidates',async()=>{
    for(let i=0;i<5;i++)await lead(`dead${i}`,{crm_status:'missing'});
    await lead('live');
    await runVerificationPass(db.pool,{limit:1});
    expect(verified()).toEqual(['live']);
  });

  it('spends nothing without a verified company scope, and keeps the backoff in step with selection',async()=>{
    vi.stubEnv('SDR_CRM_COMPANY_ID','');
    await lead('eligible');
    await runVerificationPass(db.pool,{limit:10});
    expect(verified()).toEqual([]);
    expect(VERIFY_BACKOFF).toBe(SELECT_BACKOFF);
  });
});
