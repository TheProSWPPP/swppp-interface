import {describe,expect,it} from 'vitest';
import type {MetricsResponse} from '../../../lib/sdrMetricsApi';
import {salesCards,salesSourceOf,orderSummaryLines,ORDERS_DEFINITION} from '../salesLabels';

const money=(value:number)=>`$${value.toLocaleString('en-US')}`;
describe('sales labels follow the sales source',()=>{
 it('names CRM deals when the source is Pipedrive or unknown',()=>{
  expect(salesSourceOf(null)).toBe('pipedrive');
  expect(salesSourceOf({company_sales:{history_from:null,history_to:null,freshness:{last_complete_at:null,state:'unknown'}}} as unknown as MetricsResponse)).toBe('pipedrive');
  expect(salesCards('pipedrive').map(card=>card.label)).toEqual(['Sales won','Booked revenue','Average sale']);
 });
 it('names orders, keeps the metric keys, and states what counts',()=>{
  const data={company_sales:{source:'orders',valued:{count:8,of:10},paid:{count:6,value:12500},matched:{count:7,of:10},history_from:'2025-01-01',history_to:null,freshness:{last_complete_at:null,state:'fresh'}}} as unknown as MetricsResponse;
  expect(salesSourceOf(data)).toBe('orders');
  expect(salesCards('orders').map(card=>[card.key,card.label])).toEqual([['company_won_deals','Orders'],['company_won_booked_value','Order revenue'],['company_average_won_deal_value','Average order']]);
  expect(orderSummaryLines(data,money)).toEqual(['8 of 10 orders valued.','Paid: 6 orders ($12,500).','Matched to Pipedrive: 7 of 10.']);
  expect(orderSummaryLines({company_sales:{source:'pipedrive'}} as unknown as MetricsResponse,money)).toEqual([]);
  expect(ORDERS_DEFINITION).toContain('Trello card');
  for(const text of [ORDERS_DEFINITION,...salesCards('orders').map(card=>card.detail)])expect(text).not.toMatch(/[\u2013\u2014]/);
 });
});
