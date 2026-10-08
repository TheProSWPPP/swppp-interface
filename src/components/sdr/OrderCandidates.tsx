import {useId,useState} from 'react';
import {getOrderCandidates,type OrderCandidatesData} from '../../lib/sdrPreparationEvidenceApi';
import {useEvidenceRead} from './useEvidenceRead';
const reasons:Record<string,string>={project_title:'Exact project title',contact_email:'Exact current contact email',company_name:'Exact company name'};
export function OrderCandidatesView({data}:{data:OrderCandidatesData}){return <div>
 <p>Candidate matches are unverified, including a single match. Compare the intake details with the customer conversation.</p>
 <p>{data.total} candidate records · Showing {data.items.length}{data.offset?` from ${data.offset+1}`:''} · {data.query?'Manual inventory search':'Exact title, email or company matches'}.</p>
 {data.items.length===0&&<p>No candidates in this page of the available inventory. This does not establish that no order exists.</p>}
 {data.items.map(item=><details key={item.projectId}><summary>{item.projectName||'Untitled intake'} · {item.companyName||'Company unknown'}{item.testStatus==='marked_test'?' · Test / demo marker':''}</summary><p>Candidate {item.projectId} · {item.contactName||'Contact unknown'} · {item.contactEmail||'Email unknown'}</p><p>Recorded intake date: {item.intakeDate||'Unknown'} · Document status: {item.documentStatus||'Unknown'}</p><p>{item.matchReasons.map(reason=>reasons[reason]||'Manual search').join(' · ')||'Manual search result'} · Test status: {item.testStatus==='marked_test'?'Marked or named as test / demo':'Unknown'}</p>{item.safeTrelloReference&&<a href={item.safeTrelloReference} target="_blank" rel="noopener noreferrer">Open recorded Trello card reference</a>}</details>)}
 <p className="fu-task-source">Dedicated app inventory only. WordPress intake completeness is unknown; archived and deleted records are excluded. Current Trello state is unavailable. Document status does not verify an order, payment or quote delivery.</p>
 </div>;}
export default function OrderCandidates({leadId}:{leadId:string}){
 const evidence=useEvidenceRead<OrderCandidatesData>(leadId),[query,setQuery]=useState(''),id=useId();
 if(!evidence.allowed)return null;
 const load=(q=query,offset=0)=>evidence.load(signal=>getOrderCandidates(leadId,q,offset,signal));
 return <div className="fu-project-context"><button type="button" className="fu-button" aria-expanded={evidence.open} onClick={()=>evidence.open?evidence.close():void load('',0)}>{evidence.open?'Hide website order candidates':'Check website order candidates'}</button>{evidence.open&&<div>
 <label htmlFor={id}>Search intake project, company or email</label><input id={id} maxLength={100} value={query} onChange={event=>setQuery(event.target.value)} style={{maxWidth:'100%',width:'100%',boxSizing:'border-box',minHeight:44}}/><button type="button" className="fu-button" disabled={evidence.loading} onClick={()=>void load()}>Search inventory</button><button type="button" className="fu-button" disabled={evidence.loading} onClick={()=>{setQuery('');void load('');}}>Match current project</button>
 {evidence.loading&&<p role="status">Loading order candidates…</p>}{evidence.error&&<p role="alert">{evidence.error}</p>}{evidence.data&&<><OrderCandidatesView data={evidence.data}/><button type="button" className="fu-button" disabled={evidence.loading||evidence.data.offset===0} onClick={()=>void load(evidence.data!.query,Math.max(0,evidence.data!.offset-20))}>Previous candidates</button><button type="button" className="fu-button" disabled={evidence.loading||evidence.data.offset+20>=evidence.data.total||evidence.data.offset>=10000} onClick={()=>void load(evidence.data!.query,evidence.data!.offset+20)}>Next candidates</button>{evidence.data.offset>=10000&&<p>Search more specifically to review further records.</p>}</>}
 </div>}</div>;
}
