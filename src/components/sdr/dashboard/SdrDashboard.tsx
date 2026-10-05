import { useEffect,useId,useRef,useState,type ReactNode } from 'react';
import { LayoutGroup,motion,useReducedMotion } from 'framer-motion';
import { RefreshCw,ChevronDown,Mail,Users,MessageCircle,ThumbsUp,Target,Trophy,Wallet,Send,Repeat,Clock,ShieldAlert,type LucideIcon } from 'lucide-react';
import './dashboard.css';
import type { SdrUser } from '../../../lib/sdrApi';
import { getMetrics,type MetricsQuery,type MetricsResponse,type MetricKey } from '../../../lib/sdrMetricsApi';
import MetricCard from './MetricCard';
import SenderTable from './SenderTable';
import SequenceTable from './SequenceTable';
import ActivityTimeline from './ActivityTimeline';
import MonthlySales from './MonthlySales';
import {monthWindow} from './salesMonths';
import AttentionList from './AttentionList';
import OutreachActivity from './OutreachActivity';
import OutreachHealth from './OutreachHealth';
import SequenceChecks from './SequenceChecks';
import OutreachToday from './OutreachToday';
import LiveOverview from './LiveOverview';
import LivePerformance from './LivePerformance';
import type { SdrLiveOverview } from '../../../lib/sdrLiveOverviewApi';
import type {ReplyContext} from '../../../lib/sdrOperationsApi';
import {runLatestRead} from '../../../lib/sdrReadRequest';
import { defaultWindow,comparisonWindow,snapshotLabel,cohortMaturity,shiftDate,metricText,metricExplanation,unavailable,type MetricFormat } from './metricDisplay';

