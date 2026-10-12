import {sdrFetch} from './sdrApi';

export type PreparationAction='reply'|'call'|'wait'|'quote_lookup'|'operations'|'identity_resolution'|'no_action';
export type ActivityEvidence={id:string;type:string|null;subject:string;note:string;status:'open'|'recorded_complete'|'unknown';performed:'unknown';ownerId:string|null;dueDate:string|null;sourceUpdatedAt:string|null;textTruncated?:boolean};
export type SalesEvidence={records:Array<{id:string;entity:string;text:string;sourceUpdatedAt?:string|null;textTruncated?:boolean}>;activities:ActivityEvidence[];messages:Array<{id:string;provider:string;direction:string;occurredAt:string|null;customerReply:'unverified'}>;coverage:{history:'partial';pipedriveMail:'partial'|'unavailable';gmailMail?:'partial'|'unavailable';recordsLimited?:boolean;activitiesLimited?:boolean;messagesLimited?:boolean;messageBodies:'not_collected'}};
export type SalesLoopView={leadId:string;projectTitle:string;owner:{id:string|null;name?:string|null};nextAction:null|{taskId:string;ownerId:string|null;dueDate:string|null;subject:string};activities?:ActivityEvidence[];evidence?:SalesEvidence|null;coverage:'partial'|'complete';quote:{requested:unknown;prepared:unknown;sent:unknown;acknowledged:unknown};order:{status:string};handoff:{publication:string;delivery:'unknown';awareness:'unknown';action:unknown};preparation:{status:'available'|'unavailable'}};
export type PreparedProposal={action:PreparationAction;reason:string;subject:string|null;body:string|null;missingFacts:string[];evidence:SalesEvidence;evidenceDigest:string;source:{identity:string;digest:string;provenance:{kind:string;id?:string;reviewedBy?:string|null}};contextToken:string;revision:number;editorRequestVersion:number};
export type PreparationSourceRef={kind:'crm_note';id:string}|{kind:'reviewed_crm_excerpt';id:string;text:string;reviewed:true};
export const salesLoopApi={
 read:(leadId:string)=>sdrFetch<SalesLoopView>(`/api/sdr/sales-loop/${encodeURIComponent(leadId)}`),
 prepare:(leadId:string,sourceRef:PreparationSourceRef,editorRequestVersion:number,action:PreparationAction,conversationReviewed:boolean)=>sdrFetch<PreparedProposal>(`/api/sdr/sales-loop/${encodeURIComponent(leadId)}/prepare`,{method:'POST',body:JSON.stringify({sourceRef,editorRequestVersion,action,conversationReviewed})}),
};
