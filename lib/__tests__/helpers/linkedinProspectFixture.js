// Shared synthetic fixtures for the LinkedIn prospect lanes. Local disposable Postgres only.
import fs from 'node:fs/promises';
import pg from 'pg';
import {linkedinHash} from '../../sdrLinkedinStore.js';

export function testPool(prefix){
 const url=process.env.SDR_TEST_DATABASE_URL;
 if(!url)throw Error('SDR_TEST_DATABASE_URL required');
 if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('local database required');
 const schema=`${prefix}_${process.pid}`;
 return {schema,pool:new pg.Pool({connectionString:url,options:`-c search_path=${schema}`})};
}

export const MIGRATIONS=['2026-10-16-sdr-linkedin-channel.sql','2026-10-26-sdr-linkedin-golive.sql','2026-11-03-sdr-linkedin-prospects.sql'];
export async function createProspectSchema(pool,schema){
 await pool.query(`CREATE SCHEMA ${schema}`);
 for(const file of MIGRATIONS)await pool.query(await fs.readFile(new URL(`../../../migrations/${file}`,import.meta.url),'utf8'));
 await pool.query(`CREATE TABLE sdr_mailboxes(owner_user_id text,pipedrive_sender_id integer,active boolean); INSERT INTO sdr_mailboxes VALUES('owner',42,true);
  CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,person_email text,lead_origin text,crm_status text,person_name text,trigger_type text);
  CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,status text);
  CREATE TABLE sdr_outreach_controls(company_id text,lead_id text,status text,scope_kind text,scope_id text,channel text);
  CREATE TABLE IF NOT EXISTS sdr_job_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job text,scope text,status text,started_at timestamptz DEFAULT now(),finished_at timestamptz,counts jsonb DEFAULT '{}',cursor jsonb DEFAULT '{}',error_category text,next_retry_at timestamptz)`);
}

