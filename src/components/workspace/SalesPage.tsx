import {useState,useMemo} from 'react';
import {ArrowRight,RefreshCw} from 'lucide-react';
import type {SdrUser} from '../../lib/sdrApi';
import type {MetricsQuery} from '../../lib/sdrMetricsApi';
import MonthlySales from '../sdr/dashboard/MonthlySales';
import MetricCard from '../sdr/dashboard/MetricCard';
import {defaultWindow,shiftDate} from '../sdr/dashboard/metricDisplay';
import {monthWindow} from '../sdr/dashboard/salesMonths';
import '../sdr/dashboard/dashboard.css';
import {useWorkspaceMetrics} from './useWorkspaceMetrics';
import {comparisonWindow,changeText} from '../../lib/salesComparison';
export default function SalesPage({user,onOpenSdr}:{user:SdrUser|null;onOpenSdr:()=>void}){
 const [query,setQuery]=useState<MetricsQuery>(()=>monthWindow(defaultWindow().to,12));
 const [period,setPeriod]=useState('12');
 const [custom,setCustom]=useState({from:query.from,through:shiftDate(query.to,-1)});
 const [dateError,setDateError]=useState('');
 const {data,history,error,loading,refresh:refreshCurrent}=useWorkspaceMetrics(query,user?.role==='admin');
 const previousQuery=useMemo(()=>{
  if(period.startsWith('year:')){const year=Number(query.from.slice(0,4))-1;return {from:String(year)+query.from.slice(4),to:String(Number(query.to.slice(0,4))-1)+query.to.slice(4)};}
  return comparisonWindow(query);
 },[query,period]);
 const previous=useWorkspaceMetrics(previousQuery,user?.role==='admin');
 const monthBaselineQuery=useMemo(()=>{
  const start=query.from.slice(0,8)+'01';const date=new Date(start+'T12:00:00Z');date.setUTCMonth(date.getUTCMonth()-1);
  return {from:date.toISOString().slice(0,10),to:start};
 },[query.from]);
 const monthBaseline=useWorkspaceMetrics(monthBaselineQuery,user?.role==='admin'&&period.startsWith('year:'));
 const refresh=()=>{refreshCurrent();previous.refresh();monthBaseline.refresh();};
 const freshness=data?.company_sales?.freshness;
 const firstYear=Number(history?.history_from?.slice(0,4)||defaultWindow().to.slice(0,4));
 const thisYear=Number(defaultWindow().to.slice(0,4));
 const years=Array.from({length:Math.max(1,thisYear-firstYear+1)},(_,index)=>thisYear-index);
 const comparisonLabel=period.startsWith('year:')?'same months last year':'previous period';
 const applyMonth=(from:string,to:string)=>{setQuery({from,to});setCustom({from,through:shiftDate(to,-1)});setPeriod('custom');setDateError('');};
 const selectPeriod=(value:string)=>{
  setPeriod(value);setDateError('');if(value==='custom')return;
  const window=value.startsWith('year:')?{from:Number(value.slice(5))===firstYear&&history?.history_from?history.history_from:value.slice(5)+'-01-01',to:Number(value.slice(5))===thisYear?monthWindow(defaultWindow().to,1).to:String(Number(value.slice(5))+1)+'-01-01'}:monthWindow(defaultWindow().to,Number(value));setQuery(window);setCustom({from:window.from,through:shiftDate(window.to,-1)});
 };
 const applyCustom=()=>{
  const today=defaultWindow().to;
  if(!custom.from||!custom.through||custom.from>custom.through||custom.through>=today){setDateError('Choose a valid range ending before today.');return;}
  const to=shiftDate(custom.through,1);
  if((Date.parse(to)-Date.parse(custom.from))/86400000>366){setDateError('Choose a range of 366 days or fewer.');return;}
  setDateError('');setQuery({from:custom.from,to});
 };
 return <div className="workspace-sales sdr-dashboard">
  <div className="workspace-page-heading"><div><p className="workspace-eyebrow">All company channels</p><h1>Sales</h1></div><button className="workspace-button" onClick={refresh} disabled={!user||user.role!=='admin'||loading}><RefreshCw size={17}/>{loading?'Refreshing…':'Refresh sales'}</button></div>
  {user?.role!=='admin'?<div className="workspace-notice"><div><h2>{user?'Company sales require administrator access':'Sign in to view company sales'}</h2><p>{user?'Your outreach reporting remains available in SDR. Company-wide sales follow the existing account permissions.':'Use the existing SDR account picker, then return to Sales.'}</p></div><button className="workspace-button workspace-button-primary" onClick={onOpenSdr}>Open SDR<ArrowRight size={17}/></button></div>:<>
   <div className="workspace-sales-filters"><label>Reporting period<select value={period} onChange={event=>selectPeriod(event.target.value)}><option value="1">Last complete month</option><option value="3">Last 3 complete months</option><option value="6">Last 6 complete months</option><option value="12">Last 12 complete months</option>{years.map(year=><option key={year} value={`year:${year}`}>{year}{year===thisYear?' · complete months to date':year===firstYear?' · available months':''}</option>)}<option value="custom">Custom dates</option></select></label>{period==='custom'&&<><label>From<input type="date" value={custom.from} onChange={event=>setCustom({...custom,from:event.target.value})}/></label><label>Through<input type="date" max={shiftDate(defaultWindow().to,-1)} value={custom.through} onChange={event=>setCustom({...custom,through:event.target.value})}/></label><button className="workspace-button" onClick={applyCustom}>Apply dates</button></>}<p>Chicago time · USD booked value</p></div>
   {dateError&&<p className="workspace-error" role="alert">{dateError}</p>}
   <p className="workspace-selected-range">{query.from} through {shiftDate(query.to,-1)}</p>
   {data&&<p className="workspace-reporting-status" data-state={freshness?.state}>Sales freshness: {freshness?.state||'unknown'}. {freshness?.last_complete_at?`Checked ${new Date(freshness.last_complete_at).toLocaleString('en-US',{timeZone:'America/Chicago'})} (Chicago). `:'Collection freshness has not been verified. '}{freshness?.state==='stale'?'This retained snapshot is stale. ':''}{data.company_sales?.history_from?`Available CRM history from ${data.company_sales.history_from}. `:''}{data.metrics.company_won_deals.state==='partial'?data.metrics.company_won_deals.reason==='crm_sales_dates_need_review'?'Some recorded sale dates need review.':'Selected dates extend beyond verified history and can undercount totals.':''}</p>}
   {!!data?.company_sales?.reconstructed_dates&&<p className="workspace-source-note">Older imported sales use reconstructed CRM close dates. See data quality and counting rules below.</p>}
   {!!data?.company_sales?.date_warnings?.length&&<p className="workspace-reporting-status">Date quality: {data.company_sales.date_warnings.map(warning=>`${warning.month}: ${warning.count} older deals marked won together`).join('; ')}. These CRM dates may reflect a bulk update. Comparisons involving these months are withheld.</p>}
   {error?<div className="workspace-error" role="alert">Sales could not be loaded for this period. <button onClick={refresh}>Retry sales</button></div>:loading?<div className="workspace-loading" role="status">Loading recorded sales…</div>:data&&<>
    <div className="workspace-sales-metrics"><MetricCard label="Sales won" metric={data.metrics.company_won_deals} detail="Each won Pipedrive deal counted once by its deal ID and reporting sale date."/><MetricCard label="Booked revenue" metric={data.metrics.company_won_booked_value} format="currency" detail="Known USD value of won deals. Payment collection is measured separately."/><MetricCard label="Average sale" metric={data.metrics.company_average_won_deal_value} format="currency" detail="Known USD won value divided by won deals with a known USD value."/></div>
    <div className="workspace-period-comparisons" aria-label="Sales comparison"><p>{comparisonLabel}: {previousQuery.from} through {shiftDate(previousQuery.to,-1)}</p>{previous.loading?<p role="status">Loading comparison…</p>:previous.error?<p role="alert">Comparison could not be loaded. <button onClick={previous.refresh}>Retry comparison</button></p>:<dl><div><dt>Sales won</dt><dd>{changeText(data.metrics.company_won_deals,previous.data?.metrics.company_won_deals)}</dd></div><div><dt>Booked revenue</dt><dd>{changeText(data.metrics.company_won_booked_value,previous.data?.metrics.company_won_booked_value,true)}</dd></div><div><dt>Average sale</dt><dd>{changeText(data.metrics.company_average_won_deal_value,previous.data?.metrics.company_average_won_deal_value,true)}</dd></div></dl>}</div>
    <MonthlySales data={data} stale={freshness?.state==='stale'} onSelectMonth={applyMonth} compareWith={(period.startsWith('year:')?monthBaseline.data:previous.data)||undefined} showComparisons/>

    <details className="workspace-data-details"><summary>Data quality and counting rules</summary><div><p>Company totals include every channel. Imported history uses recorded CRM close dates when the won timestamp matches the import date and the close date is earlier. Original provider timestamps are preserved. SDR attribution requires verified outreach links and remains in the SDR reporting view.</p><p>Confirmed test records excluded in this period: {data.test_data?.excluded_deals??'Unavailable'} deals. Records awaiting test review: {data.test_data?.unreviewed_deals??'Unavailable'} deals. A record without a test marker may still need review.</p><p>Sales freshness: {freshness?.state||'unknown'}. Last complete collection: {freshness?.last_complete_at?new Date(freshness.last_complete_at).toLocaleString('en-US',{timeZone:'America/Chicago'}):'Unavailable'} (Chicago time).</p><p>{data.company_sales?.reconstructed_dates||0} imported dates reconstructed from CRM close dates. Complete collection verifies the available CRM records; it does not verify every historical sale date or prove missing external sales never existed.</p><p>Partial history can undercount sales. Revenue excludes unknown and non-USD values. Monthly averages use valued wins, so the average is never calculated by averaging monthly averages.</p></div></details>
   </>}
  </>}
 </div>;
}
