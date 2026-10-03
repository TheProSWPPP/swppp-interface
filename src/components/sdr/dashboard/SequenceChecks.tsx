import {useEffect,useState} from 'react';
import {sdrApi,type SdrSequence} from '../../../lib/sdrApi';
import {sequenceChecks} from './sequenceStatusIssues';
export default function SequenceChecks({refreshKey,onReview}:{refreshKey:number;onReview:()=>void}) {
 const [state,setState]=useState<{sequences:SdrSequence[];partial:boolean;key:string}|null>(null);
 const [retry,setRetry]=useState(0);
 const [errorKey,setErrorKey]=useState<string|null>(null);
 const key=`${refreshKey}:${retry}`;
 useEffect(()=>{let active=true;sdrApi.listSequences().then(data=>{if(active){setState({sequences:data.sequences,partial:data.coverage==='partial',key});setErrorKey(null);}}).catch(()=>{if(active)setErrorKey(key)});return()=>{active=false}},[key]);
 if(errorKey===key) return <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900" aria-label="Sequence connection"><p>Sequence settings could not be verified.</p><button className="min-h-11 underline" onClick={()=>setRetry(v=>v+1)}>Retry sequence check</button></section>;
 if(state?.key!==key) return <p role="status" className="text-sm text-slate-500">Checking sequence settings…</p>;
 const issues=sequenceChecks(state.sequences);
 if(!issues.length&&!state.partial) return null;
 return <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-950" aria-label="Sequence settings need attention">
  <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Sequence settings need attention</h2><button className="min-h-11 underline" onClick={onReview}>Review sequences</button></div>
  {state.partial&&<p>Some configuration details could not be verified.</p>}
  <ul className="mt-2 space-y-2">{issues.map((issue,index)=><li key={`${issue.id}:${index}`}><strong>{issue.name.replaceAll('\u2014',':')}</strong><p>{issue.text}</p></li>)}</ul>
 </section>;
}
