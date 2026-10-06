import {readRecentReplies,validateReplyRead} from './sdrOperations.js';
import {registerActivityFeedRoute} from './sdrActivityFeed.js';
export function registerSdrOperationsRoutes(app,{pool,resolveVisibleMailboxes,read=readRecentReplies}) {
 registerActivityFeedRoute(app,{pool,resolveVisibleMailboxes});
 app.get('/api/sdr/operations/replies',async(req,res)=>{
  if(!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
  try {
   const query=req.query||{};
   const allowed=new Set(['mailbox','asOf','visibilitySnapshot','cursor','limit']);
   if(Object.entries(query).some(([key,value])=>!allowed.has(key)||typeof value!=='string')) throw new Error('invalid_reply_query');
   if(req.originalUrl) {
    const params=new URL(req.originalUrl,'http://local').searchParams;
    if([...params.keys()].some(key=>!allowed.has(key)||params.getAll(key).length!==1)) throw new Error('invalid_reply_query');
   }
   const now=new Date();
   // Validate malformed input before resolving identity scope or touching the database.
   validateReplyRead({...query,now},{checkScope:false});
   const visibleMailboxes=await resolveVisibleMailboxes(req.sdrUser);
   const options={...query,...(query.mailbox?{mailbox:query.mailbox.toLowerCase()}:{}),visibleMailboxes,now};
   validateReplyRead(options);
   return res.json(await read(pool,options));
  } catch(error) {
   const status=error.message==='mailbox_not_visible'?403:error.message==='invalid_reply_query'?400:503;
   return res.status(status).json({error:status===503?'replies_unavailable':error.message});
  }
 });
}
