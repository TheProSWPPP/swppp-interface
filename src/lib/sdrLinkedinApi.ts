import {sdrFetch} from './sdrApi';
export interface LinkedinCandidate {id:string;source:string;source_id:string;profile_url:string;segment:string|null;territory:string|null;firm:string|null;role:string|null;person_id:string|null;owner_id:string|null;state:string;hold_reason:string|null;revision:number;created_at:string;lane?:string|null;priority?:number|null;title_rank?:number|null;active_30d?:boolean|null}
export const canOpenLinkedinProfile=(candidate:LinkedinCandidate)=>Boolean(candidate.person_id&&/^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_-]+\/?$/.test(candidate.profile_url));
export interface LinkedinReviewData {mode:string;candidates:LinkedinCandidate[];account?:{product?:string;status:string;status_observed_at?:string|null;mode:string;coverage?:Record<string,unknown>}|null}
export interface LinkedinDraft {id:string;candidate_id:string;revision:number;context_hash:string;body:string;state:string;updated_at:string}
export interface LinkedinMetrics {counts:Record<string,number|null>;coverage:string;availability?:Record<string,string>;byLane?:Record<string,{candidates:number;reviewed:number}>}
export type LinkedinLane='A'|'B'|'C'|'D';
export const LANE_NAMES:Record<LinkedinLane,string>={A:'A. New in the seat',B:'B. Old contacts who moved',C:'C. Whoever replaced them',D:'D. Talking about stormwater'};
export interface LinkedinCopyPreview {body:string|null;subject?:string;reason:string|null;missing?:string[]}
export interface LinkedinDryRunPerson {order:number;candidateId:string;name:string|null;title:string|null;company:string|null;state:string|null;lane:LinkedinLane;priority:number;active30d:boolean;roleStartedOn:string|null;profileUrl:string;inCampaign:boolean;campaignStatus:string;copy:Record<string,LinkedinCopyPreview>}
export interface LinkedinLaneDApproval {candidateId:string;revision:number;name:string|null;title:string|null;company:string|null;state:string|null;profileUrl:string;post:{url:string|null;excerpt:string;postedAt:string|null}|null;topic:string;reaction:string}
export interface LinkedinAgedInvite {candidateId:string;lane:LinkedinLane;name:string|null;company:string|null;sentAt:string;invitationIdKnown:boolean}
export interface LinkedinDryRun {providerCalls:number;at:string;ramp:{started:boolean;rampStartedOn:string|null;weekInRamp:number|null;rampBudget:number;usedToday:number;remaining:number};account:{mode:string;status:string;inmailBalance:number|null;snSyncStale:boolean}|null;campaigns:Record<string,{id:string;status:string;revision:number}>;lanes:Record<LinkedinLane,LinkedinDryRunPerson[]>;held:Record<string,number>;awaitingCopy:LinkedinLaneDApproval[];wouldWithdraw:LinkedinAgedInvite[];wouldInmail:LinkedinAgedInvite[]}
export interface LinkedinReplyAlert {id:string;state:string;lane:LinkedinLane|null;reply_text:string;suggested_answer:string|null;thread_url:string|null;created_at:string;sent_at:string|null;reminder1_sent_at:string|null;reminder3_sent_at:string|null;answered_at:string|null;failure_reason:string|null;candidate_id:string;name:string|null;company:string|null;title:string|null;profile_url:string}
export interface LinkedinStageResult {runId:string;lane:LinkedinLane;dryRun:boolean;considered:number;staged:{name:string|null;company:string|null}[];wouldStage:{name:string|null;title:string|null;company:string|null;state:string|null}[];skipped:Record<string,number>;stopped:string|null}
export interface LinkedinOldCustomerImport {dryRun?:boolean;rows:number;inserted:number;updated:number;errors:{row:number;reason:string}[]}
export interface LinkedinOldCustomers {rows:{id:string;full_name:string;company:string;status:string;current_company:string|null;current_title:string|null}[];counts:Record<string,number>}
const post=<T,>(path:string,body:unknown)=>sdrFetch<T>(path,{method:'POST',body:JSON.stringify(body)});
export const sdrLinkedinApi={
 review:()=>sdrFetch<LinkedinReviewData>('/api/sdr/linkedin/review'),
 metrics:()=>sdrFetch<LinkedinMetrics>('/api/sdr/linkedin/metrics'),
 draft:(candidateId:string)=>sdrFetch<LinkedinDraft>(`/api/sdr/linkedin/drafts/${encodeURIComponent(candidateId)}`),
 saveDraft:(draft:LinkedinDraft,body:string)=>sdrFetch<LinkedinDraft>(`/api/sdr/linkedin/drafts/${encodeURIComponent(draft.id)}`,{method:'PATCH',body:JSON.stringify({expectedRevision:draft.revision,contextHash:draft.context_hash,body})}),
 replies:()=>sdrFetch<{alerts:LinkedinReplyAlert[]}>('/api/sdr/linkedin/replies'),
 markHandled:(alertId:string)=>post<{id:string;state:string}>(`/api/sdr/linkedin/replies/${encodeURIComponent(alertId)}/handled`,{}),
 dryRun:()=>sdrFetch<LinkedinDryRun>('/api/sdr/linkedin/admin/dry-run'),
 stageLane:(lane:LinkedinLane,{limit=25,dryRun=true,company}:{limit?:number;dryRun?:boolean;company?:string}={})=>post<LinkedinStageResult>(`/api/sdr/linkedin/admin/lanes/${lane}/stage`,{limit,dryRun,...(company?{company}:{})}),
 laneDCopy:(candidateId:string,body:{expectedRevision:number;decision:'approve'|'reject';topic?:string;reaction?:string})=>post<{id:string;state:string;revision:number}>(`/api/sdr/linkedin/admin/candidates/${encodeURIComponent(candidateId)}/lane-d-copy`,body),
 importOldCustomers:(csvText:string,dryRun:boolean)=>post<LinkedinOldCustomerImport>(`/api/sdr/linkedin/admin/old-customers/import${dryRun?'?dryRun=1':''}`,{csvText}),
 checkOldCustomers:(limit=25)=>post<{counts:Record<string,number>}>('/api/sdr/linkedin/admin/old-customers/check',{limit}),
 oldCustomers:()=>sdrFetch<LinkedinOldCustomers>('/api/sdr/linkedin/admin/old-customers'),
};
