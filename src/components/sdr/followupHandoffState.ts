import type {HandoffApi,HandoffInput,HandoffContentPreview,HandoffReceipt} from '../../lib/sdrFollowupHandoffApi';
export interface HandoffState {
 phase:'loading'|'preview'|'publishing'|'checking'|'receipt'|'error';
 preview:HandoffContentPreview|null;receipt:HandoffReceipt|null;attempted:boolean;error:string;retryable?:boolean;
}
export const notePreviewText=(html:string)=>html.replace(/<br\s*\/?>/gi,'\n').replace(/&(amp|lt|gt|quot|#39);/g,(_,key:string)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]||''));
export function restoreHandoffFocus(element:HTMLElement|null){
 if(element&&document.activeElement===document.body)element.focus();
}
export const handoffConfirmed=(receipt:HandoffReceipt|null)=>receipt?.status==='confirmed'&&receipt.readbackVerified;
export const handoffUnresolved=(state:HandoffState)=>state.attempted&&!handoffConfirmed(state.receipt)&&state.receipt?.status!=='not_attempted';
export const handoffPending=(state:HandoffState)=>['loading','publishing','checking'].includes(state.phase);
const preflightMessage=(error:Error&{status?:number})=>{
 if(![400,403,404,409].includes(error.status||0))return null;
 if(error.message==='preview_expired')return 'Preview expired. Save the draft and review a new preview.';
 if(error.message==='publication_unresolved')return 'Another handoff for this lead needs verification. Check Pipedrive before continuing.';
 if(error.message==='handoff_too_large')return 'This note exceeds the handoff size limit. Shorten the draft and save it again.';
 if(error.status===409)return 'Draft or CRM context changed. Close and reopen the draft to review it.';
 return 'Pipedrive handoff could not be authorized. Review your access and reopen the draft.';
};
export function createHandoffSession(input:HandoffInput&{leadId:string},api:HandoffApi,isCurrent:()=>boolean,onChange:(state:HandoffState)=>void){
 let active=true,inFlight=false;
 let state:HandoffState={phase:'loading',preview:null,receipt:null,attempted:false,error:''};
 const valid=()=>active&&isCurrent();
 const update=(patch:Partial<HandoffState>)=>{if(valid()){state={...state,...patch};onChange(state);}};
 const fields={expectedRevision:input.expectedRevision,contextToken:input.contextToken};
 const load=async()=>{
  if(!valid()||inFlight||state.attempted||state.retryable===false)return;
  inFlight=true;update({phase:'loading',error:''});
  try{
   const preview=await api.preview(input.leadId,fields);
   update({preview:preview.publication?null:preview,receipt:preview.publication,attempted:Boolean(preview.publication),phase:preview.publication?'receipt':'preview'});
  }catch(cause){
   const error=cause as Error&{status?:number};
   const message=preflightMessage(error);
   update({phase:'error',retryable:!message&&error.message!=='handoff_unavailable',error:message||'Pipedrive preview is unavailable. Your private draft is saved.'});
  }finally{inFlight=false;}
 };
 const publish=async(reviewed:boolean)=>{
  if(!valid()||inFlight||!reviewed||state.phase!=='preview'||!state.preview||state.attempted)return;
  const previewToken=state.preview.previewToken;
  inFlight=true;update({phase:'publishing',attempted:true,error:''});
  try{const receipt=await api.publish(input.leadId,{...fields,previewToken,latestConversationReviewed:true});update({phase:'receipt',receipt});}
  catch(cause){
   const message=preflightMessage(cause as Error&{status?:number});
   if(message)update({phase:'error',preview:null,attempted:false,retryable:false,error:message});
   else update({phase:'receipt',error:'The result is unconfirmed. Check status before any further handoff.'});
  }
  finally{inFlight=false;}
 };
 const check=async()=>{
  if(!valid()||inFlight||!handoffUnresolved(state))return;
  inFlight=true;update({phase:'checking',error:''});
  try{
   let receipt=state.receipt;
   if(!receipt){const preview=await api.preview(input.leadId,fields);if(!valid())return;receipt=preview.publication;}
   if(receipt&&!handoffConfirmed(receipt)){receipt=await api.reconcile(input.leadId,receipt.id);}
   update({phase:'receipt',receipt,error:receipt?'':'No publication receipt is available. Check the lead in Pipedrive; this handoff will not publish again.'});
  }catch{update({phase:'receipt',error:'Status could not be verified. Check the lead in Pipedrive before any further handoff.'});}
  finally{inFlight=false;}
 };
 return {load,publish,check,dispose:()=>{active=false;}};
}
