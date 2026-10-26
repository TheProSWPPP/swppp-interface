import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import pg from 'pg';import fs from 'node:fs/promises';
import {ingestLinkedinEvent,processLinkedinEvents} from '../sdrLinkedinSync.js';
import {createLinkedinInboundHandler} from '../sdrLinkedinInbound.js';
import {completeLinkedinSequences,queueLinkedinAction,dispatchLinkedinAction} from '../sdrLinkedinOperations.js';
import {registerLinkedinAccount,setLinkedinAccountMode,saveLinkedinCampaign,approveLinkedinCampaign,stageLinkedinCandidatesFromLeads} from '../sdrLinkedinAdmin.js';
import {planLinkedinNextAction} from '../sdrLinkedinPolicy.js';
import {registerSdrLinkedinRoutes} from '../sdrLinkedinRoutes.js';
const url=process.env.SDR_TEST_DATABASE_URL;if(!url)throw Error('SDR_TEST_DATABASE_URL required');if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('local database required');
const schema=`linkedin_golive_${process.pid}`,pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const company='13105180';
beforeAll(async()=>{
 await pool.query(`CREATE SCHEMA ${schema}`);
 for(const file of ['2026-10-16-sdr-linkedin-channel.sql','2026-10-26-sdr-linkedin-golive.sql'])await pool.query(await fs.readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
 await pool.query(`CREATE TABLE sdr_mailboxes(owner_user_id text,pipedrive_sender_id integer,active boolean); INSERT INTO sdr_mailboxes VALUES('owner',42,true);
  CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,person_email text,lead_origin text,crm_status text);
  CREATE TABLE sdr_outreach_controls(company_id text,lead_id text,status text);
  CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),trigger_type text,contact_email_snapshot text);
  CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,status text,step_status text,current_step int,total_steps int,updated_at timestamptz DEFAULT now());
  CREATE TABLE sdr_engagement_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text,pipedrive_lead_id text,apollo_sequence_id text,occurred_at timestamptz);`);
});
afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});
const account=async(id,extra='')=>pool.query(`INSERT INTO sdr_linkedin_accounts(company_id,account_id,sender_provider_id,status,mode,read_budget,read_timezone) VALUES($1,$2,'ACo-self','healthy','observe',20,'America/Chicago') ${extra}`,[company,id]);
const status=async id=>(await pool.query('SELECT status FROM sdr_linkedin_accounts WHERE account_id=$1',[id])).rows[0].status;
const candidate=async(accountId,key,fields={})=>{const row=(await pool.query(`INSERT INTO sdr_linkedin_candidates(company_id,account_id,source,source_id,profile_url,person_id,organization_id,owner_id,pipedrive_owner_id,provider_id,product,state,segment,territory,email_sequence_complete_at,email_unanswered,campaign_id) VALUES($1,$2,'pipedrive',$3,$4,$5,'org','owner','42',$6,'classic',$7,'AGC','all',now()-interval '10 days',true,$8) RETURNING *`,[company,accountId,`lead-${key}`,`https://www.linkedin.com/in/${key}/`,fields.person===null?null:`person-${key}`,fields.provider||`ACo-${key}`,fields.state||'reviewed',fields.campaign||null])).rows[0];await pool.query(`INSERT INTO sdr_linkedin_links(company_id,account_id,candidate_id,person_id,organization_id,owner_id,lead_id,verified_email,apollo_contact_id,evidence) SELECT $1,$2,$3,$4,'org','owner',$5,$6,$7,$8 WHERE $4::text IS NOT NULL`,[company,accountId,row.id,row.person_id,`lead-${key}`,`${key}@example.test`,`apollo-${key}`,JSON.stringify({source:'fixture',personId:row.person_id,leadId:`lead-${key}`})]);return row};
const message=(accountId,id,sender,extra={})=>({account_id:accountId,account_type:'LINKEDIN',account_info:{type:'LINKEDIN',feature:'classic',user_id:'ACo-self'},event:'message_received',chat_id:`chat-${id}`,timestamp:'2026-10-26T15:00:00.000Z',message_id:id,message:'Hello there',sender:{attendee_provider_id:sender},...extra});

