import {useState} from 'react';
import {sdrCrmApi,type FollowupOutcomes as Outcomes} from '../../lib/sdrCrmApi';

const n=(value:number|null)=>value==null?'unavailable':String(value);
const checked=(value:string|null)=>value?new Date(value).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' CT':'never';

export function FollowupOutcomesView({data}:{data:Outcomes}){
 return <div className="fu-coverage">
  {data.rows.length===0?<p>No quiet-conversation or bid follow-up tasks created in the last {data.weeks} weeks.</p>:
  <table className="fu-outcomes"><thead><tr><th>Week of</th><th>Task</th><th>Created</th><th>Marked done</th><th>Our email after</th><th>Buyer reply after</th><th>Quote after</th><th>Won after</th><th>Order after</th></tr></thead>
   <tbody>{data.rows.map(row=><tr key={`${row.week}-${row.kind}`}><td>{row.week}</td><td>{row.kind==='quiet'?'Quiet conversation':'Bid follow-up'}</td><td>{row.created}</td><td>{n(row.done)}{row.statusUnknown?` (${row.statusUnknown} not seen)`:''}</td><td>{n(row.emailedAfter)}</td><td>{n(row.replyAfter)}</td><td>{n(row.quoteAfter)}</td><td>{n(row.wonAfter)}</td><td>{data.orders}</td></tr>)}</tbody></table>}
  <span>Counts tasks, not emails: a task counts once if anything happened any time after it was created. Emails and replies come from collected mail and Pipedrive mail for the lead's contact, so some may be missing. Quotes and wins count only deals linked to the project. Task status checked {checked(data.activitiesCheckedAt)}; deals checked {checked(data.salesCheckedAt)}. Orders are not linked to projects yet.</span>
 </div>;
}

export default function FollowupOutcomes(){
 const [data,setData]=useState<Outcomes|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
 const load=async()=>{setLoading(true);setError(null);try{setData(await sdrCrmApi.followupOutcomes());}catch(cause){setError((cause as Error).message);}finally{setLoading(false);}};
 return <details className="fu-coverage-details" onToggle={event=>{if((event.currentTarget as HTMLDetailsElement).open&&!data&&!loading)void load();}}>
  <summary><span>Weekly outcomes of follow-up tasks</span><span>Show</span></summary>
  {loading&&<p role="status">Loading outcomes…</p>}
  {error&&<p role="alert" className="fu-warning">Could not load outcomes. {error}<button type="button" className="fu-button" onClick={()=>void load()}>Retry</button></p>}
  {data&&<FollowupOutcomesView data={data}/>}
 </details>;
}
