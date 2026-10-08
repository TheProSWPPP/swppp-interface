import {connectSnapshotRead,boundedSnapshotRead} from './sdrSnapshotReadBounds.js';
import {CRM_OBSERVATION_SCOPES} from './pipedriveObservationClient.js';
import {isInteractiveAdmin} from './sdrReplyActionBacklog.js';
const fail=code=>Object.assign(new Error(code),{code});
// Mirrors the existing 90-day verification evidence horizon without importing a writer.
const VERIFICATION_DAYS=90;
export async function readOperationsSnapshot(pool,{companyId,viewer,resolveVisibleMailboxes}={}){
 if(!isInteractiveAdmin(viewer))throw fail('admin_required');
 if(typeof companyId!=='string'||!companyId.trim())throw fail('operations_unavailable');
 const db=await connectSnapshotRead(pool);
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='5000ms'");
  if(!(await db.query("SELECT 1 FROM sdr_users WHERE id=$1 AND active AND role='admin'",[viewer.sub])).rowCount)throw fail('admin_required');
  if((await db.query("SELECT 1 FROM sdr_crm_scope_coverage WHERE company_id=$1 AND error_category='permission' LIMIT 1",[companyId])).rowCount)throw fail('operations_unavailable');
  const mailboxes=[...new Set((await boundedSnapshotRead(resolveVisibleMailboxes(viewer,db))).filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim().toLowerCase()))];
  const {rows}=await db.query(`WITH inventory AS MATERIALIZED (
   SELECT l.* FROM sdr_lead_state l WHERE l.crm_company_id=$1
    AND NOT EXISTS(SELECT 1 FROM sdr_lead_state other WHERE other.pipedrive_lead_id=l.pipedrive_lead_id AND other.crm_company_id IS DISTINCT FROM $1)
    AND NOT EXISTS(SELECT 1 FROM sdr_crm_snapshots s WHERE s.entity='lead' AND s.entity_id=l.pipedrive_lead_id AND (s.company_id<>$1 OR s.is_test))
  ), delivery_identity AS MATERIALIZED (
   SELECT l.pipedrive_lead_id FROM inventory l JOIN sdr_crm_snapshots s ON s.company_id=$1 AND s.entity='lead' AND s.entity_id=l.pipedrive_lead_id WHERE s.access_status='accessible' AND NOT s.is_test AND s.lifecycle IN ('active','archived')
  ), crm AS MATERIALIZED (
   SELECT s.entity_id FROM sdr_crm_snapshots s WHERE s.company_id=$1 AND s.entity='lead' AND s.lifecycle='active' AND s.access_status='accessible' AND NOT s.is_test
    AND NOT EXISTS(SELECT 1 FROM sdr_crm_snapshots other WHERE other.entity='lead' AND other.entity_id=s.entity_id AND (other.company_id<>$1 OR other.is_test))
    AND NOT EXISTS(SELECT 1 FROM sdr_lead_state l WHERE l.pipedrive_lead_id=s.entity_id AND l.crm_company_id IS DISTINCT FROM $1)
  ), projects AS MATERIALIZED (
   SELECT l.*,nullif(lower(btrim(l.person_email)),'') current_email FROM inventory l JOIN crm ON crm.entity_id=l.pipedrive_lead_id WHERE l.crm_status='active'
  ), contacts AS (
   SELECT CASE WHEN current_email IS NULL THEN 'missing' WHEN email_flag='email_bad' THEN 'email_bad'
    WHEN email_verified_at IS NULL OR nullif(btrim(email_verified_value),'') IS NULL
     OR lower(btrim(coalesce(email_verify_status,''))) NOT IN ('ok','valid','catch_all','catchall','catch-all','unknown','soft','invalid','disposable','spamtrap','abuse','do_not_mail','hard_fail') THEN 'unverified'
    WHEN lower(btrim(email_verified_value))<>current_email THEN 'address_changed'
    WHEN email_verified_at>transaction_timestamp() THEN 'future'
    WHEN email_verified_at<transaction_timestamp()-($3::int*INTERVAL '1 day') THEN 'stale'
    WHEN lower(btrim(email_verify_status)) IN ('ok','valid') THEN 'valid'
    WHEN lower(btrim(email_verify_status)) IN ('catch_all','catchall','catch-all','unknown','soft') THEN 'soft'
    ELSE 'hard_failure' END bucket FROM projects
  ), controls AS MATERIALIZED (SELECT * FROM sdr_outreach_controls WHERE company_id=$1 AND status='active'),
  enrollments AS MATERIALIZED (
   SELECT s.* FROM sdr_sends s JOIN delivery_identity p ON p.pipedrive_lead_id=s.pipedrive_lead_id
   JOIN sdr_drafts d ON d.id=s.draft_id AND d.pipedrive_lead_id=s.pipedrive_lead_id
   JOIN sdr_mailboxes m ON m.id=s.mailbox_id WHERE lower(btrim(m.email))=ANY($2::text[])
  ), completed AS MATERIALIZED (
   SELECT f.* FROM sdr_message_facts f WHERE f.provider='apollo' AND f.direction='out' AND f.provider_status='completed' AND NOT f.is_test
    AND lower(btrim(f.mailbox_email))=ANY($2::text[]) AND f.occurred_at>=transaction_timestamp()-INTERVAL '7 days' AND f.occurred_at<=transaction_timestamp()
    AND (f.pipedrive_lead_id IS NULL OR f.link_status='verified' AND EXISTS(SELECT 1 FROM delivery_identity p WHERE p.pipedrive_lead_id=f.pipedrive_lead_id))
  ) SELECT
   transaction_timestamp() AS checked_at,
   (SELECT count(*)::int FROM inventory) inventory_total,
   (SELECT coalesce(jsonb_agg(g ORDER BY status),'[]') FROM (SELECT CASE WHEN outreach_status IN ('clear','contacted_recent','contacted_stale','sequenced') THEN outreach_status ELSE 'unknown' END status,count(*)::int count FROM inventory GROUP BY 1) g) inventory_groups,
   (SELECT count(*)::int FROM crm) crm_total,(SELECT count(*)::int FROM projects) project_total,
   (SELECT coalesce(jsonb_object_agg(bucket,n),'{}') FROM (SELECT bucket,count(*)::int n FROM contacts GROUP BY bucket) c) contact_buckets,
   (SELECT coalesce(jsonb_object_agg(scope_kind,n),'{}') FROM (SELECT scope_kind,count(*)::int n FROM controls GROUP BY scope_kind) c) controls,
   (SELECT count(*)::int FROM projects p WHERE EXISTS(SELECT 1 FROM controls c WHERE (c.channel IS NULL OR c.channel='email') AND (c.lead_id IS NULL OR c.lead_id=p.pipedrive_lead_id)
     AND (c.scope_kind='lead' AND c.scope_id=p.pipedrive_lead_id OR c.scope_kind='recipient' AND lower(btrim(c.scope_id))=p.current_email))) held_projects,
   (SELECT count(*)::int FROM projects p WHERE EXISTS(SELECT 1 FROM controls c WHERE c.scope_kind='channel' AND c.scope_id='email' AND (c.channel IS NULL OR c.channel='email') AND (c.lead_id IS NULL OR c.lead_id=p.pipedrive_lead_id))) channel_held_projects,
   (SELECT count(*)::int FROM projects p WHERE EXISTS(SELECT 1 FROM sdr_drafts d WHERE d.pipedrive_lead_id=p.pipedrive_lead_id AND d.status IN ('pending','approved','edited'))) drafted_projects,
   (SELECT count(*)::int FROM projects p WHERE EXISTS(SELECT 1 FROM sdr_reply_messages m WHERE m.pipedrive_lead_id=p.pipedrive_lead_id AND m.link_status='verified' AND m.reply_kind='human' AND lower(btrim(m.mailbox_email))=ANY($2::text[])
    AND NOT EXISTS(SELECT 1 FROM sdr_message_facts f WHERE f.provider=m.source AND f.provider_message_id=m.source_message_id AND f.direction='in' AND lower(btrim(f.mailbox_email))=lower(btrim(m.mailbox_email)) AND (f.is_test OR f.pipedrive_lead_id IS NOT NULL AND (f.pipedrive_lead_id<>m.pipedrive_lead_id OR f.link_status<>'verified'))))) replied_projects,
   (SELECT count(*)::int FROM enrollments) enrollment_rows,(SELECT count(DISTINCT pipedrive_lead_id)::int FROM enrollments) enrollment_projects,
   (SELECT count(*)::int FROM projects p WHERE EXISTS(SELECT 1 FROM enrollments e WHERE e.pipedrive_lead_id=p.pipedrive_lead_id)) active_enrollment_projects,
   (SELECT coalesce(jsonb_agg(g ORDER BY status),'[]') FROM (SELECT CASE WHEN status IN ('enrolled','sent','bounced','replied','unsubscribed','failed','switched') THEN status ELSE 'other' END status,count(*)::int count FROM enrollments GROUP BY 1) g) enrollment_groups,
   (SELECT count(*)::int FROM completed) completed_total,
   (SELECT count(*)::int FROM completed WHERE pipedrive_lead_id IS NOT NULL AND link_status='verified') linked_completed,
   (SELECT count(*)::int FROM completed WHERE pipedrive_lead_id IS NULL) unlinked_completed,
   (SELECT count(*)::int FROM completed WHERE outreach_classification='sales_outreach' AND nullif(btrim(classification_evidence),'') IS NOT NULL) sales_completed,
   (SELECT count(*)::int FROM completed WHERE outreach_classification IN ('warmup','automatic','unrelated') AND nullif(btrim(classification_evidence),'') IS NOT NULL) other_completed
  `,[companyId,mailboxes,VERIFICATION_DAYS]);
  const r=rows[0];
  const crmScopes=(await db.query('SELECT scope,status,checked_at AS "checkedAt",completed_through AS "completedThrough",error_category AS "errorCategory" FROM sdr_crm_scope_coverage WHERE company_id=$1 ORDER BY scope',[companyId])).rows.filter(r=>CRM_OBSERVATION_SCOPES.includes(r.scope)).map(r=>({...r,errorCategory:r.errorCategory?['permission','network','rate_limit','provider_error','authentication','unavailable','timeout'].includes(r.errorCategory)?r.errorCategory:'collection_error':null}));
  const jobRows=(await db.query(`SELECT expected.family,expected.job,expected.scope,coalesce(latest.status,'missing') status,latest.started_at AS "lastAttemptAt",latest.finished_at AS "lastFinishedAt",last_complete.finished_at AS "lastCompleteAt"
   FROM (SELECT 'history' family,job,scope FROM unnest($1::text[]) scope CROSS JOIN unnest(ARRAY['apollo_messages','gmail_messages']) job
     UNION ALL SELECT 'runtime','gmail_watch',scope FROM unnest($1::text[]) scope
     UNION ALL SELECT 'runtime',job,'account' FROM unnest(ARRAY['apollo_poll','enrollment']) job) expected
   LEFT JOIN LATERAL(SELECT * FROM sdr_job_runs r WHERE r.job=expected.job AND lower(btrim(r.scope))=expected.scope ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true
   LEFT JOIN LATERAL(SELECT finished_at FROM sdr_job_runs r WHERE r.job=expected.job AND lower(btrim(r.scope))=expected.scope AND r.status='complete' AND r.finished_at<=transaction_timestamp()
     AND (r.job<>'apollo_messages' OR r.counts->>'all_sequences'='true') ORDER BY finished_at DESC,id DESC LIMIT 1) last_complete ON true ORDER BY expected.scope,expected.job`,[mailboxes])).rows;
  const result={checkedAt:r.checked_at,inventory:{total:r.inventory_total,byOutreachStatus:r.inventory_groups},crm:{activeSnapshots:r.crm_total},contacts:{denominator:r.project_total,verificationDays:VERIFICATION_DAYS,buckets:{missing:0,email_bad:0,unverified:0,address_changed:0,future:0,stale:0,valid:0,soft:0,hard_failure:0,...r.contact_buckets}},eligibleSupply:null,
   projectContext:{leadOrRecipientHold:r.held_projects,emailChannelHold:r.channel_held_projects,storedHumanReply:r.replied_projects,openDraft:r.drafted_projects,localEnrollment:r.active_enrollment_projects},controls:{lead:0,recipient:0,draft:0,service:0,channel:0,...r.controls},
   enrollments:{rows:r.enrollment_rows,projects:r.enrollment_projects,byStatus:r.enrollment_groups},completedMessages:{windowDays:7,total:r.completed_total,verifiedProjectLinked:r.linked_completed,unlinkedObservations:r.unlinked_completed,sales:r.sales_completed,otherClassification:r.other_completed,unknownClassification:r.completed_total-r.sales_completed-r.other_completed},
   coverage:{partial:true,visibleMailboxes:mailboxes.length,crmScopes,jobs:jobRows.filter(j=>j.family==='history').map(({family,...j})=>j),runtimeJobs:jobRows.filter(j=>j.family==='runtime').map(({family,...j})=>j),historicalRefusals:'unavailable',enrollmentMessageReconciliation:'unavailable'}};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