describe('personal profile messages never halt the account',()=>{
 it('records a message from someone who is not a candidate and closes it without touching the account',async()=>{
  await account('personal');
  const event=await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'personal',payload:message('personal','friend-1','ACo-friend')});
  expect(event).toMatchObject({direction:'in',person_id:null,source_message_id:'friend-1',chat_id:'chat-friend-1'});
  expect(await status('personal')).toBe('healthy');
  for(let i=0;i<3;i++){await processLinkedinEvents({pool,companyId:company,accountId:'personal'});await pool.query('UPDATE sdr_linkedin_events SET next_attempt_at=NULL WHERE id=$1',[event.id])}
  expect(await status('personal')).toBe('healthy');
  expect((await pool.query('SELECT processed_at,safe_payload FROM sdr_linkedin_events WHERE id=$1',[event.id])).rows[0]).toMatchObject({safe_payload:expect.objectContaining({resolution:'not_candidate'})});
  expect((await pool.query('SELECT processed_at FROM sdr_linkedin_events WHERE id=$1',[event.id])).rows[0].processed_at).not.toBeNull();
 });
 it('holds only the candidates an ambiguous message matches',async()=>{
  await account('ambiguous');
  const a=await candidate('ambiguous','amb-a',{provider:'ACo-shared'}),b=await candidate('ambiguous','amb-b',{provider:'ACo-shared'}),other=await candidate('ambiguous','amb-other');
  await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'ambiguous',payload:message('ambiguous','amb-msg','ACo-shared')});
  await processLinkedinEvents({pool,companyId:company,accountId:'ambiguous'});
  const states=Object.fromEntries((await pool.query('SELECT id,state,hold_reason FROM sdr_linkedin_candidates WHERE account_id=$1',['ambiguous'])).rows.map(r=>[r.id,r]));
  expect(states[a.id]).toMatchObject({state:'held',hold_reason:'ambiguous_linkedin_match'});
  expect(states[b.id]).toMatchObject({state:'held',hold_reason:'ambiguous_linkedin_match'});
  expect(states[other.id].state).toBe('reviewed');
  expect(await status('ambiguous')).toBe('healthy');
 });
});

describe('Unipile v1 webhook shapes',()=>{
 it('links a v1 new_relation by user_provider_id',async()=>{
  await account('relations');
  const c=await candidate('relations','rel',{state:'invite_sent'});
  const event=await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'relations',payload:{event:'new_relation',account_id:'relations',account_type:'LINKEDIN',webhook_name:'New relation',user_full_name:'Pat Builder',user_provider_id:'ACo-rel',user_public_identifier:'rel',user_profile_url:'https://www.linkedin.com/in/rel/'}});
  expect(event.provider_id).toBe('ACo-rel');
  await processLinkedinEvents({pool,companyId:company,accountId:'relations'});
  expect((await pool.query('SELECT state FROM sdr_linkedin_candidates WHERE id=$1',[c.id])).rows[0].state).toBe('relation_observed');
 });
 it('reads the v1 message_received text field and identifies the sender',async()=>{
  await account('v1-message');
  const c=await candidate('v1-message','v1m');
  const event=await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'v1-message',payload:message('v1-message','v1m-msg','ACo-v1m')});
  expect(event).toMatchObject({person_id:c.person_id,candidate_id:c.id,direction:'in',source_message_id:'v1m-msg'});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_candidates WHERE id=$1',[c.id])).rows[0]).toMatchObject({state:'held',hold_reason:'linkedin_inbound'});
 });
 it('accepts the nested AccountStatus payload and ignores routine sync statuses',async()=>{
  await account('status');
  await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'status',payload:{AccountStatus:{account_id:'status',account_type:'LINKEDIN',message:'SYNC_SUCCESS'}}});
  await processLinkedinEvents({pool,companyId:company,accountId:'status'});
  expect(await status('status')).toBe('healthy');
  await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'status',payload:{AccountStatus:{account_id:'status',account_type:'LINKEDIN',message:'CREDENTIALS'}}});
  expect(await status('status')).toBe('restricted');
  await expect(ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'status',payload:{AccountStatus:{account_id:'other',message:'OK'}}})).rejects.toMatchObject({code:'account_mismatch'});
 });
});

