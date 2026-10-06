import {useEffect,useState,useMemo} from 'react';
import {ArrowRight,Files,Mail,RefreshCw,Upload,Newspaper} from 'lucide-react';
import type {SdrUser} from '../../lib/sdrApi';
import {sdrReadRequest,runLatestRead} from '../../lib/sdrReadRequest';
import {defaultWindow,metricText,unavailable,metricExplanation} from '../sdr/dashboard/metricDisplay';
import {monthWindow} from '../sdr/dashboard/salesMonths';
import type {Metric} from '../../lib/sdrMetricsApi';
import {comparisonWindow,changeText} from '../../lib/salesComparison';
import type {WorkspaceView} from './navigation';
import {useWorkspaceMetrics} from './useWorkspaceMetrics';
type Summary={documents:{total:number;new:number;pending:number;processing:number;complete:number;ready:number;other:number};collectedAt:string};
function Figure({label,metric,money=false,detail,comparison}:{label:string;metric:Metric;money?:boolean;detail:string;comparison?:string}){
 return <article className="workspace-figure"><h2>{label}</h2><strong>{metricText(metric,money?'currency':'count')}</strong><p>{detail}</p>{comparison&&<p className="workspace-comparison">{comparison} vs previous month</p>}{metric.state!=='available'&&<span className="workspace-data-note">{metric.state==='partial'?'Partial history':'Unavailable'}{metric.state==='unavailable'&&metric.reason&&` · ${metricExplanation(metric)}`}</span>}</article>;
}
export default function WorkspaceOverview({user,onNavigate}:{user:SdrUser|null;onNavigate:(view:WorkspaceView)=>void}){
 const [query]=useState(()=>monthWindow(defaultWindow().to,1));
 const reporting=useWorkspaceMetrics(query,!!user);
 const previousQuery=useMemo(()=>comparisonWindow(query),[query]);
 const previous=useWorkspaceMetrics(previousQuery,user?.role==='admin');
 const [summaryResult,setSummaryResult]=useState<{key:number;data:Summary|null;error:boolean}>({key:-1,data:null,error:false});
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  if(user?.role!=='admin')return;
  return runLatestRead(signal=>sdrReadRequest<Summary>('/api/sdr/workspace/summary',signal),{success:data=>setSummaryResult({key:reload,data,error:false}),error:()=>setSummaryResult({key:reload,data:null,error:true}),settled:()=>{}});
 },[user,reload]);
 const summaryLoading=user?.role==='admin'&&summaryResult.key!==reload;
 const summary=summaryResult.key===reload?summaryResult.data:null;
 const summaryError=summaryResult.key===reload&&summaryResult.error;
 const label=new Date(`${query.from}T12:00:00Z`).toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'America/Chicago'});
 const metrics=reporting.data?.metrics;
 const admin=user?.role==='admin';
 const refresh=()=>{reporting.refresh();previous.refresh();setReload(value=>value+1);};
 return <div className="workspace-overview">
  <div className="workspace-page-heading"><div><h1>{admin?'Overview':'Workspace'}</h1></div><button className="workspace-button" onClick={refresh} disabled={!user||reporting.loading||summaryLoading}><RefreshCw size={17}/>{reporting.loading?'Refreshing…':'Refresh overview'}</button></div>
  {!user?<div className="workspace-notice"><div><h2>Business reporting uses your existing SDR sign-in</h2><p>Open SDR and sign in with your normal account. Document production and the other tools remain available.</p></div><button className="workspace-button workspace-button-primary" onClick={()=>onNavigate('sdr')}>Open SDR<ArrowRight size={17}/></button></div>:<>
   <section aria-labelledby="overview-sales-heading"><div className="workspace-section-heading"><div><h2 id="overview-sales-heading">{admin?'Sales':'Outreach activity'}</h2><p>{label} · Last complete calendar month · Chicago time</p></div>{admin&&<button className="workspace-text-link" onClick={()=>onNavigate('sales')}>Explore sales<ArrowRight size={16}/></button>}</div>
    {reporting.data&&<p className="workspace-reporting-status" data-state={(admin?reporting.data.company_sales?.freshness:reporting.data.freshness)?.state}>{admin?'Sales':'Reporting'} freshness: {(admin?reporting.data.company_sales?.freshness:reporting.data.freshness)?.state||'unknown'}. {admin&&reporting.data.company_sales?.freshness.last_complete_at?`Checked ${new Date(reporting.data.company_sales.freshness.last_complete_at).toLocaleString('en-US',{timeZone:'America/Chicago'})} (Chicago). `:''}{(admin?reporting.data.metrics.company_won_deals.state==='partial':Object.values(reporting.data.metrics).some(metric=>metric.state==='partial'))?'Recorded history is incomplete and can undercount totals.':''}</p>}
    {reporting.error?<div className="workspace-error" role="alert">Reporting could not be loaded. <button onClick={reporting.refresh}>Retry reporting</button></div>:reporting.loading?<div className="workspace-loading" role="status">Loading recorded results…</div>:<div className="workspace-figures">{admin?<>
     <Figure label="Sales won" metric={metrics?.company_won_deals||unavailable} comparison={previous.loading?'Loading comparison…':previous.error?'Comparison could not be loaded':changeText(metrics?.company_won_deals,previous.data?.metrics.company_won_deals)} detail="Unique Pipedrive won deals across all company channels."/>
     <Figure label="Booked revenue" metric={metrics?.company_won_booked_value||unavailable} comparison={previous.loading?'Loading comparison…':previous.error?'Comparison could not be loaded':changeText(metrics?.company_won_booked_value,previous.data?.metrics.company_won_booked_value,true)} money detail="Known USD values on won deals in this month."/>
     <Figure label="Average sale" metric={metrics?.company_average_won_deal_value||unavailable} comparison={previous.loading?'Loading comparison…':previous.error?'Comparison could not be loaded':changeText(metrics?.company_average_won_deal_value,previous.data?.metrics.company_average_won_deal_value,true)} money detail="Booked value divided by won deals with a known USD value."/>
    </>:<>
     <Figure label="Emails sent" metric={metrics?.messages_completed||unavailable} detail="Recorded outbound emails in your authorised mailbox scope."/>
     <Figure label="People emailed" metric={metrics?.contacts_reached||unavailable} detail="Unique recipient email addresses reached in this month."/>
     <Figure label="Human replies" metric={metrics?.human_replies_received||unavailable} detail="Reply events received in this month, including earlier outreach."/>
    </>}</div>}
    {reporting.data&&<p className="workspace-source-note">{admin?'Company totals include all sales channels. Outreach attribution is reported separately in SDR.':'Activity is restricted to the mailboxes your account can access.'} Confirmed test records are excluded.</p>}
   </section>
  </>}
  <div className="workspace-work-grid"><section className="workspace-work-panel"><div className="workspace-section-heading"><div><h2>Document queue</h2></div><Files size={23} aria-hidden="true"/></div>
   <p>Review requests, check project details and generate SWPPP documents.</p>
   {admin&&(summaryLoading?<p className="workspace-loading" role="status">Loading document status…</p>:summaryError?<p className="workspace-error" role="alert">Document counts could not be loaded. <button onClick={()=>setReload(value=>value+1)}>Retry counts</button></p>:summary&&<><dl className="workspace-document-counts"><div><dt>Pending review</dt><dd>{summary.documents.pending}</dd></div><div><dt>In production</dt><dd>{summary.documents.processing}</dd></div><div><dt>Ready</dt><dd>{summary.documents.ready}</dd></div></dl><p className="workspace-source-note">{summary.documents.total} active document requests · {summary.documents.new} new · {summary.documents.complete} complete{summary.documents.other>0?` · ${summary.documents.other} other statuses`:''}. Document statuses are independent of sales.</p></>)}
   <button className="workspace-button workspace-button-primary" onClick={()=>onNavigate('dashboard')}>Open documents<ArrowRight size={17}/></button>
  </section><section className="workspace-work-panel"><div className="workspace-section-heading"><div><h2>SDR</h2></div><Mail size={23} aria-hidden="true"/></div><div className="workspace-sdr-routes"><span>Cold outreach</span><span>Nurture campaigns</span><span>Inbox &amp; queue</span></div><button className="workspace-button" onClick={()=>onNavigate('sdr')}>Open SDR<ArrowRight size={17}/></button></section></div>
  <section className="workspace-quick-links" aria-label="Other work areas"><button onClick={()=>onNavigate('leads')}><Upload size={20}/><span><strong>Lead Import</strong><small>Upload and check source files</small></span><ArrowRight size={16}/></button><button onClick={()=>onNavigate('ai-content')}><Newspaper size={20}/><span><strong>AI Content</strong><small>Plan, review and publish content</small></span><ArrowRight size={16}/></button></section>
 </div>;
}
