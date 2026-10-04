import {readOrderReconciliation} from './sdrOrderReconciliation.js';

export function registerSdrOrderReconciliationRoutes(app,{pool,read=readOrderReconciliation,readCards,readDeals}) {
 app.get('/api/sdr/order-reconciliation',async(req,res)=>{
  if(!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
  if(req.sdrUser.role!=='admin') return res.status(403).json({error:'Admin only'});
  const query=req.query||{};
  const allowed=new Set(['limit','offset']);
  if(Object.entries(query).some(([key,value])=>!allowed.has(key)||typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value)))
   return res.status(400).json({error:'Invalid pagination'});
  if(req.originalUrl){
   const params=new URL(req.originalUrl,'http://local').searchParams;
   if([...params.keys()].some(key=>!allowed.has(key)||params.getAll(key).length!==1))
    return res.status(400).json({error:'Invalid pagination'});
  }
  const limit=query.limit===undefined?50:Number(query.limit),offset=query.offset===undefined?0:Number(query.offset);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)
   return res.status(400).json({error:'Invalid pagination'});
  try{return res.json(await read(pool,{limit,offset,...(readCards?{readCards}:{}),...(readDeals?{readDeals}:{})}));}
  catch{return res.status(503).json({error:'Order reconciliation temporarily unavailable'});}
 });
}
