import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {stageInvitationBatch} from '../sdrInvitationIntake.js';
import {createStagedInvitationReader,readExactStagedCrmMatch,readAuthorizedSalesSource} from '../sdrSalesLoopSources.js';
import {prepareProposal,projectSalesOpportunity} from '../sdrSalesLoop.js';
import {readFollowupProjectContext} from '../sdrFollowupProjectContext.js';
import {readFollowupDraft,saveFollowupDraft} from '../sdrFollowupDrafts.js';
import {createFollowupHandoffs} from '../sdrFollowupHandoffs.js';
import {readSalesLoopObservations} from '../sdrSalesLoopObservations.js';

const db=reportingTestDb('sales_loop_trace');
const viewer={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'},companyId='42',leadId='A';
const sourceUrl='https://app.buildingconnected.com/opportunities/opp-17';
const when='2026-10-10T12:00:00Z';
(db?describe:describe.skip)('synthetic connected invitation to Pipedrive handoff',()=>{
 beforeAll(async()=>{
  await db.setup();
  for(const file of ['2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  await db.pool.query('CREATE TABLE sdr_users(id uuid PRIMARY KEY,role text,active boolean); CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,crm_company_id text); CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id uuid,status text)');
  for(const file of ['2026-10-08-sdr-followup-drafts.sql','2026-10-10-sdr-followup-handoffs.sql','2026-10-03-sdr-reply-actions.sql','2026-10-03-sdr-conversation-history.sql','2026-10-07-sdr-conversation-sync.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  await db.pool.query('INSERT INTO sdr_users VALUES($1,$2,true)',[viewer.sub,viewer.role]);
  await db.pool.query("INSERT INTO sdr_lead_state VALUES('A','42')");
  await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at) VALUES('42','lead','A',$1,$2),('42','person','12',$3,$2),('42','activity','task-1',$4,$2)",[
   {title:'Library',person_id:12,owner_id:7,source_opportunity_url:sourceUrl},when,{name:'Pat',email:[{value:'pat@example.test',primary:true}]},{done:false,subject:'Call buyer',due_date:'2026-10-11',owner_id:7,type:'call'}]);
  await db.pool.query("INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','activity','task-1','lead','A','fixture')");
 });
 afterAll(async()=>db.close());
 it('passes the actual staged candidate into grounded proposal, deliberate save, fresh preview and one explicit readback note',async()=>{
  const blocked=vi.fn(()=>{throw Error('External request forbidden');});vi.stubGlobal('fetch',blocked);
  try{
   const stage=stageInvitationBatch({batchId:'export-1',observedAt:when,csvText:`Company,Contact Name,Primary Email,Project Title,Quick Link,Bid Date\nBuilder A,Pat,pat@example.test,Library,${sourceUrl},2026-10-21`,crmCandidates:[{companyId,leadId,sourceUrl,lifecycle:'active',accessStatus:'accessible'}]});
   expect(stage.candidates[0].match).toMatchObject({status:'exact',leadId:'A'});
   const readSource=createStagedInvitationReader({receipt:stage.receipt,readExactCrmMatch:input=>readExactStagedCrmMatch(db.pool,input)});
   const generated=vi.fn(async()=>({subject:'Bid form',body:'I can send the bid form for your review.',missingFacts:['quote amount','quote receipt']}));
   const proposed=await prepareProposal({pool:db.pool,companyId,leadId,viewer,sourceRef:stage.candidates[0].sourceRef,editorRequestVersion:1,readSource,generate:generated});
   expect(proposed).toMatchObject({source:{provenance:{kind:'staged_invitation',receiptDigest:stage.receipt.digest}},missingFacts:['quote amount','quote receipt']});
   expect(generated.mock.calls[0][0].sourceText).toContain('Library');
   const initial=await readFollowupDraft(db.pool,{companyId,leadId,viewer});
   const saved=await saveFollowupDraft(db.pool,{companyId,leadId,viewer,subject:proposed.subject,body:proposed.body,expectedRevision:0,contextToken:initial.contextToken});
   const actions=[];
   const evidence={complete:true,lead:{id:'A',title:'Library',owner_id:7,person_id:12,is_archived:false},person:{id:12,name:'Pat',email:[{value:'pat@example.test',primary:true}]},organization:null,notes:[],activities:[{id:'task-1',lead_id:'A',subject:'Call buyer',done:false,due_date:'2026-10-11',owner_id:7}]};
   const client={validateIdentity:async()=>{},readEvidence:async()=>structuredClone(evidence),addNote:async({content})=>{actions.push({kind:'explicit_note_publication',content});return {id:'note-9'};},getNote:async()=>({id:'note-9',lead_id:'A',content:actions[0].content}),listNotes:async()=>({complete:true,items:[]})};
   const handoff=createFollowupHandoffs({pool:db.pool,companyId,sourceHost:'proswpppllc.pipedrive.com',client});
   const input={leadId,viewer,expectedRevision:saved.draft.revision,contextToken:saved.contextToken};
   const preview=await handoff.preview(input);expect(preview).toMatchObject({owner:{id:'7'},revision:1});expect(preview.noteHtml).toContain('Task task-1');
   const publication=await handoff.publish({...input,previewToken:preview.previewToken,latestConversationReviewed:true});
   expect(publication).toMatchObject({status:'confirmed',noteId:'note-9',readbackVerified:true});expect(actions.map(a=>a.kind)).toEqual(['explicit_note_publication']);
   const context=await readFollowupProjectContext(db.pool,{companyId,leadId,viewer});
   const fromRead=await readSalesLoopObservations(db.pool,{companyId,leadId,viewer,context,resolveVisibleMailboxes:async()=>[]});
   expect(fromRead).toMatchObject({publication:{status:'confirmed',noteId:'note-9',readbackVerified:true},outcomes:[]});
   const projected=projectSalesOpportunity({companyId,context,source:stage.candidates[0].sourceRef,publication:{...publication,companyId,leadId},outcomes:[]});
   expect(projected).toMatchObject({nextAction:{taskId:'task-1',ownerId:'7',dueDate:'2026-10-11'},quote:{sent:'unknown',acknowledged:'unknown'},order:{status:'unknown'},handoff:{publication:'confirmed',awareness:'unknown',action:'unknown'}});
   const later=projectSalesOpportunity({companyId,context,publication:{...publication,companyId,leadId},outcomes:[{kind:'outgoing_reply',companyId,leadId,source:'connected_gmail',linkage:'direct_unique',providerMessageId:'synthetic-m-1',authorship:'unknown'},{kind:'quote',companyId,leadId,stage:'sent',sourceId:'synthetic-q-1',verified:true},{kind:'order',companyId,leadId,sourceId:'synthetic-o-1',verified:true}]});
   expect(later.outgoing).toMatchObject({status:'observed',authorship:'unknown',providerMessageId:'synthetic-m-1'});expect(later.quote.sent).toMatchObject({status:'observed',sourceId:'synthetic-q-1'});expect(later.order).toMatchObject({status:'observed',sourceId:'synthetic-o-1'});
   expect(blocked).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();}
 });
 it('reads only exact linked inbound observations from a visible mailbox',async()=>{
  await db.pool.query(`INSERT INTO sdr_conversation_messages(provider,account_key,provider_message_id,provider_thread_id,internet_message_id,
   from_address,to_addresses,occurred_at,direction,person_id,pipedrive_lead_id,link_evidence,source_evidence)
   VALUES('gmail','seller@example.test','msg-a','thread-a','<buyer@example.test>','buyer@example.test','["seller@example.test"]','2026-10-10T13:00:00Z','in','12','A','pipedrive:lead_id',$1),
    ('gmail','seller@example.test','msg-b','thread-b','<wrong@example.test>','wrong@example.test','["seller@example.test"]','2026-10-10T13:01:00Z','in','12','B','pipedrive:lead_id',$2)`,[
   JSON.stringify([{leadId:'A',personId:'12',threadId:'thread-a',evidence:'pipedrive:lead_id'}]),JSON.stringify([{leadId:'B',personId:'12',threadId:'thread-b',evidence:'pipedrive:lead_id'}])]);
  await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind)
    VALUES('rfc822:<buyer@example.test>','gmail','msg-a','thread-a','seller@example.test','2026-10-10T13:00:00Z','A','verified','human'),
    ('rfc822:<wrong@example.test>','gmail','msg-b','thread-b','seller@example.test','2026-10-10T13:01:00Z','B','verified','human')`);
  const context=await readFollowupProjectContext(db.pool,{companyId,leadId,viewer});
  const hidden=await readSalesLoopObservations(db.pool,{companyId,leadId,viewer,context,resolveVisibleMailboxes:async()=>[]});
  expect(hidden.outcomes).toEqual([]);
  const visible=await readSalesLoopObservations(db.pool,{companyId,leadId,viewer,context,resolveVisibleMailboxes:async()=>[{email:'seller@example.test',connected:true}]});
  expect(visible.outcomes).toMatchObject([{kind:'incoming_reply',companyId,leadId,sourceId:'rfc822:<buyer@example.test>'}]);
  expect(visible.outcomes).toHaveLength(1);
 });
 it('requires same-company unique direct CRM note provenance, not a title or email match',async()=>{
  await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('42','note','source-note',$1)",[{content:'Buyer asks for a revised form'}]);
  await db.pool.query("INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','note','source-note','lead','A','fixture')");
  const args={companyId,leadId,viewer,sourceRef:{kind:'crm_note',id:'source-note'},current:{context:{lead:{personId:'12'}}}};
  expect(await readAuthorizedSalesSource(db.pool,args)).toMatchObject({text:'Buyer asks for a revised form',linkage:'direct_unique',provenance:{id:'source-note'}});
  await expect(readAuthorizedSalesSource(db.pool,{...args,companyId:'other'})).rejects.toMatchObject({code:'source_unavailable'});
  await db.pool.query("INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','note','source-note','lead','B','fixture')");
  await expect(readAuthorizedSalesSource(db.pool,args)).rejects.toMatchObject({code:'source_unavailable'});
 });
});
