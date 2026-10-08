const fail=code=>Object.assign(new Error(code),{code});
const kinds=['stop_sequence','forward','create_task','create_note','match_lead','clear_sequence_flag'];
const reasons=new Set(['lead_unlinked','lead_ambiguous','routing_unverified','sequence_context_unverified','classification_unverified','dependencies_pending','later_outbound_unverified','reply_context_unavailable','project_context_unverified','authentication','configuration','completion_uncertain','attempts_exhausted','rate_limit','definite_failure']);
export const isInteractiveAdmin=viewer=>!viewer?.machine&&viewer?.role==='admin'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(viewer?.sub||'');

// Technical action inventory only. No message/customer identity or writer adapters.
export async function readReplyActionBacklog(pool,{companyId,viewer,resolveVisibleMailboxes}={}){
 if(!isInteractiveAdmin(viewer))throw fail('admin_required');
 if(typeof companyId!=='string'||!companyId.trim())throw fail('backlog_unavailable');
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='5000ms'");
  const admin=await db.query("SELECT id,role FROM sdr_users WHERE id=$1 AND active AND role='admin'",[viewer.sub]);
  if(!admin.rowCount)throw fail('admin_required');
  if((await db.query("SELECT 1 FROM sdr_crm_scope_coverage WHERE company_id=$1 AND error_category='permission' LIMIT 1",[companyId])).rowCount)throw fail('backlog_unavailable');
  const mailboxes=[...new Set((await resolveVisibleMailboxes(viewer)).filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim().toLowerCase()))];
  // One materialized population supplies totals, groups and the bounded oldest page.
  // Linked rows with missing, conflicting, foreign or test project scope are withheld.
  const {rows}=await db.query(`WITH scoped AS MATERIALIZED (
   SELECT a.id,a.kind,a.status,a.created_at,a.updated_at,a.retry_at,a.attempts,a.requires_review,a.safe_error,
    CASE WHEN m.pipedrive_lead_id IS NULL THEN 'unverified' ELSE 'verified' END project_status
   FROM sdr_reply_actions a JOIN sdr_reply_messages m ON m.provider_message_id=a.provider_message_id
    AND lower(btrim(m.mailbox_email))=lower(btrim(a.mailbox_email))
   WHERE lower(btrim(a.mailbox_email))=ANY($2::text[]) AND a.status IN ('pending','running','failed')
    AND NOT EXISTS(SELECT 1 FROM sdr_message_facts f WHERE f.provider=m.source AND f.provider_message_id=m.source_message_id AND f.direction='in' AND lower(btrim(f.mailbox_email))=lower(btrim(m.mailbox_email)) AND (f.is_test OR f.pipedrive_lead_id IS NOT NULL AND (f.pipedrive_lead_id IS DISTINCT FROM m.pipedrive_lead_id OR f.link_status<>'verified')))
    AND (NULLIF(a.payload->>'leadId','') IS NULL OR a.payload->>'leadId'=m.pipedrive_lead_id)
    AND (m.pipedrive_lead_id IS NULL OR (
     m.link_status='verified'
     AND EXISTS(SELECT 1 FROM sdr_lead_state l WHERE l.pipedrive_lead_id=m.pipedrive_lead_id AND l.crm_company_id=$1)
     AND NOT EXISTS(SELECT 1 FROM sdr_lead_state l WHERE l.pipedrive_lead_id=m.pipedrive_lead_id AND l.crm_company_id IS DISTINCT FROM $1)
     AND EXISTS(SELECT 1 FROM sdr_crm_snapshots s WHERE s.entity='lead' AND s.entity_id=m.pipedrive_lead_id AND s.company_id=$1 AND s.lifecycle='active' AND s.access_status='accessible' AND NOT s.is_test)
     AND NOT EXISTS(SELECT 1 FROM sdr_crm_snapshots s WHERE s.entity='lead' AND s.entity_id=m.pipedrive_lead_id AND (s.company_id<>$1 OR s.is_test))
    ))
   ) SELECT count(*)::int total,min(created_at) oldest_created_at,
     count(*) FILTER(WHERE status='failed')::int failed,
     count(*) FILTER(WHERE requires_review)::int requires_review,
     count(*) FILTER(WHERE project_status='unverified')::int unverified,
     (SELECT coalesce(jsonb_agg(g ORDER BY kind),'[]'::jsonb) FROM (SELECT kind,count(*)::int count FROM scoped GROUP BY kind) g) groups,
     (SELECT coalesce(jsonb_agg(i ORDER BY created_at,id),'[]'::jsonb) FROM (SELECT * FROM scoped ORDER BY created_at,id LIMIT 50) i) items
    FROM scoped`,[companyId,mailboxes]);
  const r=rows[0];
  const result={state:'available',coverage:'partial',checkedAt:new Date().toISOString(),total:r.total,failed:r.failed,requiresReview:r.requires_review,unverified:r.unverified,oldestCreatedAt:r.oldest_created_at,limit:50,
   groups:r.groups.map(g=>({kind:kinds.includes(g.kind)?g.kind:'other',count:g.count})),
   items:r.items.map(i=>({id:i.id,kind:kinds.includes(i.kind)?i.kind:'other',status:i.status,createdAt:i.created_at,updatedAt:i.updated_at,retryAt:i.retry_at,attempts:i.attempts,requiresReview:i.requires_review,reason:i.safe_error?(reasons.has(i.safe_error)?i.safe_error:'unclassified'):null,projectStatus:i.project_status}))};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
