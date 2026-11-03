import {useState} from 'react';
import {LANE_NAMES,type LinkedinDryRun,type LinkedinLane,type LinkedinLaneDApproval,type LinkedinOldCustomerImport,type LinkedinOldCustomers,type LinkedinReplyAlert,type LinkedinStageResult} from '../../lib/sdrLinkedinApi';
const STEP_NAMES:Record<string,string>={dm1:'Message 1',followup1:'Message 2',followup2:'Message 3',inmail:'InMail'};
const card='rounded-2xl border border-slate-200 bg-white p-5';
const button='min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 disabled:cursor-not-allowed disabled:opacity-50';
const primary='min-h-11 rounded-lg bg-brand-900 px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 disabled:cursor-not-allowed disabled:opacity-50';
const words=(value:string)=>value.replaceAll('_',' ');
const day=(value:string|null|undefined)=>value?new Date(value).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';

export function LinkedinRepliesSection({alerts,onHandled,busyId}:{alerts:LinkedinReplyAlert[];onHandled?:(id:string)=>void;busyId?:string|null}){
 const [copied,setCopied]=useState<string|null>(null);
 const copy=async(alert:LinkedinReplyAlert)=>{try{await navigator.clipboard.writeText(alert.suggested_answer||'');setCopied(alert.id)}catch{setCopied(null)}};
 const open=alerts.filter(a=>['pending','sent','reminded','failed'].includes(a.state));
 return <section className={card} aria-label="LinkedIn replies"><h2 className="text-lg font-semibold text-slate-900">Replies</h2><p className="mt-1 text-sm text-slate-600">Their messages stopped as soon as they replied. Answer in LinkedIn yourself; the suggested answer is a starting point.</p>
  {alerts.length===0?<p className="mt-3 text-sm text-slate-600">No LinkedIn replies yet.</p>:<ul className="mt-4 space-y-4">{alerts.map(alert=><li key={alert.id} className="rounded-xl border border-slate-200 p-4">
   <div className="flex flex-wrap items-baseline justify-between gap-2"><strong className="text-sm text-slate-900">{alert.name||'Someone'}{alert.company?` (${alert.company})`:''}</strong><span className="text-xs font-medium text-slate-700">{open.includes(alert)?alert.state==='failed'?'Email to Derek failed':'Open':'Handled'}{alert.lane?` · ${LANE_NAMES[alert.lane]}`:''}</span></div>
   <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{alert.reply_text}</p>
   {alert.suggested_answer&&<div className="mt-3 rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Suggested answer</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{alert.suggested_answer}</p><button type="button" className={`${button} mt-2`} onClick={()=>copy(alert)}>{copied===alert.id?'Copied':'Copy answer'}</button></div>}
   <div className="mt-3 flex flex-wrap items-center gap-3">{alert.thread_url&&<a className="inline-flex min-h-11 items-center text-sm text-blue-700 underline" href={alert.thread_url} target="_blank" rel="noreferrer">Open in LinkedIn</a>}{open.includes(alert)&&onHandled&&<button type="button" className={button} disabled={busyId===alert.id} onClick={()=>onHandled(alert.id)}>{busyId===alert.id?'Saving…':'Mark handled'}</button>}<span className="text-xs text-slate-600">Received {day(alert.created_at)}{alert.reminder1_sent_at?' · reminder sent':''}</span></div>
  </li>)}</ul>}
 </section>;
}

export function LinkedinDryRunSection({day:preview}:{day:LinkedinDryRun}){
 const lanes=(['B','D','C','A'] as LinkedinLane[]).filter(lane=>preview.lanes[lane]?.length);
 const held=Object.entries(preview.held||{});
 return <section className={card} aria-label="Today dry run"><h2 className="text-lg font-semibold text-slate-900">Today (dry run)</h2>
  <p className="mt-1 text-sm text-slate-600">Who would get a connection request today and the exact messages they would get. Nothing here is sent.</p>
  <p className="mt-3 text-sm font-medium text-slate-800">{preview.ramp.started?`Week ${preview.ramp.weekInRamp} of the ramp: ${preview.ramp.rampBudget} invites today, ${preview.ramp.remaining} left.`:`Not live yet. Day 1 would be ${preview.ramp.rampBudget} invites.`}{preview.account?.snSyncStale?' Sales Navigator inbox sync looks stuck, so InMails are on hold.':''}</p>
  {lanes.length===0?<p className="mt-3 text-sm text-slate-600">Nobody is ready for an invite today.</p>:lanes.map(lane=><div key={lane} className="mt-4"><h3 className="text-sm font-semibold text-slate-900">{LANE_NAMES[lane]}</h3><ol className="mt-2 space-y-3">{preview.lanes[lane].map(person=><li key={person.candidateId} className="rounded-xl border border-slate-200 p-3"><p className="text-sm text-slate-900"><strong>{person.order}. {person.name||'Unnamed'}</strong>{person.title?`, ${person.title}`:''}{person.company?` at ${person.company}`:''}{person.state?` (${person.state})`:''}</p><p className="text-xs text-slate-600">{person.active30d?'Active in the last 30 days · ':''}{person.inCampaign?`Campaign ${words(person.campaignStatus)}`:'Not in a campaign yet'}</p>
   <dl className="mt-2 space-y-1">{Object.entries(person.copy).map(([step,copy])=><div key={step}><dt className="text-xs font-semibold text-slate-500">{STEP_NAMES[step]||step}</dt><dd className="text-sm text-slate-800">{copy.body?<>{copy.subject?<span className="block text-xs text-slate-600">Subject: {copy.subject}</span>:null}{copy.body}</>:<span className="text-amber-800">Held until verified: {(copy.missing||[]).join(', ')||'a fact'}</span>}</dd></div>)}</dl></li>)}</ol></div>)}
  <div className="mt-4 grid gap-3 md:grid-cols-3 text-sm text-slate-700"><p>InMail due (day 14): {preview.wouldInmail.length}</p><p>Withdraw due (day 21): {preview.wouldWithdraw.length}</p><p>Group D lines waiting: {preview.awaitingCopy.length}</p></div>
  {held.length>0&&<p className="mt-2 text-sm text-slate-700">Held: {held.map(([reason,count])=>`${words(reason)} ${count}`).join(', ')}</p>}
 </section>;
}

export function LinkedinLaneDSection({items,onDecide,busyId}:{items:LinkedinLaneDApproval[];onDecide?:(item:LinkedinLaneDApproval,decision:'approve'|'reject',topic:string,reaction:string)=>void;busyId?:string|null}){
 const [edits,setEdits]=useState<Record<string,{topic:string;reaction:string}>>({});
 const value=(item:LinkedinLaneDApproval)=>edits[item.candidateId]||{topic:item.topic,reaction:item.reaction};
 return <section className={card} aria-label="Group D approvals"><h2 className="text-lg font-semibold text-slate-900">Group D approvals</h2><p className="mt-1 text-sm text-slate-600">The line about their post is written for each person and checked here before it goes. Message 1 reads: Saw your post about (topic), (line about it).</p>
  {items.length===0?<p className="mt-3 text-sm text-slate-600">No Group D lines are waiting.</p>:<ul className="mt-4 space-y-4">{items.map(item=>{const v=value(item);return <li key={item.candidateId} className="rounded-xl border border-slate-200 p-4"><p className="text-sm text-slate-900"><strong>{item.name||'Unnamed'}</strong>{item.title?`, ${item.title}`:''}{item.company?` at ${item.company}`:''}</p>{item.post?.excerpt&&<blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-sm text-slate-700">{item.post.excerpt}</blockquote>}
   <label className="mt-3 block text-sm font-medium text-slate-800">Topic<input className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm" value={v.topic} onChange={e=>setEdits({...edits,[item.candidateId]:{...v,topic:e.target.value}})}/></label>
   <label className="mt-2 block text-sm font-medium text-slate-800">Line about it<input className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm" value={v.reaction} onChange={e=>setEdits({...edits,[item.candidateId]:{...v,reaction:e.target.value}})}/></label>
   {onDecide&&<div className="mt-3 flex gap-3"><button type="button" className={primary} disabled={busyId===item.candidateId||!v.topic.trim()||!v.reaction.trim()} onClick={()=>onDecide(item,'approve',v.topic,v.reaction)}>Approve</button><button type="button" className={button} disabled={busyId===item.candidateId} onClick={()=>onDecide(item,'reject',v.topic,v.reaction)}>Reject</button></div>}
  </li>})}</ul>}
 </section>;
}

export function LinkedinOldCustomersSection({list,onPreview,onImport,onCheck,result,checkResult,busy}:{list:LinkedinOldCustomers|null;onPreview?:(csv:string)=>void;onImport?:(csv:string)=>void;onCheck?:()=>void;result?:LinkedinOldCustomerImport|null;checkResult?:Record<string,number>|null;busy?:boolean}){
 const [csv,setCsv]=useState('');
 const load=async(file:File|undefined)=>{if(file)setCsv(await file.text())};
 const counts=Object.entries(list?.counts||{});
 return <section className={card} aria-label="Old customer list"><h2 className="text-lg font-semibold text-slate-900">Old customer list</h2><p className="mt-1 text-sm text-slate-600">CSV with name, company, email, and LinkedIn if you have it. Check it first, then import, then check job changes. People who moved go to group B; each old company gets a group C search.</p>
  <input type="file" accept=".csv,text/csv" className="mt-3 block text-sm" aria-label="Old customer CSV" onChange={e=>load(e.target.files?.[0])}/>
  <div className="mt-3 flex flex-wrap gap-3">{onPreview&&<button type="button" className={button} disabled={busy||!csv} onClick={()=>onPreview(csv)}>Check the file</button>}{onImport&&<button type="button" className={primary} disabled={busy||!csv||!result?.dryRun} onClick={()=>onImport(csv)}>Import</button>}{onCheck&&<button type="button" className={button} disabled={busy} onClick={onCheck}>Check job changes</button>}</div>
  {result&&<p className="mt-3 text-sm text-slate-700">{result.dryRun?`${result.rows} rows look good`:`${result.inserted} added, ${result.updated} updated`}{result.errors.length?`, ${result.errors.length} rows skipped (${result.errors.slice(0,5).map(e=>`row ${e.row}: ${words(e.reason)}`).join('; ')})`:''}.</p>}
  {checkResult&&<p className="mt-2 text-sm text-slate-700">Checked {checkResult.checked||0}: {checkResult.moved||0} moved, {checkResult.same_company||0} still there, {checkResult.not_found||0} not found, {checkResult.ambiguous||0} need a manual pick.</p>}
  {counts.length>0&&<p className="mt-2 text-sm text-slate-700">On file: {counts.map(([status,n])=>`${words(status)} ${n}`).join(', ')}</p>}
 </section>;
}

export function LinkedinStagePanel({onStage,result,busy}:{onStage?:(lane:LinkedinLane,dryRun:boolean,company?:string)=>void;result?:LinkedinStageResult|null;busy?:boolean}){
 const [company,setCompany]=useState('');
 return <section className={card} aria-label="Find people"><h2 className="text-lg font-semibold text-slate-900">Find people</h2><p className="mt-1 text-sm text-slate-600">Searches LinkedIn without using your account. Run a dry run first to see who would be added and why the others were skipped.</p>
  <div className="mt-3 flex flex-wrap gap-3">{(['A','D'] as LinkedinLane[]).map(lane=><span key={lane} className="flex gap-2"><button type="button" className={button} disabled={busy} onClick={()=>onStage?.(lane,true)}>{`Dry run ${lane}`}</button><button type="button" className={button} disabled={busy} onClick={()=>onStage?.(lane,false)}>{`Add ${lane}`}</button></span>)}</div>
  <div className="mt-3 flex flex-wrap items-end gap-2"><label className="text-sm font-medium text-slate-800">Group C company<input className="mt-1 block rounded-lg border border-slate-300 p-2 text-sm" value={company} onChange={e=>setCompany(e.target.value)}/></label><button type="button" className={button} disabled={busy||!company.trim()} onClick={()=>onStage?.('C',true,company.trim())}>Dry run C</button><button type="button" className={button} disabled={busy||!company.trim()} onClick={()=>onStage?.('C',false,company.trim())}>Add C</button></div>
  {result&&<div className="mt-3 text-sm text-slate-700"><p>{result.dryRun?`${result.wouldStage.length} would be added`:`${result.staged.length} added`} from {result.considered} looked at{result.stopped?`, stopped: ${words(result.stopped)}`:''}.</p>{Object.keys(result.skipped).length>0&&<p>Skipped: {Object.entries(result.skipped).map(([reason,n])=>`${words(reason)} ${n}`).join(', ')}</p>}{result.dryRun&&result.wouldStage.length>0&&<ul className="mt-2 list-disc pl-5">{result.wouldStage.slice(0,25).map((p,i)=><li key={i}>{p.name||'Unnamed'}{p.title?`, ${p.title}`:''}{p.company?` at ${p.company}`:''}</li>)}</ul>}</div>}
 </section>;
}
