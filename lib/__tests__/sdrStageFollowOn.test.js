import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {followOnFacts,followOnPermit,finishedMembershipOnly,followOnSequence,FINISHED_REASON} from '../sdrFollowOnPermit.js';
import {runStageFollowOn,stageFollowOnOnly,stageFollowOnLimit} from '../sdrStageFollowOn.js';
import {reserveEnrollment} from '../sdrProviderOperations.js';
import {setOutreachControl} from '../sdrOutreachControls.js';

const MB='20000000-0000-0000-0000-000000000001',USER='30000000-0000-0000-0000-000000000001';
const D0='10000000-0000-0000-0000-000000000001',S0='40000000-0000-0000-0000-000000000001';
const ENV=['SDR_STAGE_FOLLOW_ON','SDR_STAGE_FOLLOW_ON_LIMIT','SDR_STAGE_FOLLOW_ON_ONLY','APOLLO_SEQ_AGC','APOLLO_SEQ_LBA','APOLLO_SEQ_AGC_AWARD_ONLY','SDR_DAILY_CAP'];
const saved={};
beforeEach(()=>{for(const key of ENV)saved[key]=process.env[key];
  Object.assign(process.env,{SDR_STAGE_FOLLOW_ON:'on',APOLLO_SEQ_AGC:'seq-agc',APOLLO_SEQ_LBA:'seq-lba',APOLLO_SEQ_AGC_AWARD_ONLY:'seq-award'});
  delete process.env.SDR_STAGE_FOLLOW_ON_LIMIT;delete process.env.SDR_STAGE_FOLLOW_ON_ONLY;delete process.env.SDR_DAILY_CAP;});
