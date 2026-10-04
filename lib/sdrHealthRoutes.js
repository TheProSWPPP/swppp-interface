import {readJobHealth} from './sdrJobRuns.js';
export function registerSdrHealthRoutes(app,{pool,resolveVisibleMailboxes,health=readJobHealth}) {
 app.get('/api/sdr/health',async(req,res)=>{
  if(!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
  if(Object.keys(req.query||{}).length) return res.status(400).json({error:'unsupported_filter'});
  try {
   const visibleMailboxes=await resolveVisibleMailboxes(req.sdrUser);
   return res.json(await health(pool,{visibleMailboxes,admin:req.sdrUser.role==='admin'}));
  } catch {return res.status(503).json({error:'health_unavailable'});}
 });
}
