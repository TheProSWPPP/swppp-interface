import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {createConversationSyncRuntime} from '../sdrConversationSync.js';
const db=reportingTestDb('conversation_sync');
const at=new Date('2026-10-07T10:00:00Z');
const msg=id=>({id,receivedAt:'2026-10-07T09:50:00Z',from:'buyer@example.test',to:'rep@example.test',lastOutbound:false});
const pdMessage=id=>({id,message_time:'2026-10-07 09:50:00',sent_flag:false});
const emptyPd={listMailThreads:async()=>({data:[],pagination:{more_items_in_collection:false}})};
const runtime=extra=>createConversationSyncRuntime({pool:db.pool,accounts:['rep@example.test'],accountKey:null,getToken:async()=> 'fixture',now:()=>at,gmail:{listThreadPage:async()=>({threads:[]})},pipedrive:emptyPd,...extra});
describe.skipIf(!db)('bounded read-only conversation runtime',()=>{
  beforeAll(async()=>{await db.setup();for(const file of ['2026-10-03-sdr-conversation-history.sql','2026-10-07-sdr-conversation-sync.sql']) await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));});
  beforeEach(async()=>db.pool.query('TRUNCATE sdr_conversation_messages,sdr_conversation_sync_state,sdr_conversation_sync_threads'));
  afterAll(async()=>db.close());
  it('polls a new recent head while history and a fixed recent window remain backlogged',async()=>{
    const calls=[];let current=at;
    const r=runtime({now:()=>current,gmail:{listThreadPage:async(_,{query,pageToken})=>{calls.push({query,pageToken});return {threads:[{id:'t',messages:[msg(query.includes('before:')?'old':'fresh')]}],nextPageToken:'next'};}}});
    await r.runHistory();await r.runRecent();current=new Date(+at+15*60000);await r.runRecent();
    const rows=(await db.pool.query('SELECT scope,state FROM sdr_conversation_sync_state')).rows;
    expect(rows.find(r=>r.scope==='history').state.pageToken).toBe('next');
    expect(rows.find(r=>r.scope==='recent').state.to).toBe(at.toISOString());
    expect(calls.some(c=>c.query.includes(String(Math.floor(+current/1000))))).toBe(true);
    expect(calls.filter(c=>c.pageToken==='next').length).toBeGreaterThan(0);
  });
  it('resumes a nested Pipedrive thread across runtime restarts within the request cap',async()=>{
    const starts=[];const pd={listMailThreads:async()=>({data:[{id:1,message_count:3,last_message_timestamp:'2026-10-07 09:50:00'}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async(_,{start})=>{starts.push(start);return {data:[pdMessage(start+1)],pagination:start<2?{more_items_in_collection:true,next_start:start+1}:{more_items_in_collection:false}};}};
    const opts={accounts:[],accountKey:'pd:user:1',folders:['inbox'],pipedrive:pd,requestBudget:2};
    await runtime(opts).runHistory();await runtime(opts).runHistory();await runtime(opts).runHistory();
    expect(starts).toEqual([0,1,2]);
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_conversation_messages')).rows[0].n).toBe(3);
    expect((await db.pool.query('SELECT status FROM sdr_conversation_sync_state')).rows[0].status).toBe('complete');
  });
  it('does not overlap the same provider/account/scope across runtimes',async()=>{
    let unblock;const blocked=new Promise(resolve=>{unblock=resolve;});let entered;const ready=new Promise(resolve=>{entered=resolve;});let calls=0;
    const gmail={listThreadPage:async()=>{calls++;entered();await blocked;return {threads:[]};}};
    const first=runtime({gmail}).runHistory();await ready;
    const second=await runtime({gmail}).runHistory();expect(second.scopes[0].skipped).toBe('locked');
    unblock();await first;expect(calls).toBe(1);
  });
  it('retains partial coverage for malformed or frozen pagination',async()=>{
    const opts={accounts:[],accountKey:'pd:user:1',folders:['inbox'],pipedrive:{listMailThreads:async()=>({data:[],pagination:{more_items_in_collection:true,next_start:0}})}};
    const result=await runtime(opts).runHistory();expect(result.coverage).toBe('partial');
    expect((await db.pool.query('SELECT status,error_category FROM sdr_conversation_sync_state')).rows[0]).toMatchObject({status:'error',error_category:'pagination_invalid'});
  });
  it('restarts an expired Gmail cursor once and deduplicates existing observations',async()=>{
    let expire=false;const calls=[];
    const gmail={listThreadPage:async(_,{pageToken})=>{calls.push(pageToken);if(expire&&pageToken) throw Object.assign(new Error('Invalid pageToken'),{status:400});return {threads:[{id:'t',messages:[msg('same')]}],nextPageToken:'expired'};}};
    await runtime({gmail}).runHistory();expire=true;const result=await runtime({gmail}).runHistory();
    expect(calls).toEqual([undefined,'expired',undefined]);expect(result.coverage).toBe('partial');
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_conversation_messages')).rows[0].n).toBe(1);
  });
  it('skips unchanged fully collected threads, preserving Unknown origin and explicit source identity only',async()=>{
    let reads=0;const opts={accounts:[],accountKey:'pd:user:1',folders:['inbox'],pipedrive:{listMailThreads:async()=>({data:[{id:1,message_count:1,last_message_timestamp:'2026-10-07 09:50:00',lead_id:'lead-a'}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async()=>{reads++;return {data:[{...pdMessage(1),sent_from_pipedrive_flag:true,body:'DO NOT STORE'}],pagination:{more_items_in_collection:false}};}}};
    await runtime(opts).runRecent();await runtime(opts).runRecent();
    expect(reads).toBe(1);const row=(await db.pool.query('SELECT * FROM sdr_conversation_messages')).rows[0];
    expect(row.origin).toBe('Unknown');expect(row.person_id).toBeNull();expect(JSON.stringify(row)).not.toContain('DO NOT STORE');
  });
  it('invalidates cached thread metadata when explicit project linkage changes',async()=>{
    let lead='a',reads=0;
    const pd={listMailThreads:async()=>({data:[{id:1,message_count:1,version:2,last_message_timestamp:'2026-10-07 09:50:00',lead_id:lead}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async()=>{reads++;return {data:[pdMessage(1)]};}};
    const opts={accounts:[],accountKey:'pd:1',folders:['inbox'],pipedrive:pd};
    await runtime(opts).runRecent();lead='b';await runtime(opts).runRecent();
    expect(reads).toBe(2);expect((await db.pool.query('SELECT link_evidence FROM sdr_conversation_messages')).rows[0].link_evidence).toBe('conflict:source_observations');
  });
  it('does not mistake missing outer pagination for complete coverage',async()=>{
    const r=await runtime({accounts:[],accountKey:'pd:1',folders:['inbox'],pipedrive:{listMailThreads:async()=>({data:[]})}}).runHistory();
    expect(r.scopes[0]).toMatchObject({coverage:'partial',errorCategory:'pagination_invalid'});
  });
  it('keeps Gmail repeated tokens in error and resets continuation for bounded recovery',async()=>{
    const gmail={listThreadPage:async()=>({threads:[],nextPageToken:'same'})};
    await runtime({gmail}).runHistory();const r=await runtime({gmail}).runHistory();
    expect(r.scopes[0]).toMatchObject({coverage:'partial',errorCategory:'pagination_frozen'});
    expect((await db.pool.query('SELECT state FROM sdr_conversation_sync_state')).rows[0].state.pageToken).toBeNull();
  });
  it('retains the last successfully imported nested page when the next source request fails',async()=>{
    let fail=true;const starts=[];
    const opts={accounts:[],accountKey:'pd:1',folders:['inbox'],pipedrive:{listMailThreads:async()=>({data:[{id:1}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async(_,{start})=>{starts.push(start);if(start===1&&fail) throw Object.assign(new Error('private error'),{status:429});return {data:[pdMessage(start+1)],pagination:start===0?{more_items_in_collection:true,next_start:1}:{more_items_in_collection:false}};}}};
    await runtime(opts).runHistory();const failed=await runtime(opts).runHistory();expect(failed.scopes[0].errorCategory).toBe('rate_limit');
    fail=false;await runtime(opts).runHistory();expect(starts).toEqual([0,1,1]);
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_conversation_messages')).rows[0].n).toBe(2);
  });
  it('resumes the persistent recent scan beyond the first thread page independently of head polling',async()=>{
    const starts=[];
    const r=runtime({accounts:[],accountKey:'pd:1',folders:['inbox'],requestBudget:2,pipedrive:{
      listMailThreads:async({start})=>{starts.push(start);return {data:[{id:start+1,last_message_timestamp:'2026-10-07 09:50:00',message_count:1}],pagination:start===0?{more_items_in_collection:true,next_start:10}:{more_items_in_collection:false}};},
      listMailThreadMessages:async id=>({data:[pdMessage(id)],pagination:{}}),
    }});
    await r.runRecent();await r.runRecent();await r.runRecent();
    expect(starts).toContain(10);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_conversation_messages WHERE provider_message_id='11'")).rows[0].n).toBe(1);
  });
  it('does not hydrate old threads outside the fixed recent window',async()=>{
    let reads=0;
    const r=runtime({accounts:[],accountKey:'pd:1',folders:['inbox'],pipedrive:{listMailThreads:async()=>({data:[{id:1,last_message_timestamp:'2026-01-01 00:00:00',update_time:'2026-01-01T00:00:00Z',message_count:1}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async()=>{reads++;return {data:[]};}}});
    await r.runRecent();expect(reads).toBe(0);
  });
  it('ends recent traversal at a verified chronological cutoff without requesting older pages',async()=>{
    const starts=[];let read=0;
    const r=runtime({accounts:[],accountKey:'pd:1',folders:['inbox'],pipedrive:{
      listMailThreads:async({start})=>{starts.push(start);return {data:[{id:1,last_message_timestamp:'2026-10-01 00:00:00',message_count:2}],pagination:{more_items_in_collection:true,next_start:100}};},
      listMailThreadMessages:async()=>{read++;return {data:[]};},
    }});
    const result=await r.runRecent();expect(result.coverage).toBe('complete');expect(starts).toEqual([0,0]);expect(read).toBe(0);
  });
  it('never claims the recent cutoff when provider chronology is missing or reversed',async()=>{
    const r=runtime({accounts:[],accountKey:'pd:1',folders:['inbox'],pipedrive:{
      listMailThreads:async()=>({data:[{id:1,last_message_timestamp:'2026-10-01 00:00:00'},{id:2,last_message_timestamp:'2026-10-07 09:50:00'}],pagination:{more_items_in_collection:false}}),
      listMailThreadMessages:async id=>({data:[pdMessage(id)]}),
    }});
    expect((await r.runRecent()).coverage).toBe('partial');
  });
  it('rejects malformed array pagination on the nested endpoint',async()=>{
    const r=await runtime({accounts:[],accountKey:'pd:1',folders:['inbox'],pipedrive:{listMailThreads:async()=>({data:[{id:1}],pagination:{more_items_in_collection:false}}),listMailThreadMessages:async()=>({data:[],pagination:[]})}}).runHistory();
    expect(r.scopes[0]).toMatchObject({coverage:'partial',errorCategory:'pagination_invalid'});
  });
  it('starts only bounded recent work and cancels both explicit timers',async()=>{
    const intervals=[],cancelled=[];let reads=0;
    const r=runtime({schedule:(fn,ms)=>{intervals.push({fn,ms});return intervals.length;},cancel:id=>cancelled.push(id),gmail:{listThreadPage:async()=>{reads++;return {threads:[]};}}});
    await r.start();await r.start();expect(intervals.map(x=>x.ms)).toEqual([900000,3600000]);
    expect(reads).toBe(2);r.stop();expect(cancelled).toEqual([1,2]);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_conversation_sync_state WHERE scope='history'")).rows[0].n).toBe(0);
  });
});