afterEach(()=>{for(const key of ENV){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});

const finished=(over={})=>({id:'c1',contact_campaign_statuses:[{emailer_campaign_id:'seq-lba',status:'finished',inactive_reason:FINISHED_REASON,...over}]});

describe('follow-on helpers',()=>{
  it('reads the canary allowlist strictly: unset is everyone, a set value with no usable id is nobody',()=>{
    expect(stageFollowOnOnly(undefined)).toBeNull();expect(stageFollowOnOnly('  ')).toBeNull();
    expect(stageFollowOnOnly('not-an-id')).toEqual([]);
    expect(stageFollowOnOnly(` ${S0.toUpperCase()} , junk`)).toEqual([S0]);
  });
  it('caps the per-pass limit and falls back to 3',()=>{
    expect(stageFollowOnLimit()).toBe(3);
    process.env.SDR_STAGE_FOLLOW_ON_LIMIT='0';expect(stageFollowOnLimit()).toBe(0);
    process.env.SDR_STAGE_FOLLOW_ON_LIMIT='900';expect(stageFollowOnLimit()).toBe(25);
    process.env.SDR_STAGE_FOLLOW_ON_LIMIT='-1';expect(stageFollowOnLimit()).toBe(3);
  });
  it('accepts only one membership, in the earlier sequence, finished at its last step',()=>{
    const at={contactId:'c1',campaignId:'seq-lba'};
    expect(finishedMembershipOnly(finished(),at)).toBe(true);
    expect(finishedMembershipOnly(finished({status:'active'}),at)).toBe(false);
    expect(finishedMembershipOnly(finished({inactive_reason:'replied'}),at)).toBe(false);
    expect(finishedMembershipOnly(finished({emailer_campaign_id:'other'}),at)).toBe(false);
    expect(finishedMembershipOnly({id:'c1',contact_campaign_statuses:[...finished().contact_campaign_statuses,{emailer_campaign_id:'x',status:'finished',inactive_reason:FINISHED_REASON}]},at)).toBe(false);
    expect(finishedMembershipOnly({id:'c2',contact_campaign_statuses:finished().contact_campaign_statuses},at)).toBe(false);
    expect(finishedMembershipOnly({id:'c1'},at)).toBe(false);
  });
  it('maps a hop to its sequence and nothing else',()=>{
    expect(followOnSequence('LBA>AGC')).toBe('seq-award');expect(followOnSequence('PB>AGC')).toBe('seq-agc');
    expect(followOnSequence('PB>LBA')).toBe('seq-lba');expect(followOnSequence('AGC>LBA')).toBeNull();expect(followOnSequence('LBA>CM')).toBeNull();
  });
});

const db=reportingTestDb('stage_follow_on');
describe.skipIf(!db)('stage follow-on in Postgres',()=>{
  const q=(sql,params)=>db.pool.query(sql,params);
  beforeAll(async()=>{
    await db.setup();
    await q(`CREATE TABLE sdr_settings(id int PRIMARY KEY,contact_cooldown_days int,start_date_grace_days int,auto_outreach_enabled boolean,auto_outreach_mode text,auto_min_score int);
      CREATE TABLE sdr_mailboxes(id uuid PRIMARY KEY,email text,owner_user_id uuid,apollo_mailbox_id text,active boolean,warmup_started_at timestamptz,daily_send_limit int);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,trigger_type text,trigger_override text,
        crm_status text,crm_company_id text,lead_origin text,lead_score int,start_date date,last_outgoing_mail_time timestamptz,email_verify_status text,email_verified_at timestamptz,
        email_verified_value text,project_stage text,outreach_status text);
      CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,
        contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,subject text,body text,assigned_mailbox_id uuid,assigned_user_id uuid,initiated_by text,
        metadata jsonb DEFAULT '{}',content_origin text,status text NOT NULL DEFAULT 'pending',revision bigint DEFAULT 1,sent_at timestamptz,error_message text,reject_reason text,
        scheduled_for timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX uq_sdr_drafts_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
      CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,apollo_emailer_message_id text,
        mailbox_id uuid,sent_at timestamptz,status text,step_status text,enrolled_trigger text,enrolled_person_id text,enrolled_org_id text);
      CREATE TABLE sdr_message_facts(provider text,direction text,provider_status text,prospect_email text,occurred_at timestamptz,human_reply boolean);
      CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz);
      CREATE TABLE sdr_reply_messages(provider_message_id text,pipedrive_lead_id text,from_email text,received_at timestamptz,reply_kind text,source text);
      CREATE TABLE sdr_reply_actions(provider_message_id text,kind text,status text,external_id text);
      CREATE TABLE sdr_engagement_events(pipedrive_lead_id text,event_type text,occurred_at timestamptz);
      CREATE TABLE permit_sends(id text,apollo_contact_id text);
      INSERT INTO sdr_settings VALUES(1,14,30,TRUE,'send',NULL)`);
    for(const file of ['2026-10-07-sdr-provider-operations.sql','2026-10-10-sdr-enrollment-phases.sql','2026-10-07-sdr-outreach-controls.sql','2026-10-07-sdr-policy-rollout.sql'])
      await q(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  });
  afterAll(()=>db.close());

  // One clean LBA -> AGC candidate: emailed 21 days ago, last drip step 20 days ago, sequence
  // finished by itself, same person, company and address, project now awarded.
  const seed=async({lead='lead-1',person='11',org='22',email='a@example.test',contact='c1',from='LBA',to='AGC',draft=D0,send=S0,sendAgo=21,factAgo=20}={})=>{
    await q(`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,pipedrive_org_id,person_email,trigger_type,crm_status,crm_company_id,lead_score,start_date,
        email_verify_status,email_verified_at,email_verified_value,project_stage,outreach_status)
      VALUES($1,$2,$3,$4,$5,'active','42',80,CURRENT_DATE+10,'valid',now()-interval '2 days',$4,'Awarded','sequenced')`,[lead,person,org,email,to]);
    await q(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,contact_id_snapshot,contact_email_snapshot,org_id_snapshot,trigger_type,apollo_sequence_id,assigned_mailbox_id,assigned_user_id,
        initiated_by,content_origin,status,sent_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'automatic','machine','sent',now()-make_interval(days=>$10),now()-make_interval(days=>$10))`,
    [draft,lead,person,email,org,from,`seq-${from.toLowerCase()}`,MB,USER,sendAgo]);
    await q(`INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,mailbox_id,sent_at,status,step_status,enrolled_trigger,enrolled_person_id,enrolled_org_id)
      VALUES($1,$2,$3,$4,$5,$6,now()-make_interval(days=>$7),'enrolled','completed',$8,$9,$10)`,[send,draft,lead,`seq-${from.toLowerCase()}`,contact,MB,sendAgo,from,person,org]);
    await q(`INSERT INTO sdr_provider_operations(id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,state,reason,receipt) VALUES
        (gen_random_uuid(),$1,'enroll',$3,$4,$5,jsonb_build_object('draftId',$6::text),$1,'confirmed',NULL,NULL),
        (gen_random_uuid(),$2,'stop',$3,$4,$5,'{}',$2,'confirmed','membership_finished',$7::jsonb)`,
    [`enroll:${send}`,`auto-switch:${send}`,contact,`seq-${from.toLowerCase()}`,lead,draft,JSON.stringify({membershipStatus:'finished',inactiveReason:FINISHED_REASON})]);
    if(factAgo!=null)await q(`INSERT INTO sdr_message_facts VALUES('apollo','out','completed',$1,now()-make_interval(days=>$2),NULL)`,[email,factAgo]);
    await q(`INSERT INTO sdr_outreach_log VALUES($1,'interface',now()-make_interval(days=>$2))`,[lead,sendAgo]);
  };
  beforeEach(async()=>{
    await q('TRUNCATE sdr_policy_decisions,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_provider_membership_observations,sdr_provider_operations,sdr_sends,sdr_drafts,sdr_lead_state,sdr_message_facts,sdr_outreach_log,sdr_reply_messages,sdr_mailboxes,sdr_engagement_events,permit_sends CASCADE');
    await q(`UPDATE sdr_settings SET contact_cooldown_days=14,start_date_grace_days=30,auto_outreach_enabled=TRUE,auto_outreach_mode='send',auto_min_score=NULL`);
    await q(`INSERT INTO sdr_mailboxes VALUES($1,'sender@example.test',$2,'apollo-mb',TRUE,now()-interval '200 days',30)`,[MB,USER]);
    await seed();
  });
  const facts=(over={})=>followOnFacts(db.pool,{priorSendId:S0,companyId:'42',lifecycleEnabled:true,...over});

  describe('the facts a follow-on rests on',()=>{
    it('accepts the clean shape and names the award-only sequence for LBA to AGC',async()=>{
      const got=await facts();
      expect(got).toMatchObject({ok:true,hop:'LBA>AGC',cadence:'award_only',target:'AGC',sequenceId:'seq-award',otherOps:[],
        prior:{sendId:S0,leadId:'lead-1',draftId:D0,campaignId:'seq-lba',contactId:'c1',mailboxId:MB,personId:'11',orgId:'22',email:'a@example.test'}});
      expect(got.operationIds).toHaveLength(2);
      expect(Math.round((Date.now()-+got.lastEmailAt)/86400000)).toBe(20);
    });
    it.each([
      ['a sequence still running',`UPDATE sdr_sends SET step_status='active'`,'prior_sequence_not_finished'],
      ['a send that failed',`UPDATE sdr_sends SET status='failed'`,'prior_sequence_not_finished'],
      ['a hop that is not on the list',`UPDATE sdr_lead_state SET trigger_type='CM'`,'hop_not_allowed'],
      ['a backwards hop',`UPDATE sdr_sends SET enrolled_trigger='AGC';UPDATE sdr_lead_state SET trigger_type='LBA'`,'hop_not_allowed'],
      ['a stage set by hand',`UPDATE sdr_lead_state SET trigger_override='AGC'`,'trigger_override_set'],
      ['a different person on the lead',`UPDATE sdr_lead_state SET pipedrive_person_id='99'`,'person_changed'],
      ['a different company on the lead',`UPDATE sdr_lead_state SET pipedrive_org_id='99'`,'company_changed'],
      ['a changed address',`UPDATE sdr_lead_state SET person_email='b@example.test'`,'address_changed'],
      ['an archived lead',`UPDATE sdr_lead_state SET crm_status='archived'`,'crm_not_active'],
      ['another company',`UPDATE sdr_lead_state SET crm_company_id='7'`,'other_company'],
      ['a bid-sheet lead',`UPDATE sdr_lead_state SET lead_origin='Bid Invite: PlanHub'`,'bid_invite_warm_lead'],
      ['a second send to the contact on another lead',`INSERT INTO sdr_sends(pipedrive_lead_id,apollo_contact_id,status) VALUES('lead-9','c1','enrolled')`,'other_send_exists'],
      ['a second send to the person',`INSERT INTO sdr_sends(pipedrive_lead_id,apollo_contact_id,enrolled_person_id,status) VALUES('lead-9','c9','11','failed')`,'other_send_exists'],
      ['a permit-lane send to the contact',`INSERT INTO permit_sends VALUES('p1','c1')`,'permit_send_exists'],
      ['another open draft on the lead',`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status) VALUES('lead-1','AGC','pending')`,'other_draft_on_lead'],
      ['a draft a rep rejected',`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,reject_reason) VALUES('lead-1','AGC','rejected','not this one')`,'other_draft_on_lead'],
      ['a membership that ended on a reply',`UPDATE sdr_provider_operations SET receipt=jsonb_set(receipt,'{inactiveReason}','"replied"') WHERE kind='stop'`,'finish_receipt_missing'],
      ['a stop that is not the finished inspection',`UPDATE sdr_provider_operations SET action_id='reply-stop:1' WHERE kind='stop'`,'finish_receipt_missing'],
      ['no enrollment receipt for that draft',`UPDATE sdr_provider_operations SET expected_membership='{}' WHERE kind='enroll'`,'enroll_receipt_missing'],
      ['an unresolved enrollment',`UPDATE sdr_provider_operations SET state='unresolved' WHERE kind='enroll'`,'enroll_receipt_missing'],
      ['a last email older than 30 days',`UPDATE sdr_sends SET sent_at=now()-interval '45 days';UPDATE sdr_message_facts SET occurred_at=now()-interval '31 days'`,'last_email_too_old'],
      ['a hand email logged from Pipedrive after our send',`INSERT INTO sdr_outreach_log VALUES('lead-1','pipedrive',now()-interval '3 days')`,'hand_email_after_send'],
      ['a Pipedrive mail time after our send',`UPDATE sdr_lead_state SET last_outgoing_mail_time=now()-interval '3 days'`,'hand_email_after_send'],
      ['a hand email to the person through another lead',`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,last_outgoing_mail_time) VALUES('lead-2','11',now()-interval '3 days')`,'hand_email_after_send'],
      ['a reply on record',`INSERT INTO sdr_reply_messages(provider_message_id,pipedrive_lead_id,received_at) VALUES('m1','lead-1',now())`,'reply_on_record'],
    ])('refuses %s',async(_,sql,reason)=>{await q(sql);expect(await facts()).toEqual({ok:false,reason});});
    it('allows an earlier draft that failed or aged out before the send, and counts the ledger for the cooldown only',async()=>{
      await q(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,created_at) VALUES('lead-1','LBA','failed',now()-interval '40 days')`);
      await q(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,reject_reason,created_at) VALUES('lead-1','LBA','rejected','auto: expired unapproved after 14 days',now()-interval '40 days')`);
      await q(`INSERT INTO sdr_outreach_log VALUES('lead-1','interface',now()-interval '6 days')`);
      const got=await facts();
      expect(got.ok).toBe(true);
      expect(Math.round((Date.now()-+got.lastEmailAt)/86400000)).toBe(20);
      expect(Math.round((Date.now()-+got.lastTouchAt)/86400000)).toBe(6);
    });
    it('reports other provider operations without refusing, and refuses when it cannot read',async()=>{
      await q(`INSERT INTO sdr_provider_operations(id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,state) VALUES(gen_random_uuid(),'x','stop','c1','seq-lba','lead-1','{}','verify:1','protected_external_state')`);
      expect((await facts()).otherOps).toHaveLength(1);
      expect(await facts({companyId:''})).toEqual({ok:false,reason:'company_scope_unverified'});
      expect(await facts({priorSendId:'send-a'})).toEqual({ok:false,reason:'prior_send_invalid'});
      expect(await facts({priorSendId:'40000000-0000-0000-0000-0000000000ff'})).toEqual({ok:false,reason:'prior_send_missing'});
    });
  });

  const apolloOk=(over={})=>({getContact:vi.fn(async()=>finished()),findContactsByEmail:vi.fn(async()=>[{id:'c1'}]),
    getSequenceDetail:vi.fn(async()=>({emailer_campaign:{active:true},emailer_steps:[{type:'auto_email'}]})),...over});
  const payload=(args,over={})=>({pipedrive_lead_id:'lead-1',pipedrive_contact_id:'11',pipedrive_org_id:'22',contact_id_snapshot:'11',contact_email_snapshot:'a@example.test',org_id_snapshot:'22',
    trigger_type:'AGC',apollo_sequence_id:args.apolloSequenceId,subject:'Congrats',body:'Award note',assigned_mailbox_id:args.assignedMailboxId,assigned_user_id:args.assignedUserId,
    person_last_outgoing:null,metadata:{project_stage:'Awarded',sender_email:'sender@example.test',sender_provider_id:'apollo-mb'},...over});
  const run=(over={})=>{
    const enrollDrafts=vi.fn(async drafts=>({enrolled:drafts.length,skipped:0}));
    const build=vi.fn(async args=>payload(args));
    const opts={apollo:apolloOk(),mailboxSentToday:async()=>0,enrollDrafts,build,isCustomer:async()=>false,companyId:'42',lifecycleEnabled:true,only:null,limit:3,...over};
    return runStageFollowOn(db.pool,opts).then(result=>({result,enrollDrafts:opts.enrollDrafts,build:opts.build,apollo:opts.apollo}));
  };
  const followOnDrafts=async()=>(await q(`SELECT * FROM sdr_drafts WHERE initiated_by='auto-switch'`)).rows;

  describe('the pass',()=>{
    it('dry run reports the candidate ready and writes nothing, even with the switch off',async()=>{
      delete process.env.SDR_STAGE_FOLLOW_ON;
      const {result,enrollDrafts}=await run({dryRun:true});
      expect(result).toMatchObject({dryRun:true,candidates:1,ready:1,created:0,enrolled:0,skippedBy:{}});
      expect(result.leads).toEqual([expect.objectContaining({sendId:S0,leadId:'lead-1',hop:'LBA>AGC',result:'ready',sender:'sender@example.test',lastEmailDays:20})]);
      expect(await followOnDrafts()).toHaveLength(0);expect(enrollDrafts).not.toHaveBeenCalled();
    });
    it('creates one award-only draft from the earlier sender and hands it to the normal send path',async()=>{
      const {result,enrollDrafts,build}=await run();
      expect(result).toMatchObject({candidates:1,created:1,enrolled:1,deferred:0});
      const [draft]=await followOnDrafts();
      expect(draft).toMatchObject({pipedrive_lead_id:'lead-1',trigger_type:'AGC',apollo_sequence_id:'seq-award',assigned_mailbox_id:MB,assigned_user_id:USER,status:'pending',
        content_origin:'machine',contact_email_snapshot:'a@example.test',metadata:{email_verdict:'valid',cadence:'award_only',follow_on:{prior_send_id:S0,hop:'LBA>AGC'},project_stage:'Awarded'}});
      expect(enrollDrafts).toHaveBeenCalledWith([{id:draft.id,assigned_user_id:USER,initiated_by:'auto-switch'}]);
      // The generator is asked for the live stage: no trigger is handed to it.
      expect(build.mock.calls[0][0]).toEqual({pipedriveLeadId:'lead-1',pool:db.pool,assignedUserId:USER,assignedMailboxId:MB,apolloSequenceId:'seq-award'});
    });
    it('gives a full hop the stage sequence and no cadence, and never makes a second follow-on',async()=>{
      await q(`UPDATE sdr_sends SET enrolled_trigger='PB',apollo_sequence_id='seq-pb';UPDATE sdr_provider_operations SET campaign_id='seq-pb';UPDATE sdr_drafts SET trigger_type='PB',apollo_sequence_id='seq-pb'`);
      const apollo=apolloOk({getContact:vi.fn(async()=>finished({emailer_campaign_id:'seq-pb'})),getSequenceDetail:vi.fn(async()=>({emailer_campaign:{active:true},emailer_steps:[{type:'auto_email'},{type:'auto_email'}]}))});
      expect((await run({apollo})).result).toMatchObject({created:1});
      const [draft]=await followOnDrafts();
      expect(draft.apollo_sequence_id).toBe('seq-agc');expect(draft.metadata.cadence).toBeUndefined();expect(draft.metadata.follow_on.hop).toBe('PB>AGC');
      const again=await run({apollo});
      expect(again.result).toMatchObject({created:0,skippedBy:{other_draft_on_lead:1}});expect(await followOnDrafts()).toHaveLength(1);
    });
    it('does nothing when switched off, when automatic sending is off, or when the allowlist names nobody',async()=>{
      delete process.env.SDR_STAGE_FOLLOW_ON;expect((await run()).result).toEqual({skipped:'disabled'});
      process.env.SDR_STAGE_FOLLOW_ON='on';
      await q(`UPDATE sdr_settings SET auto_outreach_mode='queue'`);expect((await run()).result).toEqual({skipped:'automatic_sending_off'});
      await q(`UPDATE sdr_settings SET auto_outreach_mode='send'`);
      expect((await run({only:[]})).result).toMatchObject({candidates:0,created:0});
      expect((await run({only:['40000000-0000-0000-0000-0000000000ff']})).result).toMatchObject({candidates:0,created:0});
      expect((await run({limit:0})).result).toMatchObject({created:0});
      expect((await run({companyId:''})).result).toEqual({skipped:'company_scope_unverified'});
      expect(await followOnDrafts()).toHaveLength(0);
    });
    it.each([
      ['a drip email inside the cooldown',async()=>q(`UPDATE sdr_message_facts SET occurred_at=now()-interval '5 days'`),{},'contact_cooldown'],
      ['a ledger entry inside the cooldown',async()=>q(`INSERT INTO sdr_outreach_log VALUES('lead-1','interface',now()-interval '5 days')`),{},'contact_cooldown'],
      ['a start date that has passed',async()=>q(`UPDATE sdr_lead_state SET start_date=CURRENT_DATE-40`),{},'start_date_passed'],
      ['no start date',async()=>q(`UPDATE sdr_lead_state SET start_date=NULL`),{},'start_date_passed'],
      ['a score under the minimum',async()=>q(`UPDATE sdr_settings SET auto_min_score=90`),{},'score_below_minimum'],
      ['a soft verdict',async()=>q(`UPDATE sdr_lead_state SET email_verify_status='catch_all'`),{},'address_not_verified_valid'],
      ['a stale verdict',async()=>q(`UPDATE sdr_lead_state SET email_verified_at=now()-interval '120 days'`),{},'address_not_verified_valid'],
      ['a recent human reply from the address',async()=>q(`INSERT INTO sdr_message_facts VALUES('gmail','in','received','a@example.test',now()-interval '60 days',TRUE)`),{},'recent_reply'],
      ['the person on an open bid-sheet lead',async()=>q(`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,lead_origin,crm_status) VALUES('lead-b','11','Bid Invite','active')`),{},'bid_invite_warm_lead'],
      ['a hold on the lead',async()=>setOutreachControl(db.pool,{companyId:'42',leadId:'lead-1',scope:{kind:'lead',id:'lead-1'},reason:'staff pause',contextHash:'h',actor:{accountId:'rep'}}),{},'held'],
      ['an inactive earlier sender',async()=>q(`UPDATE sdr_mailboxes SET active=FALSE`),{},'prior_sender_inactive'],
      ['a sender at its daily cap',async()=>{},{mailboxSentToday:async()=>30},'sender_at_daily_cap'],
      ['a sequence Apollo will not show',async()=>{},{apollo:apolloOk({getSequenceDetail:vi.fn(async()=>{throw new Error('down');})})},'sequence_unverified'],
      ['a paused sequence',async()=>{},{apollo:apolloOk({getSequenceDetail:vi.fn(async()=>({emailer_campaign:{active:false},emailer_steps:[{type:'auto_email'}]}))})},'sequence_paused'],
      ['an award sequence that is not one automatic email',async()=>{},{apollo:apolloOk({getSequenceDetail:vi.fn(async()=>({emailer_campaign:{active:true},emailer_steps:[{type:'auto_email'},{type:'auto_email'}]}))})},'award_sequence_unverified'],
      ['a membership that is active again',async()=>{},{apollo:apolloOk({getContact:vi.fn(async()=>finished({status:'active',inactive_reason:null}))})},'membership_changed'],
      ['a second membership on the contact',async()=>{},{apollo:apolloOk({getContact:vi.fn(async()=>({id:'c1',contact_campaign_statuses:[...finished().contact_campaign_statuses,{emailer_campaign_id:'manual',status:'active'}]}))})},'membership_changed'],
      ['two Apollo contacts on the address',async()=>{},{apollo:apolloOk({findContactsByEmail:vi.fn(async()=>[{id:'c1'},{id:'c2'}])})},'provider_contact_ambiguous'],
      ['an address that resolves to another contact',async()=>{},{apollo:apolloOk({findContactsByEmail:vi.fn(async()=>[{id:'c2'}])})},'provider_contact_ambiguous'],
      ['a customer',async()=>{},{isCustomer:async()=>true},'customer'],
      ['a generator failure',async()=>{},{build:vi.fn(async()=>{throw new Error('Mailbox sender@example.test is inactive');})},'draft_build_failed'],
      ['a stage that moved again in Pipedrive',async()=>{},{build:vi.fn(async args=>payload(args,{trigger_type:'CM'}))},'stage_changed_live'],
      ['a different person in Pipedrive',async()=>{},{build:vi.fn(async args=>payload(args,{contact_id_snapshot:'99'}))},'contact_changed_live'],
      ['a different address in Pipedrive',async()=>{},{build:vi.fn(async args=>payload(args,{contact_email_snapshot:'b@example.test'}))},'contact_changed_live'],
      ['a generator that picked another sender',async()=>{},{build:vi.fn(async args=>payload(args,{assigned_mailbox_id:'20000000-0000-0000-0000-000000000009'}))},'draft_mismatch'],
      ['a Pipedrive email after our send',async()=>{},{build:vi.fn(async args=>payload(args,{person_last_outgoing:new Date(Date.now()-3*86400000).toISOString().slice(0,19).replace('T',' ')}))},'hand_email_after_send'],
      ['a Pipedrive mail time it cannot read',async()=>{},{build:vi.fn(async args=>payload(args,{person_last_outgoing:'soon'}))},'crm_mail_time_unreadable'],
    ])('skips %s and writes no draft',async(_,prepare,over,reason)=>{
      await prepare();
      for(const dryRun of [true,false]){
        const {result,enrollDrafts}=await run({...over,dryRun});
        expect(result).toMatchObject({created:0,ready:0,skippedBy:{[reason]:1}});expect(enrollDrafts).not.toHaveBeenCalled();
      }
      expect(await followOnDrafts()).toHaveLength(0);
    });
    it('reads a Pipedrive mail time from before our send as no hand email',async()=>{
      const before=new Date(Date.now()-40*86400000).toISOString().slice(0,19).replace('T',' ');
      expect((await run({build:vi.fn(async args=>payload(args,{person_last_outgoing:before}))})).result).toMatchObject({created:1});
    });
    it('stops the pass on a rate limit or an unreadable CRM, and keeps what it already made',async()=>{
      const limited=apolloOk({getContact:vi.fn(async()=>{throw Object.assign(new Error('slow down'),{status:429,retryAfterSec:60});})});
      expect((await run({apollo:limited})).result).toMatchObject({created:0,stopped:'provider_rate_limited'});
      const crm=async()=>{throw Object.assign(new Error('Pipedrive unavailable'),{code:'crm_unverified'});};
      expect((await run({isCustomer:crm})).result).toMatchObject({created:0,stopped:'crm_unverified'});
      expect(await followOnDrafts()).toHaveLength(0);
    });
    it('holds to the limit and the allowlist across several candidates, oldest first',async()=>{
      const S1='40000000-0000-0000-0000-000000000002',S2='40000000-0000-0000-0000-000000000003';
      await seed({lead:'lead-2',person:'12',org:'23',email:'b@example.test',contact:'c2',draft:'10000000-0000-0000-0000-000000000002',send:S1,sendAgo:25,factAgo:18});
      await seed({lead:'lead-3',person:'13',org:'24',email:'c@example.test',contact:'c3',draft:'10000000-0000-0000-0000-000000000003',send:S2,sendAgo:23,factAgo:17});
      const byEmail={'a@example.test':['c1','lead-1','11','22'],'b@example.test':['c2','lead-2','12','23'],'c@example.test':['c3','lead-3','13','24']};
      const apollo=apolloOk({getContact:vi.fn(async id=>({...finished(),id})),findContactsByEmail:vi.fn(async email=>[{id:byEmail[email][0]}])});
      const leadOf=id=>Object.entries(byEmail).find(([,v])=>v[1]===id);
      const build=vi.fn(async args=>{const [email,[, lead,person,org]]=leadOf(args.pipedriveLeadId);
        return payload(args,{pipedrive_lead_id:lead,pipedrive_contact_id:person,pipedrive_org_id:org,contact_id_snapshot:person,contact_email_snapshot:email,org_id_snapshot:org});});
      const dry=await run({apollo,build,dryRun:true,limit:1});
      expect(dry.result).toMatchObject({candidates:3,ready:3,created:0});
      const one=await run({apollo,build,only:[S2],limit:5});
      expect(one.result).toMatchObject({candidates:1,created:1});expect((await followOnDrafts()).map(d=>d.pipedrive_lead_id)).toEqual(['lead-3']);
      const capped=await run({apollo,build,limit:1});
      expect(capped.result).toMatchObject({created:1});
      expect((await followOnDrafts()).map(d=>d.pipedrive_lead_id).sort()).toEqual(['lead-2','lead-3']);
    });
    it('counts drafts made in the pass against the sender cap',async()=>{
      await seed({lead:'lead-2',person:'12',org:'23',email:'b@example.test',contact:'c2',draft:'10000000-0000-0000-0000-000000000002',send:'40000000-0000-0000-0000-000000000002',sendAgo:25,factAgo:18});
      const apollo=apolloOk({getContact:vi.fn(async id=>({...finished(),id})),findContactsByEmail:vi.fn(async email=>[{id:email.startsWith('a')?'c1':'c2'}])});
      const build=vi.fn(async args=>args.pipedriveLeadId==='lead-1'?payload(args):payload(args,{pipedrive_lead_id:'lead-2',pipedrive_contact_id:'12',pipedrive_org_id:'23',contact_id_snapshot:'12',contact_email_snapshot:'b@example.test',org_id_snapshot:'23'}));
      expect((await run({apollo,build,mailboxSentToday:async()=>29})).result).toMatchObject({created:1,skippedBy:{sender_at_daily_cap:1}});
    });
  });

  describe('the provider guard',()=>{
    const context=(draftId,over={})=>({companyId:'42',leadId:'lead-1',personId:'11',recipientEmail:'a@example.test',organizationId:'22',projectRole:null,stage:'Awarded',trigger:'AGC',
      mailboxId:MB,sequenceId:'seq-award',scheduledFor:null,overrideDecisionId:null,roleExceptionId:null,cadence:'award_only',sourceRevision:'r1',draftId,channel:'email',serviceId:null,
      technicalComplete:true,apolloContactId:'c1',...over});
    const reserve=(draftId,{apollo={getContact:async()=>finished()},over={},actionId='attempt-1'}={})=>
      reserveEnrollment({pool:db.pool,apollo,context:context(draftId,over),draftRevision:1,actionId,enrollmentMode:'sdr_draft_v1'});
    const made=async()=>{await run();return (await followOnDrafts())[0].id;};
    const holds=async()=>(await q('SELECT count(*)::int AS n FROM sdr_outreach_controls')).rows[0].n;
    let warn;
    beforeEach(()=>{warn=vi.spyOn(console,'warn').mockImplementation(()=>{});});
    afterEach(()=>warn.mockRestore());

    it('lets the proven follow-on through and marks the reservation',async()=>{
      const draftId=await made();
      const reservation=await reserve(draftId);
      expect(reservation).toMatchObject({followOn:{priorSendId:S0,hop:'LBA>AGC'}});expect(reservation.reservationId).toBeTruthy();
      expect(await holds()).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM sdr_provider_operations WHERE kind='enroll' AND state='reserved' AND campaign_id='seq-award'`)).rows[0].n).toBe(1);
    });
    it('still refuses the same contact for a draft that is not a follow-on, with a hold',async()=>{
      const {rows:[draft]}=await q(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,apollo_sequence_id,assigned_mailbox_id,contact_email_snapshot,initiated_by,content_origin,status)
        VALUES('lead-1','AGC','seq-award',$1,'a@example.test','automatic','machine','pending') RETURNING id`,[MB]);
      await expect(reserve(draft.id)).rejects.toMatchObject({code:'provider_operation_requires_review'});
      await q('DELETE FROM sdr_provider_operations');
      await expect(reserve(draft.id)).rejects.toMatchObject({code:'external_membership_requires_review'});
      expect(await holds()).toBe(1);
    });
    it('refuses without a hold when the switch is off',async()=>{
      const draftId=await made();
      delete process.env.SDR_STAGE_FOLLOW_ON;
      await expect(reserve(draftId)).rejects.toMatchObject({code:'follow_on_not_permitted',followOnReason:'follow_on_disabled',status:409,preserveDraft:true});
      expect(await holds()).toBe(0);
    });
    it.each([
      ['a marker on a draft the pass did not write',id=>q(`UPDATE sdr_drafts SET initiated_by='manual' WHERE id=$1`,[id]),{},'draft_not_machine_follow_on'],
      ['a draft a rep rewrote',id=>q(`UPDATE sdr_drafts SET content_origin='human',status='edited' WHERE id=$1`,[id]),{},'draft_not_machine_follow_on'],
      ['a reply that arrived since',()=>q(`INSERT INTO sdr_reply_messages(provider_message_id,pipedrive_lead_id,received_at) VALUES('m1','lead-1',now())`),{},'reply_on_record'],
      ['a hand email since',()=>q(`INSERT INTO sdr_outreach_log VALUES('lead-1','pipedrive',now())`),{},'hand_email_after_send'],
      ['a stage that moved again',()=>q(`UPDATE sdr_lead_state SET trigger_type='CM'`),{},'hop_not_allowed'],
      ['another draft on the lead',()=>q(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status) VALUES('lead-1','LBA','cancelled')`),{},'other_draft_on_lead'],
      ['a marker pointing at another send',id=>q(`UPDATE sdr_drafts SET metadata=jsonb_set(metadata,'{follow_on,prior_send_id}','"40000000-0000-0000-0000-0000000000ff"') WHERE id=$1`,[id]),{},'prior_send_missing'],
      ['a marker with another hop',id=>q(`UPDATE sdr_drafts SET metadata=jsonb_set(metadata,'{follow_on,hop}','"PB>AGC"') WHERE id=$1`,[id]),{},'hop_changed'],
      ['another sequence in the send context',()=>{},{sequenceId:'seq-agc'},'sequence_mismatch'],
      ['another Apollo contact in the send context',()=>{},{apolloContactId:'c2'},'contact_mismatch'],
      ['another sender in the send context',()=>{},{mailboxId:'20000000-0000-0000-0000-000000000009'},'mailbox_mismatch'],
      ['another address in the send context',()=>{},{recipientEmail:'b@example.test'},'address_mismatch'],
      ['a full cadence on an award hop',()=>{},{cadence:null},'cadence_mismatch'],
      ['another lead in the send context',()=>{},{leadId:'lead-9'},'lead_mismatch'],
    ])('refuses %s without a hold',async(_,prepare,over,reason)=>{
      const draftId=await made();await prepare(draftId);
      await expect(reserve(draftId,{over})).rejects.toMatchObject({code:'follow_on_not_permitted',followOnReason:reason});
      expect(await holds()).toBe(0);expect(warn).toHaveBeenCalled();
    });
    it.each([
      ['active again',finished({status:'active',inactive_reason:null})],
      ['ended on a reply',finished({inactive_reason:'replied'})],
      ['gone',{id:'c1',contact_campaign_statuses:[]}],
      ['joined by a second sequence',{id:'c1',contact_campaign_statuses:[...finished().contact_campaign_statuses,{emailer_campaign_id:'manual',status:'paused'}]}],
    ])('refuses without a hold when Apollo shows the membership %s',async(_,contact)=>{
      const draftId=await made();
      await expect(reserve(draftId,{apollo:{getContact:async()=>contact}})).rejects.toMatchObject({code:'follow_on_membership_changed'});
      expect(await holds()).toBe(0);
    });
    it('applies the contact cooldown to a permitted follow-on',async()=>{
      const draftId=await made();
      await q(`INSERT INTO sdr_message_facts VALUES('apollo','out','completed','a@example.test',now()-interval '2 days',NULL)`);
      await expect(reserve(draftId)).rejects.toMatchObject({code:'contact_cooldown'});
    });
    it('is a one-time thing: after the follow-on is sent, nothing more is permitted for the lead',async()=>{
      const draftId=await made();
      await reserve(draftId);
      await q(`UPDATE sdr_drafts SET status='sent',sent_at=now() WHERE id=$1`,[draftId]);
      await q(`INSERT INTO sdr_sends(draft_id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,mailbox_id,sent_at,status,step_status,enrolled_trigger,enrolled_person_id,enrolled_org_id)
        VALUES($1,'lead-1','seq-award','c1',$2,now(),'enrolled','completed','AGC','11','22')`,[draftId,MB]);
      expect(await facts()).toEqual({ok:false,reason:'other_send_exists'});
      expect((await run()).result).toMatchObject({created:0});
      expect(await followOnPermit(db.pool,context(draftId))).toEqual({refused:'draft_not_open'});
    });
    it('reads no permit for a draft without the marker or an id that is not a draft',async()=>{
      expect(await followOnPermit(db.pool,context(D0))).toBeNull();
      expect(await followOnPermit(db.pool,context('draft'))).toBeNull();
      expect(await followOnPermit(db.pool,context('10000000-0000-0000-0000-0000000000ff'))).toBeNull();
    });
  });
});
