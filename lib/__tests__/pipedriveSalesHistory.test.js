import {expect,it,vi} from 'vitest';
import {fetchSalesHistory} from '../pipedriveSalesHistory.js';
const response=data=>({ok:true,json:async()=>({success:true,...data})});
it('exhausts current and archived pages and deduplicates IDs',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce(response({data:{is_admin:1,access:[{app:'sales',admin:true}]}}))
 .mockResolvedValueOnce(response({data:[{id:1,status:'won',won_time:'2023-07-19T00:00:00Z'}],additional_data:{next_cursor:'next'}}))
 .mockResolvedValueOnce(response({data:[{id:2,status:'open'}],additional_data:{next_cursor:null}}))
 .mockResolvedValueOnce(response({data:[{id:1,status:'won',won_time:'2023-07-19T00:00:00Z'}],additional_data:{next_cursor:null}}));
 const result=await fetchSalesHistory({apiToken:'secret',fetchImpl,now:new Date('2026-10-05T15:00:00Z')});
 expect(result.deals).toHaveLength(2);expect(result.counts).toMatchObject({history_complete:true,company_scope_accepted:true,from:'2023-07-01',to:'2026-10-05'});
 expect(fetchImpl.mock.calls[2][0].searchParams.get('cursor')).toBe('next');
 expect(fetchImpl.mock.calls.every(([url])=>!url.searchParams.has('api_token'))).toBe(true);
});
it('refuses a company-complete receipt for restricted visibility or missing won dates',async()=>{
 await expect(fetchSalesHistory({apiToken:'secret',fetchImpl:async()=>response({data:{is_admin:0,access:[]}})})).rejects.toThrow('company_visibility_unverified');
 const fetchImpl=vi.fn().mockResolvedValueOnce(response({data:{is_admin:1}})).mockResolvedValueOnce(response({data:[{id:1,status:'won'}],additional_data:{next_cursor:null}})).mockResolvedValueOnce(response({data:[],additional_data:{next_cursor:null}}));
 await expect(fetchSalesHistory({apiToken:'secret',fetchImpl})).rejects.toThrow('won_date_missing');
});
it('refuses malformed pagination rather than claiming history complete',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce(response({data:{is_admin:1}})).mockResolvedValueOnce(response({data:[]}));
 await expect(fetchSalesHistory({apiToken:'secret',fetchImpl})).rejects.toThrow('invalid_sales_page');
});

it('preserves provider won dates and records conservative import-date corrections separately',async()=>{
 const deal={id:1,status:'won',origin:'Import',add_time:'2023-07-19T11:39:31Z',won_time:'2023-07-19T11:39:32Z',close_time:'2019-08-30T05:00:00Z'};
 const fetchImpl=vi.fn().mockResolvedValueOnce(response({data:{is_admin:1}})).mockResolvedValueOnce(response({data:[deal],additional_data:{next_cursor:null}})).mockResolvedValueOnce(response({data:[],additional_data:{next_cursor:null}}));
 const result=await fetchSalesHistory({apiToken:'secret',fetchImpl});
 expect(result.deals[0].won_time).toBe(deal.won_time);
 expect(result.counts.from).toBe('2019-08-01');expect(result.counts.date_adjustments).toEqual([{id:'1',sales_at:deal.close_time,provider_won_at:deal.won_time,provider_add_at:deal.add_time,basis:'imported_crm_close_date'}]);
});

it('starts history in the Chicago month of the earliest timestamp',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce(response({data:{is_admin:1}})).mockResolvedValueOnce(response({data:[{id:1,status:'won',won_time:'2023-07-01T00:00:00Z'}],additional_data:{next_cursor:null}})).mockResolvedValueOnce(response({data:[],additional_data:{next_cursor:null}}));
 expect((await fetchSalesHistory({apiToken:'secret',fetchImpl})).counts.from).toBe('2023-06-01');
});

it('holds bulk-updated old deals separately while preserving their original CRM records',async()=>{
 const deals=Array.from({length:10},(_,i)=>({id:i+1,status:'won',value:1000,currency:'USD',add_time:'2023-08-01T10:00:00Z',won_time:'2026-04-14T13:10:30Z'}));
 deals.push({id:11,status:'won',won_time:'2026-04-20T13:10:30Z',add_time:'2026-04-01T10:00:00Z'});
 const fetchImpl=vi.fn().mockResolvedValueOnce(response({data:{is_admin:1}})).mockResolvedValueOnce(response({data:deals,additional_data:{next_cursor:null}})).mockResolvedValueOnce(response({data:[],additional_data:{next_cursor:null}}));
 const result=await fetchSalesHistory({apiToken:'secret',fetchImpl});
 expect(result.counts.date_reviews).toHaveLength(10);
 expect(result.counts.date_reviews[0]).toEqual({id:'1',provider_won_at:'2026-04-14T13:10:30Z',reason:'bulk_status_change'});
 expect(result.deals).toEqual(deals);expect(result.counts.date_warnings).toEqual([{month:'2026-04',count:10,reason:'bulk_status_change'}]);
});
