import {createHash,randomUUID} from 'node:crypto';
import {wall,replyExcerpt,htmlToText} from './sdrReplyTask.js';
const TZ='America/Chicago';
const isoDay=d=>{const w=wall(new Date(d),TZ);return `${w.y}-${String(w.m).padStart(2,'0')}-${String(w.d).padStart(2,'0')}`;};
const validDay=s=>/^\d{4}-\d\d-\d\d$/.test(s||'')&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;
const shift=(day,n,business=false)=>{let d=new Date(day+'T12:00:00Z');for(let i=0;i<Math.abs(n);){d.setUTCDate(d.getUTCDate()+Math.sign(n));if(!business||![0,6].includes(d.getUTCDay()))i++;}return d.toISOString().slice(0,10);};
const businessMorning=day=>{while([0,6].includes(new Date(day+'T12:00:00Z').getUTCDay()))day=shift(day,1);return day;};
const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
function namedDay(text,received){
 const m=new RegExp(`\\b(${months.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,'i').exec(text);if(!m)return null;
 let y=m[3]?Number(m[3]):Number(received.slice(0,4));const month=months.indexOf(m[1].toLowerCase())+1;
 if(!m[3]&&`${y}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`<received)y++;
 const d=`${y}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`;return validDay(d)&&d>=received?d:null;
}
export function requestedTiming({text,intent,receivedAt}){
 const received=isoDay(receivedAt),own=replyExcerpt(htmlToText(text),6000);
 const deadlineMatch=/\b(?:proposals?|pricing|quotes?)\b[^.!?\n]{0,80}?\b(?:by|due(?:\s+on)?)\s+([^.!?\n]+)/i.exec(own);
 const deadline=deadlineMatch?namedDay(deadlineMatch[1],received):null;
 let requested=null;
 const explicit=/\b(?:check back|follow[ -]?up|contact|reach out)\b[^.!?\n]{0,120}/i.exec(own);
 if(intent==='nurture'||explicit){
  const timingText=intent==='nurture'?own:explicit[0];
  if(explicit)requested=namedDay(explicit[0],received);
  const rel=/\b(?:in|another|after)\s+(?:(one|two|three|four|a|an|\d{1,2})\s+)?(business\s+days?|days?|weeks?)\b/i.exec(timingText);
  if(!requested&&rel){const n=({one:1,two:2,three:3,four:4,a:1,an:1})[rel[1]?.toLowerCase()]||Number(rel[1]||1);if(n>0&&n<=30)requested=shift(received,rel[2].startsWith('week')?n*7:n,rel[2].startsWith('business'));}
  if(!requested&&/\bnext week\b/i.test(timingText))requested=shift(received,7);
  if(!requested&&/\b(?:mid(?:dle of)?[- ]?(?:the )?next month)\b/i.test(timingText)){
   const d=new Date(received+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1,15);requested=d.toISOString().slice(0,10);
  }
 }
 return {requested:requested?businessMorning(requested):null,deadline,needsTiming:intent==='nurture'&&!requested};
}
export function planReminder({receivedAt,now=new Date(),task,intent,text,notices=[]}){
 now=new Date(now);if(!Number.isFinite(+now)||!Number.isFinite(+new Date(receivedAt))||!task||task.done!==false)return null;
 const w=wall(now,TZ),today=isoDay(now),weekday=new Date(today+'T12:00:00Z').getUTCDay();
 if([0,6].includes(weekday)||w.h<9||w.h>=17)return null;
 if(notices.some(n=>['reserved','uncertain'].includes(n.state)))return null;
 if(notices.some(n=>n.local_day===today&&n.state==='sent'))return null;
 const timing=requestedTiming({text,intent,receivedAt});
 const due=validDay(task.due_date)?task.due_date:null;
 if(due&&due>today)return null;
 if(due&&/^\d\d:\d\d(?::\d\d)?$/.test(task.due_time||'')&&+new Date(`${due}T${task.due_time.length===5?task.due_time+':00':task.due_time}Z`)>+now)return null;
 if(timing.needsTiming)return null;
 const first=[shift(isoDay(receivedAt),1,true),timing.requested,due].filter(Boolean).sort().at(-1);
 if(today<first)return null;
 const eligible=step=>!notices.some(n=>n.step===step&&n.state==='sent');
 if(timing.deadline){
  const days=[['deadline_1',1],['deadline_2',2]];
  for(const [step,n] of days)if(today===shift(timing.deadline,-n,true)&&eligible(step))return {step,localDay:today,deadline:timing.deadline};
 }
 const sent=notices.filter(n=>n.state==='sent').sort((a,b)=>+new Date(a.sent_at)-+new Date(b.sent_at));
 if(!sent.length)return {step:'owner',localDay:today,deadline:timing.deadline};
 const firstSent=isoDay(sent[0].sent_at);
 if(today>=shift(firstSent,1,true)&&today>=shift(isoDay(receivedAt),2,true)&&(!due||today>=shift(due,1,true))&&eligible('escalation'))return {step:'escalation',localDay:today,deadline:timing.deadline};
 return null;
}
export function reminderEmail({task,step,buyer,deadline,context=[]}){
 const link=`https://proswpppllc.pipedrive.com/activities/${Number(task.id)}`;
 const title=String(task.subject||'Buyer reply').replace(/[\r\n]+/g,' ').slice(0,180);
 return {subject:`${step==='escalation'?'Still open':'Please check'}: ${title}`,
  bodyText:[`Was this request handled?`,title,buyer?`Buyer: ${buyer}`:null,deadline?`Proposal deadline: ${deadline}`:null,
   'The Pipedrive task is still open. Another .com email or phone call may already have handled it.',
   ...context,
   'If handled, mark the task done in Pipedrive. If waiting on the buyer or following up later, move its due date to the next date you want to check.',
   'Check your sent mail, calls and notes before contacting the buyer again.',link,
   'This is an internal reminder. It has not sent a message to the buyer.'].filter(Boolean).join('\n\n')};
}
export const reminderHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

const internalEmail=value=>typeof value==='string'&&/^[a-z0-9._%+-]+@proswppp\.com$/i.test(value)?value.toLowerCase():null;
async function recipientFor(db,client,userId){
 const users=await client.users(),user=users.find(u=>String(u.id)===String(userId));
 if(!user||user.active_flag!==true||user.is_deleted===true||!internalEmail(user.email))throw Error('owner_unavailable');
 const rows=(await db.query('SELECT forward_to FROM sdr_reply_routes WHERE pipedrive_user_id=$1 AND active AND verified_at IS NOT NULL',[userId])).rows;
 const addresses=[...new Set(rows.map(r=>internalEmail(r.forward_to)).filter(Boolean))];
 if(addresses.length!==1||addresses[0]!==internalEmail(user.email))throw Error('owner_route_unverified');return addresses[0];
}
export async function runInternalReplyReminders(pool,{mode='off',companyId,since,seedTaskIds=[],derekUserId,now=new Date(),client,notify,limit=25,clock=null}={}){
 const result={mode,checked:0,sent:0,uncertain:0,rejected:0,held:0,plans:[],errors:[]};
 if(!['dry_run','live'].includes(mode))return result;
 if(String(companyId)!=='13105180'||!Number.isFinite(+new Date(since))||!Number(derekUserId)||!Array.isArray(seedTaskIds)||seedTaskIds.some(id=>!/^\d+$/.test(String(id))))throw Error('reminder_configuration');
 const lock=await pool.connect(),lockName=`internal-reply-reminders:${companyId}`;let locked=false;
 try{
  locked=(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok',[lockName])).rows[0].ok;if(!locked)return {...result,busy:true};
  await client.validateIdentity();
  if(mode==='live'&&typeof notify?.check==='function'){
   const uncertain=(await pool.query("SELECT * FROM sdr_internal_reply_reminder_notices WHERE company_id=$1 AND state IN ('reserved','uncertain') ORDER BY reconciled_at NULLS FIRST,created_at LIMIT 10",[companyId])).rows;
   for(const n of uncertain){
    try{const found=await notify.check(n);if(found?.id)await pool.query("UPDATE sdr_internal_reply_reminder_notices SET state='sent',provider_id=$2,sent_at=COALESCE(sent_at,created_at),safe_error=NULL WHERE id=$1 AND company_id=$3 AND state IN ('reserved','uncertain')",[n.id,found.id,companyId]);}catch{/* An absent/unavailable receipt never authorizes a resend. */}
    finally{await pool.query('UPDATE sdr_internal_reply_reminder_notices SET reconciled_at=now() WHERE id=$1 AND company_id=$2',[n.id,companyId]);}
   }
  }
  const rows=(await pool.query(`SELECT a.id,a.external_id,a.payload,a.created_at,r.* FROM sdr_reply_actions a JOIN sdr_reply_messages r USING(provider_message_id)
    LEFT JOIN sdr_internal_reply_reminder_checks c ON c.company_id=$1 AND c.task_id=a.external_id
    WHERE a.kind='create_task' AND a.status='completed' AND a.external_id ~ '^[0-9]+$'
      AND r.reply_kind='human' AND r.intent IN ('interested','question','nurture','unknown')
      AND r.staff_response_at IS NULL AND r.received_at<=$2
      AND (a.created_at>=$3 OR a.external_id=ANY($4::text[]))
    ORDER BY c.checked_at NULLS FIRST,r.received_at,a.id LIMIT $5`,[companyId,now,since,seedTaskIds.map(String),Math.min(Math.max(limit,1),50)])).rows;
  for(const row of rows){
   let outcome='held';result.checked++;
   try{
    const ctx=await client.inspect(row);if(ctx.handled){outcome=ctx.reason||'handled';continue;}
    const recipient=await recipientFor(pool,client,ctx.task.user_id);
    const allNotices=(await pool.query("SELECT *,to_char(local_day,'YYYY-MM-DD') AS local_day FROM sdr_internal_reply_reminder_notices WHERE company_id=$1 AND task_id=$2 AND state<>'cancelled'",[companyId,row.external_id])).rows;
    // Reassignment gets its own first reminder; retain global same-day and uncertainty holds.
    const notices=allNotices.filter(n=>n.recipient===recipient||n.step==='escalation'||n.state!=='sent'||n.local_day===isoDay(now));
    const plan=planReminder({receivedAt:row.received_at,now,task:ctx.task,intent:row.intent,text:ctx.original.body,notices});
    if(!plan||(plan.step==='escalation'&&String(ctx.task.user_id)===String(derekUserId))){outcome='not_due_or_held';continue;}
    const to=plan.step==='escalation'?await recipientFor(pool,client,derekUserId):recipient;
    const email=reminderEmail({task:ctx.task,step:plan.step,buyer:row.from_email,deadline:plan.deadline,context:ctx.context});
    result.plans.push({taskId:row.external_id,ownerId:ctx.task.user_id,to,...plan,...email});
    if(mode==='dry_run'){outcome='planned';continue;}
    if(typeof notify!=='function')throw Error('notifier_unavailable');
    const send=notify.prepare?await notify.prepare():notify;
    const messageId=`<internal-reminder-${randomUUID()}@proswppp.co>`;
    const claim=(await pool.query(`INSERT INTO sdr_internal_reply_reminder_notices(company_id,task_id,action_id,step,local_day,recipient,owner_id,state,context_hash,message_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[companyId,row.external_id,row.id,plan.step,plan.localDay,to,ctx.task.user_id,ctx.fingerprint,messageId,now])).rows[0];
    if(!claim){outcome='already_claimed';continue;}
    let ready=false;
    try{
     const current=await client.inspect(row);
     const freshPlan=planReminder({receivedAt:row.received_at,now:clock?clock():now,task:current.task,intent:row.intent,text:current.original?.body,notices});
     const currentTo=await recipientFor(pool,client,plan.step==='escalation'?derekUserId:current.task.user_id);
     const action=(await pool.query(`SELECT a.status,r.staff_response_at,r.intent,r.reply_kind FROM sdr_reply_actions a JOIN sdr_reply_messages r USING(provider_message_id) WHERE a.id=$1`,[row.id])).rows[0];
     if(!freshPlan||freshPlan.step!==plan.step||freshPlan.localDay!==plan.localDay||current.handled||current.fingerprint!==ctx.fingerprint||currentTo!==to||action?.status!=='completed'||action.staff_response_at||action.intent!==row.intent||action.reply_kind!=='human')throw Error('context_changed');
     ready=true;
    }catch{
     await pool.query("UPDATE sdr_internal_reply_reminder_notices SET state='cancelled',safe_error='context_changed' WHERE id=$1 AND company_id=$2",[claim.id,companyId]);
     outcome='context_changed';
    }
    if(!ready)continue;
    let acknowledged=false;
    try{
     const receipt=await send({to,...email,messageId});
     if(!receipt?.id)throw Error('send_receipt_missing');
     acknowledged=true;
     await pool.query("UPDATE sdr_internal_reply_reminder_notices SET state='sent',provider_id=$2,sent_at=$3 WHERE id=$1 AND company_id=$4",[claim.id,receipt.id,now,companyId]);result.sent++;outcome='sent';
    }catch(err){
     // Explicit provider rejections are retryable; timeouts and acknowledgements remain held.
     const rejected=!acknowledged&&[400,401,403,404,405,413,422,429].includes(Number(err.status));
     await pool.query('UPDATE sdr_internal_reply_reminder_notices SET state=$3,safe_error=$4 WHERE id=$1 AND company_id=$2',[claim.id,companyId,rejected?'cancelled':'uncertain',rejected?'delivery_rejected':'delivery_unconfirmed']);
     if(rejected){result.rejected++;outcome='delivery_rejected';}else{result.uncertain++;outcome='uncertain';}
    }
   }catch{result.held++;result.errors.push({taskId:row.external_id,reason:'source_or_route_unavailable'});}
   finally{if(mode==='live')await pool.query(`INSERT INTO sdr_internal_reply_reminder_checks(company_id,task_id,checked_at,outcome) VALUES($1,$2,$3,$4)
    ON CONFLICT(company_id,task_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,outcome=EXCLUDED.outcome`,[companyId,row.external_id,now,outcome]);}
   if(result.sent+result.uncertain+result.rejected>=10)break;
  }
  return result;
 }finally{if(locked)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',[lockName]);lock.release();}
}
export function createInternalReminderNotifier({gmail,getToken,sender='dc@proswppp.co'}){
 if(!/^[a-z0-9._%+-]+@proswppp\.co$/i.test(sender))throw Error('reminder_sender');
 const deliver=token=>async message=>{
  if(!internalEmail(message.to))throw Error('reminder_recipient');
  return gmail.sendMail(token,{from:sender,to:message.to,subject:message.subject,bodyText:message.bodyText,messageId:message.messageId});
 };
 const notify=async message=>deliver(await getToken(sender))(message);
 notify.prepare=async()=>deliver(await getToken(sender));
 notify.check=async n=>{
  const token=await getToken(sender),page=await gmail.listThreadPage(token,{query:`in:sent rfc822msgid:${n.message_id.replace(/^<|>$/g,'')}`,maxResults:10});
  for(const t of page?.threads||[]){const thread=await gmail.getThread(token,t.id);const m=thread.messages?.find(m=>m.lastOutbound&&m.messageId===n.message_id&&String(m.to).trim().toLowerCase()===n.recipient);if(m)return {id:m.id};}return null;
 };
 return notify;
}
