import {useState,useMemo} from 'react';
import {ArrowRight,RefreshCw,CalendarDays,Info} from 'lucide-react';
import type {SdrUser} from '../../lib/sdrApi';
import type {MetricsQuery} from '../../lib/sdrMetricsApi';
import SalesTrend from './SalesTrend';
import {changeTone,salesAmount} from './salesChartData';
import './sales.css';
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
 const hasCompleteMonth=!defaultWindow().to.startsWith(`${thisYear}-01`);
 const latestMonthLabel=new Date(shiftDate(monthWindow(defaultWindow().to,1).to,-1)+'T12:00:00Z').toLocaleDateString('en-US',{month:'short'});
 const years=Array.from({length:Math.max(1,thisYear-firstYear+1)},(_,index)=>thisYear-index);
 const comparisonLabel=period.startsWith('year:')?'same months last year':'previous period';
 const applyMonth=(from:string,to:string)=>{setQuery({from,to});setCustom({from,through:shiftDate(to,-1)});setPeriod('custom');setDateError('');};
 const selectPeriod=(value:string)=>{
  setPeriod(value);setDateError('');if(value==='custom')return;
  const window=value.startsWith('year:')?{from:Number(value.slice(5))===firstYear&&history?.history_from?history.history_from:value.slice(5)+'-01-01',to:Number(value.slice(5))===thisYear?monthWindow(defaultWindow().to,1).to:String(Number(value.slice(5))+1)+'-01-01'}:monthWindow(defaultWindow().to,Number(value));if(window.from>=window.to){setDateError('No complete months are available for this year yet.');return;}setQuery(window);setCustom({from:window.from,through:shiftDate(window.to,-1)});
 };
 const applyCustom=()=>{
  const today=defaultWindow().to;
  if(!custom.from||!custom.through||custom.from>custom.through||custom.through>=today){setDateError('Choose a valid range ending before today.');return;}
  const to=shiftDate(custom.through,1);
  if((Date.parse(to)-Date.parse(custom.from))/86400000>366){setDateError('Choose a range of 366 days or fewer.');return;}
  setDateError('');setQuery({from:custom.from,to});
 };
 const labelDate=(date:string)=>new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/Chicago'});
 const rangeLabel=`${labelDate(query.from)} – ${labelDate(shiftDate(query.to,-1))}`;
 const cards=[{key:'company_won_deals',label:'Sales won',currency:false,detail:'Each won Pipedrive deal counted once.'},{key:'company_won_booked_value',label:'Booked revenue',currency:true,detail:'Known USD value of won deals, before payment collection.'},{key:'company_average_won_deal_value',label:'Average sale',currency:true,detail:'Known USD revenue divided by sales with a known USD value.'}] as const;
 const warnings=data?.company_sales?.date_warnings||[];
 const qualityMessage=warnings.length?`${warnings.map(w=>new Date(w.month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'short',year:'numeric'})).join(', ')} sale dates need review. Affected comparisons are withheld.`:data?.metrics.company_won_deals.state==='partial'?'Selected dates include incomplete history. Totals may be understated.':null;
 return <div className="workspace-sales sales-page">
  <div className="sales-page-heading"><div><h1>Sales</h1><p>{rangeLabel}</p></div><div className="sales-heading-actions">{freshness&&<span className={`sales-freshness is-${freshness.state}`}>{freshness.state==='fresh'?'Updated':freshness.state==='stale'?'Stale data':'Freshness unknown'}{freshness.last_complete_at&&` ${new Date(freshness.last_complete_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'})} CT`}</span>}<button className="workspace-button sales-refresh" onClick={refresh} disabled={!user||user.role!=='admin'||loading}><RefreshCw size={16}/>{loading?'Refreshing…':'Refresh'}</button></div></div>
  {user?.role!=='admin'?<div className="workspace-notice"><div><h2>{user?'Company sales require administrator access':'Sign in to view company sales'}</h2><p>{user?'Your outreach reporting is available in SDR.':'Choose your SDR account to continue.'}</p></div><button className="workspace-button workspace-button-primary" onClick={onOpenSdr}>Open SDR<ArrowRight size={17}/></button></div>:<>
   <div className="sales-filter-bar"><div className="sales-period-shortcuts" role="group" aria-label="Reporting period">{[{value:'1',label:'Last month'},{value:'3',label:'3 months'},{value:'6',label:'6 months'},{value:'12',label:'12 months'}].map(item=><button key={item.value} aria-pressed={period===item.value} onClick={()=>selectPeriod(item.value)}>{item.label}</button>)}</div><label className="sales-year-select"><CalendarDays size={16} aria-hidden="true"/><span className="sr-only">Year or custom dates</span><select value={period.startsWith('year:')||period==='custom'?period:''} onChange={event=>selectPeriod(event.target.value)}><option value="" disabled>Year / custom</option>{years.map(year=><option key={year} value={`year:${year}`} disabled={year===thisYear&&!hasCompleteMonth}>{year}{year===thisYear?hasCompleteMonth?` through ${latestMonthLabel}`:' · no complete months':''}</option>)}<option value="custom">Custom dates</option></select></label><span className="sales-currency-note">USD · Chicago time</span></div>
   {period==='custom'&&<div className="sales-custom-dates"><label>From<input type="date" value={custom.from} onChange={event=>setCustom({...custom,from:event.target.value})}/></label><label>Through<input type="date" max={shiftDate(defaultWindow().to,-1)} value={custom.through} onChange={event=>setCustom({...custom,through:event.target.value})}/></label><button className="workspace-button" onClick={applyCustom}>Apply dates</button></div>}
   {dateError&&<p className="workspace-error" role="alert">{dateError}</p>}
   {error?<div className="workspace-error" role="alert">Sales could not be loaded. <button onClick={refresh}>Retry sales</button></div>:loading?<div className="sales-loading" role="status"><span/>Loading sales for this period…</div>:data&&<>
    <div className="sales-summary" aria-label="Sales totals">{cards.map(card=>{
     const metric=data.metrics[card.key],prior=previous.data?.metrics[card.key];
     const comparison=changeText(metric,prior,card.currency);
     return <article key={card.key} className={`sales-summary-item is-${card.key}`}><div className="sales-summary-label"><h2>{card.label}</h2><span title={card.detail} tabIndex={0} aria-label={card.detail}><Info size={15}/></span></div><strong>{salesAmount(metric.state==='unavailable'?null:metric.value,card.currency)}</strong><div className="sales-summary-comparison">{previous.loading?<span>Loading comparison…</span>:previous.error?<button onClick={previous.refresh}>Retry comparison</button>:<><span className={`sales-change is-${changeTone(metric,prior||{value:null,state:'unavailable'})}`} title={comparison}>{comparison.startsWith('Comparison unavailable')?metric.reason==='crm_sales_dates_need_review'||prior?.reason==='crm_sales_dates_need_review'?'Dates need review':'Incomplete comparison':comparison}</span><span>vs. {comparisonLabel}</span></>}</div>{metric.state==='partial'&&!qualityMessage&&<small>Partial values</small>}</article>;
    })}</div>
    {qualityMessage&&<div className="sales-quality-note"><Info size={16}/><span>{qualityMessage}</span><a href="#sales-data-quality" onClick={event=>{event.preventDefault();const details=document.getElementById('sales-data-quality') as HTMLDetailsElement|null;if(details){details.open=true;details.scrollIntoView({block:'start'});details.querySelector('summary')?.focus();}}}>Details</a></div>}
    <SalesTrend key={`${query.from}:${query.to}`} data={data} previous={previous.data||undefined} comparisonLabel={comparisonLabel} comparisonLoading={previous.loading} monthBaseline={period.startsWith('year:')?monthBaseline.data||undefined:undefined} onOpenMonth={applyMonth}/>
    <details id="sales-data-quality" className="sales-data-details"><summary>Data quality & counting rules <span>{data.test_data?.excluded_deals??'Unknown'} test deals excluded</span></summary><div><p>Each won Pipedrive deal counts once. Company totals include every channel. Revenue includes known USD values; average sale divides that value by valued wins. Payment collection is separate.</p><p>Available CRM history starts {data.company_sales?.history_from||'on an unverified date'}. {data.company_sales?.reconstructed_dates||0} imported sale dates were reconstructed from CRM close dates. Original provider timestamps are preserved.</p>{warnings.length>0&&<p>{warnings.map(w=>`${w.month}: ${w.count} older deals were marked won together`).join('; ')}. Those dates may reflect bulk updates. Comparisons involving these months are withheld.</p>}<p>Confirmed test deals excluded: {data.test_data?.excluded_deals??'unavailable'}. Deals awaiting test review: {data.test_data?.unreviewed_deals??'unavailable'}. Unmarked test records may still need review.</p><p>Last complete collection: {freshness?.last_complete_at?new Date(freshness.last_complete_at).toLocaleString('en-US',{timeZone:'America/Chicago'}):'unverified'} (Chicago). Complete collection verifies available CRM records, not every original sale date or sales missing from the CRM.</p><p>Comparisons require complete periods and usable dates. Partial months, missing values and zero baselines are handled separately. SDR attribution remains in SDR reporting.</p></div></details>
   </>}
  </>}
 </div>;
}
