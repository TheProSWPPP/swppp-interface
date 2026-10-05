import { sdrReadRequest } from './sdrReadRequest';
export type Metric = { value:number|null; numerator?:number; denominator?:number; state:'available'|'partial'|'unavailable'; reason?:string };
export type MetricKey = 'messages_completed'|'contacts_reached'|'first_touches'|'followups_completed'|'human_replies_received'|
  'human_reply_rate'|'positive_reply_rate'|'followup_completion_rate'|'duplicate_rate'|'quote_close_rate'|'contact_to_win_rate'|
  'won_booked_value'|'average_won_deal_value'|'company_won_booked_value'|'company_average_won_deal_value'|'company_won_deals'|'won_deals'|
  'collected_value'|'eligible_supply'|'bounce_rate'|'bounce_events'|'spam_blocked_events'|'open_rate'|'spam_rate'|'unresolved_quotes';
export type MetricsQuery = { from:string; to:string; timezone?:'America/Chicago'; mailbox?:string; source?:string; sequence?:string };
export type MetricsResponse = {
  test_data?:{excluded_messages:number;excluded_deals:number|null;unreviewed_messages:number;unreviewed_deals:number|null};
  observation_cutoff?:string|null;
  window:{from:string;to:string;timezone:'America/Chicago';provisional:boolean};
  freshness:{last_complete_at:string|null;last_observed_at?:string|null;state:'fresh'|'stale'|'unknown'};
  coverage:{provider_messages:Metric;project_links:Metric;deal_links:Metric;reply_links?:Metric};
  metrics:Record<MetricKey,Metric>;
  senders:Array<{mailbox:string;display_name:string;metrics:Partial<Record<MetricKey,Metric>>}>;
  sequences:Array<{id:string;name:string;metrics:Partial<Record<MetricKey,Metric>>}>;
  activity:Array<{date:string;messages_completed:number;first_touches:number;followups_completed:number;human_replies_received:number;company_won_deals:number|null;company_won_booked_value:number|null;company_valued_wins?:number|null}>;
  sources:string[];
  attention:Array<{kind:string;count:number;oldest_at:string|null;target:string}>;
};
export function getMetrics(query:MetricsQuery,signal?:AbortSignal):Promise<MetricsResponse> {
  const params=new URLSearchParams({from:query.from,to:query.to,timezone:query.timezone||'America/Chicago'});
  if(query.mailbox) params.set('mailbox',query.mailbox);
  if(query.source) params.set('source',query.source);
  if(query.sequence) params.set('sequence',query.sequence);
  return sdrReadRequest<MetricsResponse>(`/api/sdr/metrics?${params}`,signal);
}
