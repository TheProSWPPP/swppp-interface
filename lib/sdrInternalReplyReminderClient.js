import {addressOf,htmlToText} from './sdrReplyTask.js';
import {reminderHash} from './sdrInternalReplyReminders.js';
const timestamp=value=>{const s=String(value||'').replace(' ','T');return +new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(s)?s:s+'Z');};
const subject=s=>String(s||'').replace(/^(?:(?:re|fw|fwd):\s*)+/i,'').trim().toLowerCase();
const addresses=v=>Array.isArray(v)?v.map(x=>addressOf(x.email_address||x.email||x)).filter(Boolean):(String(v||'').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig)||[]).map(x=>x.toLowerCase());
export function createInternalReminderClient({token,companyId,getThread,fetchImpl=fetch}){
 if(!token||String(companyId)!=='13105180')throw Error('reminder_company_configuration');
 async function request(path,query={}){
  const u=new URL('https://api.pipedrive.com/v1'+path);for(const [k,v]of Object.entries(query))u.searchParams.set(k,String(v));
  const r=await fetchImpl(u,{method:'GET',headers:{'x-api-token':token},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error('reminder_source_unavailable');const j=await r.json();if(j?.success!==true)throw Error('reminder_source_unavailable');return j;
 }
 async function list(path,query={}){
  const j=await request(path,{...query,limit:100});
  const page=j.additional_data?.pagination;
  if(j.data===null&&page?.start===0&&page.limit===100&&page.more_items_in_collection===false)return [];
  if(!Array.isArray(j.data)||j.additional_data?.pagination?.more_items_in_collection===true||j.data.length>=100)throw Error('reminder_source_incomplete');
  return j.data.map(x=>x.data||x);
 }
 const taskRead=async id=>{if(!/^\d+$/.test(String(id)))throw Error('reminder_task_identity');const t=(await request('/activities/'+id)).data;if(String(t?.id)!==String(id)||typeof t.done!=='boolean'||!Number(t.user_id))throw Error('reminder_task_identity');return t;};
 return {
  async validateIdentity(){const me=(await request('/users/me')).data;if(String(me?.company_id)!==String(companyId)||me.company_domain!=='proswpppllc')throw Error('reminder_company_mismatch');},
  users:()=>list('/users'),
  async inspect(row){
   const task=await taskRead(row.external_id);
   if(!String(task.note||'').includes(`[SDR reply action ${row.id}]`)||String(task.lead_id||'')!==String(row.payload?.leadId||''))throw Error('reminder_task_identity');
   const snapshot={id:task.id,done:task.done,user:task.user_id,due:task.due_date,time:task.due_time,note:task.note,subject:task.subject,lead:task.lead_id,person:task.person_id};
   if(task.done)return {task,handled:true,reason:'task_completed',fingerprint:reminderHash(snapshot)};
   let original,messages;
   if(row.source==='gmail'){
    const thread=await getThread(row.mailbox_email,row.thread_id);if(!Array.isArray(thread?.messages))throw Error('reminder_conversation_unavailable');messages=thread.messages;
    original=messages.find(m=>m.id===row.source_message_id);
   }else if(row.source==='pipedrive'){
    const m=(await request('/mailbox/mailMessages/'+encodeURIComponent(row.source_message_id),{include_body:1})).data;
    if(!m||String(m.id)!==String(row.source_message_id)||!m.mail_thread_id)throw Error('reminder_conversation_unavailable');
    const raw=await list('/mailbox/mailThreads/'+m.mail_thread_id+'/mailMessages');
    const map=x=>({...x,from:addresses(x.from)[0],to:addresses(x.to).join(', '),receivedAt:timestamp(x.message_time),lastOutbound:x.sent_flag===1});
    original=map(m);messages=raw.map(map);
   }else throw Error('reminder_source_unsupported');
   if(!original||addressOf(original.from)!==String(row.from_email).toLowerCase()||!Number.isFinite(+new Date(original.receivedAt)))throw Error('reminder_reply_identity');
   const at=+new Date(original.receivedAt),buyer=addressOf(original.from);
   const newer=messages.filter(m=>+new Date(m.receivedAt)>at);
   const answered=newer.some(m=>m.lastOutbound&&addresses(m.to).includes(buyer)&&subject(m.subject)===subject(original.subject));
   const newerBuyer=newer.some(m=>!m.lastOutbound&&addressOf(m.from)===buyer);
   let handled=answered||newerBuyer,reason=answered?'later_reply':newerBuyer?'newer_buyer_message':null;
   const context=[];
   if(task.lead_id){
    const lead=(await request('/leads/'+encodeURIComponent(task.lead_id))).data;
    if(!lead||String(lead.id)!==String(task.lead_id)||lead.is_archived!==false)throw Error('reminder_lead_unavailable');
    const notes=await list('/notes',{lead_id:task.lead_id});
    const activities=await list('/activities',{lead_id:task.lead_id,user_id:0});
    const staffNotes=notes.filter(n=>timestamp(n.add_time)>at&&!/^(?:\[Auto\]|Outreach |\[SDR|<b>Outreach)/i.test(String(n.content||''))&&htmlToText(n.content).trim());
    const calls=activities.filter(a=>String(a.id)!==String(task.id)&&a.done===true&&['call','meeting','contact_attempt'].includes(a.type)&&timestamp(a.marked_as_done_time)>at);
    if(staffNotes.length||calls.length){handled=true;reason='staff_activity_recorded';}
   }
   let personId=task.person_id;
   if(!personId){
    const search=await request('/persons/search',{term:buyer,fields:'email',exact_match:true,limit:100});
    if(!Array.isArray(search.data?.items)||search.additional_data?.pagination?.more_items_in_collection===true||search.data.items.length>1)throw Error('reminder_person_ambiguous');
    personId=search.data.items[0]?.item?.id;
   }
   if(personId){
    const mails=await list('/persons/'+personId+'/mailMessages');
    if(mails.some(m=>m.sent_flag===1&&timestamp(m.message_time)>at&&addresses(m.to).includes(buyer)&&
      (String(m.lead_id||'')===String(task.lead_id||'')&&!!task.lead_id||subject(m.subject)&&subject(m.subject)===subject(original.subject)))){handled=true;reason='visible_crm_reply';}
   }
   return {task,original:{...original,body:htmlToText(original.body||'')},handled,reason,context,
    fingerprint:reminderHash({...snapshot,originalId:original.id,subject:original.subject,body:original.body,newer:newer.map(m=>m.id),handled,reason})};
  },
 };
}
