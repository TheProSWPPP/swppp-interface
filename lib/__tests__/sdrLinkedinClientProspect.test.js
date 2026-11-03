import {describe,it,expect} from 'vitest';
import {createLinkedinClient} from '../sdrLinkedinClient.js';

const make=({status=200,body={},text,allowWrites=true}={})=>{
 const calls=[],reads=[];
 const transport=async(url,options)=>{calls.push({url:String(url),options});return text!==undefined?new Response(text,{status}):new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})};
 return {calls,reads,client:createLinkedinClient({baseUrl:'https://fixture.unipile.test/api/v1',apiKey:'synthetic',accountId:'sender',transport,allowWrites,onRead:async info=>{reads.push(info)}})};
};
describe('Unipile client for the prospect lanes',()=>{
 it('confirms an invite receipt that carries invitation_id and keeps the usage figure',async()=>{
  const {client}=make({body:{object:'UserInvitationSent',invitation_id:'7265',usage:42}});
  expect(await client.invite({providerId:'ACo-one'})).toMatchObject({outcome:'confirmed',providerId:'7265',usage:42});
 });
 it('rejects 422 already_connected instead of leaving it uncertain',async()=>{
  const {client}=make({status:422,body:{type:'errors/already_connected',title:'Already connected'}});
  expect(await client.invite({providerId:'ACo-one'})).toEqual({outcome:'rejected',status:422,code:'errors/already_connected'});
 });
 it('reports a 401 or 403 write as rejected with its status, so dispatch restricts the account',async()=>{
  for(const status of [401,403]){const {client}=make({status,body:{error:'unauthorized'}});expect(await client.invite({providerId:'ACo-one'})).toMatchObject({outcome:'rejected',status})}
  const {client}=make({status:429});expect(await client.invite({providerId:'ACo-one'})).toMatchObject({outcome:'unknown',status:429});
 });
 it('sends an InMail through Sales Navigator with the exact form fields',async()=>{
  const {client,calls}=make({body:{object:'ChatStarted',chat_id:'chat-1',message_id:'msg-1'}});
  expect(await client.sendInmail({providerId:'ACo-one',subject:'SWPPPs at Acme',text:'Hey Pat'})).toMatchObject({outcome:'confirmed',providerId:'msg-1',chatId:'chat-1'});
  expect(calls[0].url).toBe('https://fixture.unipile.test/api/v1/chats');expect(calls[0].options.method).toBe('POST');
  const form=calls[0].options.body;expect(form).toBeInstanceOf(FormData);
  expect(Object.fromEntries(form.entries())).toEqual({account_id:'sender',text:'Hey Pat',attendees_ids:'ACo-one',subject:'SWPPPs at Acme','linkedin[api]':'sales_navigator','linkedin[inmail]':'true'});
 });
 it('withdraws an invitation by id and treats an empty 2xx body as confirmed',async()=>{
  const {client,calls}=make({text:'',status:200});
  expect(await client.withdrawInvite({invitationId:'7265'})).toEqual({outcome:'confirmed',providerId:'7265',chatId:null,receipt:{}});
  expect(calls[0].options.method).toBe('DELETE');expect(calls[0].url).toBe('https://fixture.unipile.test/api/v1/users/invite/sent/7265?account_id=sender');
  expect(()=>client.withdrawInvite({invitationId:''})).toThrow('invitation_id_required');
 });
 it('charges a Sales Navigator search POST through the read budget like a GET',async()=>{
  const {client,reads,calls}=make({body:{items:[],cursor:null}});
  await client.searchSalesNav({body:{api:'sales_navigator',category:'people'},limit:5});
  expect(reads).toEqual([{accountId:'sender',method:'POST',path:'/linkedin/search'}]);
  expect(calls[0].url).toBe('https://fixture.unipile.test/api/v1/linkedin/search?account_id=sender&limit=5');
  await client.getInmailBalance();expect(reads.at(-1)).toMatchObject({method:'GET',path:'/linkedin/inmail_balance'});
 });
 it('still refuses InMail and withdraw when writes are off',async()=>{
  const {client,calls}=make({allowWrites:false});
  await expect(client.sendInmail({providerId:'ACo-one',subject:'S',text:'T'})).rejects.toMatchObject({code:'writes_disabled'});
  await expect(client.withdrawInvite({invitationId:'7265'})).rejects.toMatchObject({code:'writes_disabled'});
  expect(calls).toHaveLength(0);
 });
});
