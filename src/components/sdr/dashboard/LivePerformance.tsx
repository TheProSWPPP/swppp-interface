import { motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, ChevronDown } from 'lucide-react';
import type { SdrLiveOverview } from '../../../lib/sdrLiveOverviewApi';
import type { MetricsQuery, MetricsResponse } from '../../../lib/sdrMetricsApi';
import MetricCard from './MetricCard';
import { shiftDate, unavailable } from './metricDisplay';

const number = (value: number) => value.toLocaleString('en-US');
const date = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
const fullDate = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });

function EnrollmentTrend({ data }: { data: SdrLiveOverview }) {
  const reduced = useReducedMotion();
  const maximum = Math.max(1, ...data.trend.map(point => point.count));
  return <div className="sdr-enrollment-chart">
    <p className="sdr-enrollment-range">{data.trend.length?`Daily chart · ${fullDate(data.trend[0].date)}–${fullDate(data.trend[data.trend.length-1].date)}`:'Daily chart dates unavailable'}</p>
    <div className="sdr-enrollment-bars" role="group" aria-label={`Daily sequence enrollments across ${data.trend.length} recorded dates. ${number(data.trend.reduce((sum, point) => sum + point.count, 0))} enrollments shown.`}>
      {data.trend.map(point => <div key={point.date} className="sdr-enrollment-day" tabIndex={0} role="img" aria-label={`${date(point.date)}: ${number(point.count)} enrollments`}>
        <motion.span initial={false} style={{ height: `${point.count / maximum * 100}%`, transformOrigin: 'bottom' }} whileHover={reduced ? undefined : { scaleY: 1.06 }} transition={{ duration: reduced ? 0 : .15 }} className={`sdr-enrollment-bar ${point.count > 0 ? 'has-enrollments' : 'no-enrollments'}`} />
        <span className="sdr-enrollment-tooltip" aria-hidden="true">{date(point.date)}: {number(point.count)}</span>
      </div>)}
    </div>
    {data.trend.length > 0 && <div className="sdr-enrollment-axis"><span>{date(data.trend[0].date)}</span><span>{date(data.trend[data.trend.length - 1].date)}</span></div>}
  </div>;
}

export type LivePerformanceProps = {
  data: SdrLiveOverview | null;
  metrics: MetricsResponse | null;
  metricWindow: MetricsQuery;
  metricsStale: boolean;
  metricsError: string | null;
  onViewPerformance: () => void;
  onRefresh: () => void;
  workspaceOnly?: boolean;
};

export default function LivePerformance({ data, metrics, metricWindow, metricsStale, metricsError, onViewPerformance, onRefresh, workspaceOnly = false }: LivePerformanceProps) {
  return <section className="sdr-live-performance" aria-labelledby={workspaceOnly?undefined:'live-performance-title'} aria-label={workspaceOnly?'Current workspace':undefined}>
        {!workspaceOnly && <><div className="sdr-performance-heading"><h2 id="live-performance-title">Performance</h2><button type="button" className="sdr-performance-window" onClick={onViewPerformance}>{date(metricWindow.from)} – {date(shiftDate(metricWindow.to, -1))}<ChevronDown size={14} aria-hidden="true" /></button></div>
        {metricsError && <div role="alert" className="sdr-performance-error"><AlertCircle size={16} aria-hidden="true"/><span>Email and sales results could not refresh. {metrics ? 'Showing the last loaded results.' : 'Results are unavailable.'}</span><button type="button" onClick={onRefresh}>Retry results</button></div>}
        {!metricsError && metricsStale && <p className="sdr-performance-status" role="status">{metrics ? 'Showing the last loaded performance snapshot.' : 'Loading email and sales results…'}</p>}
        {metrics?.freshness.last_observed_at && <p className="sdr-email-collection">Email history collected {new Date(metrics.freshness.last_observed_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} CT{metrics.metrics.messages_completed.state === 'partial' ? ' · Partial history' : ''}</p>}
        {(metricWindow.mailbox || metricWindow.source) && <p className="sdr-performance-status">{metricWindow.mailbox || 'All senders'}{metricWindow.source ? ` · ${metricWindow.source}` : ''}</p>}
        <div className="sdr-live-result-metrics">
          <MetricCard compact label="Emails sent" metric={metrics?.metrics.messages_completed || unavailable} detail="Recorded sends, including follow-ups. Delivery is not confirmed." />
          <MetricCard compact label="Human reply events" metric={metrics?.metrics.human_replies_received || unavailable} detail="Recorded human replies received during the selected period. These may relate to earlier first touches." />
          <MetricCard compact label="First-touch reply rate" format="rate" metric={metrics?.metrics.human_reply_rate || unavailable} detail="Human replies within 30 days of a first touch, divided by the people in that cohort. Verified reply links are required." />
          <MetricCard compact label="Average company sale" format="currency" metric={metrics?.metrics.company_average_won_deal_value || unavailable} detail="All channels, in USD. Unique known won value divided by unique valued wins in this period. Monthly averages are never averaged." />
        </div>
        </>}
        {data && <><div className="sdr-current-performance-heading"><span>Current workspace</span><span>Sequence activity and setup</span></div>
        <div className="sdr-performance-layout">
          <div className="sdr-enrollment-performance"><div className="sdr-enrollment-value"><span>Sequence enrollments</span><strong>{number(data.recentEnrollments.count)}</strong><small>Count · last {data.recentEnrollments.days} days</small></div><EnrollmentTrend data={data} /></div>
          <dl className="sdr-live-counts">
            <div><dt>Outreach lead rows</dt><dd>{number(data.leads.total)}</dd><span>{data.leads.eligible !== undefined ? `${number(data.leads.eligible)} marked clear; send readiness unverified` : 'CRM status unavailable'}</span></div>
            <div><dt>Active senders</dt><dd>{number(data.senders.active)}<small> / {number(data.senders.total)}</small></dd><span>Mailbox setup</span></div>
            <div><dt>Approved drafts</dt><dd>{number(data.queue.ready)}</dd><span>{number(data.queue.pending)} pending review</span></div>
          </dl>
        </div>
        <p className="sdr-supply-note">Mirrored inventory, active CRM projects, candidate checks and verified ready contacts are separate counts. Reconciliation is unavailable here; “marked clear” does not confirm a sendable buyer.</p>
        <details className="sdr-live-data-note"><summary><span>Enrollments count entries into an outreach sequence.</span><ChevronDown size={15} aria-hidden="true" /></summary><p>{data.note || 'Enrollments do not confirm an email was sent or delivered.'}{data.preview ? ' This workspace is a read-only preview of live data.' : ''}</p></details></>}
      </section>;
}
