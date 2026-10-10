import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {createConversationSyncRuntime} from '../sdrConversationSync.js';
import {readRecentReplies} from '../sdrOperations.js';
import * as gmailInbox from '../gmailInbox.js';

const db=reportingTestDb('outgoing_reply_evidence');
const mailbox='evidence-rep@example.test',threadId='thread-1';
const inbound={id:'in-1',threadId,messageId:'<in@buyer.test>',from:'Buyer <buyer@example.test>',to:'EVIDENCE-REP@EXAMPLE.TEST',receivedAt:'2026-10-03T10:00:00Z',lastOutbound:false,
  headerEvidence:{valid:true,threadId,messageId:'<in@buyer.test>',parentId:null,from:'buyer@example.test',to:mailbox}};
const outbound={id:'out-1',threadId,messageId:'<out@example.test>',inReplyTo:'<in@buyer.test>',from:'Rep <EVIDENCE-REP@example.test>',to:'buyer@example.test',receivedAt:'2026-10-03T10:05:00Z',lastOutbound:true,
  headerEvidence:{valid:true,threadId,messageId:'<out@example.test>',parentId:'<in@buyer.test>',from:mailbox,to:'buyer@example.test'}};
const now=new Date('2026-10-03T12:00:00Z');
const opts={visibleMailboxes:[mailbox],asOf:now.toISOString(),now};
let messages,calls;
const collect=()=>createConversationSyncRuntime({pool:db.pool,accounts:['EVIDENCE-REP@example.test'],getToken:async()=> 'fixture',now:()=>now,
  gmail:{listThreadPage:async()=>{calls++;return {threads:[{id:threadId,messages}]};}}}).runRecent();
