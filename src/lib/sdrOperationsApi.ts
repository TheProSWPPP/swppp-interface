import { sdrReadRequest } from './sdrReadRequest';
export type ReplyContext={asOf:string;from:string;to:string;mailbox:string|null;visibilitySnapshot:string|null};
export type RecentReply={id:string;receivedAt:string;mailbox:string;source:string;sourceMessageId:string|null;threadId:string|null;prospectEmail:string|null;
  project:{status:string;id:string|null;title:string|null;basis:string|null};
  owner:{status:'verified'|'unassigned';pipedriveUserId:number|null;label:string|null};
  response:{status:'unknown'|'recorded';at:string|null;source:string|null;coverage:'partial'};
  intent:string|null;actions:Array<{kind:string;status:string;requiresReview:boolean;receiptAt:string|null}>};
export type RecentRepliesResponse={state:'available'|'unavailable';context:ReplyContext;total:number|null;items:RecentReply[];nextCursor:string|null;coverage:{state:'partial'|'unknown';lastCollectedAt:string|null;note:string}};
export async function getRecentReplies(query:{asOf?:string;visibilitySnapshot?:string|null;mailbox?:string|null;cursor?:string;limit?:number}={},signal?:AbortSignal):Promise<RecentRepliesResponse> {
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(query)) if(value!=null) params.set(key,String(value));
  const result=await sdrReadRequest<RecentRepliesResponse>(`/api/sdr/operations/replies?${params}`,signal);
  if(!['available','unavailable'].includes(result.state)||!result.context?.asOf||!result.context.from||!result.context.to||!(result.context.visibilitySnapshot===null||typeof result.context.visibilitySnapshot==='string')||!Array.isArray(result.items)||!result.coverage||!(result.total===null||Number.isSafeInteger(result.total))||!result.items.every(item=>item&&typeof item.id==='string'&&typeof item.receivedAt==='string'&&typeof item.mailbox==='string'&&typeof item.source==='string'&&item.project&&typeof item.project.status==='string'&&item.owner&&['verified','unassigned'].includes(item.owner.status)&&item.response&&['unknown','recorded'].includes(item.response.status)&&Array.isArray(item.actions)&&item.actions.every(action=>action&&typeof action.kind==='string'&&typeof action.status==='string'))) throw new Error('Recent replies are unavailable. Please retry.');
  return result;
}

// The browser's first page, retries and continuation all share the summary's
// exact database visibility token and clock; never recapture between pages.
export function getRecentReplyPage(context:ReplyContext,cursor?:string,signal?:AbortSignal):Promise<RecentRepliesResponse> {
  return getRecentReplies({asOf:context.asOf,visibilitySnapshot:context.visibilitySnapshot,mailbox:context.mailbox,cursor,limit:20},signal);
}
