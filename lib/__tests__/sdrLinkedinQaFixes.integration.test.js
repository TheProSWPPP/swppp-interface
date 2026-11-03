// Regression tests for the independent QA of PR #124 (2026-11-03), one block per finding.
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {prospectSkipReason,stageProspect,stageLane,stageMovedContact} from '../sdrLinkedinProspect.js';
import {createProspectInboundHandler,drainReplyAlerts} from '../sdrLinkedinReplyAlerts.js';
import {queueLinkedinAction,dispatchLinkedinAction,rebindLinkedinActions} from '../sdrLinkedinOperations.js';
import {saveLinkedinCampaign,approveLinkedinCampaign} from '../sdrLinkedinAdmin.js';
import {createLinkedinProspectFreshContext} from '../sdrLinkedinProspectFreshContext.js';
import {startLinkedinRuntime} from '../sdrLinkedinRuntime.js';
import {APIFY_ACTORS} from '../apifyClient.js';
import {companyKey} from '../permitMatch.js';
import {testPool,createProspectSchema,prospectConfig,insertAccount,insertCampaign,insertProspect,insertAction,fakeSeat,writes} from './helpers/linkedinProspectFixture.js';

const {schema,pool}=testPool('linkedin_qa_fixes',{skipWithoutDb:true});
const company='13105180',DAY=86_400_000,noCustomer=async()=>null;
const MON=new Date('2026-11-02T15:00:00Z'); // Monday 09:00 Central
const facts={company:{value:'Big GC',verified:true},newCompany:{value:'Big GC',verified:true},oldCompany:{value:'Flintco',verified:true},state:{value:'Texas',verified:true}};
beforeAll(async()=>{if(pool)await createProspectSchema(pool,schema)});
afterAll(async()=>{if(!pool)return;await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});

const person=(key,extra={})=>({firstName:'Pat',lastName:key,profileUrl:`https://www.linkedin.com/in/${key}/`,company:'Big GC',title:'Director of Preconstruction',stateCode:'TX',publicIdentifier:key,providerId:`ACo-${key}`,evidence:{source:'apify',runId:'r'},...extra});
async function realCampaign(accountId,lane,keys,{rampStartedOn='2026-10-01',personFacts=facts}={}){
 await insertAccount(pool,accountId,{rampStartedOn});
 const ids=[];for(const key of keys)ids.push((await stageProspect(pool,{companyId:company,accountId,lane,person:person(key),facts:personFacts,actor:'admin',ownerId:'owner',now:MON})).id);
 const saved=await saveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',config:{lane,budgets:{invite:15,dm:25,inmail:5,withdraw:20}},expiresAt:'2027-01-15T00:00:00Z',candidateIds:ids,now:MON});
 const campaign=await approveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',campaignId:saved.id,expectedRevision:saved.revision,now:MON});
 return {ids,campaign};
}
const actionsOf=async candidateId=>(await pool.query('SELECT step,state,hold_reason,campaign_revision,context_hash FROM sdr_linkedin_actions WHERE candidate_id=$1 ORDER BY created_at',[candidateId])).rows;

