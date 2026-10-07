import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {createConversationSyncRuntime} from '../sdrConversationSync.js';
const db=reportingTestDb('conversation_folder_order');
const now=()=>new Date('2026-10-07T10:00:00Z');
const config={accounts:[],accountKey:'pd:1',now,requestBudget:5};
const message=id=>({id,message_time:'2026-10-07 09:50:00',sent_flag:false});
const save=async(scope,state)=>db.pool.query("INSERT INTO sdr_conversation_sync_state(provider,account_key,scope,state,status,error_category) VALUES('pipedrive','pd:1',$1,$2,'partial','ordering_unverified')",[scope,JSON.stringify(state)]);
describe.skipIf(!db)('Pipedrive folder-specific ordering and checkpoint upgrade',()=>{
  beforeAll(async()=>{await db.setup();for(const file of ['2026-10-03-sdr-conversation-history.sql','2026-10-07-sdr-conversation-sync.sql']) await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));});
  beforeEach(async()=>db.pool.query('TRUNCATE sdr_conversation_messages,sdr_conversation_sync_state,sdr_conversation_sync_threads'));
  afterAll(async()=>db.close());
  it.each([['sent','last_message_sent_timestamp'],['inbox','last_message_received_timestamp']])('uses the %s clock despite reversed generic times and excludes old folder messages',async(folder,clock)=>{
    const hydrated=[];const r=createConversationSyncRuntime({...config,pool:db.pool,folders:[folder],pipedrive:{
      listMailThreads:async()=>({data:[{id:1,message_count:1,last_message_timestamp:'2026-10-01 00:00:00',[clock]:'2026-10-07 09:50:00'},
        {id:2,message_count:1,last_message_timestamp:'2026-10-07 09:55:00',[clock]:'2026-10-01 00:00:00'}],pagination:{more_items_in_collection:true,next_start:20}}),
      listMailThreadMessages:async id=>{hydrated.push(id);return {data:[message(id)],pagination:{}};},
    }});
    expect((await r.runRecent()).coverage).toBe('complete');expect(hydrated).toEqual([1]);
    expect((await db.pool.query('SELECT provider_message_id FROM sdr_conversation_messages')).rows).toEqual([{provider_message_id:'1'}]);
    const state=(await db.pool.query("SELECT state FROM sdr_conversation_sync_state WHERE scope=$1",['recent:'+folder])).rows[0].state;
    expect(state.cutoffReached).toBe(true);expect(state.threads[0][clock]).toBe('2026-10-07 09:50:00');
  });
  it.each(['sent','inbox'])('keeps %s partial when its folder clock is absent even if generic time is valid',async folder=>{
    const r=createConversationSyncRuntime({...config,pool:db.pool,folders:[folder],pipedrive:{listMailThreads:async()=>({data:[{id:1,message_count:1,last_message_timestamp:'2026-10-07 09:50:00'}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async()=>({data:[message(1)]})}});
    expect((await r.runRecent()).coverage).toBe('partial');
    expect((await db.pool.query('SELECT DISTINCT error_category FROM sdr_conversation_sync_state')).rows).toEqual([{error_category:'ordering_unverified'}]);
  });
  it('restarts old recent ordering checkpoints once while preserving their exact window',async()=>{
    const prior={from:'2026-10-04T10:00:00.000Z',to:'2026-10-06T10:00:00.000Z',start:40,orderingUnverified:true,lastThreadAt:'2026-10-07T09:55:00Z',threads:[{id:'stale'}],index:0,messageStart:20,done:true};
    await save('recent:sent',prior);
    const starts=[];const r=createConversationSyncRuntime({...config,pool:db.pool,requestBudget:1,folders:['sent'],pipedrive:{listMailThreads:async({start})=>{starts.push(start);return {data:[{id:7,last_message_sent_timestamp:'2026-10-05 10:00:00',last_message_timestamp:'2026-10-07 09:55:00',message_count:1}],pagination:{more_items_in_collection:true,next_start:10}};},listMailThreadMessages:async()=>({data:[message(7)],pagination:{more_items_in_collection:false}})}});
    await r.runRecent();
    const first=(await db.pool.query("SELECT state FROM sdr_conversation_sync_state WHERE scope='recent:sent'")).rows[0].state;
    expect(first).toMatchObject({from:prior.from,to:prior.to,start:0,orderingVersion:2});expect(first.orderingUnverified).toBeUndefined();
    expect(first.threads[0].id).toBe(7);expect(starts).toEqual([0,0]);
    await r.runRecent();
    const second=(await db.pool.query("SELECT state FROM sdr_conversation_sync_state WHERE scope='recent:sent'")).rows[0].state;
    expect(second).toMatchObject({from:prior.from,to:prior.to,orderingVersion:2,index:1});
  });
  it('does not reset historical nested message continuation during the ordering upgrade',async()=>{
    await save('history:sent',{from:null,to:'2026-10-01T00:00:00Z',start:40,threads:[{id:77}],index:0,messageStart:20,next:null,orderingVersion:1});
    const starts=[];const r=createConversationSyncRuntime({...config,pool:db.pool,folders:['sent'],pipedrive:{listMailThreads:async()=>{throw new Error('history must use saved nested cursor');},listMailThreadMessages:async(_,{start})=>{starts.push(start);return {data:[message(77)],pagination:{}};}}});
    expect((await r.runHistory()).coverage).toBe('complete');expect(starts).toEqual([20]);
    expect((await db.pool.query('SELECT state FROM sdr_conversation_sync_state')).rows[0].state.start).toBe(40);
  });
});
