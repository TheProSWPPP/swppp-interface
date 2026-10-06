// Aggregate read only; the legacy project queue also transitions New requests.
export function registerWorkspaceOverviewRoutes(app,{pool}) {
  app.get('/api/sdr/workspace/summary',async(req,res)=>{
    if(!req.sdrUser?.sub)return res.status(401).json({error:'Unauthorized'});
    if(req.sdrUser.role!=='admin')return res.status(403).json({error:'Administrator access required'});
    if(Object.keys(req.query||{}).length)return res.status(400).json({error:'unsupported_filter'});
    try {
      const {rows}=await pool.query("SELECT data->>'status' AS status, count(*)::int AS count FROM projects WHERE archived = FALSE GROUP BY data->>'status'");
      const documents={total:0,new:0,pending:0,processing:0,complete:0,ready:0,other:0};
      for(const row of rows){
        const count=Number(row.count);documents.total+=count;
        const key=row.status==='New'?'new':row.status==='Pending Review'?'pending':['Processing','Manual Processing','Approved for Generation'].includes(row.status)?'processing':row.status==='Complete'?'complete':row.status==='Ready'?'ready':'other';
        documents[key]+=count;
      }
      return res.json({documents,collectedAt:new Date().toISOString()});
    }catch{return res.status(503).json({error:'workspace_summary_unavailable'});}
  });
}
