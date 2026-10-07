import {describe,it,expect} from 'vitest';
import {createReplyActionClients} from '../inboxReplyWatch.js';
const action={id:'action-1',payload:{mailbox:'rep@example.test',forwardTo:'owner@example.test',threadId:'source-thread',sourceMessageId:'source-message',leadId:'lead-a',intent:'interested'}};
const original={id:'source-message',subject:'Project A',receivedAt:'2026-10-05T15:00:00Z'};
const forwarded={id:'receipt-1',messageId:'<CAPK=replaced@mail.gmail.com>',lastOutbound:true,from:'Rep <rep@example.test>',to:'owner@example.test',subject:'Reply (interested): Project A',body:'New interested reply. Open in interface: https://app.test/#/sdr?inboxLead=lead-a\n[SDR reply action action-1]\n\n---------- Forwarded message ----------\nProspect body'};
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
  it.each([{to:'other@example.test'},{from:'other@example.test'},{subject:'Other project'},{lastOutbound:false},{body:'[SDR reply action other]'},
    {body:'Different source\n\n---------- Forwarded message ----------\n[SDR reply action action-1]'}])('keeps contradictory receipt %j unknown without sending',async change=>{
    const {clients}=clientsFor({...forwarded,...change});
    expect(await clients.forward.reconcile(action)).toEqual({state:'unknown'});
  });
});
