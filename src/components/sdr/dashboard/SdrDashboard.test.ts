import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect,it } from 'vitest';
import SdrDashboard from './SdrDashboard';
import MetricCard from './MetricCard';
it('offers accessible date/sender/source filters and a loading state before data arrives',()=>{
  const html=renderToStaticMarkup(createElement(SdrDashboard,{user:{id:'u',username:'admin',display_name:'Admin User',email:'rep-a@example.test',role:'admin'},onNavigate:()=>{}}));
  expect(html).toContain('Sales and email performance'); expect(html).toContain('Sender'); expect(html).toContain('Lead source'); expect(html).toContain('Loading your outreach numbers');
  expect(html.indexOf('Recent buyer work')).toBeLessThan(html.indexOf('Sales and email performance'));
});
it('keeps unknown currency metrics distinct from zero and exposes denominator evidence',()=>{
  const unknown=renderToStaticMarkup(createElement(MetricCard,{label:'Linked won value',metric:{value:null,state:'unavailable',reason:'deal_links_missing'},detail:'Verified project links',format:'currency'}));
  expect(unknown).toContain('Unavailable'); expect(unknown).not.toContain('$0');
  const known=renderToStaticMarkup(createElement(MetricCard,{label:'Reply rate',metric:{value:.05,state:'partial',numerator:5,denominator:100,reason:'cohort_maturing_30_days'},detail:'30-day cohort',format:'rate'}));
  expect(known).toContain('5.0%'); expect(known).toContain('5 / 100'); expect(known).toContain('Partial data');
});
it('keeps filters, sales and linked results outside closed disclosures',()=>{
  const html=renderToStaticMarkup(createElement(SdrDashboard,{user:{id:'u',username:'admin',display_name:'Admin User',email:'rep-a@example.test',role:'admin'},onNavigate:()=>{}}));
  expect(html).not.toContain('Detailed performance');
  expect(html).toContain('Last month');
  expect(html).toContain('Sequence<select');
  expect(html).toContain('Compare previous period');
  for(const label of ['Company sales','Company orders won','Average company sale','Sales from outreach','Quote close rate','Outreach orders won','First-touch reply rate','Human reply events','Follow-ups sent','Duplicate email rate']) expect(html).toContain(`aria-label="${label}"`);
  expect(html.slice(0,html.indexOf('id="sdr-email-title"'))).not.toContain('<details');
  expect(html).toContain('Delivery and opens');
  expect(html).toContain('Sender and sequence breakdown');
  expect(html).toContain('Planned · Not connected');
  expect(html).not.toContain('0.0%');
});
it('leaves connection next steps visible on compact unavailable cards',()=>{
  const html=renderToStaticMarkup(createElement(MetricCard,{label:'Open rate',compact:true,metric:{value:null,state:'unavailable',reason:'open_tracking_unverified'},detail:'Tracked opens',format:'rate'}));
  expect(html).toContain('Unavailable');
  expect(html).toContain('Connect and verify email-open tracking');
  expect(html).not.toContain('0.0%');
});

it('uses one explanation on compact unknown rates without duplicate status lines',()=>{
  const html=renderToStaticMarkup(createElement(MetricCard,{label:'Reply rate',compact:true,metric:{value:null,state:'unavailable',reason:'incomplete_coverage'},detail:'30-day reply window',format:'rate',maturity:'Reply history unavailable'}));
  expect(html).toContain('Complete history is needed to calculate this rate.');
  expect(html).not.toContain('Not available yet');
  expect(html).not.toContain('Reply history unavailable');
});