describe('LinkedIn reply becomes a Pipedrive task',()=>{
 it('creates one task for the lead owner with the reply text and reuses it on retry',async()=>{
  await account('reply-task');
  const c=await candidate('reply-task','rt');
  const activities=[];let failAfterCreate=true;
  const crm={getPerson:async()=>({id:c.person_id,owner_id:42,org_id:'org'}),getLead:async()=>({id:'lead-rt',owner_id:42}),listActivities:async()=>activities,
   addActivity:async task=>{activities.push({id:activities.length+100,user_id:task.userId,...task});if(failAfterCreate){failAfterCreate=false;throw Error('receipt lost')}return {id:activities.at(-1).id,user_id:task.userId}}};
  const client={getChat:async()=>({account_id:'reply-task',attendees_ids:['ACo-rt']}),listMessages:async()=>({complete:true,items:[{id:'rt-msg',is_sender:false,text:'Can you send pricing for the SWPPP?'}]})};
  const onInbound=createLinkedinInboundHandler({pool,client,crm,mode:'live',appBase:'https://app.example.test'});
  const event=await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'reply-task',payload:message('reply-task','rt-msg','ACo-rt')});
  expect((await processLinkedinEvents({pool,companyId:company,accountId:'reply-task',onInbound})).unresolved).toBe(1);
  await pool.query('UPDATE sdr_linkedin_events SET next_attempt_at=NULL WHERE id=$1',[event.id]);
  expect((await processLinkedinEvents({pool,companyId:company,accountId:'reply-task',onInbound})).processed).toBe(1);
  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({leadId:'lead-rt',type:'task',done:false,userId:42,strictAssignee:true});
  expect(activities[0].note).toContain('Can you send pricing for the SWPPP?');
  expect(activities[0].note).toContain('https://www.linkedin.com/messaging/thread/chat-rt-msg/');
  expect(activities[0].note).toContain('https://app.example.test/#/sdr?inboxLead=lead-rt');
  expect((await pool.query('SELECT state,activity_id FROM sdr_linkedin_reply_tasks WHERE source_message_id=$1',['rt-msg'])).rows[0]).toMatchObject({state:'created',activity_id:'100'});
  await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'reply-task',payload:message('reply-task','rt-msg','ACo-rt')});
  await processLinkedinEvents({pool,companyId:company,accountId:'reply-task',onInbound});
  expect(activities).toHaveLength(1);
 });
});

describe('sequences that cannot progress complete and free capacity',()=>{
 const config={senderProviderId:'ACo-self',timezone:'America/Chicago',sendWindow:{weekdays:[1,2,3,4,5],start:'08:00',end:'17:00'},lateAcceptancePolicy:'send_on_verified_observation',followupDays:[3,7],budgets:{invite:2,dm:1},copy:{dm1:'Hello',followup1:'Checking in',followup2:'Last note'},segments:['AGC'],territories:['all'],sources:['pipedrive'],candidateSourceIds:['lead-stale','lead-next'],ownerIds:['owner'],stopPolicy:'any_inbound'};
 it('completes an invite unaccepted after 21 days so the next invite is not starved',async()=>{
  await account('capacity',"ON CONFLICT DO NOTHING");await pool.query("UPDATE sdr_linkedin_accounts SET mode='live' WHERE account_id='capacity'");
  const campaignId=(await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id,config,expires_at) VALUES($1,'capacity',$2,now()+interval '30 days') RETURNING id`,[company,JSON.stringify(config)])).rows[0].id;
  const approved=await approveLinkedinCampaign({pool,companyId:company,accountId:'capacity',actor:'admin',campaignId,expectedRevision:1}).catch(e=>e);
  expect(approved.code).toBe('cohort_mismatch');
  const stale=await candidate('capacity','stale',{campaign:campaignId}),next=await candidate('capacity','next',{campaign:campaignId});
  await approveLinkedinCampaign({pool,companyId:company,accountId:'capacity',actor:'admin',campaignId,expectedRevision:1});
  await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,state,reserved_at,confirmed_at) VALUES($1,'capacity',$2,$3,$4,1,'invite','stale-invite',now()-interval '22 days','h','confirmed',now()-interval '22 days',now()-interval '22 days')`,[company,stale.id,stale.person_id,campaignId]);
  const queued=await queueLinkedinAction({pool,candidateId:next.id,campaignId,now:new Date('2027-10-19T15:00:00Z')});
  expect(queued.step).toBe('invite');
  const allow=async()=>({allowed:true,contextHash:queued.context_hash});const sent=[];const client={invite:async()=>{sent.push(1);return {outcome:'confirmed',providerId:'inv-next'}}};
  await pool.query("CREATE TABLE IF NOT EXISTS sdr_outreach_controls(company_id text,lead_id text,status text)");
  expect((await dispatchLinkedinAction({pool,client,actionId:queued.id,readFreshContext:allow,mode:'live',now:new Date('2027-10-19T15:00:00Z')})).state).toBe('dm_capacity_reserved');
  expect(await completeLinkedinSequences({pool,companyId:company,accountId:'capacity',now:new Date()})).toMatchObject({inviteExpired:1});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_candidates WHERE id=$1',[stale.id])).rows[0]).toMatchObject({state:'completed_no_reply',hold_reason:'invite_not_accepted'});
  expect((await dispatchLinkedinAction({pool,client,actionId:queued.id,readFreshContext:allow,mode:'live',now:new Date('2027-10-19T15:00:00Z')})).state).toBe('confirmed');
  expect(sent).toHaveLength(1);
 });
 it('completes a candidate a week after the last unanswered follow-up',async()=>{
  await account('finished');
  const campaignId=(await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id) VALUES($1,'finished') RETURNING id`,[company])).rows[0].id;
  const done=await candidate('finished','done',{state:'dm1_sent'}),recent=await candidate('finished','recent',{state:'dm1_sent'});
  for(const [row,days] of [[done,8],[recent,2]])await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,state,confirmed_at) VALUES($1,'finished',$2,$3,$4,1,'followup2',$5,now(),'h','confirmed',now()-make_interval(days=>$6::int))`,[company,row.id,row.person_id,campaignId,`f2-${row.id}`,days]);
  expect(await completeLinkedinSequences({pool,companyId:company,accountId:'finished'})).toMatchObject({sequenceFinished:1});
  expect((await pool.query('SELECT state FROM sdr_linkedin_candidates WHERE id=$1',[done.id])).rows[0].state).toBe('completed_no_reply');
  expect((await pool.query('SELECT state FROM sdr_linkedin_candidates WHERE id=$1',[recent.id])).rows[0].state).toBe('dm1_sent');
 });
});

