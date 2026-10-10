// Synthetic browser exercise only. This file is never imported by the production app.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import FollowupDraftEditor from './FollowupDraftEditor';
import './followups.css';
import '../../index.css';

type Scenario='success'|'loading'|'error'|'empty'|'disabled'|'conflict'|'uncertain'|'late';
const token='synthetic-local-token';
localStorage.setItem('swppp_sdr_jwt',token);
const contextToken='a'.repeat(64);
const now='2026-10-10T12:00:00.000Z';
let scenario:Scenario='success',revision=0,saved={subject:'',body:''};
let pendingResolve:(()=>void)|null=null;
const releasePreparation=()=>{const release=pendingResolve;pendingResolve=null;release?.();};
Object.assign(window,{__salesLoopResolvePreparation:releasePreparation});
const actions:string[]=[];
const record=(kind:string)=>{actions.push(kind);window.dispatchEvent(new Event('synthetic-action'));};
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string,string>)[char]||char);
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const draft=()=>({draft:revision?{...saved,revision,contextToken,updatedAt:now}:null,contextToken,contextChanged:false,context:{lead:{title:'Library',ownerId:'7',personId:'12',contactName:'Pat'},records:scenario==='empty'?[]:[{id:'note-1',entity:'note',subject:'Buyer request',text:'Buyer asks for the bid form by October 21.',textTruncated:false,type:null,done:false,dueDate:null,ownerId:'7',sourceUpdatedAt:now}],holds:[],limited:false,coverage:'partial',orderLink:'unverified'}});
const view=()=>({leadId:'A',projectTitle:'Library',owner:{id:'7'},nextAction:{taskId:'task-1',ownerId:'7',dueDate:'2026-10-11',subject:'Call buyer'},coverage:'partial',quote:{requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'},order:{status:'unknown'},handoff:{publication:'private',delivery:'unknown',awareness:'unknown',action:'unknown'},preparation:{status:scenario==='disabled'?'unavailable':'available'}});
window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=String(input),method=init?.method||'GET';
 if(!url.startsWith('/api/sdr/'))return json({error:'external_request_blocked'},403);
 if(url.includes('/followup-drafts/')){
  if(scenario==='loading'&&method==='GET')await new Promise(resolve=>setTimeout(resolve,4000));
  if(method==='GET')return json(draft());
  if(method==='PUT'){
   if(scenario==='conflict')return json({error:'revision_conflict',current:draft()},409);
   const body=JSON.parse(String(init?.body));saved={subject:body.subject,body:body.body};revision++;record('private_draft_save');return json(draft());
  }
 }
 if(url.includes('/sales-loop/')&&url.endsWith('/prepare')){
  if(scenario==='late')await new Promise<void>(resolve=>{pendingResolve=resolve;});
  return json({subject:'Bid form',body:'I can send the bid form for your review.',missingFacts:['quote amount','quote receipt'],source:{identity:'crm_note:note-1',digest:'b'.repeat(64),provenance:{kind:'crm_note',id:'note-1'}},contextToken,revision,editorRequestVersion:JSON.parse(String(init?.body)).editorRequestVersion});
 }
 if(url.includes('/sales-loop/'))return scenario==='error'?json({error:'sales_loop_unavailable'},503):json(view());
 if(url.includes('/followup-handoffs/')&&url.endsWith('/preview'))return scenario==='uncertain'?json({publication:{id:'handoff-1',status:'uncertain',noteId:null,readbackVerified:false,projectUrl:'https://proswpppllc.pipedrive.com/leads/inbox/A',checkedAt:now,revision},revision,replyCoverage:'unverified',requiresLatestConversationReview:true}):json({previewToken:'synthetic-preview-token',revision,leadId:'A',content:saved,noteHtml:`[Prepared response — unsent]<br>Library<br>Subject: ${escape(saved.subject)}<br>Message: ${escape(saved.body)}`,owner:{id:'7',name:'Owner'},contact:{id:'12',name:'Pat',email:'pat@example.test'},checkedAt:now,replyCoverage:'unverified',requiresLatestConversationReview:true,publication:null});
 if(url.includes('/followup-handoffs/')&&url.endsWith('/publish')){record('explicit_note_publication');return json({id:'handoff-1',status:'confirmed',noteId:'note-9',readbackVerified:true,projectUrl:'https://proswpppllc.pipedrive.com/leads/inbox/A',checkedAt:now,revision});}
 if(url.includes('/followup-handoffs/')&&url.endsWith('/reconcile'))return json({id:'handoff-1',status:'uncertain',noteId:null,readbackVerified:false,projectUrl:'https://proswpppllc.pipedrive.com/leads/inbox/A',checkedAt:now,revision});
 if(url.includes('/followup-context'))return json({lead:{id:'A',title:'Library',ownerId:'7',ownerName:'Owner',personId:'12',contactName:'Pat',contactEmail:'pat@example.test',sourceUpdatedAt:now,observedAt:now,sourceUrl:'https://proswpppllc.pipedrive.com/leads/inbox/A'},holds:[],openTaskCount:1,tasksLimited:false,tasks:[{id:'task-1',subject:'Call buyer',subjectTruncated:false,note:'',noteTruncated:false,type:'call',ownerId:'7',ownerName:'Owner',dueDate:'2026-10-11',dueTime:null,sourceUpdatedAt:now,observedAt:now,sourceUrl:null}],recentRecords:{note:null,completedCall:null},coverage:{partial:true,asOf:now,scopes:[],quoteStatus:'unknown',orderStatus:'unknown',emailStatus:'unavailable'}});
 return json({error:'fixture_route_missing'},404);
};

export function Harness(){
 const [selected,setSelected]=useState<Scenario>('success'),[cycle,setCycle]=useState(0);
 const [actionVersion,setActionVersion]=useState(0);
 useEffect(()=>{const changed=()=>setActionVersion(value=>value+1);window.addEventListener('synthetic-action',changed);return()=>window.removeEventListener('synthetic-action',changed);},[]);
 const choose=(value:Scenario)=>{releasePreparation();scenario=value;revision=value==='uncertain'?1:0;saved=value==='uncertain'?{subject:'Existing private reply',body:'Prepared response'}:{subject:'',body:''};actions.length=0;setSelected(value);setCycle(n=>n+1);};
 return <main style={{maxWidth:900,margin:'24px auto',padding:16}}><h1>Sales loop synthetic UI exercise</h1><p>Local fixture only. No provider, customer or CRM request leaves this page.</p><label>State <select value={selected} onChange={event=>choose(event.target.value as Scenario)}>{(['success','loading','error','empty','disabled','conflict','uncertain','late'] as Scenario[]).map(value=><option key={value}>{value}</option>)}</select></label><p>Open the editor. In success, Prepare → Apply → Save → Preview; publication requires the review checkbox. In late, edit text and change it back while preparation is pending, then release the response. In conflict, try Save. In uncertain, Preview the existing saved draft.</p><FollowupDraftEditor key={cycle} leadId="A"/>{selected==='late'&&<button type="button" style={{position:'fixed',right:12,bottom:12,zIndex:1002,minHeight:44,padding:'8px 16px',background:'#205b82',color:'#fff'}} onClick={releasePreparation}>Release pending proposal</button>}<details><summary>Fake action log ({actionVersion&&actions.length})</summary><pre>{JSON.stringify(actions,null,2)}</pre></details></main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
