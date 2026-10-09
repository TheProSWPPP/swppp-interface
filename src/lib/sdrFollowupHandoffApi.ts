import {sdrFetch} from './sdrApi';
export interface HandoffReceipt {
 id:string;status:'reserved'|'confirmed'|'uncertain'|'not_attempted';reason?:string;noteId:string|null;readbackVerified:boolean;projectUrl:string;checkedAt:string;revision:number;
}
export interface HandoffContentPreview {
 noteHtml:string;previewToken:string;revision:number;leadId:string;content:{subject:string;body:string};
 owner:{id:string|null;name:string|null};contact:{id:string|null;name:string|null;email:string|null};
 checkedAt:string;replyCoverage:'unverified';requiresLatestConversationReview:true;publication:null;
}
export type HandoffPreview=HandoffContentPreview|{publication:HandoffReceipt;revision:number;replyCoverage:'unverified';requiresLatestConversationReview:true};
export interface HandoffInput {expectedRevision:number;contextToken:string}
export const followupHandoffApi={
 preview:(leadId:string,input:HandoffInput)=>sdrFetch<HandoffPreview>(`/api/sdr/followup-handoffs/${encodeURIComponent(leadId)}/preview`,{method:'POST',body:JSON.stringify(input)}),
 publish:(leadId:string,input:HandoffInput&{previewToken:string;latestConversationReviewed:true})=>sdrFetch<HandoffReceipt>(`/api/sdr/followup-handoffs/${encodeURIComponent(leadId)}/publish`,{method:'POST',body:JSON.stringify(input)}),
 reconcile:(leadId:string,handoffId:string)=>sdrFetch<HandoffReceipt>(`/api/sdr/followup-handoffs/${encodeURIComponent(leadId)}/reconcile`,{method:'POST',body:JSON.stringify({handoffId})}),
};
export type HandoffApi=typeof followupHandoffApi;
