import type {CrmFollowUp} from '../../lib/sdrCrmApi';
export function groupFollowups(items:CrmFollowUp[]) {
 const groups=new Map<string,CrmFollowUp[]>();
 for(const item of items){const tasks=groups.get(item.leadId)||[];if(!tasks.some(task=>task.id===item.id))tasks.push(item);groups.set(item.leadId,tasks);}
 return [...groups].map(([leadId,tasks])=>({leadId,tasks,project:tasks[0]}));
}
export function followupNextAction(item:CrmFollowUp) {
 if(item.restrictions?.length)return 'Review the restriction before contacting this buyer.';
 if(item.outreachReviewRequired)return 'Confirm the current contact and outreach restrictions.';
 if(item.lastReply&&!item.lastReply.staffResponseAt)return 'Read the latest reply and check whether the team has responded.';
 if(item.type==='email')return 'Check the email thread for delivery and replies.';
 return null;
}
export function chicagoDay(date=new Date()) {
 return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
export function followupDue(date:string|null,today=chicagoDay()) {
 if(!date)return 'No date';
 const days=Math.round((Date.parse(today+'T12:00:00Z')-Date.parse(date+'T12:00:00Z'))/86400000);
 return days===0?'Today':days>0?`${days}d overdue`:`In ${-days}d`;
}
