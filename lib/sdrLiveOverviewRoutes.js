import {readLiveOverview} from './sdrLiveOverview.js';
export function registerSdrLiveOverviewRoutes(app,{pool,read=readLiveOverview}) {
 app.get('/api/sdr/live-overview',async(req,res)=>{
  if(!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
  // Company-wide operational counts are administrator-only, like SDR settings.
  if(req.sdrUser.role!=='admin') return res.status(403).json({error:'Admin only'});
  if(Object.keys(req.query||{}).length) return res.status(400).json({error:'Unsupported overview filter'});
  try{return res.json(await read(pool));}catch{return res.status(503).json({error:'Live overview temporarily unavailable'});}
 });
}
