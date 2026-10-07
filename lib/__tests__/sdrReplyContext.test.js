import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {resolveReplyProject,checkReplyThread} from '../sdrReplyContext.js';
import {observeConversationMessage} from '../sdrConversationHistory.js';
const db=reportingTestDb('reply_context');
const inbound={id:'in',messageId:'<in@buyer.test>',from:'buyer@buyer.test',to:'rep@example.test',subject:'Project A',receivedAt:'2026-10-05T15:00:00Z'};
const sent={id:'out',messageId:'<out@sender.test>',from:'rep@example.test',to:'buyer@buyer.test',subject:'Re: Project A',receivedAt:'2026-10-05T15:01:00Z',lastOutbound:true};
const thread=()=>({id:'t',messages:[inbound,sent]});
const record=(extra={})=>observeConversationMessage(db.pool,{provider:'pipedrive',account:'pipedrive-account:42',id:'pd-1',threadId:'pd-t',internetMessageId:sent.messageId,from:sent.from,to:[sent.to],occurredAt:sent.receivedAt,direction:'out',origin:'Manual',originEvidence:'reviewed-source:message-42',...extra});
describe.skipIf(!db)('exact reply context evidence',()=>{
  beforeAll(async()=>{await db.setup();await db.pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-conversation-history.sql',import.meta.url),'utf8'));await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-conversation-sync.sql',import.meta.url),'utf8'));});
  beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_conversation_messages');});
  afterAll(async()=>{await db.close();});
  it('confirms human handling only through exact message identity and explicit manual evidence',async()=>{
    await record();
    expect(await checkReplyThread({pool:db.pool,mailbox:'rep@example.test',thread:thread(),sourceMessageId:'in'})).toMatchObject({state:'staff_replied',staffResponseAt:sent.receivedAt});
  });
  it.each([{internetMessageId:'<different@sender.test>'},{from:'other@example.test'},{origin:'Unknown',originEvidence:null},{direction:'in'}])('does not infer staff from mismatched or unknown source %j',async extra=>{
    await record(extra);
    expect(await checkReplyThread({pool:db.pool,mailbox:'rep@example.test',thread:thread(),sourceMessageId:'in'})).toMatchObject({state:'later_outbound_unverified'});
  });
  it('holds conflicting manual and automatic origin evidence for review',async()=>{
    await record();await record({id:'pd-conflict',origin:'Automatic',originEvidence:'provider-campaign:1'});
    expect(await checkReplyThread({pool:db.pool,mailbox:'rep@example.test',thread:thread(),sourceMessageId:'in'})).toMatchObject({state:'later_outbound_unverified'});
  });
  it.each([{receivedAt:null},{to:'colleague@example.test'},{subject:'Different conversation'}])('does not treat unrelated or undated manual outbound as handling %j',async change=>{
    const later={...sent,...change};await record({to:[later.to],occurredAt:later.receivedAt});
    expect(await checkReplyThread({pool:db.pool,mailbox:'rep@example.test',thread:{id:'t',messages:[inbound,later]},sourceMessageId:'in'})).toMatchObject({state:'later_outbound_unverified'});
  });
  it('links an exact Pipedrive inbound RFC identity with explicit project linkage',async()=>{
    await record({internetMessageId:inbound.messageId,from:inbound.from,to:[inbound.to],occurredAt:inbound.receivedAt,direction:'in',origin:'Unknown',originEvidence:null,leadId:'lead-a',linkEvidence:'pipedrive:explicit-thread-or-message-id'});
    expect(await resolveReplyProject(db.pool,{mailbox:'rep@example.test',thread:{id:'t',messages:[inbound]},message:inbound,candidates:[]})).toMatchObject({status:'verified',leadId:'lead-a'});
  });
  it('does not use a Pipedrive thread or participant match without exact RFC identity',async()=>{
    await record({internetMessageId:'<other@buyer.test>',leadId:'lead-a',linkEvidence:'pipedrive:explicit-thread-or-message-id'});
    expect(await resolveReplyProject(db.pool,{mailbox:'rep@example.test',thread:{id:'t',messages:[inbound]},message:inbound,candidates:[]})).toMatchObject({status:'unlinked'});
  });
});
