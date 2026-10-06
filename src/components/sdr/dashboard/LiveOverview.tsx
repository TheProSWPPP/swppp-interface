import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Inbox, ListChecks, RefreshCw, Target, Users } from 'lucide-react';
import { getLiveOverview, type LiveOverviewAction, type SdrLiveOverview } from '../../../lib/sdrLiveOverviewApi';
import { runLatestRead } from '../../../lib/sdrReadRequest';
import type { MetricsQuery, MetricsResponse } from '../../../lib/sdrMetricsApi';
import LivePerformance from './LivePerformance';
import ActivityFeed from './ActivityFeed';

const number = (value: number) => value.toLocaleString('en-US');
const needsAttention = (action: LiveOverviewAction) => ['warning', 'urgent', 'error', 'critical'].includes(action.severity);
const time = (value: string) => new Date(value).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' CT';

function ActionRow({ action, onNavigate }: { action: LiveOverviewAction; onNavigate: (target: string) => void }) {
  const Icon = action.target === 'leads' ? Target : action.target === 'mailboxes' ? Users : ListChecks;
  const clearRows = action.id === 'fresh-leads';
  return <button type="button" className="sdr-live-action" onClick={() => onNavigate(action.target)}>
    <span className="sdr-live-action-icon"><Icon size={19} aria-hidden="true" /></span>
    <span className="sdr-live-action-copy"><strong>{clearRows?'Review clear lead rows':action.title}</strong><span>{clearRows?'CRM status only. Verify each project and contact before outreach.':action.description}</span></span>
    {action.count !== null && <span className="sdr-live-action-count">{number(action.count)}</span>}
    <ArrowRight size={18} className="sdr-live-action-arrow" aria-hidden="true" />
  </button>;
}

export default function LiveOverview({ refreshKey, onRefresh, onNavigate, metrics, metricWindow, metricsStale, metricsError, onViewPerformance, showPerformance = true, onWorkspaceLoaded }: { refreshKey: number; onRefresh: () => void; onNavigate: (target: string) => void; metrics: MetricsResponse | null; metricWindow: MetricsQuery; metricsStale: boolean; metricsError: string | null; onViewPerformance: () => void; showPerformance?: boolean; onWorkspaceLoaded?: (data:SdrLiveOverview)=>void }) {
  const [data, setData] = useState<SdrLiveOverview | null>(null);
  const [error, setError] = useState(false);
  const [settledKey, setSettledKey] = useState<number | null>(null);
  const loading = settledKey !== refreshKey;
  const attention = data?.actions.filter(needsAttention) || [];
  const actions = data?.actions.filter(action => !needsAttention(action)) || [];
  useEffect(() => runLatestRead(signal => getLiveOverview(signal), {
    success: value => { setData(value); onWorkspaceLoaded?.(value); setError(false); },
    error: () => setError(true),
    settled: () => setSettledKey(refreshKey),
  }), [refreshKey,onWorkspaceLoaded]);

  return <div className="sdr-live-overview">
    <header className="sdr-live-heading">
      <div><h1>Outreach</h1></div>
      <div className="sdr-live-tools">
        <span className={`sdr-live-freshness ${error ? 'is-stale' : ''}`}><span aria-hidden="true" />{loading ? data ? `Updating · prior check ${time(data.collectedAt)}` : 'Updating…' : error ? `Refresh needed · prior check ${data ? time(data.collectedAt) : 'unknown'}` : data ? `Checked ${time(data.collectedAt)}` : 'Not checked'}</span>
        <button type="button" className="sdr-live-refresh" onClick={onRefresh} disabled={loading} aria-label="Refresh workspace"><RefreshCw size={18} aria-hidden="true" className={loading ? 'sdr-refreshing' : undefined} /><span>Refresh</span></button>
      </div>
    </header>
    <ActivityFeed refreshKey={refreshKey}/>
    {error && <div role="alert" className="sdr-live-error"><AlertCircle size={18} aria-hidden="true" /><span>{data ? 'The workspace could not refresh. These counts are from the last check.' : 'Current workload could not be loaded.'}</span><button onClick={onRefresh} type="button">Try again</button></div>}
    {!data ? <>
      <div className="sdr-live-work sdr-live-pending" aria-busy={loading}>
        <section className="sdr-work-attention"><h2>Needs attention</h2><p role="status">{loading ? 'Checking recent failures and sender setup…' : 'Refresh to check your current workload.'}</p><div className="sdr-work-placeholder" aria-hidden="true" /></section>
        <section className="sdr-work-actions"><h2>Next actions</h2><p>{loading ? 'Loading your queue and leads…' : 'Current actions are unavailable.'}</p><div className="sdr-work-placeholder" aria-hidden="true" /></section>
      </div>
    </> : <>
      <div className="sdr-live-work">
        <section className={`sdr-work-attention ${attention.length || data.queue.failed > 0 ? 'has-attention' : ''}`} aria-labelledby="live-attention-title">
          <div className="sdr-work-section-heading"><h2 id="live-attention-title">Needs attention</h2>{attention.length > 0 && <span className="sdr-work-count">{attention.length} {attention.length === 1 ? 'check' : 'checks'}</span>}</div>
          {attention.length > 0 ? <div className="sdr-live-attention-list">{attention.map(action => <ActionRow key={action.id} action={action} onNavigate={onNavigate} />)}</div> : data.queue.failed > 0 ? <>
            <AlertCircle size={28} className="sdr-attention-symbol" aria-hidden="true" /><strong className="sdr-failed-count">{number(data.queue.failed)}</strong><p>Currently failed drafts updated in the last {data.queue.failedDays || 7} days</p><button type="button" className="sdr-live-cta" onClick={() => onNavigate('queue')}>Review recent failures <ArrowRight size={17} aria-hidden="true" /></button>
          </> : <div className="sdr-no-attention"><CheckCircle2 size={29} aria-hidden="true" /><strong>No recently updated failed drafts</strong><p>No failed drafts updated in the last {data.queue.failedDays || 7} days.</p><button type="button" className="sdr-quiet-link" onClick={() => onNavigate('queue')}>View queue <ArrowRight size={16} aria-hidden="true" /></button></div>}
        </section>
        <section className="sdr-work-actions" aria-labelledby="live-actions-title">
          <div className="sdr-work-section-heading"><h2 id="live-actions-title">Next actions</h2><span className="sdr-current-label">Current workload</span></div>
          {actions.length > 0 ? <div className="sdr-live-action-list">{actions.map(action => <ActionRow key={action.id} action={action} onNavigate={onNavigate} />)}</div> : <div className="sdr-no-actions"><Inbox size={25} aria-hidden="true" /><p>No further queue actions are listed.</p><button type="button" className="sdr-quiet-link" onClick={() => onNavigate('leads')}>Browse leads <ArrowRight size={16} aria-hidden="true" /></button></div>}
        </section>
      </div>

    </>}
    {showPerformance && <LivePerformance data={data} metrics={metrics} metricWindow={metricWindow} metricsStale={metricsStale} metricsError={metricsError} onViewPerformance={onViewPerformance} onRefresh={onRefresh}/>}
  </div>;
}
