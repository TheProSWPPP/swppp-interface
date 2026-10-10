import {readFollowupProjectContext} from './sdrFollowupProjectContext.js';
import {projectSalesOpportunity,prepareProposal} from './sdrSalesLoop.js';
import {readAuthorizedSalesSource} from './sdrSalesLoopSources.js';
import {readSalesLoopObservations} from './sdrSalesLoopObservations.js';

const errors={session_required:403,lead_unavailable:404,source_unavailable:404,source_changed:409,context_changed:409,publication_unresolved:409,invalid_preparation:400,invalid_proposal:502};
const allowedSource={crm_note:['kind','id'],reviewed_crm_excerpt:['kind','id','text','reviewed'],gmail_message:['kind','provider','account','id','threadId'],pipedrive_message:['kind','provider','account','id','threadId']};
const validRef=ref=>ref&&typeof ref==='object'&&!Array.isArray(ref)&&allowedSource[ref.kind]&&Object.keys(ref).every(key=>allowedSource[ref.kind].includes(key))&&typeof ref.id==='string'&&ref.id.length>0&&ref.id.length<=255&&
 (ref.kind!=='reviewed_crm_excerpt'||ref.reviewed===true&&typeof ref.text==='string'&&ref.text.length<=2000)&&
 (!ref.kind.endsWith('_message')||typeof ref.account==='string'&&typeof ref.threadId==='string'&&ref.threadId.length>0&&ref.provider===(ref.kind==='gmail_message'?'gmail':'pipedrive'));

export function registerSdrSalesLoopRoutes(app,{pool,companyId,readContext=readFollowupProjectContext,readObservations=readSalesLoopObservations,prepare=prepareProposal,readSource,generate,resolveVisibleMailboxes,getGmailToken,enabled=false}={}){
 if(!pool||!companyId)throw new Error('sales_loop_dependencies_required');
 const session=req=>!req.sdrUser?.machine&&['admin','sdr'].includes(req.sdrUser?.role)&&req.sdrUser?.sub;
 app.get('/api/sdr/sales-loop/:leadId',async(req,res)=>{
  res.set?.('Cache-Control','no-store');
  if(!session(req))return res.status(403).json({error:'session_required'});
  if(Object.keys(req.query||{}).length)return res.status(400).json({error:'invalid_preparation'});
  try{
   const identity={companyId,leadId:req.params.leadId,viewer:req.sdrUser};
   const context=await readContext(pool,identity);
   const observations=await readObservations(pool,{...identity,context,resolveVisibleMailboxes});
   return res.json({...projectSalesOpportunity({companyId,context,publication:observations.publication,outcomes:observations.outcomes}),preparation:{status:enabled?'available':'unavailable'}});
  }
  catch(error){const status=errors[error.code]||503;return res.status(status).json({error:status===503?'sales_loop_unavailable':error.code});}
 });
 app.post('/api/sdr/sales-loop/:leadId/prepare',async(req,res)=>{
  res.set?.('Cache-Control','no-store');
  if(!session(req))return res.status(403).json({error:'session_required'});
  if(!enabled)return res.status(503).json({error:'preparation_unavailable'});
  const body=req.body;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['sourceRef','editorRequestVersion'].includes(key))||!validRef(body.sourceRef)||!Number.isSafeInteger(body.editorRequestVersion)||body.editorRequestVersion<0)return res.status(400).json({error:'invalid_preparation'});
  if(prepare===prepareProposal&&typeof generate!=='function')return res.status(503).json({error:'preparation_unavailable'});
  const sourceReader=readSource|| (input=>readAuthorizedSalesSource(pool,{...input,resolveVisibleMailboxes,getGmailToken}));
  try{return res.json(await prepare({pool,companyId,leadId:req.params.leadId,viewer:req.sdrUser,sourceRef:body.sourceRef,editorRequestVersion:body.editorRequestVersion,readSource:sourceReader,generate}));}
  catch(error){const status=errors[error.code]||503;return res.status(status).json({error:status===503?'preparation_unavailable':error.code});}
 });
}
