import {createFollowupHandoffs} from './sdrFollowupHandoffs.js';
import {createFollowupHandoffClient} from './sdrFollowupHandoffClient.js';
export function registerSdrFollowupHandoffRoutes(app,{pool,companyId,sourceHost='proswpppllc.pipedrive.com',token,enabled=false,client}={}){
 let service=null;if(enabled&&pool&&companyId&&(client||token))service=createFollowupHandoffs({pool,companyId,sourceHost,client:client||createFollowupHandoffClient({token,companyId,sourceHost})});
 for(const operation of ['preview','publish','reconcile'])app.post(`/api/sdr/followup-handoffs/:leadId/${operation}`,async(req,res)=>{
  res.set?.('Cache-Control','no-store');
  if(req.sdrUser?.machine||!['admin','sdr'].includes(req.sdrUser?.role)||!req.sdrUser?.sub)return res.status(403).json({error:'session_required'});
  if(!service)return res.status(503).json({error:'handoff_unavailable'});
  const body=req.body,allowed=operation==='reconcile'?['handoffId']:operation==='publish'?['expectedRevision','contextToken','previewToken','latestConversationReviewed']:['expectedRevision','contextToken'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k))||
   (operation==='reconcile'?!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.handoffId||''):!Number.isInteger(body.expectedRevision)||body.expectedRevision<1||!/^[a-f0-9]{64}$/.test(body.contextToken||'')))return res.status(400).json({error:'invalid_handoff'});
  try{return res.json(await service[operation]({...body,leadId:req.params.leadId,viewer:req.sdrUser}));}
  catch(error){const status={session_required:403,lead_unavailable:404,revision_conflict:409,context_changed:409,preview_expired:409,publication_unresolved:409,conversation_review_required:400,handoff_too_large:400}[error.code]||503;return res.status(status).json({error:status===503?'handoff_unavailable':error.code});}
 });
}