describe.skipIf(!pool)('1 and 8. reply alerts: no clogged drain, one alert per person',()=>{
 const gmailFake=()=>{const sent=[];return {sent,sendMail:async(t,mail)=>{sent.push(mail);return {id:`gm-${sent.length}`}},listThreadPage:async()=>({threads:[]})}};
 const drain=(gmail,at,accountId)=>drainReplyAlerts(pool,{gmail,getToken:async()=>'t',now:at,companyId:company,accountId,enabled:true,from:'alerts@proswppp.co',to:'derek@proswppp.co',limit:10});
 it('a new reply reaches Derek although many earlier alerts finished or wait for reminders',async()=>{
  await insertAccount(pool,'alerts');
  const rows=[];for(let i=0;i<21;i++)rows.push(await insertProspect(pool,'alerts',`alert-${i}`));
  // 10 finished (both reminders sent) and 10 still waiting for their first reminder.
  for(let i=0;i<20;i++)await pool.query(`INSERT INTO sdr_linkedin_reply_alerts(company_id,account_id,candidate_id,source_message_id,reply_text,lane,state,sent_at,reminder1_sent_at,reminder3_sent_at,next_reminder_at,created_at)
   VALUES($1,'alerts',$2,$3,'old','A',$4,$5,$6,$7,$8,$9)`,[company,rows[i].id,`old-${i}`,i<10?'reminded':'sent',new Date(MON-10*DAY),i<10?new Date(MON-9*DAY):null,i<10?new Date(MON-7*DAY):null,i<10?null:new Date(MON.getTime()+DAY),new Date(MON-10*DAY+i)]);
  await pool.query(`INSERT INTO sdr_linkedin_reply_alerts(company_id,account_id,candidate_id,source_message_id,reply_text,lane) VALUES($1,'alerts',$2,'new','hello','A')`,[company,rows[20].id]);
  const gmail=gmailFake();
  expect(await drain(gmail,MON,'alerts')).toMatchObject({sent:1,reminders:0});
  expect(gmail.sent.map(m=>m.bodyText.includes('"hello"'))).toEqual([true]);
  const fresh=(await pool.query("SELECT state,next_reminder_at FROM sdr_linkedin_reply_alerts WHERE source_message_id='new'")).rows[0];
  expect(fresh.state).toBe('sent');expect(fresh.next_reminder_at.toISOString()).toBe('2026-11-03T15:00:00.000Z');
 });
 it('ends the drain for an alert once its third-day reminder is sent',async()=>{
  await insertAccount(pool,'alerts-end');const c=await insertProspect(pool,'alerts-end','ender');
  await pool.query(`INSERT INTO sdr_linkedin_reply_alerts(company_id,account_id,candidate_id,source_message_id,reply_text,lane) VALUES($1,'alerts-end',$2,'end-1','hi','A')`,[company,c.id]);
  const gmail=gmailFake();
  await drain(gmail,MON,'alerts-end');
  await drain(gmail,new Date('2026-11-03T16:00:00Z'),'alerts-end');
  await drain(gmail,new Date('2026-11-05T16:00:00Z'),'alerts-end');
  expect(gmail.sent).toHaveLength(3);
  expect((await pool.query("SELECT state,next_reminder_at FROM sdr_linkedin_reply_alerts WHERE source_message_id='end-1'")).rows[0]).toEqual({state:'reminded',next_reminder_at:null});
  expect(await drain(gmail,new Date('2026-11-12T16:00:00Z'),'alerts-end')).toMatchObject({sent:0,reminders:0});
 });
 it('appends a second message to the open alert: one email, both messages in it',async()=>{
  await insertAccount(pool,'alerts-two');const c=await insertProspect(pool,'alerts-two','twice');
  const candidate=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1',[c.id])).rows[0];
  const items=[{id:'m1',is_sender:false,text:'Hi Derek.'},{id:'m2',is_sender:false,text:'Call me Tuesday.'}];
  const client={getChat:async()=>({account_id:'alerts-two',attendees_ids:['ACo-twice'],provider_id:'2-T'}),listMessages:async()=>({complete:true,items})};
  let suggestions=0;const handler=createProspectInboundHandler({pool,client,mode:'live',suggest:async()=>`answer ${++suggestions}`});
  const first=await handler({candidate,event:{source_message_id:'m1',chat_id:'chat-2',direction:'in'}});
  const second=await handler({candidate,event:{source_message_id:'m2',chat_id:'chat-2',direction:'in'}});
  const replay=await handler({candidate,event:{source_message_id:'m2',chat_id:'chat-2',direction:'in'}});
  expect(second.alertId).toBe(first.alertId);expect(replay.alertId).toBeNull();
  const alerts=(await pool.query('SELECT reply_text,suggested_answer,message_ids FROM sdr_linkedin_reply_alerts WHERE candidate_id=$1',[c.id])).rows;
  expect(alerts).toEqual([{reply_text:'Hi Derek.\n\nCall me Tuesday.',suggested_answer:'answer 2',message_ids:['m2']}]);
  const gmail=gmailFake();await drain(gmail,MON,'alerts-two');
  expect(gmail.sent).toHaveLength(1);expect(gmail.sent[0].bodyText).toContain('Call me Tuesday.');
 });
 it('in dry_run records the alert with no seat read and no model call',async()=>{
  await insertAccount(pool,'alerts-dry',{mode:'dry_run'});const c=await insertProspect(pool,'alerts-dry','dry');
  const candidate=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1',[c.id])).rows[0];
  let reads=0,suggestions=0;const client={getChat:async()=>{reads++;return {}},listMessages:async()=>{reads++;return {complete:true,items:[]}}};
  const result=await createProspectInboundHandler({pool,client,mode:'dry_run',suggest:async()=>{suggestions++;return 'x'}})({candidate,event:{source_message_id:'d1',chat_id:'chat-d',direction:'in'}});
  expect(result.alertId).toBeTruthy();expect(reads).toBe(0);expect(suggestions).toBe(0);
 });
 it('a prospect reply with an email on record also exits their email sequences, at the time they wrote; no email, no exit',async()=>{
  await insertAccount(pool,'alerts-exit',{mode:'dry_run'});
  const withEmail=await insertProspect(pool,'alerts-exit','mailed');
  const noEmail=await insertProspect(pool,'alerts-exit','nomail',{email:null});
  const calls=[];const enqueueExit=async(_pool,input)=>{calls.push(input);return {detected:1,enqueued:1}};
  const handler=createProspectInboundHandler({pool,client:{},mode:'dry_run',suggest:async()=>'x',enqueueExit});
  const at=new Date('2026-11-02T16:30:00Z');
  const r=await handler({candidate:withEmail,event:{source_message_id:'x1',chat_id:'chat-x',direction:'in',source_at:at}});
  expect(r.exit).toEqual({enqueued:1,skipped:null});
  expect(calls).toEqual([{messageId:'linkedin:alerts-exit:x1',source:'linkedin',mailbox:'linkedin:alerts-exit',receivedAt:at,fromEmail:'mailed@example.test',threadId:'chat-x',intent:'linkedin_inbound'}]);
  expect((await handler({candidate:noEmail,event:{source_message_id:'x2',chat_id:'chat-y',direction:'in'}})).exit).toBeNull();
  expect(calls).toHaveLength(1);
  // The real enqueue is inert while SDR_REPLY_EXIT_MODE is off (the default).
  const real=await createProspectInboundHandler({pool,client:{},mode:'dry_run',suggest:async()=>'x'})({candidate:withEmail,event:{source_message_id:'x3',chat_id:'chat-x',direction:'in'}});
  expect(real.exit).toEqual({enqueued:0,skipped:'disabled'});
 });
});

