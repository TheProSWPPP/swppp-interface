import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect,it } from 'vitest';
import ActivityTimeline from './ActivityTimeline';
import type { MetricsResponse } from '../../../lib/sdrMetricsApi';
const data:MetricsResponse={window:{from:'2026-09-03',to:'2026-10-03',timezone:'America/Chicago',provisional:false},freshness:{last_complete_at:null,state:'unknown'},coverage:{provider_messages:{value:null,state:'unavailable'},project_links:{value:null,state:'unavailable'},deal_links:{value:null,state:'unavailable'}},metrics:{human_replies_received:{value:2,state:'available'}} as MetricsResponse['metrics'],senders:[],sequences:[],sources:[],attention:[],activity:[{date:'2026-09-03',messages_completed:27,first_touches:20,followups_completed:7,human_replies_received:2,company_won_deals:null,company_won_booked_value:null}]};
it('shows observed selected-window history with inclusive dates and partial coverage',()=>{
  const html=renderToStaticMarkup(createElement(ActivityTimeline,{data}));
  expect(html).toContain('Sep 3 through Oct 2');
  expect(html).toContain('27 emails sent, 2 human reply events');
  expect(html).toContain('selected outreach filters');
  expect(html).not.toContain('Partial history can undercount');
  expect(html).not.toContain('Company sales');
  expect(html).toContain('Daily records');
  expect(html).toContain('<th scope="row"');
  expect(html).not.toContain('Unavailable');
});
it('does not invent chart activity while reporting history is absent',()=>{
  const html=renderToStaticMarkup(createElement(ActivityTimeline,{data:{...data,activity:[]}}));
  expect(html).toContain('Daily reporting history is not available');
  expect(html).not.toContain('sdr-timeline-bar');
});
it('groups long periods into observed weekly counts',()=>{
  const activity=Array.from({length:49},(_,index)=>({...data.activity[0],date:new Date(Date.UTC(2026,7,1+index)).toISOString().slice(0,10),messages_completed:2,human_replies_received:1}));
  const html=renderToStaticMarkup(createElement(ActivityTimeline,{data:{...data,window:{...data.window,from:'2026-08-01',to:'2026-09-19'},activity}}));
  expect(html).toContain('Weekly totals');
  expect(html).toContain('14 emails sent, 7 human reply events');
  expect(html.match(/class="sdr-timeline-day"/g)).toHaveLength(7);
});

it('hides reply marks when reply history cannot support a total',()=>{
 const html=renderToStaticMarkup(createElement(ActivityTimeline,{data:{...data,metrics:{...data.metrics,human_replies_received:{value:null,state:'unavailable'}}}}));
 expect(html).not.toContain('human reply events');expect(html).not.toContain('sdr-timeline-replies');expect(html).toContain('27 emails sent');
});