export const COPY={
 A:{dm1:'Hey {firstName}, A1 {company}.',followup1:'Hey {firstName}, A2.',followup2:'Hey {firstName}, A3.',inmail:{subject:'SWPPPs at {company}',body:'Hey {firstName}, InMail {state}.'}},
 B:{dm1:'Hey {firstName}, B1 {newCompany} {oldCompany}.',followup1:'Hey {firstName}, B2.',inmail:{subject:'SWPPPs at {company}',body:'Hey {firstName}, InMail {state}.'}},
 C:{dm1:'Hey {firstName}, C1 {company}[[, most recently {lastProject}]].',followup1:'Hey {firstName}, C2.'},
 D:{dm1:'Hey {firstName}, D1 {topic}, {reaction}. {state}',followup1:'Hey {firstName}, A2.',followup2:'Hey {firstName}, A3.'},
};
export function prospectConfig({lane='A',sourceIds=['one'],budgets={},territories=['TX'],copy,...rest}={}){
 return {senderProviderId:'ACo-sender',timezone:'America/Chicago',sendWindow:{weekdays:[1,2,3,4,5],start:'08:00',end:'17:00'},lateAcceptancePolicy:'send_on_verified_observation',
  lane,inmail:lane==='A'||lane==='B',followupDays:lane==='B'||lane==='C'?[4]:[3,7],copy:copy||COPY[lane],budgets:{invite:5,dm:5,inmail:1,withdraw:1,...budgets},
  segments:[lane],territories,sources:['linkedin_prospect'],candidateSourceIds:sourceIds,ownerIds:['owner'],stopPolicy:'any_inbound',...rest};
}
export const approvalDigest=(accountId,config,cohort='cohort',revision=1)=>linkedinHash({companyId:'13105180',accountId,revision,config,cohort,expiresAt:'2030-01-01T00:00:00.000Z'});
export async function insertAccount(pool,accountId,{mode='live',readBudget=100,rampStartedOn='2027-09-01',status='healthy',inmailBalance=null}={}){
 await pool.query(`INSERT INTO sdr_linkedin_accounts(company_id,account_id,sender_provider_id,status,mode,read_budget,read_timezone,ramp_started_on,inmail_balance,inmail_balance_observed_at) VALUES('13105180',$1,'ACo-sender',$2,$3,$4,'America/Chicago',$5,$6,CASE WHEN $6::int IS NULL THEN NULL ELSE now() END)`,[accountId,status,mode,readBudget,rampStartedOn,inmailBalance]);
}
export async function insertCampaign(pool,accountId,config,{status='approved'}={}){
 return (await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id,status,approval_digest,cohort_digest,config,approved_by,approved_at,expires_at) VALUES('13105180',$1,$2,$3,'cohort',$4,'owner',now(),'2030-01-01T00:00:00Z') RETURNING id`,[accountId,status,approvalDigest(accountId,config),JSON.stringify(config)])).rows[0].id;
}
export const personOf=key=>`li:ACo-${key}`;
export async function insertProspect(pool,accountId,key,{lane='A',campaignId=null,state='reviewed',territory='TX',email=`${key}@example.test`,firm='Example GC',facts}={}){
 const context={firstName:'Pat',firstNameVerified:true,fullName:`Pat ${key}`,facts:facts||{company:{value:firm,verified:true},newCompany:{value:firm,verified:true},oldCompany:{value:'Old GC',verified:true},state:{value:'Texas',verified:true}}};
 return (await pool.query(`INSERT INTO sdr_linkedin_candidates(company_id,account_id,source,source_id,profile_url,segment,territory,firm,role,person_id,organization_id,owner_id,provider_id,product,state,campaign_id,lane,priority,title_rank,resolved_email,source_context,company_key)
  VALUES('13105180',$1,'linkedin_prospect',$2,$3,$4,$5,$6,'Director of Preconstruction',$7,'example gc','owner',$8,'classic',$9,$10,$4,1000,1,$11,$12,'example gc') RETURNING *`,
 [accountId,key,`https://www.linkedin.com/in/${key}/`,lane,territory,firm,personOf(key),`ACo-${key}`,state,campaignId,email,JSON.stringify(context)])).rows[0];
}
export async function insertAction(pool,accountId,candidate,campaignId,{step='invite',dueAt="now()-interval '1 minute'",contextHash='hash',body=null,state='pending'}={}){
 return (await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,body,state) VALUES('13105180',$1,$2,$3,$4,1,$5,$6,${dueAt},$7,$8,$9) RETURNING *`,
 [accountId,candidate.id,candidate.person_id,campaignId,step,`${step}-${candidate.id}`,contextHash,body,state])).rows[0];
}
// A fully green synthetic Unipile seat for one prospect; tests flip the fields they need.
export function fakeSeat({accountId,providerId,publicId,state={}}){
 const calls=[];const s={connected:false,invited:false,chats:[],sent:[],...state};
 const client={calls,state:s,
  getAccount:async()=>{calls.push('getAccount');return {id:accountId,type:'LINKEDIN',sources:[{status:'OK'}]}},
  getSelf:async()=>{calls.push('getSelf');return {provider_id:'ACo-sender'}},
  getProfile:async()=>{calls.push('getProfile');return {provider_id:providerId,public_identifier:publicId,is_relationship:s.connected,...(s.invited&&!s.connected?{invitation:{type:'SENT',status:'PENDING'}}:{})}},
  findChats:async()=>{calls.push('findChats');return {complete:true,items:s.chats}},
  listMessages:async()=>{calls.push('listMessages');return {complete:true,items:s.sent.map(id=>({id,is_sender:true}))}},
  getInmailBalance:async()=>{calls.push('getInmailBalance');return {sales_navigator:s.inmailBalance??10}},
  invite:async()=>{calls.push('invite');s.invited=true;return {outcome:'confirmed',providerId:`inv-${publicId}`}},
  sendFirst:async()=>{calls.push('sendFirst');s.chats=[{id:`chat-${publicId}`,account_id:accountId,attendee_provider_id:providerId}];s.sent.push(`dm-${publicId}`);return {outcome:'confirmed',providerId:`dm-${publicId}`,chatId:`chat-${publicId}`}},
  sendInChat:async()=>{calls.push('sendInChat');const id=`msg-${publicId}-${s.sent.length}`;s.sent.push(id);return {outcome:'confirmed',providerId:id,chatId:`chat-${publicId}`}},
  sendInmail:async()=>{calls.push('sendInmail');return {outcome:'confirmed',providerId:`inmail-${publicId}`,chatId:`inmail-chat-${publicId}`}},
  withdrawInvite:async({invitationId})=>{calls.push('withdrawInvite');s.invited=false;return {outcome:'confirmed',providerId:invitationId}},
 };
 return client;
}
export const writes=client=>client.calls.filter(c=>['invite','sendFirst','sendInChat','sendInmail','withdrawInvite'].includes(c));
