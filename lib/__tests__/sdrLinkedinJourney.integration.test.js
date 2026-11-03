import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {queueLinkedinAction,dispatchLinkedinAction} from '../sdrLinkedinOperations.js';
import {createLinkedinProspectFreshContext} from '../sdrLinkedinProspectFreshContext.js';import {startLinkedinRuntime} from '../sdrLinkedinRuntime.js';
import {testPool,createProspectSchema,prospectConfig,insertAccount,insertCampaign,insertProspect} from './helpers/linkedinProspectFixture.js';
// Prospect lane A since 2026-11-03 (the Pipedrive path is retired); the same fences and journey.
const {schema,pool}=testPool('linkedin_journey');let candidate,campaign;
const config=prospectConfig({lane:'A',sourceIds:['one'],budgets:{invite:2,dm:3},copy:{dm1:'Hello.',followup1:'Checking in.',followup2:'Final note.',inmail:{subject:'S',body:'I'}}});
const noCustomer=async()=>null;
beforeAll(async()=>{
 await createProspectSchema(pool,schema);
 await pool.query("UPDATE sdr_mailboxes SET owner_user_id='owner'");
 await insertAccount(pool,'sender',{rampStartedOn:'2026-10-01'});await pool.query("UPDATE sdr_linkedin_accounts SET sender_provider_id='ACo-me' WHERE account_id='sender'");
 config.senderProviderId='ACo-me';
 campaign=await insertCampaign(pool,'sender',config);
 candidate=(await insertProspect(pool,'sender','one',{lane:'A',campaignId:campaign})).id;
});afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});
describe('synthetic provider, real Postgres journey',()=>{
 it('moves invite, relation, DM1 and both due follow-ups without duplicate sends',async()=>{
  const now=new Date('2026-10-19T16:00:00Z'),sent=[];let connected=false,chat=false,calls=0,unknownDirection=false,chatIdentityMode="normal";
  const client={
   getAccount:async()=>({id:'sender',type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-me'}),getProfile:async()=>({provider_id:'ACo-one',public_identifier:'one',is_relationship:connected,...(calls&&!connected?{invitation:{type:'SENT',status:'PENDING'}}:{})}),
   findChats:async()=>({items:chat?[{id:'chat-1',account_id:chatIdentityMode==='foreign'?'foreign':'sender',...(chatIdentityMode==='missing'?{}:{attendee_provider_id:'ACo-one'})}]:[],complete:true}),listMessages:async()=>({items:sent.map(id=>({id,is_sender:unknownDirection?undefined:true})),complete:true}),
   invite:async()=>{calls++;return {outcome:'confirmed',providerId:'inv-1'}},sendFirst:async()=>{calls++;chat=true;sent.push('dm-1');return {outcome:'confirmed',providerId:'dm-1',chatId:'chat-1'}},sendInChat:async()=>{calls++;const id=`follow-${calls}`;sent.push(id);return {outcome:'confirmed',providerId:id,chatId:'chat-1'}}};
  const fresh=createLinkedinProspectFreshContext({pool,client,customerCheck:noCustomer});
  const runtime=startLinkedinRuntime({pool,client,companyId:'13105180',accountId:'sender',mode:'live',readFreshContext:fresh,customerCheck:noCustomer,now:()=>now,scheduler:{setInterval:()=>1,clearInterval:()=>{}}});
  expect((await runtime.tick()).counts.considered).toBe(1);runtime.stop();
  const invite=(await pool.query("SELECT * FROM sdr_linkedin_actions WHERE candidate_id=$1 AND step='invite'",[candidate])).rows[0];expect(invite.state).toBe('confirmed');expect((await pool.query("SELECT COUNT(*)::int AS count FROM sdr_linkedin_actions WHERE candidate_id=$1 AND step='invite'",[candidate])).rows[0].count).toBe(1);
  connected=true;await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,source_at,observed_at,coverage,payload_hash) VALUES('13105180','sender',$1,'li:ACo-one','new_relation','fixture','ACo-one',$2,$2,'event','relation-one')`,[candidate,now]);
  const dm=await queueLinkedinAction({pool,candidateId:candidate,campaignId:campaign,now:new Date(now.getTime()+1000)});expect(dm.step).toBe('dm1');expect((await dispatchLinkedinAction({pool,client,actionId:dm.id,readFreshContext:fresh,customerCheck:noCustomer,mode:'live',now:new Date(now.getTime()+1000)})).state).toBe('confirmed');
  const follow1=await queueLinkedinAction({pool,candidateId:candidate,campaignId:campaign,now:new Date(now.getTime()+2000)});expect(follow1.step).toBe('followup1');expect((await dispatchLinkedinAction({pool,client,actionId:follow1.id,readFreshContext:fresh,customerCheck:noCustomer,mode:'live',now:new Date(follow1.due_at.getTime()+1000)})).state).toBe('confirmed');
  const follow2=await queueLinkedinAction({pool,candidateId:candidate,campaignId:campaign,now:new Date(follow1.due_at.getTime()+2000)});expect(follow2.step).toBe('followup2');expect((await dispatchLinkedinAction({pool,client,actionId:follow2.id,readFreshContext:fresh,customerCheck:noCustomer,mode:'live',now:new Date(follow2.due_at.getTime()+1000)})).state).toBe('confirmed');expect(calls).toBe(4);
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
