import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {runReplyAction} from '../sdrReplyActions.js';
import {createReplyActionClients} from '../inboxReplyWatch.js';
const action={id:'action-1',created_at:'2026-10-05T15:01:00Z',payload:{mailbox:'rep@example.test',forwardTo:'owner@example.test',threadId:'source-thread',sourceMessageId:'source-message',leadId:'lead-a',intent:'interested'}};
const original={id:'source-message',subject:'Project A',receivedAt:'2026-10-05T15:00:00Z'};
const forwarded={id:'receipt-1',receivedAt:'2026-10-05T15:02:00Z',messageId:'<CAPK=replaced@mail.gmail.com>',lastOutbound:true,from:'Rep <rep@example.test>',to:'owner@example.test',subject:'Reply (interested): Project A',body:'New interested reply. Open in interface: https://app.test/#/sdr?inboxLead=lead-a\nSource thread: source-thread\n[SDR reply action action-1]\n\n---------- Forwarded message ----------\nProspect body'};
const clientsFor=(record=forwarded)=>{
  const queries=[];
  return {queries,clients:createReplyActionClients({pool:{},appBase:'https://app.test',getToken:async()=> 'fixture',gmail:{
    listThreadPage:async(_,{query})=>{queries.push(query);return {threads:query.includes('rfc822msgid:')?[]:[{id:'sent-thread',messages:[record]}]};},
    getThread:async(_,id)=>({messages:id==='source-thread'?[original]:[record]}),
    sendMail:async()=>{throw new Error('must never resend');},
  }})};
};
describe('forward reconciliation when Google replaces Message-ID',()=>{
  it('recovers the existing receipt from its exact action marker and message context',async()=>{
    const {clients,queries}=clientsFor();
    expect(await clients.forward.reconcile(action)).toEqual({state:'completed',receipt:{id:'receipt-1'}});
    expect(queries).toHaveLength(2);
  });
  it('accepts the exact neutral note with source thread after attribution becomes uncertain',async()=>{
    const neutral=forwarded.body.replace('New interested reply. Open in interface: https://app.test/#/sdr?inboxLead=lead-a','New interested reply. Project match needs review. Open in interface: https://app.test/#/sdr');
    expect(await clientsFor({...forwarded,body:neutral}).clients.forward.reconcile(action)).toEqual({state:'completed',receipt:{id:'receipt-1'}});
  });
  it.each([
    {body:'Copied for reference:\n'+forwarded.body},
    {body:forwarded.body.replace('Source thread: source-thread','Source thread: another-thread')},
    {body:forwarded.body.replace('\n\n---------- Forwarded message ----------','\nExtra authored text\n\n---------- Forwarded message ----------')},
    {body:forwarded.body.replace('---------- Forwarded message ----------','Forwarded text without delimiter')},
    {receivedAt:'2026-10-05T15:00:30Z'},{receivedAt:null},{receivedAt:'invalid'},
  ])('rejects copied, altered or undated receipt %j',async change=>{
    expect(await clientsFor({...forwarded,...change}).clients.forward.reconcile(action)).toEqual({state:'unknown'});
  });
  it('requires receipt timing after both action creation and source inbound time',async()=>{
    const early=clientsFor({...forwarded,receivedAt:'2026-10-05T14:59:00Z'});
    expect(await early.clients.forward.reconcile({...action,created_at:'2026-10-05T14:00:00Z'})).toEqual({state:'unknown'});
    expect(await clientsFor().clients.forward.reconcile({...action,created_at:null})).toEqual({state:'unknown'});
  });
  it('checks both searches before accepting a receipt and holds duplicate markers',async()=>{
    const queries=[];
    const clients=createReplyActionClients({pool:{},appBase:'https://app.test',getToken:async()=> 'fixture',gmail:{
      listThreadPage:async(_,{query})=>{queries.push(query);return {threads:[{id:query.includes('rfc822msgid:')?'first':'second'}]};},
      getThread:async(_,id)=>({messages:id==='source-thread'?[original]:[{...forwarded,id}]}),
    }});
    expect(await clients.forward.reconcile(action)).toEqual({state:'unknown'});
    expect(queries).toHaveLength(2);
  });
  it.each([{to:'other@example.test'},{from:'other@example.test'},{subject:'Other project'},{lastOutbound:false},{body:'[SDR reply action other]'},
    {body:'Different source\n\n---------- Forwarded message ----------\n[SDR reply action action-1]'}])('keeps contradictory receipt %j unknown without sending',async change=>{
    const {clients}=clientsFor({...forwarded,...change});
    expect(await clients.forward.reconcile(action)).toEqual({state:'unknown'});
  });
});

