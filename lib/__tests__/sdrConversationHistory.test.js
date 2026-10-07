import {beforeAll,afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {observeConversationMessage,backfillGmailHistory,backfillPipedriveHistory,backfillPipedriveActivities,readContactConversation,readUnlinkedMessages,readMessageBody,readSharedAddressCandidates} from '../sdrConversationHistory.js';
import {registerSdrConversationRoutes} from '../sdrConversationRoutes.js';

const db=reportingTestDb('conversation');
const pool=db?.pool;
const july=[
  ['buyer','2026-07-30T18:34:00Z','in','Unknown'],
  ['rep-b','2026-07-30T19:36:00Z','out','Manual'],
  ['later','2026-08-03T17:56:00Z','out','Unknown'],
];
const base={provider:'gmail',account:'rep-b@example.test',id:'same',threadId:'thread-1',from:'Buyer <buyer@example.test>',to:['Rep B <rep-b@example.test>'],cc:['Copied <cc@example.test>'],occurredAt:'2026-07-30T18:34:00Z',direction:'in',origin:'Unknown'};
async function invoke(handler,req) {
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;}};
  await handler(req,res);return res;
}

describe.skipIf(!pool)('account-scoped conversation history SQL',()=>{
  beforeAll(async()=>{await db.setup();await pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-conversation-history.sql',import.meta.url),'utf8'));await pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-conversation-sync.sql',import.meta.url),'utf8'));await pool.query('CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,person_email text)');await pool.query('CREATE TABLE sdr_inbox_handled(thread_id text PRIMARY KEY,mailbox_email text,handled_at timestamptz NOT NULL)');await pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-reply-actions.sql',import.meta.url),'utf8'));});
  beforeEach(async()=>{await pool.query('TRUNCATE sdr_conversation_messages,sdr_conversation_events,sdr_conversation_coverage,sdr_lead_state,sdr_reply_messages,sdr_reply_actions,sdr_inbox_handled');});
  afterAll(async()=>db.close());
  it('retains both conflicting project observations and withdraws authoritative link evidence',async()=>{
    await observeConversationMessage(pool,{...base,leadId:'lead-a',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,leadId:'lead-b',linkEvidence:'pipedrive:lead_id'});
    const row=(await pool.query('SELECT * FROM sdr_conversation_messages')).rows[0];
    expect(row.pipedrive_lead_id).toBe('lead-a');
    expect(row.link_evidence).toBe('conflict:source_observations');
    expect(row.source_evidence).toEqual(expect.arrayContaining([expect.objectContaining({leadId:'lead-a'}),expect.objectContaining({leadId:'lead-b'})]));
  });
  it('withdraws authority when message and thread disagree on project',async()=>{
    const result=await backfillPipedriveHistory(pool,{account:'visible',folders:['sent'],pipedrive:{
      listMailThreads:async()=>({data:[{id:1,lead_id:'thread-lead'}],pagination:{more_items_in_collection:false}}),
      listMailThreadMessages:async()=>({data:[{id:2,lead_id:'message-lead',message_time:'2026-10-07 09:00:00'}],pagination:{more_items_in_collection:false}}),
    }});
    expect(result.status).toBe('complete');
    const row=(await pool.query('SELECT * FROM sdr_conversation_messages')).rows[0];
    expect(row.link_evidence).toBe('conflict:source_observations');
    expect(row.source_evidence).toEqual(expect.arrayContaining([expect.objectContaining({leadId:'message-lead'}),expect.objectContaining({leadId:'thread-lead'})]));
  });
  it('preserves conflict review after a later repetition of the original association',async()=>{
    await observeConversationMessage(pool,{...base,leadId:'a',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,leadId:'b',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,leadId:'a',linkEvidence:'pipedrive:lead_id'});
    const row=(await pool.query('SELECT * FROM sdr_conversation_messages')).rows[0];
    expect(row.link_evidence).toBe('conflict:source_observations');expect(row.source_evidence).toHaveLength(2);
  });
  it('holds changed thread provenance without discarding prior source observations',async()=>{
    await observeConversationMessage(pool,{...base,leadId:'a',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,threadId:'different-thread',leadId:'a',linkEvidence:'pipedrive:lead_id'});
    const row=(await pool.query('SELECT * FROM sdr_conversation_messages')).rows[0];
    expect(row.link_evidence).toBe('conflict:source_observations');
    expect(row.source_evidence).toEqual(expect.arrayContaining([expect.objectContaining({threadId:'thread-1'}),expect.objectContaining({threadId:'different-thread'})]));
  });
  it('withdraws trusted linkage after the provider explicitly clears a previously linked project',async()=>{
    let lead='lead-a';
    const pd={listMailThreads:async()=>({data:[{id:1,lead_id:lead,deal_id:null}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async()=>({data:[{id:2,lead_id:null,deal_id:null,message_time:'2026-10-07 09:00:00'}],pagination:{}})};
    await backfillPipedriveHistory(pool,{account:'visible',folders:['sent'],pipedrive:pd});lead=null;
    await backfillPipedriveHistory(pool,{account:'visible',folders:['sent'],pipedrive:pd});
    const row=(await pool.query('SELECT * FROM sdr_conversation_messages')).rows[0];
    expect(row.pipedrive_lead_id).toBe('lead-a');expect(row.link_evidence).toBe('conflict:source_observations');
  });
  it('keeps identical provider IDs in separate accounts and preserves Cc display without storing bodies',async()=>{
    await observeConversationMessage(pool,{...base,body:'PRIVATE BODY'});
    await observeConversationMessage(pool,{...base,account:'rep-a@example.test',from:'Admin User <rep-a@example.test>'});
    const rows=(await pool.query('SELECT account_key,cc_addresses,from_address FROM sdr_conversation_messages ORDER BY account_key')).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].cc_addresses).toEqual(['Copied <cc@example.test>']);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE BODY');
  });
  it('keeps explicit project links and distinct person IDs even when email is shared',async()=>{
    await observeConversationMessage(pool,{...base,id:'a',personId:'p1',leadId:'lead-a',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,id:'b',personId:'p2',leadId:'lead-b',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,id:'c',personId:'p1',leadId:'lead-c',linkEvidence:'pipedrive:lead_id'});
    const one=await readContactConversation(pool,{personId:'p1',visibleAccounts:['rep-b@example.test']});
    expect(one.messages.map(x=>x.provider_message_id)).toEqual(['a','c']);
    expect(one.projects).toEqual(['lead-a','lead-c']);
  });
  it('keeps unknown project messages visible when filtering a verified contact project',async()=>{
    await observeConversationMessage(pool,{...base,id:'project-a',personId:'p1',leadId:'lead-a',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,id:'unknown',personId:'p1'});
    await observeConversationMessage(pool,{...base,id:'project-b',personId:'p1',leadId:'lead-b',linkEvidence:'pipedrive:lead_id'});
    const result=await readContactConversation(pool,{personId:'p1',projectId:'lead-a',visibleAccounts:['rep-b@example.test']});
    expect(result.messages.map(x=>x.provider_message_id)).toEqual(['project-a','unknown']);
  });
  it('reopens only the matching account/thread when an inbound arrives after handled time',async()=>{
    await pool.query('INSERT INTO sdr_inbox_handled VALUES($1,$2,$3)',['thread-1','rep-b@example.test','2026-07-30T19:00:00Z']);
    await observeConversationMessage(pool,{...base,id:'old',personId:'p1',occurredAt:'2026-07-30T18:34:00Z'});
    await observeConversationMessage(pool,{...base,id:'new',personId:'p1',occurredAt:'2026-07-30T20:00:00Z'});
    await observeConversationMessage(pool,{...base,id:'other-account',account:'rep-a@example.test',personId:'p1',occurredAt:'2026-07-30T20:05:00Z'});
    const result=await readContactConversation(pool,{personId:'p1',visibleAccounts:['rep-b@example.test','rep-a@example.test']});
    expect(result.threadStates.find(x=>x.account==='rep-b@example.test')).toMatchObject({newInboundAfterHandled:true});
    expect(result.threadStates.find(x=>x.account==='rep-a@example.test')).toMatchObject({newInboundAfterHandled:false});
  });
  it('orders July buyer, Rep B manual response and later sends by actual event time',async()=>{
    for(const [id,occurredAt,direction,origin] of [...july].reverse()) await observeConversationMessage(pool,{...base,provider:'pipedrive',account:'token-visible',id,personId:'p1',occurredAt,direction,origin,originEvidence:origin==='Manual'?'reviewed-july-message':null});
    const result=await readContactConversation(pool,{personId:'p1',visibleAccounts:[],includePipedrive:true});
    expect(result.messages.map(x=>[x.provider_message_id,x.origin])).toEqual([['buyer','Unknown'],['rep-b','Manual'],['later','Unknown']]);
  });
  it('authorizes the exact account before any body fetch and never marks mail read',async()=>{
    await observeConversationMessage(pool,base);
    const gmail={getThread:vi.fn(async()=>({messages:[{id:'same',body:'private'}]})),markThreadRead:vi.fn()};
    await expect(readMessageBody(pool,{provider:'gmail',account:'rep-b@example.test',id:'same',visibleAccounts:['rep-a@example.test'],getGmailToken:async()=>'',gmail})).rejects.toThrow('mailbox_not_visible');
    expect(gmail.getThread).not.toHaveBeenCalled();
    expect(await readMessageBody(pool,{provider:'gmail',account:'rep-b@example.test',id:'same',visibleAccounts:['rep-b@example.test'],getGmailToken:async()=>'token',gmail})).toMatchObject({body:'private'});
    expect(gmail.markThreadRead).not.toHaveBeenCalled();
  });
  it('paginates more than 100 Gmail messages and retains independent failed-account coverage',async()=>{
    const gmail={listThreadPage:vi.fn(async(_token,{pageToken})=>({threads:[{id:'t',messages:Array.from({length:101},(_,i)=>({id:`${pageToken||'first'}-${i}`,from:'Buyer <buyer@example.test>',to:'rep@example.test',cc:'Copied <cc@example.test>',receivedAt:'2026-07-30T18:34:00Z',lastOutbound:false}))}],nextPageToken:pageToken?null:'page-2'}))};
    const result=await backfillGmailHistory(pool,{accounts:['ok@example.test','bad@example.test'],getToken:async account=>{if(account.startsWith('bad')) throw Object.assign(new Error('denied'),{status:403});return 'token';},gmail,maxPages:3});
    expect(result.accounts).toMatchObject([{account:'ok@example.test',status:'complete',messages:202},{account:'bad@example.test',status:'error'}]);
    expect((await pool.query('SELECT count(*)::int n FROM sdr_conversation_messages')).rows[0].n).toBe(202);
    expect((await pool.query('SELECT account_key,status FROM sdr_conversation_coverage ORDER BY account_key')).rows).toEqual([{account_key:'bad@example.test',status:'error'},{account_key:'ok@example.test',status:'complete'}]);
  });
  it('does not double count Gmail observations replayed after a partial page failure',async()=>{
    let fail=true;
    const gmail={listThreadPage:async()=>({threads:[{id:'thread-1',messages:[{id:'one',receivedAt:'2026-07-30T18:34:00Z'},
      {id:fail?null:'two',receivedAt:'2026-07-30T18:35:00Z'}]}],nextPageToken:null})};
    expect((await backfillGmailHistory(pool,{accounts:['rep-b@example.test'],getToken:async()=>'token',gmail})).accounts[0]).toMatchObject({status:'error',messages:1});
    fail=false;
    expect((await backfillGmailHistory(pool,{accounts:['rep-b@example.test'],getToken:async()=>'token',gmail})).accounts[0]).toMatchObject({status:'complete',messages:2});
  });
  it('backfills Pipedrive folders and messages without calling action adapters',async()=>{
    const pd={listMailThreads:vi.fn(async({start})=>({data:start?[]:[{id:1,lead_id:'lead-a'}],pagination:{more_items_in_collection:false}})),listMailThreadMessages:vi.fn(async()=>({data:[{id:9,mail_thread_id:1,account_id:'acct-1',from:[{name:'Rep B',email_address:'rep-b@example.test'}],to:[{email_address:'buyer@example.test'}],sent_flag:true,sent_from_pipedrive_flag:true,message_time:'2026-07-30 19:36:00',lead_id:'lead-a'}],pagination:{}}))};
    const result=await backfillPipedriveHistory(pool,{account:'token-visible',folders:['sent'],pipedrive:pd,maxPages:2,resolvePersonId:async()=> 'p1',classifyOrigin:()=>({origin:'Manual',evidence:'reviewed-july-message'})});
    expect(result.status).toBe('complete');
    const row=(await pool.query('SELECT account_key,from_address,to_addresses,origin,origin_evidence,occurred_at,person_id,pipedrive_lead_id FROM sdr_conversation_messages')).rows[0];
    expect(row).toMatchObject({account_key:'pipedrive-account:acct-1',from_address:'Rep B <rep-b@example.test>',to_addresses:['buyer@example.test'],origin:'Manual',origin_evidence:'reviewed-july-message',person_id:'p1',pipedrive_lead_id:'lead-a'});
    expect(row.occurred_at.toISOString()).toBe('2026-07-30T19:36:00.000Z');
  });
  it('does not call a folder complete until a nested thread message page past 100 is exhausted',async()=>{
    const pd={listMailThreads:async()=>({data:[{id:8}],pagination:{more_items_in_collection:false}}),
      listMailThreadMessages:vi.fn(async(_id,{start=0}={})=>({data:Array.from({length:start?1:100},(_,i)=>({id:start+i+1,mail_thread_id:8,message_time:'2026-07-30 19:36:00'})),pagination:start?{more_items_in_collection:false}:{more_items_in_collection:true,next_start:100}}))};
    const result=await backfillPipedriveHistory(pool,{account:'token-visible',folders:['sent'],pipedrive:pd,maxPages:1});
    expect(result).toMatchObject({status:'complete',folders:[{messages:101,status:'complete'}]});
    expect(pd.listMailThreadMessages.mock.calls.map(([,options])=>options?.start||0)).toEqual([0,100]);
  });
  it('keeps folder coverage partial when a nested message continuation cannot advance',async()=>{
    const pd={listMailThreads:async()=>({data:[{id:8}],pagination:{more_items_in_collection:false}}),
      listMailThreadMessages:async()=>({data:[{id:1,message_time:'2026-07-30 19:36:00'}],pagination:{more_items_in_collection:true,next_start:0}})};
    const result=await backfillPipedriveHistory(pool,{account:'token-visible',folders:['sent'],pipedrive:pd,maxPages:1});
    expect(result).toMatchObject({status:'partial',folders:[{status:'partial'}]});
    expect((await pool.query('SELECT status,cursor FROM sdr_conversation_coverage')).rows[0]).toEqual({status:'partial',cursor:'0'});
  });
  it('does not double count Pipedrive messages when a partial folder page replays',async()=>{
    let fail=true;
    const pd={listMailThreads:async()=>({data:[{id:1},{id:2}],pagination:{more_items_in_collection:false}}),
      listMailThreadMessages:async id=>{if(id===2&&fail) throw new Error('temporary');return {data:[{id,message_time:'2026-07-30 19:36:00'}],pagination:{}};}};
    expect((await backfillPipedriveHistory(pool,{account:'token-visible',folders:['sent'],pipedrive:pd})).folders[0]).toMatchObject({status:'error',messages:1});
    fail=false;
    expect((await backfillPipedriveHistory(pool,{account:'token-visible',folders:['sent'],pipedrive:pd})).folders[0]).toMatchObject({status:'complete',messages:2});
    expect((await pool.query('SELECT count(*)::int n FROM sdr_conversation_messages')).rows[0].n).toBe(2);
  });
  it('routes restrict each mailbox and project association before returning conversation metadata',async()=>{
    await observeConversationMessage(pool,{...base,personId:'p1',leadId:'lead-private',dealId:'deal-private',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,id:'other',account:'rep-a@example.test',personId:'p1',leadId:'lead-public',linkEvidence:'pipedrive:lead_id'});
    await observeConversationMessage(pool,{...base,id:'pd',provider:'pipedrive',account:'pipedrive-account:1',personId:'p1',leadId:'lead-public',linkEvidence:'pipedrive:lead_id'});
    const routes={};const app={get:(path,fn)=>{routes[path]=fn;}};
    registerSdrConversationRoutes(app,{pool,resolveVisibleMailboxes:async()=>[{email:'rep-b@example.test'}],isProjectVisible:async(_user,id)=>id==='lead-public',getGmailToken:async()=>'token'});
    const req={sdrUser:{sub:'staff-1',role:'staff'},params:{personId:'p1'},query:{}};
    const response=await invoke(routes['/api/sdr/conversations/:personId'],req);
    expect(response.statusCode).toBe(200);
    expect(response.value.messages).toHaveLength(1);
    expect(response.value.messages[0].pipedrive_lead_id).toBeNull();
    expect(response.value.messages[0].pipedrive_deal_id).toBeNull();
    expect(response.value.projects).toEqual([]);
    const denied=await invoke(routes['/api/sdr/conversations/messages/:provider/:account/:id/body'],{...req,params:{provider:'gmail',account:'rep-a@example.test',id:'other'}});
    expect(denied.statusCode).toBe(403);
  });
  it('strips inaccessible deal IDs from event and unlinked review responses',async()=>{
    await observeConversationMessage(pool,{...base,id:'unlinked',dealId:'deal-private',linkEvidence:'pipedrive:deal_id'});
    await pool.query(`INSERT INTO sdr_conversation_events(provider,account_key,provider_event_id,event_type,person_id,pipedrive_lead_id,pipedrive_deal_id)
      VALUES('pipedrive','token-visible','activity-1','task','p1','lead-private','deal-private')`);
    const routes={};const app={get:(path,fn)=>{routes[path]=fn;}};
    registerSdrConversationRoutes(app,{pool,resolveVisibleMailboxes:async()=>[{email:'rep-b@example.test'}],isProjectVisible:async()=>false,getGmailToken:async()=>'token'});
    const admin={sdrUser:{sub:'admin-1',role:'admin'},query:{}};
    const conversation=await invoke(routes['/api/sdr/conversations/:personId'],{...admin,params:{personId:'p1'}});
    expect(conversation.value.events[0]).toMatchObject({pipedrive_lead_id:null,pipedrive_deal_id:null});
    const review=await invoke(routes['/api/sdr/conversations/unlinked'],admin);
    expect(review.value.messages[0].pipedrive_deal_id).toBeNull();
  });
  it('exhausts all-user activity pages beyond 100 and keeps explicit owner and project scope',async()=>{
    const pd={listActivitiesPage:vi.fn(async({start})=>({data:start?Array.from({length:3},(_,i)=>({id:101+i,user_id:7,person_id:123,lead_id:'lead-a',add_time:'2026-07-30 20:00:00',type:'task',done:1})):Array.from({length:100},(_,i)=>({id:i+1,user_id:8,person_id:123,lead_id:'lead-a',add_time:'2026-07-30 19:00:00',type:'task',done:0})),pagination:start?{more_items_in_collection:false}:{more_items_in_collection:true,next_start:100}}))};
    const result=await backfillPipedriveActivities(pool,{account:'token-visible',pipedrive:pd,maxPages:3});
    expect(result).toMatchObject({status:'complete',events:103,pages:2});
    expect((await pool.query('SELECT count(*)::int n FROM sdr_conversation_events')).rows[0].n).toBe(103);
    expect((await pool.query('SELECT person_id,pipedrive_lead_id,actor_id FROM sdr_conversation_events WHERE provider_event_id=$1',['101'])).rows[0]).toEqual({person_id:'123',pipedrive_lead_id:'lead-a',actor_id:'7'});
  });
  it('loads latest activity events with an independent older-page cursor',async()=>{
    for(let i=0;i<120;i++) await pool.query(`INSERT INTO sdr_conversation_events(provider,account_key,provider_event_id,event_type,occurred_at,person_id)
      VALUES('pipedrive','token-visible',$1,'task',$2,'p1')`,[`event-${i}`,new Date(Date.parse('2026-07-30T18:34:00Z')+i*60000)]);
    const newest=await readContactConversation(pool,{personId:'p1',includePipedrive:true,limit:25});
    expect(newest.events.map(x=>x.provider_event_id)).toEqual(Array.from({length:25},(_,i)=>`event-${i+95}`));
    expect(newest.eventNextCursor).toBeTruthy();
    const older=await readContactConversation(pool,{personId:'p1',includePipedrive:true,limit:25,eventCursor:newest.eventNextCursor});
    expect(older.events.map(x=>x.provider_event_id)).toEqual(Array.from({length:25},(_,i)=>`event-${i+70}`));
  });
  it('keeps 31 same-address leads across 27 person IDs as separate review candidates',async()=>{
    for(let i=0;i<31;i++) await pool.query('INSERT INTO sdr_lead_state VALUES($1,$2,$3)',[`lead-${i}`,`person-${i%27}`,'SHARED@example.test']);
    const rows=await readSharedAddressCandidates(pool,{address:'shared@example.test'});
    expect(rows).toHaveLength(27);
    expect(rows.find(r=>r.personId==='person-0').leadIds).toEqual(['lead-0','lead-27']);
  });
  it('collapses mirrored Internet messages only with matching identity evidence and retains both sources',async()=>{
    const shared={...base,id:'gmail-id',personId:'p1',internetMessageId:'<same@buyer.test>',leadId:'lead-a',linkEvidence:'pipedrive:lead_id'};
    await observeConversationMessage(pool,shared);
    await observeConversationMessage(pool,{...shared,provider:'pipedrive',account:'pipedrive-account:1',id:'pd-id'});
    await observeConversationMessage(pool,{...shared,account:'rep-a@example.test',id:'different',from:'Other <other@example.test>'});
    const result=await readContactConversation(pool,{personId:'p1',visibleAccounts:['rep-b@example.test','rep-a@example.test'],includePipedrive:true});
    expect(result.messages).toHaveLength(2);
    expect(result.messages.find(m=>m.provider_message_id==='gmail-id').sourceReferences).toEqual([
      {provider:'gmail',account:'rep-b@example.test',id:'gmail-id'},
      {provider:'pipedrive',account:'pipedrive-account:1',id:'pd-id'},
    ]);
  });
  it('loads older chronological messages in bounded pages without repeating the newest page',async()=>{
    for(let i=0;i<120;i++) await observeConversationMessage(pool,{...base,id:`m-${i}`,personId:'p1',occurredAt:new Date(Date.parse('2026-07-30T18:34:00Z')+i*60000).toISOString()});
    const newest=await readContactConversation(pool,{personId:'p1',visibleAccounts:['rep-b@example.test'],limit:25});
    expect(newest.messages.map(x=>x.provider_message_id)).toEqual(Array.from({length:25},(_,i)=>`m-${i+95}`));
    expect(newest.nextCursor).toBeTruthy();
    const older=await readContactConversation(pool,{personId:'p1',visibleAccounts:['rep-b@example.test'],limit:25,cursor:newest.nextCursor});
    expect(older.messages.map(x=>x.provider_message_id)).toEqual(Array.from({length:25},(_,i)=>`m-${i+70}`));
  });
  it('keeps unlinked Gmail history visible only inside the authorized account review queue',async()=>{
    await observeConversationMessage(pool,{...base,id:'visible'});
    await observeConversationMessage(pool,{...base,id:'private',account:'rep-a@example.test'});
    const queue=await readUnlinkedMessages(pool,{visibleAccounts:['rep-b@example.test']});
    expect(queue.messages.map(x=>x.provider_message_id)).toEqual(['visible']);
    expect(queue.messages[0]).toMatchObject({person_id:null,reviewReason:'unlinked_identity'});
    const routes={};const app={get:(path,fn)=>{routes[path]=fn;}};
    registerSdrConversationRoutes(app,{pool,resolveVisibleMailboxes:async()=>[{email:'rep-b@example.test'}],isProjectVisible:async()=>false,getGmailToken:async()=>'token'});
    const response=await invoke(routes['/api/sdr/conversations/unlinked'],{sdrUser:{sub:'staff-1',role:'staff'},query:{}});
    expect(response.value.messages.map(x=>x.provider_message_id)).toEqual(['visible']);
  });
  it('historical replay creates no reply actions or task/forward receipts',async()=>{
    const forbidden=vi.fn(()=>{throw new Error('historical_action_dispatched');});
    vi.stubGlobal('fetch',forbidden);
    const gmail={listThreadPage:async()=>({threads:[{id:'thread-1',messages:[{id:'new-inbound',from:'buyer@example.test',to:'rep-b@example.test',receivedAt:'2026-07-30T18:34:00Z',lastOutbound:false}]}],nextPageToken:null}),
      sendMail:forbidden,sendReply:forbidden,markThreadRead:forbidden,forward:forbidden,stopSequence:forbidden,enrollContacts:forbidden};
    await backfillGmailHistory(pool,{accounts:['rep-b@example.test'],getToken:async()=>'token',gmail});
    const pd={listMailThreads:async()=>({data:[{id:1}],pagination:{more_items_in_collection:false}}),
      listMailThreadMessages:async()=>({data:[{id:2,message_time:'2026-07-30 19:36:00'}],pagination:{}}),
      addActivity:forbidden,addNote:forbidden,updateLead:forbidden,updatePerson:forbidden,
      createTask:forbidden,createNote:forbidden,removeContactsFromSequence:forbidden,addContactsToSequence:forbidden};
    await backfillPipedriveHistory(pool,{account:'token-visible',folders:['sent'],pipedrive:pd});
    const counts=(await pool.query('SELECT (SELECT count(*)::int FROM sdr_reply_messages) messages,(SELECT count(*)::int FROM sdr_reply_actions) actions')).rows[0];
    expect(counts).toEqual({messages:0,actions:0});
    expect(forbidden).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
