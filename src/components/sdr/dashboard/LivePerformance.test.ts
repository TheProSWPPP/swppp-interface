import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import LivePerformance from './LivePerformance';
import type { MetricsResponse } from '../../../lib/sdrMetricsApi';
import { unavailable } from './metricDisplay';
import type { SdrLiveOverview } from '../../../lib/sdrLiveOverviewApi';

const base = { data: null, metrics: null, metricWindow: { from: '2026-09-03', to: '2026-10-03' }, metricsStale: false, metricsError: null, onViewPerformance: () => {}, onRefresh: () => {} };
const metrics: MetricsResponse = {
  window: { from: '2026-09-03', to: '2026-10-03', timezone: 'America/Chicago', provisional: false },
  freshness: { last_complete_at: null, state: 'unknown' },
  coverage: { provider_messages: unavailable, project_links: unavailable, deal_links: unavailable },
  senders: [], sequences: [], activity: [], sources: [], attention: [],
  metrics: {
    messages_completed: { value: 66, state: 'partial', reason: 'incomplete_coverage' }, contacts_reached: unavailable,
    first_touches: unavailable, followups_completed: unavailable, human_replies_received: unavailable, human_reply_rate: unavailable,
    positive_reply_rate: unavailable, followup_completion_rate: unavailable, duplicate_rate: unavailable, quote_close_rate: unavailable,
    contact_to_win_rate: unavailable, won_booked_value: unavailable, average_won_deal_value: unavailable,
    company_won_booked_value: unavailable, company_average_won_deal_value: { value: 1250, state: 'available', numerator: 2500, denominator: 2 },
    company_won_deals: unavailable, open_rate: unavailable, spam_rate: unavailable, bounce_events: unavailable, spam_blocked_events: unavailable, won_deals: unavailable, collected_value: unavailable, eligible_supply: unavailable, bounce_rate: unavailable, unresolved_quotes: unavailable,
  },
};
it('shows a visible performance failure and retry when reporting fails before its first snapshot', () => {
  const html = renderToStaticMarkup(createElement(LivePerformance, { ...base, metricsError: 'Request failed' }));
  expect(html).toContain('role="alert"');
  expect(html).toContain('Results are unavailable');
  expect(html).toContain('Retry results');
  expect(html).not.toContain('$0');
  expect(html).not.toContain('Loading email and sales');
});
it('retains measured performance independently of the live workload request and identifies a failed refresh', () => {
  const html = renderToStaticMarkup(createElement(LivePerformance, { ...base, metrics, metricsStale: true, metricsError: 'Request failed' }));
  expect(html).toContain('Showing the last loaded results');
  expect(html).toContain('>66<');
  expect(html).toContain('Partial data');
  expect(html).toContain('$1,250.00');
  expect(html).not.toContain('Sequence enrollments');
});
it('separates in-progress reporting from a failed read while keeping unknown rates distinct from zero', () => {
  const html = renderToStaticMarkup(createElement(LivePerformance, { ...base, metricsStale: true }));
  expect(html).toContain('Loading email and sales results');
  expect(html).not.toContain('role="alert"');
  expect(html).toContain('aria-label="Unavailable"');
  expect(html).not.toContain('0.0%');
});
it('labels the enrollment count and chart by their separate actual windows and avoids calling clear rows sendable',()=>{
  const data:SdrLiveOverview={collectedAt:'2026-10-04T12:00:00Z',preview:true,queue:{pending:2,failed:0,ready:1},leads:{total:3000,eligible:2753},senders:{active:2,total:3},recentEnrollments:{count:7,days:7},actions:[],trend:[{date:'2026-09-20',count:2},{date:'2026-10-03',count:4}],note:'Observed enrollments.'};
  const html=renderToStaticMarkup(createElement(LivePerformance,{...base,data,workspaceOnly:true}));
  expect(html).toContain('Count · last 7 days');expect(html).toContain('Sep 20, 2026–Oct 3, 2026');expect(html).toContain('2,753 marked clear; send readiness unverified');expect(html).toContain('Mirrored inventory, active CRM projects, candidate checks and verified ready contacts are separate counts');expect(html).not.toContain('2,753 sendable');
});
