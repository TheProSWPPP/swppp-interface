export type PreparationRequest={leadId:string;session:string|null;editorVersion:number;revision:number;contextToken:string;handoffUnresolved:boolean};
export const canApplyProposal=(requested:PreparationRequest,current:PreparationRequest)=>
 !requested.handoffUnresolved&&!current.handoffUnresolved&&requested.leadId===current.leadId&&requested.session===current.session&&requested.editorVersion===current.editorVersion&&requested.revision===current.revision&&requested.contextToken===current.contextToken;

export type ConversationReview={leadId:string;contextToken:string;revision:number;sourceId:string;action:string};
export const isConversationReviewCurrent=(reviewed:ConversationReview|null,current:ConversationReview)=>Boolean(reviewed&&reviewed.leadId===current.leadId&&reviewed.contextToken===current.contextToken&&reviewed.revision===current.revision&&reviewed.sourceId===current.sourceId&&reviewed.action===current.action);
