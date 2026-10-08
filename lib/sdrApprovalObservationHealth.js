import {connectSnapshotRead} from './sdrSnapshotReadBounds.js';
export function registerApprovalObservationHealth(app,{pool,companyId,stats}){
 app.get('/api/sdr/health/approval-observations',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!req.sdrUser?.sub)return res.status(401).json({error:'unauthorized'});
  if(req.sdrUser.role!=='admin'||req.sdrUser.machine)return res.status(403).json({error:'admin_required'});
  if(Object.keys(req.query||{}).length)return res.status(400).json({error:'unsupported_filter'});
  if(companyId!=='13105180')return res.status(503).json({error:'observations_unavailable'});
  let db;
  try{
   db=await connectSnapshotRead(pool);await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='2000ms'");
   const user=await db.query("SELECT 1 FROM sdr_users WHERE id=$1 AND active AND role='admin'",[req.sdrUser.sub]);await db.query('COMMIT');
   if(!user.rowCount)return res.status(403).json({error:'admin_required'});
   return res.json({runtime:stats(),coverage:{partial:true,since:'process_boot',outcomes:'http_responses_only',upstreamAuth:'not_observed',retention:'preserved_unmanaged'}});
  }catch{await db?.query('ROLLBACK').catch(()=>{});return res.status(503).json({error:'observations_unavailable'});}
  finally{db?.release();}
 });
}
