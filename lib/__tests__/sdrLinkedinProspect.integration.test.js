import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {prospectSkipReason,stageProspect,stageLane,stageMovedContact,holdLinkedinLaneForPerson} from '../sdrLinkedinProspect.js';
import {approveLaneDCopy} from '../sdrLinkedinLaneDCopy.js';
import {assignLinkedinCampaign,previewLinkedinCampaign} from '../sdrLinkedinOfflineReview.js';
import {APIFY_ACTORS} from '../apifyClient.js';
import {testPool,createProspectSchema,prospectConfig,insertAccount,insertProspect} from './helpers/linkedinProspectFixture.js';

const {schema,pool}=testPool('linkedin_prospect',{skipWithoutDb:true});
const NOW=new Date('2026-11-03T16:00:00Z');
const company='13105180';
const person=(key,extra={})=>({firstName:'Pat',lastName:key,profileUrl:`https://www.linkedin.com/in/${key}/`,email:`${key}@example.test`,company:'Big GC',title:'Director of Preconstruction',stateCode:'TX',publicIdentifier:key,evidence:{source:'apify',runId:'run-1'},...extra});
const skip=(p,lane='A',opts={})=>prospectSkipReason(pool,{companyId:company,person:p,lane,now:NOW,customerCheck:async()=>null,...opts});
beforeAll(async()=>{
 if(!pool)return;
 await createProspectSchema(pool,schema);
 await pool.query(`CREATE TABLE sdr_message_facts(direction text,prospect_email text,human_reply boolean,occurred_at timestamptz);CREATE TABLE sdr_engagement_events(event_type text,pipedrive_lead_id text,occurred_at timestamptz)`);
 await insertAccount(pool,'sender',{mode:'observe'});
});
afterAll(async()=>{if(!pool)return;await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});
beforeEach(async()=>{if(!pool)return;await pool.query('TRUNCATE sdr_linkedin_candidates,sdr_linkedin_actions,sdr_linkedin_events,sdr_lead_state,sdr_sends,sdr_message_facts,sdr_engagement_events,sdr_linkedin_search_runs,sdr_linkedin_campaigns')});

describe.skipIf(!pool)('prospect skip rules, one per reason',()=>{
 it('skips someone in an active Pipedrive sequence, by email and by name',async()=>{
  await pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,person_email,person_name,trigger_type,crm_status) VALUES('l1','seq@example.test','Someone Else','CM','active'),('l2','other@example.test','Pat  Named','CM','active')");
  await pool.query("INSERT INTO sdr_sends(pipedrive_lead_id,status) VALUES('l1','enrolled'),('l2','enrolled')");
  expect(await skip(person('seq'))).toBe('pipedrive_active_sequence');
  expect(await skip(person('named',{email:null,lastName:'Named'}))).toBe('pipedrive_active_sequence');
  await pool.query("UPDATE sdr_sends SET status='sent'");
  expect(await skip(person('seq'))).toBeNull();
 });
 it('leaves AGC, LBA and bid-invite contacts to email and calls',async()=>{
  await pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,person_email,person_name,trigger_type,lead_origin,crm_status) VALUES('a1','agc@example.test',NULL,'AGC',NULL,'active'),('b1','bid@example.test',NULL,'CM','Bid Invite: BuildingConnected','active'),('x1','gone@example.test',NULL,'LBA',NULL,'archived')");
  expect(await skip(person('agc'))).toBe('agc_lba_or_bid_invite');
  expect(await skip(person('bid'))).toBe('agc_lba_or_bid_invite');
  expect(await skip(person('gone'))).toBeNull();
 });
 it('skips anyone we emailed in the last 3 days but not 4',async()=>{
  await pool.query("INSERT INTO sdr_message_facts VALUES('out','recent@example.test',null,$1),('out','older@example.test',null,$2)",[new Date(NOW-2*86_400_000),new Date(NOW-4*86_400_000)]);
  expect(await skip(person('recent'))).toBe('emailed_last_3_days');
  expect(await skip(person('older'))).toBeNull();
  await pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,person_email,trigger_type,crm_status) VALUES('e1','apollo@example.test','CM','active')");
  await pool.query("INSERT INTO sdr_engagement_events VALUES('email_sent','e1',$1)",[new Date(NOW-86_400_000)]);
  expect(await skip(person('apollo'))).toBe('emailed_last_3_days');
 });
 it('the 3-day rule reads every source the bid invite engine reads: a bid invite email or a permit email 2 days ago counts',async()=>{
  await pool.query(`CREATE TABLE bid_invite_sends(recipient_email text,status text,sent_at timestamptz,claimed_at timestamptz);
   CREATE TABLE permit_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text);CREATE TABLE permit_sends(draft_id uuid,status text,sent_at timestamptz)`);
  try{
   await pool.query("INSERT INTO bid_invite_sends VALUES('bid2@example.test','sent',$1,$1),('bid5@example.test','sent',$2,$2)",[new Date(NOW-2*86_400_000),new Date(NOW-5*86_400_000)]);
   const draft=(await pool.query("INSERT INTO permit_drafts(email) VALUES('permit@example.test') RETURNING id")).rows[0].id;
   await pool.query("INSERT INTO permit_sends VALUES($1,'sent',$2)",[draft,new Date(NOW-86_400_000)]);
   expect(await skip(person('bid2'))).toBe('emailed_last_3_days');
   expect(await skip(person('bid5'))).toBeNull();
   expect(await skip(person('permit'))).toBe('emailed_last_3_days');
  }finally{await pool.query('DROP TABLE bid_invite_sends,permit_sends,permit_drafts')}
 });
 it('skips a recent human reply',async()=>{
  await pool.query("INSERT INTO sdr_message_facts VALUES('in','replied@example.test',true,now())");
  expect(await skip(person('replied'))).toBe('recent_reply');
 });
 it('skips a customer company for lane A and D, never for C, and holds when the check cannot run',async()=>{
  const customer=async name=>name==='Big GC'?{reason:'tagged'}:null;
  expect(await skip(person('cust'),'A',{customerCheck:customer})).toBe('customer_company');
  expect(await skip(person('cust'),'D',{customerCheck:customer})).toBe('customer_company');
  expect(await skip(person('cust'),'C',{customerCheck:customer})).toBeNull();
  expect(await skip(person('cust'),'A',{customerCheck:async()=>{throw new Error('pipedrive down')}})).toBe('customer_check_unavailable');
  expect(await skip(person('cust',{company:null}),'A')).toBe('customer_check_unavailable');
 });
 it('stops the same person sitting in two lanes',async()=>{
  const staged=await stageProspect(pool,{companyId:company,accountId:'sender',lane:'A',person:{...person('twice'),providerId:'ACo-twice'},facts:{},actor:'admin',ownerId:'owner',now:NOW});
  expect(staged).toMatchObject({state:'reviewed',person_id:'li:ACo-twice',lane:'A',segment:'A',owner_id:'owner',provider_id:'ACo-twice',resolved_email:'twice@example.test'});
  expect(await skip(person('twice'),'B')).toBe('already_candidate');
  await expect(stageProspect(pool,{companyId:company,accountId:'sender',lane:'B',person:{...person('twice'),providerId:'ACo-twice'},facts:{},actor:'admin',ownerId:'owner',now:NOW})).rejects.toMatchObject({code:'already_candidate'});
 });
});

