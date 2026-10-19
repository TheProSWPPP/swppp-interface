import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import pg from 'pg';import fs from 'node:fs/promises';
import {queueLinkedinAction,dispatchLinkedinAction} from '../sdrLinkedinOperations.js';
import {createLinkedinFreshContext} from '../sdrLinkedinFreshContext.js';import {startLinkedinRuntime} from '../sdrLinkedinRuntime.js';
import {linkedinHash} from '../sdrLinkedinStore.js';
const url=process.env.SDR_TEST_DATABASE_URL;if(!url)throw Error('SDR_TEST_DATABASE_URL required');if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('local database required');
const schema=`linkedin_journey_${process.pid}`,pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});let candidate,campaign;
const config={senderProviderId:'ACo-me',timezone:'America/Chicago',sendWindow:{weekdays:[1,2,3,4,5],start:'08:00',end:'17:00'},lateAcceptancePolicy:'send_on_verified_observation',followupDays:[3,7],budgets:{invite:2,dm:3},copy:{invite:'',dm1:'Hello.',followup1:'Checking in.',followup2:'Final note.'},segments:['AGC'],territories:['Illinois'],sources:['pipedrive'],candidateSourceIds:['lead-1'],ownerIds:['owner'],stopPolicy:'any_inbound'};
beforeAll(async()=>{
 await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(await fs.readFile(new URL('../../migrations/2026-10-16-sdr-linkedin-channel.sql',import.meta.url),'utf8'));
 await pool.query(`CREATE TABLE sdr_mailboxes(owner_user_id text,pipedrive_sender_id integer,active boolean); INSERT INTO sdr_mailboxes VALUES('owner',42,true); CREATE TABLE sdr_outreach_controls(company_id text,lead_id text,status text); CREATE TABLE sdr_job_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job text,scope text,status text,started_at timestamptz DEFAULT now(),finished_at timestamptz,counts jsonb DEFAULT '{}',cursor jsonb DEFAULT '{}',error_category text,next_retry_at timestamptz)`);
 await pool.query("INSERT INTO sdr_linkedin_accounts(company_id,account_id,sender_provider_id,status,mode,read_budget,read_timezone) VALUES('13105180','sender','ACo-me','healthy','live',100,'America/Chicago')");
 campaign=(await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id,status,approval_digest,cohort_digest,config,approved_by,approved_at,expires_at) VALUES('13105180','sender','approved',$1,'cohort-lead-1',$2,'owner',now(),'2030-01-01T00:00:00Z') RETURNING id`,[linkedinHash({companyId:'13105180',accountId:'sender',revision:1,config,cohort:'cohort-lead-1',expiresAt:'2030-01-01T00:00:00.000Z'}),JSON.stringify(config)])).rows[0].id;
 candidate=(await pool.query(`INSERT INTO sdr_linkedin_candidates(company_id,account_id,source,source_id,profile_url,segment,territory,person_id,organization_id,owner_id,pipedrive_owner_id,provider_id,product,state,campaign_id,email_sequence_complete_at,email_unanswered) VALUES('13105180','sender','pipedrive','lead-1','https://www.linkedin.com/in/one/','AGC','Illinois','person','org','owner','42','ACo-one','classic','reviewed',$1,now()-interval '1 day',true) RETURNING id`,[campaign])).rows[0].id;
 await pool.query(`INSERT INTO sdr_linkedin_links(company_id,account_id,candidate_id,person_id,organization_id,owner_id,lead_id,verified_email,apollo_contact_id,evidence) VALUES('13105180','sender',$1,'person','org','owner','lead-1','person@example.test','apollo-1','{"source":"pipedrive_export","personId":"person","leadId":"lead-1"}')`,[candidate]);
});afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});
describe('synthetic provider, real Postgres journey',()=>{
 it('moves invite, relation, DM1 and both due follow-ups without duplicate sends',async()=>{
  const now=new Date('2026-10-19T16:00:00Z'),sent=[];let connected=false,chat=false,calls=0,unknownDirection=false,chatIdentityMode="normal";
  const client={
   getAccount:async()=>({id:'sender',type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-me'}),getProfile:async()=>({provider_id:'ACo-one',public_identifier:'one'}),
   listSentInvites:async()=>({items:[],complete:true}),listRelations:async()=>({items:connected?[{provider_id:'ACo-one'}]:[],complete:true}),findChats:async()=>({items:chat?[{id:'chat-1',account_id:chatIdentityMode==='foreign'?'foreign':'sender',...(chatIdentityMode==='missing'?{}:{attendee_provider_id:'ACo-one'})}]:[],complete:true}),listMessages:async()=>({items:sent.map(id=>({id,is_sender:unknownDirection?undefined:true})),complete:true}),
   invite:async()=>{calls++;return {outcome:'confirmed',providerId:'inv-1'}},sendFirst:async()=>{calls++;chat=true;sent.push('dm-1');return {outcome:'confirmed',providerId:'dm-1',chatId:'chat-1'}},sendInChat:async()=>{calls++;const id=`follow-${calls}`;sent.push(id);return {outcome:'confirmed',providerId:id,chatId:'chat-1'}}};
  const crm={getPerson:async()=>({id:'person',org_id:'org',owner_id:42,email:[{value:'person@example.test'}]}),getOrganization:async()=>({id:'org'}),getLead:async()=>({id:'lead-1',person_id:'person',organization_id:'org',owner_id:42,is_archived:false})};
  const fresh=createLinkedinFreshContext({pool,client,crm,apollo:{getContact:async()=>({id:'apollo-1',email:'person@example.test',contact_campaign_statuses:[]})},customerLookup:async()=>false});
  const runtime=startLinkedinRuntime({pool,client,companyId:'13105180',accountId:'sender',mode:'live',readFreshContext:fresh,now:()=>now,scheduler:{setInterval:()=>1,clearInterval:()=>{}}});
  expect((await runtime.tick()).counts.considered).toBe(1);runtime.stop();
  const invite=(await pool.query("SELECT * FROM sdr_linkedin_actions WHERE candidate_id=$1 AND step='invite'",[candidate])).rows[0];expect(invite.state).toBe('confirmed');expect((await pool.query("SELECT COUNT(*)::int AS count FROM sdr_linkedin_actions WHERE candidate_id=$1 AND step='invite'",[candidate])).rows[0].count).toBe(1);
  connected=true;await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,source_at,observed_at,coverage,payload_hash) VALUES('13105180','sender',$1,'person','new_relation','fixture','ACo-one',$2,$2,'event','relation-one')`,[candidate,now]);
  const dm=await queueLinkedinAction({pool,candidateId:candidate,campaignId:campaign,now:new Date(now.getTime()+1000)});expect(dm.step).toBe('dm1');expect((await dispatchLinkedinAction({pool,client,actionId:dm.id,readFreshContext:fresh,mode:'live',now:new Date(now.getTime()+1000)})).state).toBe('confirmed');
  const follow1=await queueLinkedinAction({pool,candidateId:candidate,campaignId:campaign,now:new Date(now.getTime()+2000)});expect(follow1.step).toBe('followup1');expect((await dispatchLinkedinAction({pool,client,actionId:follow1.id,readFreshContext:fresh,mode:'live',now:new Date(follow1.due_at.getTime()+1000)})).state).toBe('confirmed');
  const follow2=await queueLinkedinAction({pool,candidateId:candidate,campaignId:campaign,now:new Date(follow1.due_at.getTime()+2000)});expect(follow2.step).toBe('followup2');expect((await dispatchLinkedinAction({pool,client,actionId:follow2.id,readFreshContext:fresh,mode:'live',now:new Date(follow2.due_at.getTime()+1000)})).state).toBe('confirmed');expect(calls).toBe(4);
  unknownDirection=true;
  const [action,candidateRow,campaignRow,accountRow]=await Promise.all([pool.query('SELECT * FROM sdr_linkedin_actions WHERE id=$1',[follow2.id]),pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1',[candidate]),pool.query('SELECT * FROM sdr_linkedin_campaigns WHERE id=$1',[campaign]),pool.query("SELECT * FROM sdr_linkedin_accounts WHERE account_id='sender'")]);
  expect((await fresh({action:action.rows[0],candidate:candidateRow.rows[0],campaign:campaignRow.rows[0],account:accountRow.rows[0],now:new Date(follow2.due_at.getTime()+2000)})).allowed).toBe(false);
  unknownDirection=false;chatIdentityMode='missing';
  expect((await fresh({action:action.rows[0],candidate:candidateRow.rows[0],campaign:campaignRow.rows[0],account:accountRow.rows[0],now:new Date(follow2.due_at.getTime()+2000)})).allowed).toBe(false);
  chatIdentityMode='foreign';
  expect((await fresh({action:action.rows[0],candidate:candidateRow.rows[0],campaign:campaignRow.rows[0],account:accountRow.rows[0],now:new Date(follow2.due_at.getTime()+2000)})).allowed).toBe(false);
  chatIdentityMode='normal';
  expect((await fresh({action:{...action.rows[0],provider_chat_id:'wrong-chat'},candidate:candidateRow.rows[0],campaign:campaignRow.rows[0],account:accountRow.rows[0],now:new Date(follow2.due_at.getTime()+2000)})).allowed).toBe(false);
 });
});
