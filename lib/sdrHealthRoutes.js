import {readJobHealth} from './sdrJobRuns.js';
export function registerSdrHealthRoutes(app,{pool,resolveVisibleMailboxes,health=readJobHealth,inboxReads=null}) {
 app.get('/api/sdr/health',async(req,res)=>{
  if(!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
  if(Object.keys(req.query||{}).length) return res.status(400).json({error:'unsupported_filter'});
  try {
   const visibleMailboxes=await resolveVisibleMailboxes(req.sdrUser);
   const result=await health(pool,{visibleMailboxes,admin:req.sdrUser.role==='admin'});
   // Live inbox reads (the Inbox page) share this signal so System checks never says "Up to date" while the Inbox can't read.
   return res.json(typeof inboxReads==='function'?{...result,inboxReads:inboxReads(visibleMailboxes)}:result);
  } catch {return res.status(503).json({error:'health_unavailable'});}
 });
}