type Tile={key:MetricKey;label:string;format?:MetricFormat;detail:string;icon?:LucideIcon};
const primary:Tile[]=[
  {key:'messages_completed',label:'Emails sent',icon:Mail,detail:'Recorded sends, including follow-ups. Delivery unconfirmed.'},
  {key:'human_reply_rate',label:'First-touch reply rate',icon:MessageCircle,format:'rate',detail:'Replies within 30 days of first touch, divided by that cohort’s people.'},
  {key:'human_replies_received',label:'Human reply events',icon:MessageCircle,detail:'Human replies received in this period, including earlier first-touch cohorts.'},
  {key:'positive_reply_rate',label:'Interested reply rate',icon:ThumbsUp,format:'rate',detail:'People who showed interest, asked a question or made a qualified referral.'},
];
const company:Tile[]=[
  {key:'company_won_booked_value',label:'Company sales',format:'currency',detail:'All channels. Each won USD deal counted once.'},
  {key:'company_won_deals',label:'Company orders won',detail:'Unique company won deals in the selected period, across all channels.'},
  {key:'company_average_won_deal_value',label:'Average company sale',format:'currency',detail:'Total known USD won value / unique valued wins. Monthly averages are never averaged.'},
];
const pipeline:Tile[]=[
  {key:'won_booked_value',label:'Sales from outreach',format:'currency',detail:'Won USD value with verified links to outreach.'},
  {key:'quote_close_rate',label:'Quote close rate',icon:Target,format:'rate',detail:'Won quotes divided by won + lost quotes. Open quotes are excluded.'},
  {key:'won_deals',label:'Outreach orders won',icon:Trophy,detail:'Each won sale counted once, with a verified link to outreach.'},
  {key:'average_won_deal_value',label:'Average outreach sale',icon:Wallet,format:'currency',detail:'Total linked USD sales ÷ unique wins with a known value.'},
];
const operations:Tile[]=[
  {key:'contacts_reached',label:'People emailed',icon:Users,detail:'Unique email addresses, counted once.'},
  {key:'first_touches',label:'First emails',icon:Send,detail:'Recorded first-step sends. A repeated enrollment can add another first email.'},
  {key:'followups_completed',label:'Follow-ups sent',icon:Repeat,detail:'Recorded sends at step two or later in an email sequence.'},
  {key:'followup_completion_rate',label:'Follow-ups completed',icon:Clock,format:'rate',detail:'Follow-ups sent ÷ eligible follow-ups due. Requires verified scheduling data.'},
  {key:'duplicate_rate',label:'Duplicate email rate',format:'rate',detail:'Confirmed repeated sends after recipient, project, step and timing review.'},
  {key:'bounce_events',label:'Bounce records',detail:'Observed provider bounce records. Partial history may omit events.'},
];
const delivery:Tile[]=[
  {key:'bounce_rate',label:'Bounce rate',icon:ShieldAlert,format:'rate',detail:'Recorded bounce flags as a share of outbound email records.'},
  {key:'spam_blocked_events',label:'Spam-blocked records',detail:'Observed provider blocks flagged as spam. This does not measure inbox placement.'},
  {key:'open_rate',label:'Open rate',format:'rate',detail:'Requires verified email-open tracking.'},
  {key:'spam_rate',label:'Spam placement rate',format:'rate',detail:'Requires verified inbox and spam-folder placement.'},
];
const field='sdr-field mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-2 focus:outline-brand-500';
const button='sdr-button min-h-11 disabled:cursor-not-allowed disabled:opacity-50 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-500';
function Section({title,children,detailRef}:{title:string;children:ReactNode;detailRef?:React.RefObject<HTMLDetailsElement|null>}) {
  const [open,setOpen]=useState(false);
  const reduced=useReducedMotion();
  return <details ref={detailRef} className="sdr-section" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary className="sdr-section-heading"><span>{title}</span><ChevronDown aria-hidden="true" className="sdr-chevron h-4 w-4"/></summary>
    <motion.div className="sdr-section-content" initial={false} animate={{opacity:open?1:0,y:open?0:-4}} transition={{duration:reduced?0:.18}}>{children}</motion.div>
  </details>;
}
export default function SdrDashboard({user,onNavigate,onOpenReplies,mailboxes=[]}:{user:SdrUser;onNavigate:(target:string)=>void;onOpenReplies?:(context:ReplyContext)=>void;mailboxes?:Array<{email:string;display_name:string|null}>}) {
  const reduced=useReducedMotion();
  const tabsId=useId();
  const [query,setQuery]=useState<MetricsQuery>(()=>monthWindow(defaultWindow().to,3));
  const [period,setPeriod]=useState('3months');
  const [custom,setCustom]=useState(()=>({from:query.from,through:shiftDate(query.to,-1)}));
  const [compare,setCompare]=useState(false);
  const monthUnavailable=defaultWindow().to.endsWith('-01');
  const [mode,setMode]=useState<'sending'|'delivery'>('sending');
  const [breakdown,setBreakdown]=useState<'senders'|'sequences'>('senders');
  const [data,setData]=useState<MetricsResponse|null>(null);
  const [sequenceOptions,setSequenceOptions]=useState<MetricsResponse['sequences']>([]);
  const [workspace,setWorkspace]=useState<SdrLiveOverview|null>(null);
  const [previous,setPrevious]=useState<MetricsResponse|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [comparisonError,setComparisonError]=useState(false);
  const [loading,setLoading]=useState(true);
  const [reload,setReload]=useState(0);
  const [snapshot,setSnapshot]=useState<{query:MetricsQuery;loadedAt:string}|null>(null);
  const [comparisonPending,setComparisonPending]=useState(false);
  const [comparisonKey,setComparisonKey]=useState('');
  const reportingRef=useRef<HTMLDetailsElement>(null);
  const filtersRef=useRef<HTMLDivElement>(null);
  useEffect(()=>runLatestRead(signal=>getMetrics(query,signal),{
    success:value=>{setSequenceOptions(previous=>[...new Map([...previous,...(value.sequences||[])].map(sequence=>[sequence.id,sequence])).values()]);setData(value);setSnapshot({query:{...query},loadedAt:new Date().toISOString()});setError(null);},
    error:()=>setError('Performance data could not be refreshed. Retry to get the latest numbers.'),
    settled:()=>setLoading(false),
  }),[query,reload]);
  const requestedComparison=JSON.stringify([query,reload,period]);
  useEffect(()=>{
    if(!compare) return;
    return runLatestRead(signal=>getMetrics({...query,...comparisonWindow(query,period)},signal),{
      success:value=>{setPrevious(value);setComparisonError(false);},
      error:()=>{setPrevious(null);setComparisonError(true);},
      settled:()=>{setComparisonPending(false);setComparisonKey(requestedComparison);},
    });
  },[query,compare,reload,requestedComparison,period]);
  const update=(next:MetricsQuery)=>{setLoading(true);setQuery(next);};
  const refresh=()=>{setLoading(true);setReload(value=>value+1);};
  const navigate=(target:string)=>{
    if(target==='reporting') {if(reportingRef.current) {reportingRef.current.open=true;reportingRef.current.scrollIntoView({block:'nearest',behavior:'auto'});reportingRef.current.querySelector('summary')?.focus();}}
    else onNavigate(target);
  };
  const names=Object.fromEntries(mailboxes.map(mailbox=>[mailbox.email,mailbox.display_name||mailbox.email]));
  const senderOptions=mailboxes.length?mailboxes.map(mailbox=>mailbox.email):(data?.senders.map(sender=>sender.mailbox)||[]);
  const tiles=(items:Tile[])=>items.map(tile=><MetricCard key={tile.key} label={tile.label} metric={data?.metrics[tile.key]||unavailable} format={tile.format} compact detail={tile.detail} icon={tile.icon} previous={compare&&!loading&&!error&&comparisonKey===requestedComparison&&!comparisonPending&&!data?.window.provisional&&!data?.metrics[tile.key]?.reason?.startsWith('cohort_maturing')&&!previous?.metrics[tile.key]?.reason?.startsWith('cohort_maturing')&&!(tile.key.includes('reply_rate')&&(data?.metrics[tile.key]?.state!=='available'||previous?.metrics[tile.key]?.state!=='available'))?previous?.metrics[tile.key]:undefined} maturity={tile.key.includes('reply_rate')&&data?cohortMaturity(data.metrics[tile.key],data.window.provisional):undefined}/>);
  const hasStaleValues=Boolean(data && (error || loading));
  return <div className="sdr-dashboard">
    <LiveOverview onWorkspaceLoaded={setWorkspace} showPerformance={false} refreshKey={reload} onRefresh={refresh} onNavigate={navigate} metrics={data} metricWindow={snapshot?.query||query} metricsStale={hasStaleValues||(!data&&loading)} metricsError={error} onViewPerformance={()=>filtersRef.current?.scrollIntoView({block:'start',behavior:reduced?'auto':'smooth'})}/>
    <OutreachToday onOpenReplies={onOpenReplies}/>
    <SequenceChecks refreshKey={reload} onReview={()=>navigate('templates')}/>
    <section className="sdr-reporting-workspace" aria-label="Sales and email performance">
    <header className="sdr-overview-header">
      <div><h2>Sales and email performance</h2><p>Choose a period to see the work and results.</p></div>
      <button type="button" className={`${button} flex items-center gap-2`} onClick={refresh} disabled={loading}><RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading?'motion-safe:animate-spin':''}`}/>{loading?'Updating…':'Refresh numbers'}</button>
    </header>
    <div ref={filtersRef} className="sdr-filters">
      <div className="sdr-filter-fields">
        <label className="text-xs font-medium text-slate-600">Period<select aria-label="Period" className={field} value={period} onChange={event=>{
          const value=event.target.value;setPeriod(value);
          if(value==='custom') return;
          const current=defaultWindow();
          if(value.endsWith('months')){update({...query,...monthWindow(current.to,Number(value.replace('months','')))});return;}
          if(value==='lastmonth'){const to=current.to.slice(0,8)+'01';const from=shiftDate(to,-1).slice(0,8)+'01';update({...query,from,to});return;}
          update({...query,from:value==='month'?current.to.slice(0,8)+'01':shiftDate(current.to,-Number(value)),to:current.to});
        }}><option value="30">Last 30 complete days</option><option value="7">Last 7 complete days</option><option value="month" disabled={monthUnavailable}>{monthUnavailable?'This month: no complete days yet':'This month, complete days'}</option><option value="lastmonth">Last month</option><option value="3months">Last 3 complete months</option><option value="6months">Last 6 complete months</option><option value="12months">Last 12 complete months</option><option value="custom">Custom dates</option></select></label>
        <label className="text-xs font-medium text-slate-600">Sender<select className={field} value={query.mailbox||''} onChange={event=>update({...query,mailbox:event.target.value||undefined})}>
          <option value="">{user.role==='admin'?'All senders':'My senders'}</option>{senderOptions.map(mailbox=><option key={mailbox} value={mailbox}>{names[mailbox]||mailbox} ({mailbox})</option>)}
        </select></label>
        <label className="text-xs font-medium text-slate-600">Lead source<select className={field} value={query.source||''} onChange={event=>update({...query,source:event.target.value||undefined})}>
          <option value="">All sources</option>{(data?.sources||[]).map(source=><option key={source} value={source}>{source==='unknown'?'Unknown origin':source}</option>)}
        </select></label>
        <label className="text-xs font-medium text-slate-600">Sequence<select className={field} value={query.sequence||''} onChange={event=>update({...query,sequence:event.target.value||undefined})}>
          <option value="">All sequences</option>{sequenceOptions.map(sequence=><option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}
        </select></label>
        <label className="sdr-compare-control flex min-h-11 items-center gap-2 text-sm text-slate-600"><input type="checkbox" className="h-4 w-4 accent-brand-700" checked={compare} onChange={event=>{setComparisonPending(event.target.checked);setComparisonError(false);setCompare(event.target.checked);}}/>Compare previous period</label>
      </div>
      {period==='custom' && <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={event=>{event.preventDefault();if(custom.from && custom.through && custom.through>=custom.from) update({...query,from:custom.from,to:shiftDate(custom.through,1)});}}>
        <label className="text-xs text-slate-600">From<input required type="date" value={custom.from} className={field} onChange={event=>setCustom({...custom,from:event.target.value})}/></label>
        <label className="text-xs text-slate-600">Through (included)<input required type="date" min={custom.from} max={custom.from?shiftDate(custom.from,365):undefined} value={custom.through} className={field} onChange={event=>setCustom({...custom,through:event.target.value})}/></label>
        <button type="submit" className={button}>Apply dates</button><p className="sdr-custom-help">Both dates are included. Choose up to 366 days.</p>
      </form>}
      {compare && <p className="sdr-performance-status">Previous period: {comparisonWindow(query,period).from} through {shiftDate(comparisonWindow(query,period).to,-1)}</p>}
      {data?.freshness.last_observed_at && <p className="sdr-email-collection">Email history collected {new Date(data.freshness.last_observed_at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT{data.metrics.messages_completed.state==='partial'?' · Partial history':''}</p>}
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
        <span>{snapshot?`Loaded snapshot: ${snapshotLabel(snapshot.query,sequenceOptions.find(sequence=>sequence.id===snapshot.query.sequence)?.name)}`:`Requested: ${snapshotLabel(query,sequenceOptions.find(sequence=>sequence.id===query.sequence)?.name)}`}{data?.window.provisional?' • Current day is provisional':''}</span>
        <span>{snapshot?`Loaded ${new Date(snapshot.loadedAt).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT. `:''}{hasStaleValues?(loading?'Updating requested filters; retained values show the loaded snapshot.':'Refresh failed; retained snapshot is stale.'):data?.freshness.last_complete_at?`Last full collection: ${new Date(data.freshness.last_complete_at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT${data.freshness.state==='stale'?' • Stale':''}`:'Full history not yet confirmed'}</span>
      </div>
    </div>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}{data?' Previous values are stale.':''}</span><button type="button" className={button} onClick={refresh}>Retry</button></div>}
    {compare&&comparisonKey===requestedComparison&&comparisonError && <p role="status" className="text-sm text-amber-800">The previous period could not be loaded. Current-period data is shown.</p>}
    {compare&&(comparisonPending||comparisonKey!==requestedComparison)&&<p role="status">Loading previous period; current reporting loads separately.</p>}
    {!data && loading && <p role="status" className="sdr-loading">Loading your outreach numbers…</p>}
    <section className="sdr-kpi-group" aria-labelledby="sdr-sales-title"><div className="sdr-group-heading"><div><h2 id="sdr-sales-title">Sales</h2><p>Company totals include all channels and stay independent of outreach filters.</p></div><button className={button} onClick={()=>navigate('reporting')}>Review sales links</button></div>
      <div className="sdr-company-metrics">{tiles(company)}</div>
      <div className="sdr-group-subheading"><h3>Linked to outreach</h3><span>Verified email-to-sale links are required.</span></div><div className="sdr-linked-metrics">{tiles(pipeline)}</div>
    </section>
    {user.role==='admin' && data && <MonthlySales data={data} stale={hasStaleValues} onSelectMonth={(from,to)=>{setPeriod('custom');setCustom({from,through:shiftDate(to,-1)});update({...query,from,to});filtersRef.current?.scrollIntoView({block:'start',behavior:'auto'});}}/>}
    {data?.test_data && <p className="sdr-test-data-note">Excluded marked tests: {data.test_data.excluded_messages.toLocaleString('en-US')} email records{data.test_data.excluded_deals===null?'':`, ${data.test_data.excluded_deals.toLocaleString('en-US')} sales`}.{data.test_data.unreviewed_messages+(data.test_data.unreviewed_deals||0)>0?` Test audit incomplete: ${(data.test_data.unreviewed_messages+(data.test_data.unreviewed_deals||0)).toLocaleString('en-US')} records still need source review.`:' Source metadata has been reviewed for this period; unmarked test records may still require a manual correction.'}</p>}
    <section className="sdr-kpi-group" aria-labelledby="sdr-email-title"><div className="sdr-group-heading"><div><h2 id="sdr-email-title">Email performance</h2><p>Recorded sends and human replies across selected Apollo sequences, including construction and permits. Partial history can undercount activity.</p></div></div><div className="sdr-kpi-strip">{tiles(primary)}</div>
      {data?.metrics.messages_completed.state==='available' && data.metrics.messages_completed.value===0 && <p className="sdr-timeline-note">No emails were sent in this period. Email history for this view is complete.</p>}
      <div className="sdr-email-detail-heading"><LayoutGroup id={tabsId}><div className="sdr-mode" role="tablist" aria-label="Email performance details">
        {(['sending','delivery'] as const).map(value=><button key={value} id={`${tabsId}-${value}`} role="tab" aria-selected={mode===value} aria-controls={`${tabsId}-panel`} tabIndex={mode===value?0:-1} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'sending':event.key==='End'?'delivery':mode==='sending'?'delivery':'sending';setMode(next);document.getElementById(`${tabsId}-${next}`)?.focus();}}} type="button" className="sdr-mode-button" onClick={()=>setMode(value)}>{mode===value&&<motion.span className="sdr-tab-highlight" layoutId="metric-tab" transition={{duration:reduced?0:.18}}/>}<span>{value==='sending'?'Sending and follow-ups':'Delivery and opens'}</span></button>)}
      </div></LayoutGroup><span>{mode==='sending'?'Activity behind your email totals':'Sends do not confirm inbox delivery.'}</span></div>
      <motion.div key={mode} id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${mode}`} initial={reduced?false:{opacity:0,y:3}} animate={{opacity:1,y:0}} transition={{duration:reduced?0:.18}} className="sdr-email-detail-metrics">{tiles(mode==='sending'?operations:delivery)}</motion.div>
    </section>
    {data && <ActivityTimeline data={data}/>}
    <section className="sdr-breakdown" aria-labelledby="sdr-breakdown-title"><div className="sdr-results-heading"><div><h2 id="sdr-breakdown-title">Sender and sequence breakdown</h2><p>Compare recorded email activity in the selected period.</p></div><LayoutGroup id={`${tabsId}-breakdown`}><div className="sdr-mode" role="tablist" aria-label="Performance breakdown">{(['senders','sequences'] as const).map(value=><button key={value} id={`${tabsId}-${value}`} aria-controls={`${tabsId}-breakdown-panel`} role="tab" aria-selected={breakdown===value} tabIndex={breakdown===value?0:-1} type="button" className="sdr-mode-button" onClick={()=>setBreakdown(value)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'senders':event.key==='End'?'sequences':breakdown==='senders'?'sequences':'senders';setBreakdown(next);document.getElementById(`${tabsId}-${next}`)?.focus();}}}>{breakdown===value&&<motion.span className="sdr-tab-highlight" layoutId="breakdown-tab" transition={{duration:reduced?0:.18}}/>}<span>{value==='senders'?'Senders':'Sequences'}</span></button>)}</div></LayoutGroup></div>
      <motion.div key={breakdown} id={`${tabsId}-breakdown-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${breakdown}`} initial={reduced?false:{opacity:0,y:3}} animate={{opacity:1,y:0}} transition={{duration:reduced?0:.18}}>{breakdown==='senders'?<SenderTable senders={data?.senders||[]} names={names}/>:<SequenceTable sequences={data?.sequences||[]}/>}</motion.div>
    </section>
    {workspace && <LivePerformance workspaceOnly data={workspace} metrics={data} metricWindow={snapshot?.query||query} metricsStale={hasStaleValues} metricsError={error} onRefresh={refresh} onViewPerformance={()=>filtersRef.current?.scrollIntoView({block:'start',behavior:'auto'})}/>}
    <div className="sdr-linkedin-status"><div><h2>LinkedIn DMs</h2><p>Planned · Not connected</p></div><span>Connect LinkedIn activity to report sends, replies and follow-ups here.</span></div>
    {data && <>
      <Section title="Contacted projects and payments"><div className="grid gap-4 p-4 sm:grid-cols-2">{tiles([{key:'contact_to_win_rate',label:'Contacted projects won',format:'rate',detail:'Verified won projects / contacted projects, with 60 days to mature.'},{key:'collected_value',label:'Collected payments',format:'currency',detail:'Requires verified accounting records.'}])}</div></Section>
      <Section title="Sending and reply details"><OutreachActivity data={data} onNavigate={onNavigate}/></Section>
      <AttentionList items={data.attention} onNavigate={navigate}/>
      <Section title="Data completeness and sales links" detailRef={reportingRef}><div className="space-y-3 p-4 text-sm text-slate-600">
        <dl className="sdr-sales-evidence">{[{key:'won_booked_value',label:'Sales from outreach',format:'currency'},...pipeline.filter(tile=>tile.key!=='won_booked_value'&&data.metrics[tile.key]?.state==='unavailable')].map(tile=><div key={tile.key}><dt>{tile.label}</dt><dd>{metricText(data.metrics[tile.key as MetricKey],(tile.format||'count') as MetricFormat)}. {metricExplanation(data.metrics[tile.key as MetricKey])}</dd></div>)}</dl>
        {Object.entries(data.coverage).map(([key,metric])=><p key={key}><strong className="font-medium text-slate-900">{{provider_messages:'Message history',project_links:'Project links',deal_links:'Linked deal values',reply_links:'Reply links'}[key]}: {metricText(metric,'rate')}</strong><br/>{metricExplanation(metric)}</p>)}
        <p>Unknown source stays unknown. Sales and reply links need message, thread or project evidence. Existing leads and inbox records can be reviewed below; unresolved links are not counted as confirmed sales.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={()=>onNavigate('leads')}>Open leads</button><button type="button" className={button} onClick={()=>onNavigate('inbox')}>Open inbox</button><button type="button" className={button} onClick={()=>onNavigate('queue')}>Open queue</button></div>
      </div></Section>
      <Section title="How these numbers are calculated"><dl className="space-y-4 p-4 text-sm text-slate-600">
        <div><dt className="font-medium text-slate-900">Messages and enrollments</dt><dd className="mt-1">A completed provider message is an observed email, while an enrollment joins a sequence. Draft counts are not message counts. Completion does not establish delivery.</dd></div>
        <div><dt className="font-medium text-slate-900">Reply cohorts</dt><dd className="mt-1">Each verified project enters at its first recorded completed first touch; addresses are deduplicated within the reply cohort. Human replies must link to a contacted message or thread within 30 days. Automatic replies and bounces are excluded. A September reply to an August first touch stays in August’s conversion cohort. Cohort dates: {data.window.from} through {shiftDate(data.window.to,-1)}. Observation cutoff: {data.observation_cutoff||'Unknown; not supplied by reporting'}. Maturing or provisional cohorts are not compared as final conversion.</dd></div>
        <div><dt className="font-medium text-slate-900">Qualified quotes and averages</dt><dd className="mt-1">Quote close rate uses won / (won + lost) qualified quotes from the quote-created period. Unresolved quotes: {metricText(data.metrics.unresolved_quotes,'count')}. Averages divide unique known USD won value by unique valued wins. Other currencies and missing values reduce coverage.</dd></div>
        <div><dt className="font-medium text-slate-900">Partial and unavailable</dt><dd className="mt-1">Partial values describe observed evidence or a cohort still maturing. Unavailable means a required connection or verified link is missing. Neither should be treated as a final zero.</dd></div>
      </dl></Section>
    </>}
    <OutreachHealth refreshKey={reload}/>
    </section>
  </div>;
}