describe('DM1 timing',()=>{
 const campaign={config:{timezone:'America/Chicago',sendWindow:{weekdays:[1,2,3,4,5],start:'08:00',end:'17:00'},lateAcceptancePolicy:'send_on_verified_observation',followupDays:[3,7]}};
 it('waits for the weekday window and sends within one business day of the observed acceptance',()=>{
  const friday='2026-10-23T23:30:00Z';
  const plan=planLinkedinNextAction({candidate:{state:'relation_observed'},campaign,observations:{relationVerified:true,relationObservedAt:friday,acceptanceDayUnknown:true},now:new Date('2026-10-24T12:00:00Z')});
  expect(plan).toMatchObject({step:'dm1',held:false});expect(plan.dueAt.toISOString()).toBe('2026-10-26T13:00:00.000Z');
  expect(planLinkedinNextAction({candidate:{state:'relation_observed'},campaign,observations:{relationVerified:true,relationObservedAt:friday},now:new Date('2026-10-27T12:59:00Z')}).held).toBe(false);
  expect(planLinkedinNextAction({candidate:{state:'relation_observed'},campaign,observations:{relationVerified:true,relationObservedAt:friday},now:new Date('2026-10-27T13:01:00Z')})).toMatchObject({held:true,reasons:['late_acceptance_review']});
 });
});

