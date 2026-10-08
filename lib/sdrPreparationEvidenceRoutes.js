import {isInteractiveAdmin} from './sdrReplyActionBacklog.js';
import {readOrderCandidates,readDeliveryEvidence} from './sdrPreparationEvidence.js';
export function registerSdrPreparationEvidenceRoutes(app,{pool,companyId,resolveVisibleMailboxes,readOrders=readOrderCandidates,readDelivery=readDeliveryEvidence}={}){
 for(const [path,kind] of [['/api/sdr/crm/leads/:leadId/order-candidates','orders'],['/api/sdr/health/delivery-evidence','delivery']])app.get(path,async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!req.sdrUser?.sub)return res.status(401).json({error:'unauthorized'});
  if(!isInteractiveAdmin(req.sdrUser))return res.status(403).json({error:'admin_required'});
  const allowed=kind==='orders'?new Set(['q','offset']):new Set(),query=req.query||{};
  let invalid=Object.entries(query).some(([k,v])=>!allowed.has(k)||typeof v!=='string');
  if(req.originalUrl){const params=new URL(req.originalUrl,'http://local').searchParams;invalid ||= [...params.keys()].some(k=>!allowed.has(k)||params.getAll(k).length!==1);}
  if(invalid||query.q?.length>100||query.offset!==undefined&&(!/^(0|[1-9]\d*)$/.test(query.offset)||Number(query.offset)>10000))return res.status(400).json({error:'invalid_query'});
  try{return res.json(await (kind==='orders'?readOrders(pool,{companyId,viewer:req.sdrUser,leadId:req.params?.leadId,query:query.q||'',offset:Number(query.offset||0)}):readDelivery(pool,{companyId,viewer:req.sdrUser,resolveVisibleMailboxes})));}
  catch(error){const code=['admin_required','lead_unavailable','invalid_query'].includes(error.code)?error.code:'evidence_unavailable';return res.status({admin_required:403,lead_unavailable:404,invalid_query:400}[code]||503).json({error:code});}
 });
}