describe.skipIf(!pool)('2. Pipedrive-lead skip matches the person, not the exact spelling',()=>{
 const skip=p=>prospectSkipReason(pool,{companyId:company,person:{profileUrl:`https://www.linkedin.com/in/${p.key}/`,email:null,...p},lane:'A',now:MON,customerCheck:noCustomer});
 it('catches nicknames, credentials, spacing and punctuation on AGC, LBA, bid-invite and enrolled leads',async()=>{
  await pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,person_name,trigger_type,lead_origin,crm_status) VALUES
   ('n1','Michael Smith ','AGC',NULL,'active'),('n2','Pat Named.','LBA',NULL,'active'),('n3','Steve O''Brien',' cm','Bid Invite: BuildingConnected','active'),('n4','Christopher J. Lee','CM',NULL,'active')`);
  await pool.query("INSERT INTO sdr_sends(pipedrive_lead_id,status) VALUES('n4','enrolled')");
  expect(await skip({key:'k1',firstName:'Mike',lastName:'Smith, P.E.',company:'Big GC'})).toBe('agc_lba_or_bid_invite');
  expect(await skip({key:'k2',firstName:'Pat',lastName:'Named',company:'Big GC'})).toBe('agc_lba_or_bid_invite');
  expect(await skip({key:'k3',firstName:'Stephen',lastName:'OBrien',company:'Big GC'})).toBe('agc_lba_or_bid_invite');
  expect(await skip({key:'k4',firstName:'Chris',lastName:'Lee PE',company:'Big GC'})).toBe('pipedrive_active_sequence');
  expect(await skip({key:'k5',firstName:'Jane',lastName:'Smith',company:'Big GC'})).toBeNull();
 });
 it('lets a same-name person through only when both organizations are known and differ',async()=>{
  await pool.query('ALTER TABLE sdr_lead_state ADD COLUMN org_name text');
  await pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,person_name,trigger_type,crm_status,org_name) VALUES('o1','Dana Cole','AGC','active','Other Builders')");
  expect(await skip({key:'o-a',firstName:'Dana',lastName:'Cole',company:'Big GC'})).toBeNull();
  expect(await skip({key:'o-b',firstName:'Dana',lastName:'Cole',company:'Other Builders, LLC'})).toBe('agc_lba_or_bid_invite');
  expect(await skip({key:'o-c',firstName:'Dana',lastName:'Cole',company:null})).toBe('agc_lba_or_bid_invite');
  await pool.query('ALTER TABLE sdr_lead_state DROP COLUMN org_name');
 });
});

describe.skipIf(!pool)('3. lane C names the old customer, and only real replacements',()=>{
 it('refuses a company not on the old customer list and skips look-alikes and old contacts',async()=>{
  await insertAccount(pool,'lane-c');
  await pool.query(`INSERT INTO sdr_linkedin_old_customers(company_id,import_id,full_name,company,company_key,linkedin_url,status) VALUES($1,gen_random_uuid(),'Olive Contact','Manhattan',$2,'https://www.linkedin.com/in/oldcontact/','moved')`,[company,companyKey('Manhattan')]);
  const profile=(id,companyName)=>({publicIdentifier:id,linkedinUrl:`https://www.linkedin.com/in/${id}/`,firstName:id==='oldcontact'?'Olive':'Pat',lastName:id==='oldcontact'?'Contact':id,location:{linkedinText:'Austin, Texas, United States'},currentPosition:[{position:'Chief Estimator',companyName,dateRange:{start:{month:8,year:2026}}}]});
  const runs=[];const apify={configured:true,runActor:async({input})=>{runs.push(input);return [profile('assoc','Manhattan Associates'),profile('oldcontact','Manhattan'),profile('real','Manhattan, Inc.')]}};
  const client={getProfile:async({identifier})=>({provider_id:`ACo-${identifier}`,public_identifier:identifier,is_relationship:false})};
  const base={pool,client,apify,lane:'C',limit:10,companyId:company,accountId:'lane-c',actor:'admin',ownerId:'owner',states:['TX'],now:MON,customerCheck:noCustomer};
  await expect(stageLane({...base,currentCompanies:['Manhattan Associates']})).rejects.toMatchObject({code:'company_not_old_customer'});
  expect(runs).toHaveLength(0);
  const result=await stageLane({...base,currentCompanies:['manhattan']});
  expect(runs[0].currentCompanies).toEqual(['Manhattan']);
  expect(result.skipped).toEqual({company_mismatch:1,old_customer_contact:1});
  expect(result.staged).toHaveLength(1);
  const row=(await pool.query('SELECT firm,source_context FROM sdr_linkedin_candidates WHERE id=$1',[result.staged[0].candidateId])).rows[0];
  expect(row.firm).toBe('Manhattan, Inc.');
  expect(row.source_context.facts.company).toMatchObject({value:'Manhattan',verified:true,evidenceRef:'old_customer_csv'});
 });
});

