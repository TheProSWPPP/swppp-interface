import {enrollmentRetryEnabled} from './sdrEnrollmentRetry.js';
export function registerSdrWorkDraftsRoutes(app,{pool}) {
 app.get('/api/sdr/operations/drafts',async(req,res)=>{
  if(!req.sdrUser?.sub) return res.status(401).json({error:'Unauthorized'});
  const view=req.query?.view;
  if(!['open','failed'].includes(view)||Object.keys(req.query).some(key=>key!=='view')) return res.status(400).json({error:'Invalid draft view'});
  const params=[],scope=req.sdrUser.role==='admin'?'TRUE':(params.push(req.sdrUser.sub),'d.assigned_user_id=$1');
  const filter=view==='failed'?"d.status='failed' AND d.updated_at>=now()-interval '7 days'":"d.status IN ('pending','approved','edited')";
  try {
   const retry=enrollmentRetryEnabled();
   const {rows}=await pool.query(`SELECT d.*,${retry?'ea.status AS enrollment_status,ea.category AS enrollment_category,ea.attempt_count AS enrollment_attempts,ea.first_attempt_at AS enrollment_first_attempt_at,ea.next_retry_at AS enrollment_next_retry_at,':''}ls.outreach_status,ls.last_outgoing_mail_time,ls.person_name AS lead_person_name,CASE WHEN ls.last_outgoing_mail_time IS NULL THEN NULL ELSE EXTRACT(DAY FROM (NOW()-ls.last_outgoing_mail_time))::int END AS days_since_outgoing FROM sdr_drafts d LEFT JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=d.pipedrive_lead_id ${retry?"LEFT JOIN sdr_enrollment_attempts ea ON ea.draft_id=d.id":""} WHERE ${scope} AND ${filter} ORDER BY d.updated_at DESC LIMIT 251`,params);
   return res.json({drafts:rows.slice(0,250),hasMore:rows.length>250,view});
  }catch{return res.status(503).json({error:'Work drafts temporarily unavailable'});}
 });
}
