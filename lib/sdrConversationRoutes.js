import {readContactConversation,readUnlinkedMessages,readMessageBody,readSharedAddressCandidates} from './sdrConversationHistory.js';

// Register after the shared SDR JWT middleware. Caller supplies the same mailbox
// visibility and token resolver as the existing inbox routes.
export function registerSdrConversationRoutes(app,{pool,resolveVisibleMailboxes,getGmailToken,isProjectVisible,isDealVisible,gmail,pipedrive}) {
  const auth=req=>Boolean(req.sdrUser?.sub);
  const visible=async req=>(await resolveVisibleMailboxes(req.sdrUser)).map(row=>String(row.email||row).toLowerCase());
  const sendError=(res,error)=>{
    const status=error.message==='mailbox_not_visible'||error.message==='project_not_visible'?403:
      error.message==='message_not_found'?404:/^(invalid_|person_required)/.test(error.message)?400:503;
    return res.status(status).json({error:status===503?'conversation_unavailable':error.message});
  };
  app.get('/api/sdr/conversations/coverage',async(req,res)=>{
    if(!auth(req)) return res.status(401).json({error:'Unauthorized'});
    try {
      const accounts=await visible(req);
      const {rows}=await pool.query(`SELECT provider,account_key,scope,status,cursor,pages,messages,error_category,checked_at
        FROM sdr_conversation_coverage WHERE (provider='gmail' AND account_key=ANY($1::text[]))
        OR (provider='pipedrive' AND $2::boolean) ORDER BY provider,account_key,scope`,[accounts,req.sdrUser.role==='admin']);
      return res.json({coverage:rows});
    } catch(error) {return sendError(res,error);}
  });
  app.get('/api/sdr/conversations/shared-address',async(req,res)=>{
    if(!auth(req)) return res.status(401).json({error:'Unauthorized'});
    try {
      const candidates=await readSharedAddressCandidates(pool,{address:req.query?.email});
      const visible=[];
      for(const candidate of candidates) {
        const leadIds=[];
        for(const id of candidate.leadIds) if(await isProjectVisible(req.sdrUser,id)) leadIds.push(id);
        if(leadIds.length) visible.push({personId:candidate.personId,leadIds});
      }
      return res.json({candidates:visible});
    } catch(error) {return sendError(res,error);}
  });
  app.get('/api/sdr/conversations/unlinked',async(req,res)=>{
    if(!auth(req)) return res.status(401).json({error:'Unauthorized'});
    try {
      const accounts=await visible(req);
      const data=await readUnlinkedMessages(pool,{visibleAccounts:accounts,limit:req.query?.limit,cursor:req.query?.cursor});
      for(const message of data.messages) {
        if(message.pipedrive_lead_id && !(await isProjectVisible(req.sdrUser,message.pipedrive_lead_id))) message.pipedrive_lead_id=null;
        if(message.pipedrive_deal_id && !(isDealVisible && await isDealVisible(req.sdrUser,message.pipedrive_deal_id))) message.pipedrive_deal_id=null;
      }
      return res.json(data);
    } catch(error) {return sendError(res,error);}
  });
  app.get('/api/sdr/conversations/messages/:provider/:account/:id/body',async(req,res)=>{
    if(!auth(req)) return res.status(401).json({error:'Unauthorized'});
    try {
      const accounts=await visible(req);
      const body=await readMessageBody(pool,{provider:req.params.provider,account:req.params.account,id:req.params.id,
        visibleAccounts:accounts,includePipedrive:req.sdrUser.role==='admin',getGmailToken,gmail,pipedrive});
      return res.json({message:body});
    } catch(error) {return sendError(res,error);}
  });
  app.get('/api/sdr/conversations/:personId',async(req,res)=>{
    if(!auth(req)) return res.status(401).json({error:'Unauthorized'});
    try {
      const projectId=req.query?.project ? String(req.query.project) : null;
      if(projectId && !(await isProjectVisible(req.sdrUser,projectId))) throw new Error('project_not_visible');
      const accounts=await visible(req);
      const data=await readContactConversation(pool,{personId:req.params.personId,visibleAccounts:accounts,
        includePipedrive:req.sdrUser.role==='admin',projectId,limit:req.query?.limit,cursor:req.query?.cursor,eventCursor:req.query?.eventCursor});
      const allowed=new Set();
      for(const leadId of data.projects) if(await isProjectVisible(req.sdrUser,leadId)) allowed.add(leadId);
      for(const message of data.messages) if(message.pipedrive_lead_id&&!allowed.has(message.pipedrive_lead_id)) {
        message.pipedrive_lead_id=null;message.pipedrive_deal_id=null;message.link_evidence=null;
      }
      for(const message of data.messages) if(message.pipedrive_deal_id && !(isDealVisible && await isDealVisible(req.sdrUser,message.pipedrive_deal_id))) message.pipedrive_deal_id=null;
      for(const event of data.events) {
        if(event.pipedrive_lead_id&&!allowed.has(event.pipedrive_lead_id)) {event.pipedrive_lead_id=null;event.pipedrive_deal_id=null;}
        if(event.pipedrive_deal_id && !(isDealVisible && await isDealVisible(req.sdrUser,event.pipedrive_deal_id))) event.pipedrive_deal_id=null;
      }
      data.projects=data.projects.filter(id=>allowed.has(id));
      return res.json(data);
    } catch(error) {return sendError(res,error);}
  });
}
