import type {FollowupDraftResponse} from '../../lib/sdrFollowupDraftApi';
export type DraftText={subject:string;body:string};
export const isUnsaved=(text:DraftText,saved:DraftText)=>text.subject!==saved.subject||text.body!==saved.body;
export const applyConflict=(local:DraftText,current:FollowupDraftResponse)=>({...local,current,acknowledged:false});