describe('admin production writers',()=>{
 const baseConfig={copy:{dm1:'Hi {firstName}, thanks for looking at our SWPPP bid.',followup1:'Checking in.',followup2:'Last note.'},followupDays:[3,7],budgets:{invite:2,dm:2}};
 it('registers the verified account in observe, then creates, approves and queues a campaign',async()=>{
  const reads=[];const client={getAccount:async()=>{reads.push('account');return {id:'derek',type:'LINKEDIN',sources:[{status:'OK'}]}},getSelf:async()=>{reads.push('me');return {provider_id:'ACo-derek',public_identifier:'derek-real'}}};
  await expect(registerLinkedinAccount({pool,client,companyId:company,accountId:'derek',actor:'admin',readBudget:500})).rejects.toMatchObject({code:'invalid_account_settings'});
  const registered=await registerLinkedinAccount({pool,client,companyId:company,accountId:'derek',actor:'admin',readBudget:20});
  expect(registered).toMatchObject({sender_provider_id:'ACo-derek',status:'healthy',mode:'observe',read_budget:20,read_timezone:'America/Chicago',sender_profile_url:'https://www.linkedin.com/in/derek-real/'});
  await expect(registerLinkedinAccount({pool,client:{...client,getSelf:async()=>({provider_id:'ACo-someone-else'})},companyId:company,accountId:'derek',actor:'admin',readBudget:20})).rejects.toMatchObject({code:'sender_changed'});
  const c=await candidate('derek','cohort');
  await expect(saveLinkedinCampaign({pool,companyId:company,accountId:'derek',actor:'admin',config:{...baseConfig,budgets:{invite:50,dm:50}},expiresAt:new Date(Date.now()+20*86_400_000).toISOString(),candidateIds:[c.id]})).rejects.toMatchObject({code:'budget_above_cap'});
  const campaign=await saveLinkedinCampaign({pool,companyId:company,accountId:'derek',actor:'admin',config:baseConfig,expiresAt:new Date(Date.now()+20*86_400_000).toISOString(),candidateIds:[c.id]});
  expect(campaign.config).toMatchObject({senderProviderId:'ACo-derek',timezone:'America/Chicago',lateAcceptancePolicy:'send_on_verified_observation',candidateSourceIds:['lead-cohort'],sources:['pipedrive'],ownerIds:['owner'],segments:['AGC'],territories:['all']});
  expect(campaign.status).toBe('unapproved');
  const approved=await approveLinkedinCampaign({pool,companyId:company,accountId:'derek',actor:'admin',campaignId:campaign.id,expectedRevision:campaign.revision});
  expect(approved.status).toBe('approved');expect(approved.approval_digest).toMatch(/^[0-9a-f]{64}$/);
  await expect(approveLinkedinCampaign({pool,companyId:company,accountId:'derek',actor:'admin',campaignId:campaign.id,expectedRevision:campaign.revision})).rejects.toMatchObject({code:'campaign_already_approved'});
  const revised=await saveLinkedinCampaign({pool,companyId:company,accountId:'derek',actor:'admin',campaignId:campaign.id,expectedRevision:campaign.revision,config:{budgets:{invite:1,dm:1}}});
  expect(revised).toMatchObject({revision:campaign.revision+1,status:'unapproved',approval_digest:null});
  expect(revised.config).toMatchObject({budgets:{invite:1,dm:1},candidateSourceIds:['lead-cohort'],copy:baseConfig.copy,lateAcceptancePolicy:'send_on_verified_observation'});
  expect((await queueLinkedinAction({pool,candidateId:c.id,campaignId:campaign.id,now:new Date('2027-10-19T15:00:00Z')}))).toMatchObject({state:'held',reason:'approval_unverified'});
  await approveLinkedinCampaign({pool,companyId:company,accountId:'derek',actor:'admin',campaignId:campaign.id,expectedRevision:revised.revision});
  const queued=await queueLinkedinAction({pool,candidateId:c.id,campaignId:campaign.id,now:new Date('2027-10-19T15:00:00Z')});
  expect(queued.step).toBe('invite');
  expect((await setLinkedinAccountMode({pool,companyId:company,accountId:'derek',actor:'admin',mode:'dry_run'})).mode).toBe('dry_run');
  const audit=(await pool.query("SELECT action FROM sdr_linkedin_admin_audit WHERE account_id='derek' ORDER BY created_at")).rows.map(r=>r.action);
  expect(audit).toEqual(['account.register','campaign.create','campaign.approve','campaign.update','campaign.approve','account.mode']);
 });
 it('stages only finished, unanswered AGC/LBA leads that resolve to a classic LinkedIn profile',async()=>{
  await account('stage');
  const lead=async(key,{trigger='AGC',sendStatus='sent',step='completed',current=3,total=3,origin=null,replied=false,completedDaysAgo=5}={})=>{
   await pool.query('INSERT INTO sdr_lead_state VALUES($1,$2,$3,$4,$5)',[`lead-${key}`,`person-${key}`,`${key}@example.test`,origin,'active']);
   const draft=(await pool.query('INSERT INTO sdr_drafts(trigger_type,contact_email_snapshot) VALUES($1,$2) RETURNING id',[trigger,`${key}@example.test`])).rows[0].id;
   await pool.query('INSERT INTO sdr_sends(draft_id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id,status,step_status,current_step,total_steps,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-make_interval(days=>$9::int))',[draft,`lead-${key}`,'seq',`apollo-${key}`,sendStatus,step,current,total,completedDaysAgo]);
   if(replied)await pool.query("INSERT INTO sdr_engagement_events(event_type,pipedrive_lead_id,occurred_at) VALUES('email_replied',$1,now())",[`lead-${key}`]);
  };
  await lead('ok');await lead('lba',{trigger:'LBA'});await lead('cm',{trigger:'CM'});await lead('midway',{step:'sent',current:2});await lead('replied',{replied:true});
  await lead('bid',{origin:'Bid Invite: BuildingConnected'});await lead('customer');await lead('fresh',{completedDaysAgo:1});await lead('connected');await lead('nolink');
  const people=key=>({id:`person-${key}`,owner_id:{id:42},org_id:{value:'org'},email:[{value:`${key}@example.test`}],first_name:'Pat',job_title:'Estimator'});
  const crm={getLead:async id=>({id,person_id:id.replace('lead-','person-'),organization_id:'org',owner_id:42,is_archived:false}),getPerson:async id=>people(id.replace('person-','')),getOrganization:async()=>({id:'org',name:'Example GC'})};
  const apollo={getContact:async id=>{const key=id.replace('apollo-','');return {id,email:`${key}@example.test`,contact_campaign_statuses:[{status:'finished'}],linkedin_url:key==='nolink'?null:`https://linkedin.com/in/${key}-li`}}};
  const reads=[];const client={getProfile:async({identifier})=>{reads.push(identifier);const key=identifier.replace('-li','');return {provider_id:`ACo-${key}`,public_identifier:identifier,is_relationship:key==='connected'}}};
  const result=await stageLinkedinCandidatesFromLeads({pool,client,crm,apollo,customerLookup:async id=>id==='lead-customer',companyId:company,accountId:'stage',actor:'admin',limit:10});
  expect(result.staged.map(s=>s.leadId).sort()).toEqual(['lead-lba','lead-ok']);
  expect(Object.fromEntries(result.skipped.map(s=>[s.leadId,s.reason]))).toEqual({'lead-customer':'customer','lead-connected':'already_connected','lead-nolink':'no_linkedin_profile'});
  expect(reads.sort()).toEqual(['connected-li','lba-li','ok-li']);
  const staged=(await pool.query("SELECT * FROM sdr_linkedin_candidates WHERE account_id='stage' AND source_id='lead-ok'")).rows[0];
  expect(staged).toMatchObject({state:'reviewed',person_id:'person-ok',owner_id:'owner',pipedrive_owner_id:'42',provider_id:'ACo-ok',profile_url:'https://www.linkedin.com/in/ok-li/',segment:'AGC',email_unanswered:true});
  expect(staged.source_context).toMatchObject({firstName:'Pat',firstNameVerified:true,facts:{company:{value:'Example GC',verified:true}}});
  expect((await pool.query("SELECT lead_id,verified_email,apollo_contact_id FROM sdr_linkedin_links WHERE candidate_id=$1",[staged.id])).rows).toEqual([{lead_id:'lead-ok',verified_email:'ok@example.test',apollo_contact_id:'apollo-ok'}]);
  const again=await stageLinkedinCandidatesFromLeads({pool,client,crm,apollo,customerLookup:async id=>id==='lead-customer',companyId:company,accountId:'stage',actor:'admin',limit:10});
  expect(again.staged).toEqual([]);
 });
 it('refuses every admin writer to a non-admin or machine session',async()=>{
  const app={routes:new Map(),get(){},patch(){},post(path,fn){this.routes.set(path,fn)}};
  let queries=0;registerSdrLinkedinRoutes(app,{pool:{query:async()=>{queries++;return {rows:[]}},connect:async()=>{queries++}},companyId:company,accountId:'derek',client:{}});
  for(const path of ['/api/sdr/linkedin/admin/account','/api/sdr/linkedin/admin/account/mode','/api/sdr/linkedin/admin/campaigns','/api/sdr/linkedin/admin/campaigns/:campaignId','/api/sdr/linkedin/admin/campaigns/:campaignId/approve','/api/sdr/linkedin/admin/candidates/stage'])for(const sdrUser of [{role:'sdr',sub:'rep'},{role:'admin',sub:'bot',machine:true}]){
   let code;const res={set(){return this},status(n){code=n;return this},json(){return this}};
   await app.routes.get(path)({sdrUser,body:{},params:{},query:{},headers:{}},res);expect(code).toBe(403);
  }
  expect(queries).toBe(0);
 });
});
