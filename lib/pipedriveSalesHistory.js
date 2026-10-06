import {syncDealFacts} from './sdrReportingIngest.js';
// Reads CRM records only; the writer updates the reporting database, never Pipedrive.
export async function fetchSalesHistory({apiToken,fetchImpl=fetch,now=new Date()}) {
 if(!apiToken)throw Error('pipedrive_token_missing');
 const get=async(path,params={})=>{
  const url=new URL(path,'https://api.pipedrive.com');url.search=new URLSearchParams(params);
  const response=await fetchImpl(url,{headers:{'x-api-token':apiToken},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`pipedrive_http_${response.status}`);
  const result=await response.json();if(result.success!==true)throw Error('pipedrive_response_invalid');return result;
 };
 const me=await get('/api/v1/users/me');
 if(!(me.data?.is_admin===1||me.data?.is_admin===true) || (me.data.access && !me.data.access.some(item=>item.app==='sales'&&item.admin)))throw Error('company_visibility_unverified');
 const deals=new Map(),pages={};
 for(const path of ['/api/v2/deals','/api/v2/deals/archived']){
  let cursor=null,n=0;const seen=new Set();
  do{
   const page=await get(path,{limit:'500',sort_by:'id',sort_direction:'asc',...(cursor?{cursor}:{})});
   if(!Array.isArray(page.data)||!Object.hasOwn(page.additional_data||{},'next_cursor'))throw Error('invalid_sales_page');
   for(const deal of page.data){if(!deal.id)throw Error('invalid_deal_id');deals.set(String(deal.id),deal);}
   cursor=page.additional_data.next_cursor;n++;
   if(cursor&&seen.has(cursor))throw Error('repeated_sales_cursor');if(cursor)seen.add(cursor);
   if(n>100)throw Error('sales_pagination_limit');
  }while(cursor);
  pages[path]=n;
 }
 const records=[...deals.values()].filter(deal=>!deal.is_deleted&&deal.status!=='deleted');
 if(records.some(deal=>deal.status==='won'&&(!deal.won_time||!Number.isFinite(Date.parse(deal.won_time)))))throw Error('won_date_missing');
 const date_adjustments=records.filter(deal=>deal.status==='won'&&deal.origin==='Import'&&deal.close_time&&deal.add_time
  && Number.isFinite(Date.parse(deal.close_time))&&Date.parse(deal.close_time)<Date.parse(deal.add_time)
  && deal.won_time.slice(0,10)===deal.add_time.slice(0,10)).map(deal=>({id:String(deal.id),sales_at:deal.close_time,
    provider_won_at:deal.won_time,provider_add_at:deal.add_time,basis:'imported_crm_close_date'}));
 const adjusted=new Set(date_adjustments.map(item=>item.id)),clusters=new Map();
 for(const deal of records.filter(deal=>deal.status==='won'&&!adjusted.has(String(deal.id)))){
  const key=deal.won_time.slice(0,19);const group=clusters.get(key)||[];group.push(deal);clusters.set(key,group);
 }
 const warningIds=new Map();
 for(const group of clusters.values())if(group.length>=10)for(const deal of group)if(deal.add_time&&Date.parse(deal.won_time)-Date.parse(deal.add_time)>30*86400000)warningIds.set(String(deal.id),deal);
 const warningMonths=new Map();
 for(const deal of warningIds.values()){
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).format(new Date(deal.won_time));
  warningMonths.set(month,(warningMonths.get(month)||0)+1);
 }
 const date_warnings=[...warningMonths].map(([month,count])=>({month,count,reason:'bulk_status_change'}));
 const dates=records.flatMap(deal=>[deal.add_time,deal.won_time,deal.lost_time]).concat(date_adjustments.map(item=>item.sales_at)).filter(Boolean).sort();
 if(!dates.length)throw Error('sales_history_empty');
 const localDate=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
 const today=localDate(now);
 return {deals:records,checkedAt:now.toISOString(),counts:{from:localDate(new Date(dates[0])).slice(0,7)+'-01',to:today,deals:records.length,
  pages,date_adjustments,date_warnings,history_complete:true,company_scope_accepted:true,includes_archived:true,record_only:true}};
}
export async function storeSalesHistory(pool,snapshot){
 if(!snapshot.counts?.history_complete||!snapshot.counts?.company_scope_accepted||!snapshot.counts?.includes_archived)throw Error('sales_history_unverified');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('pipedrive_sales_history'))");
  const writes=await syncDealFacts(client,snapshot.deals);
  // Keep vanished IDs for audit, but stop treating them as current wins.
  const missing=await client.query("UPDATE sdr_deal_facts SET status='missing_from_source',observed_at=$2 WHERE NOT (pipedrive_deal_id=ANY($1::text[])) AND status<>'missing_from_source'",[snapshot.deals.map(deal=>String(deal.id)),snapshot.checkedAt]);
  await client.query("INSERT INTO sdr_job_runs(job,scope,status,finished_at,counts) VALUES('pipedrive_deals','company','complete',$1,$2)",[snapshot.checkedAt,{...snapshot.counts,...writes,missing_from_source:missing.rowCount}]);
  await client.query('COMMIT');return {...snapshot.counts,...writes,missing_from_source:missing.rowCount};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
