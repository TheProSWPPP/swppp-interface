import type {MetricsResponse} from '../../lib/sdrMetricsApi';
export type SalesSource='orders'|'pipedrive';
export type SalesCard={key:'company_won_deals'|'company_won_booked_value'|'company_average_won_deal_value';label:string;currency:boolean;detail:string};

export const ORDERS_DEFINITION='Orders = jobs ordered through the website intake that exist as a Trello card. Test, archived and deleted records excluded. Revenue = Pipedrive deal value when matched, otherwise the invoice total entered on the project. Payment shown separately.';

export function salesSourceOf(data:MetricsResponse|null|undefined):SalesSource{
 return data?.company_sales?.source==='orders'?'orders':'pipedrive';
}

export function salesCards(source:SalesSource):SalesCard[]{
 if(source==='orders')return [
  {key:'company_won_deals',label:'Orders',currency:false,detail:'Each website order with a Trello card, counted once, by the date it was received.'},
  {key:'company_won_booked_value',label:'Order revenue',currency:true,detail:'Pipedrive deal value when matched, otherwise the invoice total on the project. Orders without either are counted but not valued.'},
  {key:'company_average_won_deal_value',label:'Average order',currency:true,detail:'Order revenue divided by orders that have a value.'},
 ];
 return [
  {key:'company_won_deals',label:'Sales won',currency:false,detail:'Each won Pipedrive deal counted once.'},
  {key:'company_won_booked_value',label:'Booked revenue',currency:true,detail:'Known USD value of won deals, before payment collection.'},
  {key:'company_average_won_deal_value',label:'Average sale',currency:true,detail:'Known USD revenue divided by sales with a known USD value.'},
 ];
}

// Extra lines under the totals for the orders source: matching, valuation and payment.
export function orderSummaryLines(data:MetricsResponse|null|undefined,formatMoney:(value:number)=>string):string[]{
 const sales=data?.company_sales;
 if(sales?.source!=='orders')return [];
 const lines:string[]=[];
 if(sales.valued&&sales.valued.count<sales.valued.of)lines.push(`${sales.valued.count} of ${sales.valued.of} orders valued.`);
 if(sales.paid)lines.push(`Paid: ${sales.paid.count} orders (${formatMoney(sales.paid.value)}).`);
 if(sales.matched)lines.push(`Matched to Pipedrive: ${sales.matched.count} of ${sales.matched.of}.`);
 return lines;
}
