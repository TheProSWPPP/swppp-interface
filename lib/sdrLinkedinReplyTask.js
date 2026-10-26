import {linkedinHash} from './sdrLinkedinStore.js';
const fail=code=>Object.assign(new Error(code),{code});
const value=v=>v==null?'':String(v?.value??v?.id??v);
const dueDate=now=>new Date(now).toISOString().slice(0,10);

// A LinkedIn reply becomes a Pipedrive task for the lead owner with the reply text pre-filled.
// Nothing is sent. The row is claimed before the Pipedrive write, so a retry after a lost
// receipt finds the earlier task by its marker instead of creating a second one.
export async function createLinkedinReplyTask({pool,crm,candidate,links,event,text,appBase=process.env.PUBLIC_BASE_URL||'https://swppp-interface-production.up.railway.app',now=new Date()}){
 if(!crm?.addActivity||!crm?.listActivities||!crm?.getLead)throw fail('reply_task_crm_unavailable');
 if(!candidate?.id||!event?.source_message_id||!links?.length)throw fail('reply_task_identity_unverified');
 const link=links.find(l=>l.lead_id===candidate.source_id)||(links.length===1?links[0]:[...links].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0]);
 const existing=(await pool.query('SELECT * FROM sdr_linkedin_reply_tasks WHERE company_id=$1 AND account_id=$2 AND source_message_id=$3',[candidate.company_id,candidate.account_id,event.source_message_id])).rows[0];
 if(existing?.state==='created')return {state:'created',activityId:existing.activity_id,duplicate:true};
 const lead=await crm.getLead(link.lead_id);
 const assigneeId=existing?.assignee_id||value(lead?.owner_id)||value(candidate.pipedrive_owner_id);
 if(!assigneeId)throw fail('reply_task_owner_unavailable');
 const marker=existing?.marker||`[li:${linkedinHash({account:candidate.account_id,message:event.source_message_id}).slice(0,12)}]`;
 if(!existing)await pool.query(`INSERT INTO sdr_linkedin_reply_tasks(company_id,account_id,source_message_id,candidate_id,lead_id,assignee_id,marker) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[candidate.company_id,candidate.account_id,event.source_message_id,candidate.id,link.lead_id,assigneeId,marker]);
 const claimed=(await pool.query('SELECT * FROM sdr_linkedin_reply_tasks WHERE company_id=$1 AND account_id=$2 AND source_message_id=$3',[candidate.company_id,candidate.account_id,event.source_message_id])).rows[0];
 if(claimed.state==='created')return {state:'created',activityId:claimed.activity_id,duplicate:true};
 const finish=async activityId=>{await pool.query(`UPDATE sdr_linkedin_reply_tasks SET state='created',activity_id=$2,completed_at=now() WHERE id=$1`,[claimed.id,String(activityId)]);return {state:'created',activityId:String(activityId)}};
 const earlier=(await crm.listActivities(claimed.lead_id,{limit:100})).find(a=>String(a.subject||'').includes(claimed.marker));
 if(earlier?.id)return finish(earlier.id);
 const thread=event.chat_id?`https://www.linkedin.com/messaging/thread/${encodeURIComponent(event.chat_id)}/`:candidate.profile_url;
 const note=[`LinkedIn reply from ${candidate.profile_url}:`,'',String(text||'').trim()||'(Open LinkedIn to read the reply.)','',`Open the LinkedIn conversation: ${thread}`,`Open in interface: ${appBase}/#/sdr?inboxLead=${encodeURIComponent(claimed.lead_id)}`,'','LinkedIn outreach for this person has stopped. Reply by hand in LinkedIn.'].join('\n');
 const receipt=await crm.addActivity({leadId:claimed.lead_id,type:'task',done:false,dueDate:dueDate(now),userId:Number(claimed.assignee_id),strictAssignee:true,subject:`LinkedIn reply — follow up ${claimed.marker}`,note});
 const owner=receipt?.user_id??receipt?.owner_id;
 if(!receipt?.id||String(owner)!==String(claimed.assignee_id))throw fail('reply_task_receipt_unverified');
 return finish(receipt.id);
}