describe.skipIf(!pool)('lane staging with the finalist seat read',()=>{
 const apifyFor=people=>({configured:true,runActor:async({actor,input,allowEmpty})=>{if(actor===APIFY_ACTORS.profileSearch&&input.recentlyPostedOnLinkedIn)return [];const items=people.map(id=>({publicIdentifier:id,linkedinUrl:`https://www.linkedin.com/in/${id}`,firstName:'Pat',lastName:id,location:{linkedinText:'Austin, Texas, United States'},currentPosition:[{position:'Chief Estimator',companyName:'Big GC',dateRange:{start:{month:7,year:2026}}}]}));if(!items.length&&!allowEmpty)throw Object.assign(new Error('apify_empty_result'),{code:'apify_empty_result'});return items}});
 const seat=({connected=[],pending=[]}={})=>{const reads=[];return {reads,getProfile:async({identifier})=>{reads.push(identifier);return {provider_id:`ACo-${identifier}`,public_identifier:identifier,is_relationship:connected.includes(identifier),...(pending.includes(identifier)?{invitation:{status:'PENDING'}}:{})}}}};
 it('lists existing connections and pending invites for review instead of staging them',async()=>{
  const client=seat({connected:['linked'],pending:['waiting']});
  const result=await stageLane({pool,client,apify:apifyFor(['fresh','linked','waiting']),lane:'A',limit:10,companyId:company,accountId:'sender',actor:'admin',ownerId:'owner',states:['TX'],now:NOW,customerCheck:async()=>null});
  expect(result.staged.map(s=>s.profileUrl)).toEqual(['https://www.linkedin.com/in/fresh/']);
  expect(result.skipped).toEqual({already_connected:1,pending_invite:1});
  expect(client.reads.sort()).toEqual(['fresh','linked','waiting']);
  const run=(await pool.query('SELECT state,items,staged,skipped FROM sdr_linkedin_search_runs WHERE id=$1',[result.runId])).rows[0];
  expect(run).toMatchObject({state:'complete',items:3,staged:1,skipped:{already_connected:1,pending_invite:1}});
 });
 it('dry run makes no seat read and no insert',async()=>{
  const client=seat();
  const result=await stageLane({pool,client,apify:apifyFor(['one','two']),lane:'A',limit:10,dryRun:true,companyId:company,accountId:'sender',actor:'admin',ownerId:null,states:['TX'],now:NOW,customerCheck:async()=>null});
  expect(result.wouldStage.map(p=>p.name)).toEqual(['Pat one','Pat two']);expect(client.reads).toEqual([]);
  expect((await pool.query('SELECT count(*)::int AS n FROM sdr_linkedin_candidates')).rows[0].n).toBe(0);
 });
 it('refuses real staging without an owner or served states',async()=>{
  await expect(stageLane({pool,client:seat(),apify:apifyFor(['x']),lane:'A',companyId:company,accountId:'sender',actor:'admin',ownerId:null,states:['TX']})).rejects.toMatchObject({code:'owner_unconfigured'});
  await expect(stageLane({pool,client:seat(),apify:apifyFor(['x']),lane:'A',companyId:company,accountId:'sender',actor:'admin',ownerId:'owner',states:[]})).rejects.toMatchObject({code:'states_unconfigured'});
 });
 it('stages a moved old contact in lane B with the old company from the CSV',async()=>{
  const result=await stageMovedContact({pool,client:seat(),companyId:company,accountId:'sender',actor:'admin',ownerId:'owner',row:{id:null,full_name:'Randy Smith',company:'Flintco',email:'randy@flintco.com'},person:{...person('randy',{company:'Crossland Construction'}),email:null},states:['TX'],now:NOW});
  const row=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1',[result.staged.candidateId])).rows[0];
  expect(row).toMatchObject({lane:'B',state:'reviewed',resolved_email:'randy@flintco.com'});
  expect(row.source_context.facts).toMatchObject({newCompany:{value:'Crossland Construction',verified:true},oldCompany:{value:'Flintco',verified:true},state:{value:'Texas',verified:true}});
  expect(row.priority).toBeLessThan(1000);
 });
});

