import {sdrFetch} from './sdrApi';

export type SalesLoopView={leadId:string;projectTitle:string;owner:{id:string|null};nextAction:null|{taskId:string;ownerId:string|null;dueDate:string|null;subject:string};coverage:'partial'|'complete';quote:{requested:unknown;prepared:unknown;sent:unknown;acknowledged:unknown};order:{status:string};handoff:{publication:string;delivery:'unknown';awareness:'unknown';action:unknown};preparation:{status:'available'|'unavailable'}};
export type PreparedProposal={subject:string;body:string;missingFacts:string[];source:{identity:string;digest:string;provenance:{kind:string;id?:string;reviewedBy?:string|null}};contextToken:string;revision:number;editorRequestVersion:number};
export type PreparationSourceRef={kind:'crm_note';id:string}|{kind:'reviewed_crm_excerpt';id:string;text:string;reviewed:true};
export const salesLoopApi={
 read:(leadId:string)=>sdrFetch<SalesLoopView>(`/api/sdr/sales-loop/${encodeURIComponent(leadId)}`),
 prepare:(leadId:string,sourceRef:PreparationSourceRef,editorRequestVersion:number)=>sdrFetch<PreparedProposal>(`/api/sdr/sales-loop/${encodeURIComponent(leadId)}/prepare`,{method:'POST',body:JSON.stringify({sourceRef,editorRequestVersion})}),
};