const body='Buyer message received today\nFrom: Buyer <buyer@example.test>\nSubject: Project A\n\nPlease send details.';
const manifest={version:2,mode:'reply',from:'rep@proswppp.co',to:'rep@proswppp.com',replyTo:'buyer@example.test',
  subject:'Project A',bodyText:body,bodyDigest:createHash('sha256').update(body).digest('hex'),messageId:'<sdr-action-action-1@proswppp.co>',forwardId:'action-1',
  sourceMessageId:'source-message',sourceThreadId:'source-thread',sourceReceivedAt:'2026-10-12T09:00:00Z',
  inReplyTo:'<source@buyer.test>',references:'<source@buyer.test>',attemptedAt:'2026-10-12T10:00:00Z'};
const trackedAction={id:'action-1',kind:'forward',status:'failed',requiresReview:true,safeError:'completion_uncertain',attempts:1,
  payload:{mailbox:manifest.from,forwardTo:manifest.to,sourceMessageId:'source-message',threadId:'source-thread',forwardFormat:2,forwardManifest:manifest}};
const trackedSent={id:'gmail-generated-id',lastOutbound:true,receivedAt:'2026-10-12T10:00:05Z',subject:'Project A',body,
  mimeAudit:{complete:true},routingHeadersTruncated:false,routingHeaders:[
    {name:'message-id',value:'<rewritten@mail.gmail.com>'},{name:'x-proswppp-forward-id',value:'action-1'},
    {name:'from',value:'Rep <rep@proswppp.co>'},{name:'to',value:'Rep <rep@proswppp.com>'},{name:'reply-to',value:'buyer@example.test'},
    {name:'in-reply-to',value:'<source@buyer.test>'},{name:'references',value:'<source@buyer.test>'}]};
