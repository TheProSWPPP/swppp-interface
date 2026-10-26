import { sdrReadRequest } from './sdrReadRequest';
export type OutreachJob = {job:string;label:string;scope:string;state:'current'|'late'|'failed'|'partial'|'running'|'skipped'|'outside_hours'|'not_connected';intervalMs:number|null;status:string|null;lastAttempt:string|null;lastFinished:string|null;lastComplete?:string|null;errorCategory:string|null;nextRetryAt:string|null;counts?:Record<string,number>};
export type InboxReadState = {mailbox:string;status:'current'|'stale'|'error'|'not_checked'|string;checkedAt:string|null;issue:string|null;retryAt:string|null};
export type OutreachHealth = {state:'available'|'unavailable';jobs:OutreachJob[];inboxReads?:InboxReadState[]};
export const getOutreachHealth=(signal?:AbortSignal)=>sdrReadRequest<OutreachHealth>('/api/sdr/health',signal);
