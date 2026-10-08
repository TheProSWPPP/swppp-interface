import {isInteractiveAdmin} from './sdrReplyActionBacklog.js';
import {readOperationsSnapshot} from './sdrOperationsSnapshot.js';
export function registerSdrOperationsSnapshotRoutes(app,{pool,companyId,resolveVisibleMailboxes,read=readOperationsSnapshot}={}){
 app.get('/api/sdr/health/operations',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!req.sdrUser?.sub)return res.status(401).json({error:'unauthorized'});
  if(!isInteractiveAdmin(req.sdrUser))return res.status(403).json({error:'admin_required'});
  if(Object.keys(req.query||{}).length)return res.status(400).json({error:'unsupported_filter'});
  if(!companyId)return res.status(503).json({error:'operations_unavailable'});
  try{return res.json(await read(pool,{companyId,viewer:req.sdrUser,resolveVisibleMailboxes}));}
  catch(error){return res.status(error.code==='admin_required'?403:503).json({error:error.code==='admin_required'?'admin_required':'operations_unavailable'});}
 });
}