const trackedClient=(pages=[{threads:[{id:'sent-thread'}],nextPageToken:null}],records={'sent-thread':[trackedSent]})=>{
  const queries=[];let sends=0;
  const client=createReplyActionClients({pool:{},getToken:async()=> 'fixture',gmail:{
    listThreadPage:async(_token,args)=>{queries.push(args);return pages[queries.length-1];},
    getThread:async(_token,id)=>({messages:records[id]}),sendMail:async()=>{sends++;return {id:'unexpected-send'};},
  }});
  return {client,queries,get sends(){return sends;}};
};
describe('immutable forward header reconciliation',()=>{
  it('reconciles a Gmail-rewritten Message-ID only after complete SENT discovery without sending again',async()=>{
    const fixture=trackedClient([{threads:[],nextPageToken:'page-2'},{threads:[{id:'sent-thread'}],nextPageToken:null}]);
    expect(await runReplyAction(trackedAction,fixture.client.forward)).toMatchObject({status:'completed',externalId:'gmail-generated-id',attempts:1});
    expect(fixture.sends).toBe(0);
    expect(fixture.queries).toEqual([
      {query:'in:sent after:1791799140 before:1791885600',maxResults:25,pageToken:undefined},
      {query:'in:sent after:1791799140 before:1791885600',maxResults:25,pageToken:'page-2'},
    ]);
  });
  it.each([
    ['missing ID',{routingHeaders:trackedSent.routingHeaders.filter(h=>h.name!=='x-proswppp-forward-id')}],
    ['duplicate ID',{routingHeaders:[...trackedSent.routingHeaders,{name:'x-proswppp-forward-id',value:'action-1'}]}],
    ['malformed ID',{routingHeaders:trackedSent.routingHeaders.map(h=>h.name==='x-proswppp-forward-id'?{...h,value:'action-1\r\n'}:h)}],
    ['truncated headers',{routingHeadersTruncated:true}],['incomplete MIME',{mimeAudit:{complete:false}}],
    ['wrong recipient',{routingHeaders:trackedSent.routingHeaders.map(h=>h.name==='to'?{...h,value:'other@example.test'}:h)}],
    ['wrong sender',{routingHeaders:trackedSent.routingHeaders.map(h=>h.name==='from'?{...h,value:'other@example.test'}:h)}],
    ['copied recipient',{routingHeaders:[...trackedSent.routingHeaders,{name:'cc',value:'other@example.test'}]}],
    ['wrong reply-to',{routingHeaders:trackedSent.routingHeaders.map(h=>h.name==='reply-to'?{...h,value:'other@example.test'}:h)}],
    ['wrong source',{routingHeaders:trackedSent.routingHeaders.map(h=>h.name==='in-reply-to'?{...h,value:'<other@buyer.test>'}:h)}],
    ['wrong body',{body:'changed'}],['wrong subject',{subject:'Other'}],['not SENT',{lastOutbound:false}],
    ['before window',{receivedAt:'2026-10-12T09:58:59Z'}],['after window',{receivedAt:'2026-10-13T10:00:01Z'}],
    ['missing Message-ID',{routingHeaders:trackedSent.routingHeaders.filter(h=>h.name!=='message-id')}],
  ])('holds %s evidence without a resend',async(_label,change)=>{
    const fixture=trackedClient(undefined,{'sent-thread':[{...trackedSent,...change}]});
    const result=await runReplyAction(trackedAction,fixture.client.forward);
    expect(result).toEqual(trackedAction);expect(fixture.sends).toBe(0);
  });
  it('rejects duplicate IDs on distinct messages even if only one body matches',async()=>{
    const fixture=trackedClient(undefined,{'sent-thread':[trackedSent,{...trackedSent,id:'duplicate',body:'altered'}]});
    expect(await fixture.client.forward.reconcile(trackedAction)).toEqual({state:'unknown'});
  });
  it.each([
    [{threads:[{id:'sent-thread'}],nextPageToken:'more'},{threads:[],nextPageToken:'more'}],
    [{threads:[{id:'sent-thread'}],nextPageToken:'two'},{threads:[{id:'sent-thread'}],nextPageToken:null}],
    [{threads:[{id:'sent-thread'}],nextPageToken:'two'},{threads:[],nextPageToken:'three'},{threads:[],nextPageToken:'four'},{threads:[],nextPageToken:'five'}],
    [{threads:[{id:'sent-thread'},{id:'missing-thread'}],nextPageToken:null}],
  ])('holds incomplete or repeated discovery %j',async(...pages)=>{
    const fixture=trackedClient(pages);
    expect(await fixture.client.forward.reconcile(trackedAction)).toEqual({state:'unknown'});
    expect(fixture.queries.length).toBeLessThanOrEqual(4);
  });
  it('does not certify a match when another discovered thread has no messages',async()=>{
    const fixture=trackedClient([{threads:[{id:'sent-thread'},{id:'empty'}],nextPageToken:null}],{'sent-thread':[trackedSent],empty:[]});
    expect(await fixture.client.forward.reconcile(trackedAction)).toEqual({state:'unknown'});
  });
  it('holds malformed headers anywhere in complete discovery',async()=>{
    const fixture=trackedClient(undefined,{'sent-thread':[trackedSent,{...trackedSent,id:'malformed',routingHeaders:[null]}]});
    expect(await fixture.client.forward.reconcile(trackedAction)).toEqual({state:'unknown'});
  });
  it('does not certify a match when another discovered message has truncated evidence',async()=>{
    const fixture=trackedClient(undefined,{'sent-thread':[trackedSent,{...trackedSent,id:'unreadable',routingHeaders:[],routingHeadersTruncated:true}]});
    expect(await fixture.client.forward.reconcile(trackedAction)).toEqual({state:'unknown'});
  });
  it.each([['<p>Buyer <a href="mailto:buyer@example.test">Email buyer</a></p>','completed'],['<p>Buyer <a href="mailto:other@example.test">Email buyer</a></p>','unknown'],['','unknown']])('requires persisted HTML handoff bytes (%s)',async(html,state)=>{
    const fixture=trackedClient(undefined,{'sent-thread':[{...trackedSent,html}]});
    const htmlAction={...trackedAction,payload:{...trackedAction.payload,forwardManifest:{...manifest,bodyHtml:'<p>Buyer <a href="mailto:buyer@example.test">Email buyer</a></p>'}}};
    expect(await fixture.client.forward.reconcile(htmlAction)).toMatchObject({state});
  });
  it('retains Message-ID-only contract for existing manifests',async()=>{
    const old={...manifest};delete old.forwardId;
    const fixture=trackedClient();
    expect(await fixture.client.forward.reconcile({...trackedAction,payload:{...trackedAction.payload,forwardManifest:old}})).toEqual({state:'unknown'});
    expect(fixture.queries).toEqual([{query:'in:sent rfc822msgid:<sdr-action-action-1@proswppp.co>',maxResults:25}]);
  });
  it.each(['other-action',null,'bad ID'])('rejects a malformed or cross-action manifest ID %j without discovery',async forwardId=>{
    const fixture=trackedClient();
    expect(await fixture.client.forward.reconcile({...trackedAction,payload:{...trackedAction.payload,forwardManifest:{...manifest,forwardId}}})).toEqual({state:'unknown'});
    expect(fixture.queries).toEqual([]);
  });
});
