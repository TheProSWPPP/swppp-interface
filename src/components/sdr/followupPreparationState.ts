export type PreparationRequest={leadId:string;session:string|null;editorVersion:number;revision:number;contextToken:string;handoffUnresolved:boolean};
export const canApplyProposal=(requested:PreparationRequest,current:PreparationRequest)=>
 !requested.handoffUnresolved&&!current.handoffUnresolved&&requested.leadId===current.leadId&&requested.session===current.session&&requested.editorVersion===current.editorVersion&&requested.revision===current.revision&&requested.contextToken===current.contextToken;
