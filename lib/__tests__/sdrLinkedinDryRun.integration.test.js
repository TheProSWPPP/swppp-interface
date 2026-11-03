import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {previewProspectDay} from '../sdrLinkedinProspect.js';
import {startLinkedinRuntime} from '../sdrLinkedinRuntime.js';
import {testPool,createProspectSchema,prospectConfig,insertAccount,insertCampaign,insertProspect} from './helpers/linkedinProspectFixture.js';
import {laneCampaignDefaults} from '../sdrLinkedinLaneCopy.js';

const {schema,pool}=testPool('linkedin_dry_run',{skipWithoutDb:true});
const NOW=new Date('2026-11-04T15:00:00Z');
const transport=[];
const client=new Proxy({},{get:(_,name)=>name==='then'?undefined:async()=>{transport.push(String(name));throw new Error('no provider call expected')}});
beforeAll(async()=>{
 if(!pool)return;
 await createProspectSchema(pool,schema);
 await insertAccount(pool,'sender',{mode:'dry_run',rampStartedOn:'2026-11-04'});
 const a=await insertCampaign(pool,'sender',prospectConfig({lane:'A',copy:laneCampaignDefaults('A').copy}),{status:'unapproved'});
 for(const [key,priority,lane] of [['last',3150,'A'],['first',150,'B'],['third',1250,'D'],['second',1100,'D'],['fourth',2100,'C'],['fifth',3100,'A'],['sixth',3120,'A']]){
  const row=await insertProspect(pool,'sender',key,{lane,campaignId:lane==='A'?a:null});
  await pool.query('UPDATE sdr_linkedin_candidates SET priority=$2 WHERE id=$1',[row.id,priority]);
 }
 const facts={company:{value:'Example GC',verified:true}};
 const missingState=await insertProspect(pool,'sender','nostate',{lane:'A',facts});await pool.query('UPDATE sdr_linkedin_candidates SET priority=10 WHERE id=$1',[missingState.id]);
 await insertProspect(pool,'sender','poster',{lane:'D',state:'copy_review',facts:{...facts,topic:{value:'permits',verified:false,draft:true},reaction:{value:'good read',verified:false,draft:true}}});
});
afterAll(async()=>{if(!pool)return;await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});

describe.skipIf(!pool)('prospect dry run',()=>{
 it('lists today in dispatch order, cut at the ramp budget (lane A keeps at least half), with the rendered copy and no provider call',async()=>{
  const day=await previewProspectDay(pool,{companyId:'13105180',accountId:'sender',now:NOW});
  expect(day.providerCalls).toBe(0);
  expect(day.ramp).toMatchObject({started:true,rampStartedOn:'2026-11-04',weekInRamp:1,rampBudget:5,usedToday:0,remaining:5,laneAShare:3,otherLanesShare:2});
  const ordered=Object.values(day.lanes).flat().sort((x,y)=>x.order-y.order).map(p=>p.profileUrl.split('/')[4]);
  // 3 of the 5 for lane A (nostate, fifth, sixth); B and D, warmest first, get the other 2.
  expect(ordered).toEqual(['nostate','first','second','fifth','sixth']);
  const nostate=day.lanes.A.find(p=>p.profileUrl.includes('nostate'));
  expect(nostate.copy.dm1.body).toBe("Hey Pat, appreciate the connection. Congrats on the new role at Example GC. Who's handling the SWPPPs over there these days?");
  expect(nostate.copy.inmail).toMatchObject({body:null,reason:'copy_facts_unverified',missing:['state']});
  expect(day.lanes.B[0].copy.dm1.body).toBe("Hey Pat, saw you made the move to Example GC. Congrats man. We miss doing your SWPPPs from the Old GC days. Who's handling stormwater over there?");
  expect(day.lanes.B[0].copy.followup2).toBeUndefined();
  expect(day.lanes.D[0].copy.dm1).toMatchObject({body:null,missing:['topic','reaction']});
  expect(day.awaitingCopy.map(p=>p.topic)).toEqual(['permits']);
  expect(day.held).toEqual({copy_review:1});
  expect(transport).toEqual([]);
 });
 it('the runtime dry-run mode stores counts only and still makes no provider call',async()=>{
  const runtime=startLinkedinRuntime({pool,client,companyId:'13105180',accountId:'sender',mode:'dry_run',now:()=>NOW,scheduler:{setInterval:()=>1,clearInterval(){}}});
  expect(await runtime.ready).toBe(true);
  const result=await runtime.tick();runtime.stop();
  expect(result.counts).toMatchObject({wouldInvite:5,rampBudget:5,awaitingCopy:1});
  const run=(await pool.query("SELECT counts FROM sdr_job_runs WHERE job='linkedin' ORDER BY started_at DESC LIMIT 1")).rows[0];
  expect(run.counts).toMatchObject({wouldInvite:5,rampBudget:5});
  expect(transport).toEqual([]);
  expect((await pool.query('SELECT count(*)::int AS n FROM sdr_linkedin_actions')).rows[0].n).toBe(0);
 });
});
