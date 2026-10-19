import {sdrFetch} from './sdrApi';
export interface LinkedinCandidate {id:string;source:string;source_id:string;profile_url:string;segment:string|null;territory:string|null;firm:string|null;role:string|null;person_id:string|null;owner_id:string|null;state:string;hold_reason:string|null;revision:number;created_at:string}
export const canOpenLinkedinProfile=(candidate:LinkedinCandidate)=>Boolean(candidate.person_id&&/^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_-]+\/?$/.test(candidate.profile_url));
export interface LinkedinReviewData {mode:string;candidates:LinkedinCandidate[];account?:{product?:string;status:string;status_observed_at?:string|null;mode:string;coverage?:Record<string,unknown>}|null}
export interface LinkedinDraft {id:string;candidate_id:string;revision:number;context_hash:string;body:string;state:string;updated_at:string}
export interface LinkedinMetrics {counts:{staged:number;confirmedInvites:number;verifiedRelations:number;confirmedDms:number;inbound:number;interested:number;quotes:number;orders:number};coverage:string}
export const sdrLinkedinApi={
 review:()=>sdrFetch<LinkedinReviewData>('/api/sdr/linkedin/review'),
 metrics:()=>sdrFetch<LinkedinMetrics>('/api/sdr/linkedin/metrics'),
 draft:(candidateId:string)=>sdrFetch<LinkedinDraft>(`/api/sdr/linkedin/drafts/${encodeURIComponent(candidateId)}`),
 saveDraft:(draft:LinkedinDraft,body:string)=>sdrFetch<LinkedinDraft>(`/api/sdr/linkedin/drafts/${encodeURIComponent(draft.id)}`,{method:'PATCH',body:JSON.stringify({expectedRevision:draft.revision,contextHash:draft.context_hash,body})}),
};
