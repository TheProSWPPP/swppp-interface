import {readOrderReconciliation} from './sdrOrderReconciliation.js';
import {isInteractiveAdmin} from './sdrReplyActionBacklog.js';
import {connectSnapshotRead,boundedSnapshotRead} from './sdrSnapshotReadBounds.js';

export function registerSdrOrderReconciliationRoutes(app,{pool,companyId,read=readOrderReconciliation,readCards,readDeals}) {
 app.get('/api/sdr/order-reconciliation',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
  if(!isInteractiveAdmin(req.sdrUser)) return res.status(403).json({error:'Admin only'});
  // projects has no tenant column: only this dedicated deployment may read it.
  if(companyId!=='13105180') return res.status(503).json({error:'Order reconciliation temporarily unavailable'});
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
  let db;
  try{
   db=await connectSnapshotRead(pool);
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await db.query("SET LOCAL statement_timeout='5000ms'");
   if(!(await db.query("SELECT 1 FROM sdr_users WHERE id=$1 AND active AND role='admin'",[req.sdrUser.sub])).rowCount){
    await db.query('ROLLBACK');
    return res.status(403).json({error:'Admin only'});
   }
   // Bound optional observation hooks separately so the reader retains a valid
   // source when the other is unavailable. No provider hooks are wired in production.
   const bounded=hook=>()=>boundedSnapshotRead(Promise.resolve().then(hook));
   const result=await read(db,{limit,offset,...(readCards?{readCards:bounded(readCards)}:{}),...(readDeals?{readDeals:bounded(readDeals)}:{})});
   await db.query('COMMIT');
   return res.json(result);
  }catch{
   if(db)await db.query('ROLLBACK').catch(()=>{});
   return res.status(503).json({error:'Order reconciliation temporarily unavailable'});
  }finally{db?.release();}
 });
}