describe.skipIf(!pool)('lane D copy approval',()=>{
 it('lands in copy_review and cannot join a campaign until its line is approved',async()=>{
  const staged=await stageProspect(pool,{companyId:company,accountId:'sender',lane:'D',person:{...person('poster'),providerId:'ACo-poster'},facts:{company:{value:'Big GC',verified:true},state:{value:'Texas',verified:true},topic:{value:'the new permit',verified:false,draft:true},reaction:{value:'good read',verified:false,draft:true}},actor:'admin',ownerId:'owner',post:{url:null,excerpt:'Permit post',postedAt:null},now:NOW});
  expect(staged.state).toBe('copy_review');
  const campaign=await previewLinkedinCampaign({pool,companyId:company,accountId:'sender',config:prospectConfig({lane:'D',sourceIds:[staged.source_id]}),expiresAt:'2030-01-01T00:00:00Z',reviewer:'admin',now:NOW});
  await expect(assignLinkedinCampaign({pool,companyId:company,accountId:'sender',candidateId:staged.id,campaignId:campaign.id,expectedRevision:staged.revision,reviewer:'admin'})).rejects.toMatchObject({code:'assignment_unverified'});
  await expect(approveLaneDCopy(pool,{companyId:company,accountId:'sender',candidateId:staged.id,expectedRevision:staged.revision-1,topic:'x',reaction:'y',actor:'admin'})).rejects.toMatchObject({code:'revision_conflict'});
  const approved=await approveLaneDCopy(pool,{companyId:company,accountId:'sender',candidateId:staged.id,expectedRevision:staged.revision,topic:'the new EPA permit',reaction:'a clear breakdown of the NOI',actor:'admin'});
  expect(approved.state).toBe('reviewed');
  expect(approved.source_context.facts.reaction).toMatchObject({value:'a clear breakdown of the NOI',verified:true,approvedBy:'admin'});
  expect((await assignLinkedinCampaign({pool,companyId:company,accountId:'sender',candidateId:staged.id,campaignId:campaign.id,expectedRevision:approved.revision,reviewer:'admin'})).campaign_id).toBe(campaign.id);
  expect((await pool.query("SELECT action FROM sdr_linkedin_admin_audit WHERE target_id=$1",[staged.id])).rows).toEqual([{action:'lane_d.approve'}]);
 });
});

describe.skipIf(!pool)('cross-sequence reply exit hook',()=>{
 it('holds a person by email and cancels their pending LinkedIn steps',async()=>{
  const row=await insertProspect(pool,'sender','exit',{lane:'A'});
  await pool.query(`INSERT INTO sdr_linkedin_campaigns(id,company_id,account_id) VALUES('00000000-0000-0000-0000-0000000000aa','13105180','sender')`);
  await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash) VALUES('13105180','sender',$1,$2,'00000000-0000-0000-0000-0000000000aa',1,'invite','exit-invite',now(),'h')`,[row.id,row.person_id]);
  expect(await holdLinkedinLaneForPerson(pool,{companyId:company,email:'EXIT@example.test',reason:'email_reply'})).toEqual({held:1});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_candidates WHERE id=$1',[row.id])).rows[0]).toEqual({state:'held',hold_reason:'email_reply'});
  expect((await pool.query('SELECT state FROM sdr_linkedin_actions WHERE candidate_id=$1',[row.id])).rows[0].state).toBe('cancelled');
  expect(await holdLinkedinLaneForPerson(pool,{companyId:company,email:'exit@example.test'})).toEqual({held:0});
 });
});
