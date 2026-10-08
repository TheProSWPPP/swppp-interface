import {readFollowupDraft,saveFollowupDraft} from './sdrFollowupDrafts.js';

export function registerSdrFollowupDraftRoutes(app,{pool,companyId}={}){
 if(!pool||!companyId)throw new Error('followup_draft_dependencies_required');
 const handler=save=>async(req,res)=>{
  res.set?.('Cache-Control','no-store');
  if(req.sdrUser?.machine||!['admin','sdr'].includes(req.sdrUser?.role)||!req.sdrUser?.sub)return res.status(403).json({error:'session_required'});
  try{
   if(save&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(key=>!['subject','body','expectedRevision','contextToken','acknowledgeContext'].includes(key))))return res.status(400).json({error:'invalid_draft'});
   const input={...(save?req.body:{}),companyId,leadId:req.params.leadId,viewer:req.sdrUser};
   return res.json(await (save?saveFollowupDraft:readFollowupDraft)(pool,input));
  }catch(error){
   const status={session_required:403,lead_unavailable:404,invalid_draft:400,context_changed:409,revision_conflict:409}[error.code]||503;
   return res.status(status).json({error:status===503?'draft_unavailable':error.code,...(status===409&&error.current?{current:error.current}:{})});
  }
 };
 app.get('/api/sdr/followup-drafts/:leadId',handler(false));
 app.put('/api/sdr/followup-drafts/:leadId',handler(true));
}
