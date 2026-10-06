import {sdrReadRequest} from './sdrReadRequest';
export type ActivityKind='all'|'sent'|'reply';
export type ActivityEvent={id:string;kind:'sent'|'reply';occurredAt:string;mailbox:string;contact:string;projectId:string|null;projectTitle:string|null;threadId:string|null};
export type ActivityFeedResponse={checkedAt:string;from:string;items:ActivityEvent[];sources:{sends:string|null;replies:string|null}};
export async function getActivityFeed(kind:ActivityKind,signal?:AbortSignal):Promise<ActivityFeedResponse> {
 const data=await sdrReadRequest<ActivityFeedResponse>(`/api/sdr/operations/activity?kind=${kind}`,signal);
 if(!data.checkedAt||!data.from||!data.sources||!Array.isArray(data.items)||!data.items.every(item=>typeof item.id==='string'&&['sent','reply'].includes(item.kind)&&Number.isFinite(Date.parse(item.occurredAt))&&typeof item.mailbox==='string'&&typeof item.contact==='string'))throw Error('Activity unavailable');
 return data;
}
