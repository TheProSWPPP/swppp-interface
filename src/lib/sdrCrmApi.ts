import {sdrFetch} from './sdrApi';

export type CrmFollowUp = {id:string;leadId:string;leadTitle?:string|null;leadLifecycle?:string|null;subject:string|null;type?:string|null;note:string|null;ownerId:string|null;ownerName?:string|null;dueDate:string|null;dueTime:string|null;done:boolean;sourceUpdatedAt:string|null;observedAt:string|null;sourceUrl:string|null};
export type CrmSnapshot = {entity:string;entity_id:string;data:Record<string,unknown>|null;lifecycle:string;source_updated_at:string|null;observed_at:string|null;source_url:string|null;access_status?:string};
export type CrmHealth = {scopes:Array<{scope:string;status:string;checkedAt?:string|null;completedThrough?:string|null;errorCategory?:string|null}>;inbox:{pending:number;leased:number;dead:number;oldestPendingAt:string|null};observedAt:string};
export type CrmObservations = {lead:CrmSnapshot|null;items:CrmSnapshot[];revisions:Array<{entity:string;entity_id:string;action:string;source_at:string|null;observed_at:string|null;data:Record<string,unknown>|null;source_url:string|null}>;hasMore?:{items:boolean;revisions:boolean};unavailable?:string|null;freshness:CrmHealth;source:string};
const leadPath=(id:string)=>`/api/sdr/crm/leads/${encodeURIComponent(id)}`;
export const sdrCrmApi={
  users:()=>sdrFetch<{users:Array<{id:string;name:string}>;checkedAt:string}>('/api/sdr/crm/users'),
  followups:(query='')=>sdrFetch<{items:CrmFollowUp[];nextCursor:string|null;freshness:CrmHealth;unavailable?:string|null}>(`/api/sdr/crm/followups${query}`),
  observations:(id:string)=>sdrFetch<CrmObservations>(`${leadPath(id)}/observations`),
};