const reply=()=>db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,detected_at,reply_kind,link_status)
  VALUES('rfc822:<in@buyer.test>','gmail','in-1',$1,$2,$3,$4,'human','unlinked')`,[threadId,mailbox,inbound.receivedAt,'2026-10-03T11:00:00Z']);
const observed=async()=>(await readRecentReplies(db.pool,opts)).items[0]?.outgoingReply;
describe.skipIf(!db)('exact outgoing reply recording',()=>{
  beforeAll(async()=>{await db.setup();for(const name of ['2026-10-02-sdr-reporting.sql','2026-10-03-sdr-reply-actions.sql','2026-10-03-sdr-reply-visibility.sql','2026-10-03-sdr-conversation-history.sql','2026-10-07-sdr-conversation-sync.sql']) await db.pool.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));await db.pool.query('CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,lead_title text,person_email text,owner_name text)');});
  afterAll(async()=>db.close());
  afterEach(()=>vi.unstubAllGlobals());
  beforeEach(async()=>{messages=[inbound,outbound];calls=0;vi.stubGlobal('fetch',vi.fn(()=>{throw Error('external request forbidden');}));await db.pool.query('TRUNCATE sdr_conversation_messages,sdr_conversation_sync_state,sdr_conversation_sync_threads,sdr_reply_actions,sdr_reply_messages,sdr_reply_routes,sdr_message_facts,sdr_job_runs,sdr_lead_state');await reply();});
  it('records and returns one exact outgoing reply while leaving response and project unknown',async()=>{
    await collect();const page=await readRecentReplies(db.pool,opts);
    expect(page.items[0].outgoingReply).toEqual({status:'observed',source:'connected_gmail',authorship:'unknown',providerMessageId:'out-1',at:'2026-10-03T10:05:00.000Z',coverage:'partial'});
    expect(page.items[0].response.status).toBe('unknown');expect(page.items[0].project.status).toBe('unlinked');expect(calls).toBe(2);expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('maps raw Gmail metadata through normal collection into the existing GET without extra requests',async()=>{
    const raw=[{id:'in-1',threadId,internalDate:String(+new Date(inbound.receivedAt)),labelIds:['INBOX'],payload:{headers:[
      {name:'Message-ID',value:inbound.messageId},{name:'From',value:inbound.from},{name:'To',value:inbound.to}]}},
    {id:'out-1',threadId,internalDate:String(+new Date(outbound.receivedAt)),labelIds:['SENT'],payload:{headers:[
      {name:'Message-ID',value:outbound.messageId},{name:'In-Reply-To',value:outbound.inReplyTo},{name:'From',value:outbound.from},{name:'To',value:outbound.to}]}}];
    const fetch=vi.fn(async url=>({ok:true,json:async()=>String(url).includes('/threads?')?{threads:[{id:threadId}]}:{messages:raw}}));vi.stubGlobal('fetch',fetch);
    await createConversationSyncRuntime({pool:db.pool,accounts:['EVIDENCE-REP@example.test'],getToken:async()=> 'fixture',now:()=>now,gmail:gmailInbox}).runRecent();
    expect((await observed()).providerMessageId).toBe('out-1');expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('keeps old evidence, manual origin, project, staff timestamp and actions unchanged on repeat collection',async()=>{
    await collect();await db.pool.query("UPDATE sdr_conversation_messages SET origin='Manual',origin_evidence='reviewed',pipedrive_lead_id='lead-a',link_evidence='reviewed' WHERE provider_message_id='in-1'");
    await db.pool.query("UPDATE sdr_reply_messages SET staff_response_at='2026-10-03T10:10:00Z',link_status='verified',pipedrive_lead_id='lead-a' WHERE source_message_id='in-1'");
    await db.pool.query("INSERT INTO sdr_reply_actions(id,provider_message_id,mailbox_email,kind,target_key,status) VALUES(gen_random_uuid(),'rfc822:<in@buyer.test>','evidence-rep@example.test','forward','target','completed')");
    const before=(await db.pool.query("SELECT origin,origin_evidence,pipedrive_lead_id,link_evidence,source_evidence FROM sdr_conversation_messages WHERE provider_message_id='in-1'")).rows[0];
    await collect();const after=(await db.pool.query("SELECT origin,origin_evidence,pipedrive_lead_id,link_evidence,source_evidence FROM sdr_conversation_messages WHERE provider_message_id='in-1'")).rows[0];
    expect(after).toEqual(before);expect((await db.pool.query('SELECT staff_response_at,link_status,pipedrive_lead_id FROM sdr_reply_messages')).rows[0]).toMatchObject({link_status:'verified',pipedrive_lead_id:'lead-a',staff_response_at:new Date('2026-10-03T10:10:00Z')});
    expect((await db.pool.query('SELECT kind,status FROM sdr_reply_actions')).rows).toEqual([{kind:'forward',status:'completed'}]);expect((await observed()).status).toBe('observed');expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['partial parent',{...outbound,headerEvidence:{...outbound.headerEvidence,parentId:'<in@buyer.test>.extra'}}],
    ['cross thread',{...outbound,threadId:'other',headerEvidence:{...outbound.headerEvidence,threadId:'other'}}],
    ['wrong recipient',{...outbound,to:'other@buyer.test',headerEvidence:{...outbound.headerEvidence,to:'other@buyer.test'}}],
    ['older send',{...outbound,receivedAt:'2026-10-03T09:59:00Z'}],
    ['not sent',{...outbound,lastOutbound:false}],
    ['malformed header',{...outbound,headerEvidence:{valid:false,reason:'malformed_header',threadId}}],
  ])('does not observe %s',async(_name,bad)=>{messages=[inbound,bad];await collect();expect(await observed()).toBeNull();});
  it('rejects a duplicate parent, absent outbound row, and conflicting reobservation',async()=>{
    messages=[inbound,{...inbound,id:'in-2'},outbound];await collect();expect(await observed()).toBeNull();
    await db.pool.query('TRUNCATE sdr_conversation_messages,sdr_conversation_sync_state,sdr_conversation_sync_threads');messages=[inbound,outbound];await collect();expect((await observed()).status).toBe('observed');
    await db.pool.query("DELETE FROM sdr_conversation_messages WHERE provider_message_id='out-1'");expect(await observed()).toBeNull();
    messages=[inbound,outbound];await collect();expect((await observed()).status).toBe('observed');
    messages=[inbound,{...outbound,headerEvidence:{valid:false,reason:'duplicate_header',threadId}}];await collect();expect(await observed()).toBeNull();
  });
  it('invalidates an earlier exact relation after changed valid parent or party metadata',async()=>{
    await collect();expect((await observed()).status).toBe('observed');
    messages=[inbound,{...outbound,headerEvidence:{...outbound.headerEvidence,parentId:'<different@buyer.test>'}}];await collect();expect(await observed()).toBeNull();
    const evidence=(await db.pool.query("SELECT source_evidence FROM sdr_conversation_messages WHERE provider_message_id='out-1'")).rows[0].source_evidence;
    expect(evidence.filter(e=>e.kind==='gmail_reply_header_v1')).toHaveLength(2);
    messages=[inbound,{...outbound,headerEvidence:{...outbound.headerEvidence,to:'other@buyer.test'}}];await collect();expect(await observed()).toBeNull();
  });
  it('invalidates an earlier claim when a later observation lacks raw-header evidence',async()=>{
    await collect();expect((await observed()).status).toBe('observed');
    messages=[inbound,{...outbound,headerEvidence:undefined}];await collect();expect(await observed()).toBeNull();
  });
  it('rejects equal or invalid provider times, missing parent, and absent raw summary',async()=>{
    for(const bad of [{...outbound,receivedAt:inbound.receivedAt},{...outbound,receivedAt:'invalid'},{...outbound,receivedAt:'2026-10-03T10:05:00+00:00'},
      {...outbound,headerEvidence:{...outbound.headerEvidence,parentId:null}},{...outbound,headerEvidence:undefined}]) {
      await db.pool.query('TRUNCATE sdr_conversation_messages,sdr_conversation_sync_state,sdr_conversation_sync_threads');messages=[inbound,bad];await collect();expect(await observed()).toBeNull();
    }
  });
  it('shows the earliest of two exact replies but rejects edge overflow',async()=>{
    messages=[inbound,outbound,{...outbound,id:'out-2',messageId:'<out-2@example.test>',receivedAt:'2026-10-03T10:06:00Z',headerEvidence:{...outbound.headerEvidence,messageId:'<out-2@example.test>'}}];
    await collect();expect((await observed()).providerMessageId).toBe('out-1');
    await db.pool.query('TRUNCATE sdr_conversation_messages,sdr_conversation_sync_state,sdr_conversation_sync_threads');
    messages=[inbound,...Array.from({length:5},(_,i)=>({...outbound,id:`out-${i}`,messageId:`<out-${i}@example.test>`,receivedAt:`2026-10-03T10:0${i+1}:00Z`,headerEvidence:{...outbound.headerEvidence,messageId:`<out-${i}@example.test>`}}))];
    await collect();expect(await observed()).toBeNull();
  });
  it('rejects an outbound row whose persisted direction or parent-header evidence changes',async()=>{
    await collect();await db.pool.query("UPDATE sdr_conversation_messages SET direction='in' WHERE provider_message_id='out-1'");expect(await observed()).toBeNull();
    await db.pool.query("UPDATE sdr_conversation_messages SET direction='out',source_evidence='[]' WHERE provider_message_id='out-1'");expect(await observed()).toBeNull();
  });
  it('returns unknown when retained evidence exceeds the bounded read shape',async()=>{
    await collect();await db.pool.query("UPDATE sdr_conversation_messages SET source_evidence=source_evidence || $1::jsonb WHERE provider_message_id='in-1'",[JSON.stringify(Array.from({length:20},(_,i)=>({oldEvidence:i})))]);
    expect(await observed()).toBeNull();
  });
  it('does not load an oversized retained evidence payload into an outgoing claim',async()=>{
    await collect();await db.pool.query("UPDATE sdr_conversation_messages SET source_evidence=source_evidence || $1::jsonb WHERE provider_message_id='in-1'",[JSON.stringify([{oversized:'x'.repeat(12000)}])]);
    expect(await observed()).toBeNull();
  });
  it('rejects duplicate provider-message identities with conflicting raw headers',async()=>{
    messages=[inbound,outbound,{...outbound,headerEvidence:{...outbound.headerEvidence,parentId:'<other@buyer.test>'}}];
    await collect();expect(await observed()).toBeNull();
  });
  it('rejects a duplicated outbound provider message even when copies look identical',async()=>{
    messages=[inbound,outbound,outbound];await collect();expect(await observed()).toBeNull();
  });
  it('does not expose an identical message in another mailbox or to an unauthorized mailbox',async()=>{
    await collect();await db.pool.query("UPDATE sdr_conversation_messages SET account_key='other@example.test' WHERE provider_message_id='out-1'");expect(await observed()).toBeNull();
    await expect(readRecentReplies(db.pool,{...opts,mailbox:'other@example.test'})).rejects.toThrow('mailbox_not_visible');
  });
});
