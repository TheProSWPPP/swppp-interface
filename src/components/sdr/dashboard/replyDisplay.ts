import type {RecentReply} from '../../../lib/sdrOperationsApi';
export function replyTime(value:string|null){return value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'Not recorded';}
export function projectLabel(reply:RecentReply){return reply.project.status==='verified'&&reply.project.id?reply.project.title||'Linked project':reply.project.status==='ambiguous'?'Project link ambiguous':'Project not linked';}
export function ownerLabel(reply:RecentReply){return reply.owner.status==='verified'&&reply.owner.pipedriveUserId?`Routing owner: Pipedrive #${reply.owner.pipedriveUserId}`:'Owner unassigned';}
