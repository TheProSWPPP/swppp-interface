import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {readDecisionContext,hashContextDependencies} from '../sdrChangeJournal.js';
import {assertSendSafety} from '../sdrSendSafety.js';
import {setOutreachControl} from '../sdrOutreachControls.js';
import {getPolicyRollout,observeOutreachPolicy} from '../sdrPolicyRollout.js';
const db=reportingTestDb('policy_rollout');
const stage='7c1852c27664d1118f75660223a6af9e99d10f2c';
const draft={id:'d',revision:1,pipedrive_lead_id:'l',contact_id_snapshot:'p',org_id_snapshot:'o',contact_email_snapshot:'a@example.test',assigned_mailbox_id:'m',apollo_sequence_id:'s',trigger_type:'AGC',metadata:{sender_email:'rep@example.test',sender_provider_id:'sender'}};
const deps=()=>({companyId:'42',actionKey:'draft:d:1',phase:'preflight',getLead:async()=>({id:'l',is_archived:false,person_id:'p',organization_id:'o',[stage]:'AGC'}),getPerson:async()=>({id:'p',email:[{value:'a@example.test',primary:true}]})});
describe.skipIf(!db)('staged business-review policy with invariant enforcement',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,person_name text,project_stage text,trigger_type text,trigger_override text,sequence_started text,owner_name text);
   CREATE TABLE sdr_drafts(id text,pipedrive_lead_id text,created_at timestamptz,status text,assigned_mailbox_id text,apollo_sequence_id text,scheduled_for timestamptz,metadata jsonb,revision integer);
   CREATE TABLE sdr_mailboxes(id text,email text,apollo_mailbox_id text,active boolean);
   CREATE TABLE sdr_provider_operations(id text);`);
  for(const file of ['2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-manual-protection.sql','2026-10-07-sdr-outreach-controls.sql','2026-10-07-sdr-policy-rollout.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(async()=>await db.close());
 beforeEach(async()=>{
  await db.pool.query(`TRUNCATE sdr_lead_state,sdr_drafts,sdr_mailboxes,sdr_crm_snapshots,sdr_crm_scope_coverage,sdr_policy_rollouts,sdr_policy_cohorts,sdr_policy_decisions,sdr_outreach_controls,sdr_outreach_control_decisions,sdr_provider_operations;
   INSERT INTO sdr_policy_rollouts(company_id,version,mode,owner_id,actor,evidence) VALUES('42',1,'observe','reviewer','{"accountId":"reviewer"}','staged rollout');
   INSERT INTO sdr_lead_state(pipedrive_lead_id,trigger_type,crm_company_id) VALUES('l','AGC','42');
   INSERT INTO sdr_drafts VALUES('d','l',now(),'pending','m','s',NULL,'{}',1);
   INSERT INTO sdr_mailboxes VALUES('m','rep@example.test','sender',true);`);
  for(const [entity,id,data] of [['lead','l',{id:'l',person_id:'p',organization_id:'o',[stage]:'AGC'}],['person','p',{id:'p',email:[{value:'a@example.test',primary:true}]}],['organization','o',{id:'o'}]])
   await db.pool.query('INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at) VALUES($1,$2,$3,$4,now())',['42',entity,id,data]);
 });
 const context=()=>readDecisionContext(db.pool,'l',{companyId:'42',draftId:'d'});
 const cohort=async c=>db.pool.query(`INSERT INTO sdr_policy_cohorts(company_id,lead_id,version,active,dependency_hash,context_hash,owner_id,actor,evidence) VALUES('42','l',1,true,$1,$2,'reviewer','{"accountId":"reviewer"}','reviewed pilot membership')`,[hashContextDependencies(c),c.contextHash]);
 it('lets a valid ordinary first send reach reservation eligibility while recording the new-rule review in shadow',async()=>{
  const result=await assertSendSafety(db.pool,draft,deps());
  expect(result).toMatchObject({technicalComplete:true,businessReviewed:false,complete:false});
  const rows=(await db.pool.query('SELECT mode,proposed_outcome,actual_outcome,invariant_outcome,reason_codes FROM sdr_policy_decisions')).rows;
  expect(rows).toMatchObject([{mode:'observe',proposed_outcome:'review',actual_outcome:'allow',invariant_outcome:'allow',reason_codes:expect.arrayContaining(['project_role_unverified','cadence_unverified'])}]);
 });
 it('enforces new review inside an explicitly selected cohort',async()=>{
  await cohort(await context());
  await expect(assertSendSafety(db.pool,draft,deps())).rejects.toMatchObject({code:'project_role_unverified'});
 });
 it('allows reviewed cohort members only on the reviewed dependency and full context hashes',async()=>{
  const old=await context();
  await db.pool.query("UPDATE sdr_lead_state SET safety_context=$1",[{identityHash:hashContextDependencies(old),projectRole:'estimator',roleExceptionId:'decision',cadence:'standard',evidence:'reviewed project role',actor:{accountId:'reviewer'}}]);
  const reviewed=await context();await cohort(reviewed);
  expect(await assertSendSafety(db.pool,{...draft,metadata:{...draft.metadata,reviewed_outreach_context_hash:reviewed.contextHash}},deps())).toMatchObject({complete:true,businessReviewed:true});
  await db.pool.query("UPDATE sdr_drafts SET scheduled_for='2000-01-01'");
  await expect(assertSendSafety(db.pool,{...draft,metadata:{...draft.metadata,reviewed_outreach_context_hash:reviewed.contextHash}},deps())).rejects.toMatchObject({code:'cohort_context_changed'});
 });
 it('invalidates role review if the person organization link changes while the email stays the same',async()=>{
  const old=await context();
  await db.pool.query("UPDATE sdr_lead_state SET safety_context=$1",[{identityHash:hashContextDependencies(old),projectRole:'estimator',roleExceptionId:'decision',cadence:'standard',evidence:'reviewed project role'}]);
  const reviewed=await context();await cohort(reviewed);
  await db.pool.query("UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{org_id}',$1::jsonb) WHERE entity='person'",[JSON.stringify('another-employer')]);
  const current=await context();
  expect(current).toMatchObject({recipientEmail:'a@example.test',businessReviewed:false,technicalComplete:true});
  expect(hashContextDependencies(current)).not.toBe(hashContextDependencies(reviewed));
 });
 it('requires an explicit new cohort version to leave enforcement even when company mode stays observe',async()=>{
  const c=await context();await cohort(c);
  await expect(assertSendSafety(db.pool,draft,deps())).rejects.toMatchObject({code:'project_role_unverified'});
  await db.pool.query(`INSERT INTO sdr_policy_cohorts(company_id,lead_id,version,active,dependency_hash,context_hash,owner_id,actor,evidence) VALUES('42','l',2,false,$1,$2,'reviewer','{"accountId":"reviewer"}','explicit cohort rollback')`,[hashContextDependencies(c),c.contextHash]);
  expect(await assertSendSafety(db.pool,draft,deps())).toMatchObject({complete:false,technicalComplete:true});
 });
 it('keeps an active cohort enforced after dependency drift instead of reverting to observe',async()=>{
  await cohort(await context());await db.pool.query("UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{email}','[{\"value\":\"changed@example.test\",\"primary\":true}]') WHERE entity='person'");
  const current=await context(),config=await getPolicyRollout(db.pool,{companyId:'42',leadId:'l'});
  const decision=await observeOutreachPolicy(db.pool,{context:current,config,actionKey:'drift',invariantDecision:{outcome:'allow',reasonCodes:[]}});
  expect(decision).toMatchObject({outcome:'hold',enforced:true,reasonCodes:expect.arrayContaining(['cohort_context_changed'])});
  expect(config.cohort.active).toBe(true);
 });
 it.each(['held','future','recipient','sender','crm_failure','company','award_only'])('still blocks %s outside the cohort and journals the actual invariant failure',async kind=>{
  const options=deps();
  if(kind==='held')await setOutreachControl(db.pool,{companyId:'42',leadId:'l',scope:{kind:'lead',id:'l'},reason:'call only',contextHash:'hash',actor:{accountId:'rep'}});
  if(kind==='future')await db.pool.query("UPDATE sdr_drafts SET scheduled_for='2999-01-01'");
  if(kind==='recipient')options.getPerson=async()=>({id:'p',email:[{value:'changed@example.test',primary:true}]});
  if(kind==='sender')await db.pool.query("UPDATE sdr_mailboxes SET email='changed@example.test'");
  if(kind==='crm_failure')options.getLead=async()=>{throw Error('denied');};
  if(kind==='company')await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='another'");
  if(kind==='award_only'){await db.pool.query(`UPDATE sdr_lead_state SET safety_context='{"cadence":"award_only"}'`);options.getSequence=async()=>({emailer_steps:[{type:'auto_email'},{type:'auto_email'}]});}
  await expect(assertSendSafety(db.pool,draft,options)).rejects.toMatchObject({status:409,preserveDraft:true});
  expect((await db.pool.query('SELECT invariant_outcome,actual_outcome FROM sdr_policy_decisions')).rows).toMatchObject([{invariant_outcome:'hold',actual_outcome:'hold'}]);
 });
 it('observes unknown role without holds, drafts, reservations or external actions and deduplicates immutable audit retries',async()=>{
  const c=await context(),config=await getPolicyRollout(db.pool,{companyId:'42',leadId:'l'});
  const input={context:c,config,actionKey:'observer:1',phase:'observation',invariantDecision:{outcome:'allow',reasonCodes:[]}};
  await observeOutreachPolicy(db.pool,input);await observeOutreachPolicy(db.pool,input);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_policy_decisions')).rows[0].n).toBe(1);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_outreach_controls')).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_provider_operations')).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT status FROM sdr_drafts')).rows).toEqual([{status:'pending'}]);
  await expect(db.pool.query("UPDATE sdr_policy_decisions SET actual_outcome='allow'")).rejects.toThrow('append_only');
  await expect(db.pool.query('DELETE FROM sdr_policy_rollouts')).rejects.toThrow('append_only');
 });
 it('uses the latest explicit company version and fails closed when configuration is missing',async()=>{
  await db.pool.query('TRUNCATE sdr_policy_rollouts');
  await expect(assertSendSafety(db.pool,draft,deps())).rejects.toMatchObject({code:'policy_rollout_unconfigured'});
  await db.pool.query(`INSERT INTO sdr_policy_rollouts(company_id,version,mode,owner_id,actor,evidence) VALUES('42',1,'observe','reviewer','{}','first'),('42',2,'enforce','reviewer','{}','rollout');`);
  expect(await getPolicyRollout(db.pool,{companyId:'42',leadId:'l'})).toMatchObject({mode:'enforce',version:2});
  await expect(assertSendSafety(db.pool,draft,deps())).rejects.toMatchObject({code:'project_role_unverified'});
 });
});
