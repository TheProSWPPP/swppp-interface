import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import express from 'express';
import {registerSdrLinkedinRoutes} from '../sdrLinkedinRoutes.js';
import {dispatchLinkedinAction,queueLinkedinAction} from '../sdrLinkedinOperations.js';
import {validateLinkedinCampaign} from '../sdrLinkedinPolicy.js';
import {linkedinHash} from '../sdrLinkedinStore.js';
import {testPool,createProspectSchema,insertAccount} from './helpers/linkedinProspectFixture.js';

// Retired 2026-11-03 (Derek): LinkedIn no longer stages or messages AGC, LBA or bid-invite leads.
const {schema,pool}=testPool('linkedin_retired',{skipWithoutDb:true});
let server,base;
beforeAll(async()=>{
 if(!pool)return;
 await createProspectSchema(pool,schema);
 await insertAccount(pool,'sender');
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser={role:'admin',sub:'admin',username:'admin'};next()});
 registerSdrLinkedinRoutes(app,{pool,companyId:'13105180',accountId:'sender',mode:'live',client:{}});
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});base=`http://127.0.0.1:${server.address().port}`;
});
afterAll(async()=>{if(!pool)return;await new Promise(resolve=>server.close(resolve));await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});

describe.skipIf(!pool)('retired Pipedrive LinkedIn path',()=>{
 it('no longer serves the AGC/LBA stage route',async()=>{
  const response=await fetch(`${base}/api/sdr/linkedin/admin/candidates/stage`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"limit":5}'});
  expect(response.status).toBe(404);
 });
 it('never approves or dispatches an old approved Pipedrive campaign',async()=>{
  const config={senderProviderId:'ACo-sender',timezone:'America/Chicago',sendWindow:{weekdays:[1,2,3,4,5],start:'08:00',end:'17:00'},lateAcceptancePolicy:'send_on_verified_observation',followupDays:[3,7],budgets:{invite:5,dm:5},copy:{dm1:'A',followup1:'B',followup2:'C'},segments:['AGC'],territories:['all'],sources:['pipedrive'],candidateSourceIds:['lead-1'],ownerIds:['owner'],stopPolicy:'any_inbound'};
  const digest=linkedinHash({companyId:'13105180',accountId:'sender',revision:1,config,cohort:'cohort',expiresAt:'2030-01-01T00:00:00.000Z'});
  const campaign=(await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id,status,approval_digest,cohort_digest,config,approved_by,approved_at,expires_at) VALUES('13105180','sender','approved',$1,'cohort',$2,'owner',now(),'2030-01-01T00:00:00Z') RETURNING *`,[digest,JSON.stringify(config)])).rows[0];
  const view={companyId:'13105180',accountId:'sender',revision:1,status:'approved',approvalDigest:digest,cohortDigest:'cohort',approvedBy:'owner',approvedAt:campaign.approved_at,expiresAt:campaign.expires_at,config};
  const verdict=validateLinkedinCampaign(view);expect(verdict.allowed).toBe(false);expect(verdict.reasons).toContain('source_retired');
  const candidate=(await pool.query(`INSERT INTO sdr_linkedin_candidates(company_id,account_id,source,source_id,profile_url,segment,territory,person_id,organization_id,owner_id,pipedrive_owner_id,provider_id,product,state,campaign_id,email_sequence_complete_at,email_unanswered) VALUES('13105180','sender','pipedrive','lead-1','https://www.linkedin.com/in/old/','AGC','all','person','org','owner','42','ACo-old','classic','reviewed',$1,now()-interval '10 days',true) RETURNING id`,[campaign.id])).rows[0];
  expect(await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:campaign.id,now:new Date('2027-10-19T16:00:00Z')})).toEqual({state:'held',reason:'approval_unverified'});
  // An action queued before the retirement is held at dispatch, before any provider call.
  const action=(await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash) VALUES('13105180','sender',$1,'person',$2,1,'invite','old-invite',now()-interval '1 minute','hash') RETURNING id`,[candidate.id,campaign.id])).rows[0];
  const transport=[];const client=new Proxy({},{get:(_,name)=>async()=>{transport.push(String(name));return {outcome:'confirmed',providerId:'x'}}});
  expect(await dispatchLinkedinAction({pool,client,actionId:action.id,readFreshContext:async()=>({allowed:true,contextHash:'hash'}),mode:'live',now:new Date('2027-10-19T16:00:00Z')})).toEqual({state:'held',reason:'local_gate_failed'});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_actions WHERE id=$1',[action.id])).rows[0]).toEqual({state:'held',hold_reason:'local_gate_failed'});
  expect(transport).toEqual([]);
 });
});
