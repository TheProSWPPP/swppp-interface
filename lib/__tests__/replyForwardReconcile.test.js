import {describe,it,expect} from 'vitest';
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
