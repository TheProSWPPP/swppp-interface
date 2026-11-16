import {describe,it,expect} from 'vitest';
import * as mod from '../sdrInternalReplyReminderClient.js';
const row={external_id:'39093',id:'action-1',source:'gmail',source_message_id:'msg',mailbox_email:'pm@proswppp.co',thread_id:'thread',received_at:'2026-11-10T12:10:00Z',from_email:'cody@buyer.test',pipedrive_lead_id:'lead-1',payload:{leadId:'lead-1'}};
function fixture(change={}){
 const calls=[];const task={id:39093,user_id:22,done:false,lead_id:'lead-1',person_id:44,due_date:'2026-11-10',note:'[SDR reply action action-1]',subject:'Reply received: Cody',...change.task};
 const thread={messages:[{id:'msg',from:'Cody <cody@buyer.test>',to:'pm@proswppp.co',body:'Please send the proposal',subject:'Pavilion',receivedAt:row.received_at},...(change.later||[])]};
 const fetchImpl=async url=>{calls.push(String(url));const path=new URL(url).pathname;let data;
  if(path.endsWith('/users/me'))data={company_id:change.company||13105180,company_domain:'proswpppllc'};
  else if(path.endsWith('/users'))data=[{id:22,email:'pm@proswppp.com',active_flag:true},{id:11,email:'dc@proswppp.com',active_flag:true}];
  else if(path.includes('/activities/39093'))data=task;
  else if(path==='/v1/persons/44/mailMessages'){
   if(change.mailResponse)return {ok:true,json:async()=>change.mailResponse};
   data=change.mails||[];
  }
  else if(path==='/v1/mailbox/mailMessages/msg')data=change.pdMessage;
  else if(path==='/v1/mailbox/mailThreads/thread/mailMessages')data=[change.pdMessage];
  else if(path.includes('/leads/'))data={id:'lead-1',is_archived:false,person_id:44};
  else data=[];
  return {ok:true,json:async()=>({success:true,data,additional_data:{pagination:{more_items_in_collection:!!change.incomplete}}})};
 };
 const client=mod.createInternalReminderClient({companyId:'13105180',token:'fixture',getThread:async()=>thread,fetchImpl});
 return {client,calls,task};
}
describe('internal reminder source checks',()=>{
 it('uses current task assignee and verified company identity',async()=>{
  const {client}=fixture();await client.validateIdentity();const c=await client.inspect(row);
  expect(c.task.user_id).toBe(22);expect(c.handled).toBe(false);expect(c.original.body).toBe('Please send the proposal');
 });
 it('rejects another company before reading tasks',async()=>{
  const {client}=fixture({company:7});await expect(client.validateIdentity()).rejects.toThrow('company');
 });
 it('rejects a task that no longer belongs to the recorded reply action',async()=>{
  const {client}=fixture({task:{note:'Another task'}});await expect(client.inspect(row)).rejects.toThrow('identity');
 });
 it('does not call internal forwarding a buyer response',async()=>{
  const {client}=fixture({later:[{id:'forward',from:'pm@proswppp.co',to:'pm@proswppp.com',lastOutbound:true,receivedAt:'2026-11-11T12:00:00Z',subject:'Pavilion'}]});
  expect((await client.inspect(row)).handled).toBe(false);
 });
 it('suppresses after a later outgoing email to this buyer in the same project thread',async()=>{
  const {client}=fixture({later:[{id:'answer',from:'pm@proswppp.co',to:'cody@buyer.test',lastOutbound:true,receivedAt:'2026-11-11T12:00:00Z',subject:'Re: Pavilion'}]});
  expect((await client.inspect(row)).handled).toBe(true);
 });
 it('holds incomplete CRM reads rather than assuming nobody handled it',async()=>{
  const {client}=fixture({incomplete:true});await expect(client.inspect(row)).rejects.toThrow('incomplete');
 });
 it('holds a reassigned project link',async()=>{
  const {client}=fixture({task:{lead_id:'different'}});await expect(client.inspect(row)).rejects.toThrow('identity');
 });
});

it('compares bare UTC CRM times against Gmail timestamps independently of host time zone',async()=>{
 const {client}=fixture({mails:[{sent_flag:1,message_time:'2026-11-10 12:20:00',to:'cody@buyer.test',lead_id:'lead-1',subject:'Pavilion'}]});
 expect((await client.inspect(row)).handled).toBe(true);
});
it('normalizes original Pipedrive timestamps to UTC',async()=>{
 const {client}=fixture({pdMessage:{id:'msg',mail_thread_id:'thread',from:[{email_address:'cody@buyer.test'}],to:[{email_address:'pm@proswppp.co'}],message_time:'2026-11-10 12:10:00',subject:'Pavilion',body:'Proposal please'}});
 expect(+new Date((await client.inspect({...row,source:'pipedrive'})).original.receivedAt)).toBe(+new Date('2026-11-10T12:10:00Z'));
});

const emptyMailResponse={success:true,data:null,additional_data:{pagination:{start:0,limit:100,more_items_in_collection:false}}};
it('inspects an open task when Pipedrive explicitly confirms an empty person mail list',async()=>{
 const {client}=fixture({mailResponse:emptyMailResponse});
 const result=await client.inspect(row);
 expect(result.handled).toBe(false);
 expect(result.task.id).toBe(39093);
 expect(result.original.body).toBe('Please send the proposal');
});
it.each([
 ['missing data',{success:true,additional_data:emptyMailResponse.additional_data}],
 ['malformed data',{...emptyMailResponse,data:{}}],
 ['failed response',{...emptyMailResponse,success:false}],
 ['missing pagination',{success:true,data:null}],
 ['missing completion',{...emptyMailResponse,additional_data:{pagination:{start:0,limit:100}}}],
 ['more pages',{...emptyMailResponse,additional_data:{pagination:{start:0,limit:100,more_items_in_collection:true}}}],
 ['later page',{...emptyMailResponse,additional_data:{pagination:{start:100,limit:100,more_items_in_collection:false}}}],
 ['wrong limit',{...emptyMailResponse,additional_data:{pagination:{start:0,limit:0,more_items_in_collection:false}}}],
])('still holds the task for %s in the person mail response',async(_name,mailResponse)=>{
 const {client}=fixture({mailResponse});
 await expect(client.inspect(row)).rejects.toThrow(/reminder_source_/);
});
it('retains a visible staff-answer suppression when the CRM person mail list is empty',async()=>{
 const {client}=fixture({mailResponse:emptyMailResponse,later:[{id:'answer',from:'pm@proswppp.co',to:'cody@buyer.test',lastOutbound:true,receivedAt:'2026-11-11T12:00:00Z',subject:'Re: Pavilion'}]});
 expect((await client.inspect(row)).reason).toBe('later_reply');
});
