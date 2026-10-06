import { receivePipedriveEvent,readLeadCrmObservations,readLeadCrmFollowups,readCrmFollowups,readCrmSyncHealth } from './sdrCrmObservations.js';

// Register only when the observation feature is enabled by the host application.
// Authorization and lead visibility are injected by the host, which owns SDR sessions.
export function registerSdrCrmObservationRoutes(app,{pool,companyId,authorizeWebhook,canViewLead,listUsers}={}) {
  if(!app||!pool||!companyId||typeof canViewLead!=='function')throw new Error('crm_route_dependencies_required');
  const admin=(req,res)=>{if(req.sdrUser?.role!=='admin'){res.status(403).json({error:'Admin only'});return false;}return true;};
  const leadRead=read=>async(req,res)=>{
    if(!admin(req,res))return;
    try {
      if(!await canViewLead(req,req.params.leadId))return res.status(404).json({error:'Lead unavailable'});
      const result=await read(pool,{companyId,leadId:req.params.leadId,limit:req.query.limit,activityType:req.query.activityType});
      return res.json({...result,provenanceVersion:2});
    }catch{return res.status(503).json({error:'CRM observations unavailable'});}
  };
  app.get('/api/sdr/crm/leads/:leadId/observations',leadRead(readLeadCrmObservations));
  app.get('/api/sdr/crm/leads/:leadId/followups',leadRead(readLeadCrmFollowups));
  app.get('/api/sdr/crm/followups',async(req,res)=>{
    if(!admin(req,res))return;
    try{return res.json(await readCrmFollowups(pool,{companyId,ownerId:req.query.ownerId,lifecycle:req.query.lifecycle,activityType:req.query.activityType,limit:req.query.limit,cursor:req.query.cursor}));}
    catch{return res.status(503).json({error:'CRM observations unavailable'});}
  });
  if(typeof listUsers==='function')app.get('/api/sdr/crm/users',async(req,res)=>{
    if(!admin(req,res))return;
    try{return res.json({users:await listUsers(),checkedAt:new Date().toISOString()});}
    catch{return res.status(503).json({error:'CRM user directory unavailable'});}
  });
  app.get('/api/sdr/crm/health',async(req,res)=>{
    if(!admin(req,res))return;
    try{return res.json(await readCrmSyncHealth(pool,{companyId}));}catch{return res.status(503).json({error:'CRM observations unavailable'});}
  });
  if(typeof authorizeWebhook==='function')app.post('/api/sdr/crm/webhooks/pipedrive',async(req,res)=>{
    try {
      if(!await authorizeWebhook(req))return res.status(401).json({error:'Unauthorized'});
      const result=await receivePipedriveEvent(pool,req.body,{companyId});
      return res.status(202).json({accepted:true,duplicate:!result.inserted});
    }catch(error){
      if(error?.message==='invalid_pipedrive_event'||error?.message==='invalid_event_timestamp')return res.status(400).json({error:'Invalid Pipedrive event'});
      return res.status(503).json({error:'CRM inbox unavailable'});
    }
  });
}
