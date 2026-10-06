// Read-only event feed. Enrollment and queued drafts are not send receipts.
export async function readActivityFeed(pool,{visibleMailboxes=[],kind='all',now=new Date()}={}) {
 const mailboxes=[...new Set(visibleMailboxes.map(value=>value.toLowerCase()))];
 const result={checkedAt:now.toISOString(),from:new Date(+now-7*86400000).toISOString(),items:[],sources:{sends:null,replies:null}};
 if(!mailboxes.length)return result;
 const {rows}=await pool.query({query_timeout:4000,text:`WITH events AS (
  SELECT jsonb_build_array('sent',f.provider,f.provider_message_id)::text AS id,'sent' AS kind,
   f.occurred_at AS at,f.mailbox_email AS mailbox,f.prospect_email AS contact,
   CASE WHEN f.link_status='verified' THEN f.pipedrive_lead_id END AS project_id,
   NULL::text AS thread_id
  FROM sdr_reporting_messages f WHERE f.mailbox_email=ANY($1::text[]) AND f.direction='out'
   AND f.provider='apollo' AND f.provider_status='completed' AND f.campaign_id IS NOT NULL
   AND f.outreach_classification IN ('unknown','sales_outreach')
   AND f.occurred_at >= $2::timestamptz AND f.occurred_at < $3::timestamptz
  UNION ALL
  SELECT jsonb_build_array('reply',r.source,r.provider_message_id)::text,'reply',r.received_at,r.mailbox_email,f.prospect_email,
   CASE WHEN r.link_status='verified' THEN r.pipedrive_lead_id END,r.thread_id
  FROM sdr_reply_messages r JOIN sdr_reporting_messages f ON f.provider=r.source AND f.provider_message_id=r.source_message_id
   AND f.mailbox_email=r.mailbox_email AND f.direction='in'
  WHERE r.mailbox_email=ANY($1::text[]) AND r.source='gmail' AND r.reply_kind='human'
   AND r.received_at >= $2::timestamptz AND r.received_at < $3::timestamptz AND r.detected_at <= $3::timestamptz
 ), page AS (
  SELECT * FROM events WHERE $4='all' OR kind=$4 ORDER BY at DESC,id DESC LIMIT 20
 ) SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'occurredAt',p.at,
   'mailbox',p.mailbox,'contact',p.contact,'projectId',p.project_id,'projectTitle',l.lead_title,'threadId',p.thread_id)
   ORDER BY p.at DESC,p.id DESC) FROM page p LEFT JOIN sdr_lead_state l ON l.pipedrive_lead_id=p.project_id),'[]'::jsonb) AS items,
  (SELECT max(finished_at) FROM sdr_job_runs WHERE job='apollo_poll' AND scope='account' AND status IN ('complete','partial') AND finished_at<=$3::timestamptz) AS sends_sync,
  (SELECT CASE WHEN count(*)=cardinality($1::text[]) THEN min(latest) END FROM (
   SELECT scope,max(finished_at) AS latest FROM sdr_job_runs WHERE job='gmail_watch' AND scope=ANY($1::text[])
    AND status IN ('complete','partial') AND finished_at<=$3::timestamptz GROUP BY scope
  ) mailbox_sync) AS replies_sync`,values:[mailboxes,result.from,result.checkedAt,kind]});
 const row=rows[0];
 result.items=row.items;
 result.sources={sends:row.sends_sync?new Date(row.sends_sync).toISOString():null,replies:row.replies_sync?new Date(row.replies_sync).toISOString():null};
 return result;
}

export function registerActivityFeedRoute(app,{pool,resolveVisibleMailboxes,read=readActivityFeed}) {
 app.get('/api/sdr/operations/activity',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!req.sdrUser?.sub)return res.status(401).json({error:'Unauthorized'});
  const query=req.query||{},kind=query.kind??'all';
  const params=new URL(req.originalUrl||'/','http://local').searchParams;
  if(Object.keys(query).some(key=>key!=='kind')||!['all','sent','reply'].includes(kind)||[...params.keys()].some(key=>key!=='kind'||params.getAll(key).length!==1))return res.status(400).json({error:'invalid_activity_query'});
  try {
   const visibleMailboxes=await resolveVisibleMailboxes(req.sdrUser);
   return res.json(await read(pool,{visibleMailboxes,kind,now:new Date()}));
  }catch{return res.status(503).json({error:'activity_unavailable'});}
 });
}
