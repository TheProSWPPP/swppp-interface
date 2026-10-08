import {sdrFetch} from './sdrApi';
export interface FollowupDraftResponse {
 draft:null|{subject:string;body:string;revision:number;contextToken:string;updatedAt:string};
 contextToken:string;
 contextChanged:boolean;
 context:{
  lead:{title:string;ownerId:string|null;personId:string|null;contactName:string};
  records:Array<{id:string;entity:string;subject:string;text:string;textTruncated:boolean;type:string|null;done:boolean;dueDate:string|null;ownerId:string|null;sourceUpdatedAt:string|null}>;
  holds:Array<{id:string;reason:string;providerStopStatus:string}>;
  limited:boolean;coverage:'partial';orderLink:'unverified';
 };
}
export const followupDraftApi={
 read:(leadId:string)=>sdrFetch<FollowupDraftResponse>(`/api/sdr/followup-drafts/${encodeURIComponent(leadId)}`),
 save:(leadId:string,input:{subject:string;body:string;expectedRevision:number;contextToken:string;acknowledgeContext:boolean})=>
  sdrFetch<FollowupDraftResponse>(`/api/sdr/followup-drafts/${encodeURIComponent(leadId)}`,{method:'PUT',body:JSON.stringify(input)}),
};