describe.skipIf(!pool)('4. queued steps survive a campaign revision or a restricted account',()=>{
 it('leaves a step pending through a revision, then re-queues it under the approved revision',async()=>{
  const {ids,campaign}=await realCampaign('rebind','A',['rb']);
  const first=await queueLinkedinAction({pool,candidateId:ids[0],campaignId:campaign.id,now:MON});
  expect(first.step).toBe('invite');
  const revised=await saveLinkedinCampaign({pool,companyId:company,accountId:'rebind',actor:'admin',campaignId:campaign.id,expectedRevision:campaign.revision,config:{budgets:{invite:10,dm:25,inmail:5,withdraw:20}},now:MON});
  const seat=fakeSeat({accountId:'rebind',providerId:'ACo-rb',publicId:'rb'});
  const fresh=createLinkedinProspectFreshContext({pool,client:seat,customerCheck:noCustomer});
  expect(await dispatchLinkedinAction({pool,client:seat,actionId:first.id,readFreshContext:fresh,mode:'live',now:MON,customerCheck:noCustomer})).toEqual({state:'campaign_changed'});
  expect(await actionsOf(ids[0])).toMatchObject([{step:'invite',state:'pending',hold_reason:'campaign_changed',campaign_revision:1}]);
  // Unapproved revision: nothing is rebound yet.
  expect(await rebindLinkedinActions({pool,companyId:company,accountId:'rebind',now:MON})).toEqual({rebound:0});
  await approveLinkedinCampaign({pool,companyId:company,accountId:'rebind',actor:'admin',campaignId:campaign.id,expectedRevision:revised.revision,now:MON});
  expect(await rebindLinkedinActions({pool,companyId:company,accountId:'rebind',now:MON})).toEqual({rebound:1});
  const again=await queueLinkedinAction({pool,candidateId:ids[0],campaignId:campaign.id,now:MON});
  expect(again).toMatchObject({step:'invite',state:'pending',campaign_revision:revised.revision});
  expect(again.context_hash).not.toBe(first.context_hash);
  expect((await dispatchLinkedinAction({pool,client:seat,actionId:again.id,readFreshContext:fresh,mode:'live',now:MON,customerCheck:noCustomer})).state).toBe('confirmed');
  expect(writes(seat)).toEqual(['invite']);
 });
 it('keeps a step pending while the account is restricted and sends it once healthy again',async()=>{
  const {ids,campaign}=await realCampaign('restore','A',['rs']);
  const action=await queueLinkedinAction({pool,candidateId:ids[0],campaignId:campaign.id,now:MON});
  const seat=fakeSeat({accountId:'restore',providerId:'ACo-rs',publicId:'rs'});
  const fresh=createLinkedinProspectFreshContext({pool,client:seat,customerCheck:noCustomer});
  await pool.query("UPDATE sdr_linkedin_accounts SET status='restricted' WHERE account_id='restore'");
  expect(await dispatchLinkedinAction({pool,client:seat,actionId:action.id,readFreshContext:fresh,mode:'live',now:MON,customerCheck:noCustomer})).toEqual({state:'account_not_ready'});
  await pool.query("UPDATE sdr_linkedin_accounts SET status='healthy' WHERE account_id='restore'");
  expect((await dispatchLinkedinAction({pool,client:seat,actionId:action.id,readFreshContext:fresh,mode:'live',now:MON,customerCheck:noCustomer})).state).toBe('confirmed');
 });
 it('queues an invite only into a free slot of today\'s budget',async()=>{
  const keys=['b1','b2','b3','b4','b5','b6'];
  const {ids,campaign}=await realCampaign('slots','B',keys,{rampStartedOn:'2026-11-02'});
  const results=[];for(const id of ids)results.push(await queueLinkedinAction({pool,candidateId:id,campaignId:campaign.id,now:MON}));
  expect(results.filter(r=>r.step==='invite')).toHaveLength(5);
  expect(results.at(-1)).toEqual({state:'held',reason:'budget_exhausted'});
 });
 it('lane A (the main lane) keeps at least half of the day\'s invites while it has people; B, C and D share the rest',async()=>{
  const accountId='shares';
  await insertAccount(pool,accountId,{rampStartedOn:'2026-11-02'});
  const campaignFor=async(lane,keys)=>{
   const ids=[];for(const key of keys)ids.push((await stageProspect(pool,{companyId:company,accountId,lane,person:person(key),facts,actor:'admin',ownerId:'owner',now:MON})).id);
   const saved=await saveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',config:{lane,budgets:{invite:15,dm:25,inmail:5,withdraw:20}},expiresAt:'2027-01-15T00:00:00Z',candidateIds:ids,now:MON});
   return {ids,campaign:await approveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',campaignId:saved.id,expectedRevision:saved.revision,now:MON})};
  };
  const b=await campaignFor('B',['sb1','sb2','sb3','sb4','sb5','sb6']);
  const a=await campaignFor('A',['sa1','sa2','sa3','sa4','sa5','sa6']);
  // Week 1 = 5 invites. The warmer lane B is queued first and still leaves 3 for lane A.
  const bResults=[];for(const id of b.ids)bResults.push(await queueLinkedinAction({pool,candidateId:id,campaignId:b.campaign.id,now:MON}));
  expect(bResults.filter(r=>r.step==='invite')).toHaveLength(2);
  expect(bResults.at(-1)).toEqual({state:'held',reason:'budget_kept_for_lane_a'});
  const aResults=[];for(const id of a.ids)aResults.push(await queueLinkedinAction({pool,candidateId:id,campaignId:a.campaign.id,now:MON}));
  expect(aResults.filter(r=>r.step==='invite')).toHaveLength(3);
  expect(aResults.at(-1)).toEqual({state:'held',reason:'budget_exhausted'});
 });
});

describe.skipIf(!pool)('5 and 6. runtime passes do not starve anyone',()=>{
 const runtimeSeat=accountId=>({
  getAccount:async()=>({id:accountId,type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-sender'}),
  getProfile:async({identifier})=>({provider_id:identifier,public_identifier:String(identifier).replace('ACo-',''),is_relationship:true}),
  findChats:async()=>({complete:true,items:[]}),listMessages:async()=>({complete:true,items:[]}),
  invite:async({providerId})=>({outcome:'confirmed',providerId:`inv-${providerId}`}),sendFirst:async()=>({outcome:'confirmed',providerId:'dm',chatId:'chat'})});
 const tick=async(accountId,at)=>{const client=runtimeSeat(accountId);const runtime=startLinkedinRuntime({pool,client,companyId:company,accountId,mode:'live',readFreshContext:createLinkedinProspectFreshContext({pool,client,customerCheck:noCustomer}),customerCheck:noCustomer,now:()=>at,scheduler:{setInterval:()=>1,clearInterval(){}}});await runtime.ready;const result=await runtime.tick();runtime.stop();return result};
 it('reaches an approved candidate behind 25 higher-priority ones in an unapproved campaign',async()=>{
  await insertAccount(pool,'clog',{rampStartedOn:'2026-10-01'});
  const blockedKeys=Array.from({length:25},(_,i)=>`blocked-${i}`);
  const blocked=await insertCampaign(pool,'clog',prospectConfig({lane:'A',sourceIds:blockedKeys}),{status:'unapproved'});
  for(const key of blockedKeys){const row=await insertProspect(pool,'clog',key,{campaignId:blocked});await pool.query('UPDATE sdr_linkedin_candidates SET priority=1 WHERE id=$1',[row.id])}
  const open=await insertCampaign(pool,'clog',prospectConfig({lane:'A',sourceIds:['winner']}));
  const winner=await insertProspect(pool,'clog','winner',{campaignId:open});await pool.query('UPDATE sdr_linkedin_candidates SET priority=9999 WHERE id=$1',[winner.id]);
  await tick('clog',new Date('2026-11-04T15:00:00Z'));
  expect((await actionsOf(winner.id)).map(a=>a.step)).toEqual(['invite']);
 });
 it('queues M1 for a low-priority accepter behind 120 people with pending invites',async()=>{
  await insertAccount(pool,'starve',{rampStartedOn:'2026-10-01'});
  const at=new Date('2026-11-04T15:00:00Z');
  const keys=[...Array.from({length:120},(_,i)=>`wait-${i}`),'late'];
  const campaign=await insertCampaign(pool,'starve',prospectConfig({lane:'A',sourceIds:keys}));
  for(const key of keys){const row=await insertProspect(pool,'starve',key,{campaignId:campaign,state:'invite_sent'});await pool.query('UPDATE sdr_linkedin_candidates SET priority=$2 WHERE id=$1',[row.id,key==='late'?9999:1]);
   await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,state,reserved_at,confirmed_at,provider_id) VALUES($1,'starve',$2,$3,$4,1,'invite',$5,$6,'h','confirmed',$6,$6,$7)`,[company,row.id,row.person_id,campaign,`op-${key}`,new Date(at-(key==='late'?2:15)*DAY),`inv-${key}`])}
  const late=(await pool.query("SELECT * FROM sdr_linkedin_candidates WHERE source_id='late' AND account_id='starve'")).rows[0];
  await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,source_at,observed_at,coverage,payload_hash) VALUES($1,'starve',$2,$3,'new_relation','fixture','ACo-late',$4,$4,'event','rel-late')`,[company,late.id,late.person_id,new Date(at-60*60_000)]);
  await tick('starve',at);
  expect((await actionsOf(late.id)).map(a=>a.step)).toEqual(['invite','dm1']);
 });
});

describe.skipIf(!pool)('9 and 10. copy checked before the invite; switches re-read at dispatch',()=>{
 it('does not invite a person whose later messages cannot render',async()=>{
  const {ids,campaign}=await realCampaign('nocopy','A',['nc'],{personFacts:{state:{value:'Texas',verified:true}}});
  expect(await queueLinkedinAction({pool,candidateId:ids[0],campaignId:campaign.id,now:MON})).toEqual({state:'held',reason:'copy_facts_unverified'});
  expect(await actionsOf(ids[0])).toEqual([]);
 });
 it('skips a lane B contact at staging when their copy cannot render',async()=>{
  await insertAccount(pool,'nocopy-b');let reads=0;
  const result=await stageMovedContact({pool,client:{getProfile:async()=>{reads++;return {}}},companyId:company,accountId:'nocopy-b',actor:'admin',ownerId:'owner',row:{id:null,full_name:'Randy Smith',company:'Flintco',email:null},person:person('nofirst',{firstName:null}),states:['TX'],now:MON});
  expect(result).toEqual({skipped:'copy_facts_unverified'});expect(reads).toBe(0);
 });
 it('keeps a queued InMail or withdraw pending when its switch is off at dispatch',async()=>{
  await insertAccount(pool,'switches',{inmailBalance:5});
  const campaign=await insertCampaign(pool,'switches',prospectConfig({lane:'A',sourceIds:['sw']}));
  const candidate=await insertProspect(pool,'switches','sw',{campaignId:campaign});
  const inmail=await insertAction(pool,'switches',candidate,campaign,{step:'inmail',body:JSON.stringify({subject:'S',body:'B'})});
  const calls=[];const client=new Proxy({},{get:(_,name)=>name==='then'?undefined:async()=>{calls.push(String(name));return {outcome:'confirmed'}}});
  expect(await dispatchLinkedinAction({pool,client,actionId:inmail.id,readFreshContext:async()=>({allowed:true,contextHash:'hash'}),mode:'live',now:new Date('2026-11-04T15:00:00Z'),inmailEnabled:false})).toEqual({state:'inmail_disabled'});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_actions WHERE id=$1',[inmail.id])).rows[0]).toEqual({state:'pending',hold_reason:'inmail_disabled'});
  await pool.query("UPDATE sdr_linkedin_actions SET step='withdraw' WHERE id=$1",[inmail.id]);
  expect(await dispatchLinkedinAction({pool,client,actionId:inmail.id,readFreshContext:async()=>({allowed:true,contextHash:'hash'}),mode:'live',now:new Date('2026-11-04T15:00:00Z'),withdrawEnabled:false})).toEqual({state:'withdraw_disabled'});
  expect(calls).toEqual([]);
 });
});

describe.skipIf(!pool)('11. lane D author checks are capped per call',()=>{
 it('makes at most 25 Apify author searches in one dry run',async()=>{
  await insertAccount(pool,'lane-d');
  const posts=Array.from({length:40},(_,i)=>({postUrl:`https://www.linkedin.com/posts/p${i}`,text:'New SWPPP rules',author:{name:`Pat Poster${i}`,headline:'Director of Preconstruction',linkedinUrl:`https://www.linkedin.com/in/poster${i}/`}}));
  let searches=0;const apify={configured:true,runActor:async({actor})=>{if(actor===APIFY_ACTORS.postSearch)return posts;searches++;return []}};
  const result=await stageLane({pool,client:null,apify,lane:'D',limit:25,dryRun:true,companyId:company,accountId:'lane-d',actor:'admin',ownerId:null,states:['TX'],now:MON,customerCheck:noCustomer});
  expect(searches).toBe(25);expect(result.stopped).toBe('author_check_cap');expect(result.considered).toBe(25);
 });
});
