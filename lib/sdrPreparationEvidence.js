import {connectSnapshotRead,boundedSnapshotRead} from './sdrSnapshotReadBounds.js';
import {isInteractiveAdmin} from './sdrReplyActionBacklog.js';
const fail=code=>Object.assign(new Error(code),{code});
const plain=value=>typeof value==='string'?value.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,300):null;
const scalar=value=>{const v=value&&typeof value==='object'?value.id??value.value:value;return ['string','number'].includes(typeof v)?String(v):null;};
const normalize=value=>typeof value==='string'?value.trim().toLowerCase():'';
// This app's projects table has no tenant column. The exact existing company
// configuration is the dedicated-deployment binding; never generalize this read.
async function readAdmin(pool,{companyId,viewer},work){
 if(!isInteractiveAdmin(viewer))throw fail('admin_required');
 if(companyId!=='13105180')throw fail('evidence_unavailable');
 const db=await connectSnapshotRead(pool);
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='5000ms'");
  if(!(await db.query("SELECT 1 FROM sdr_users WHERE id=$1 AND active AND role='admin'",[viewer.sub])).rowCount)throw fail('admin_required');
  if((await db.query("SELECT 1 FROM sdr_crm_scope_coverage WHERE company_id=$1 AND error_category='permission' LIMIT 1",[companyId])).rowCount)throw fail('evidence_unavailable');
  const result=await work(db);await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
const identitySql=`SELECT s.entity_id,s.data FROM sdr_crm_snapshots s WHERE s.company_id=$1 AND s.entity='lead' AND s.access_status='accessible' AND NOT s.is_test
 AND EXISTS(SELECT 1 FROM sdr_lead_state l WHERE l.pipedrive_lead_id=s.entity_id AND l.crm_company_id=$1)
 AND NOT EXISTS(SELECT 1 FROM sdr_lead_state l WHERE l.pipedrive_lead_id=s.entity_id AND l.crm_company_id IS DISTINCT FROM $1)
 AND NOT EXISTS(SELECT 1 FROM sdr_crm_snapshots other WHERE other.entity='lead' AND other.entity_id=s.entity_id AND (other.company_id<>$1 OR other.is_test))`;
export function safeTrelloReference(value){
 try{const u=new URL(value);const match=u.pathname.match(/^\/c\/([A-Za-z0-9]{8}|[a-fA-F0-9]{24})(?:\/[^/]*)?\/?$/);if(u.protocol==='https:'&&['trello.com','www.trello.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&match)return `https://trello.com/c/${match[1]}`;}catch{}
 return null;
}
export async function readOrderCandidates(pool,{companyId,viewer,leadId,query='',offset=0}={}){
 if(typeof leadId!=='string'||!leadId||leadId.length>200||typeof query!=='string'||query.length>100||!Number.isSafeInteger(offset)||offset<0||offset>10000)throw fail('invalid_query');
 return readAdmin(pool,{companyId,viewer},async db=>{
  const lead=(await db.query(`${identitySql} AND s.lifecycle='active' AND s.entity_id=$2`,[companyId,leadId])).rows[0];
  if(!lead)throw fail('lead_unavailable');
  const personId=scalar(lead.data?.person_id),orgId=scalar(lead.data?.organization_id??lead.data?.org_id);
  const related=(await db.query("SELECT entity,data FROM sdr_crm_snapshots WHERE company_id=$1 AND ((entity='person' AND entity_id=$2) OR (entity='organization' AND entity_id=$3)) AND lifecycle='active' AND access_status='accessible' AND NOT is_test",[companyId,personId,orgId])).rows;
  const person=related.find(r=>r.entity==='person')?.data,organization=related.find(r=>r.entity==='organization')?.data;
  const emails=[...new Set([...(Array.isArray(person?.email)?person.email:[]),...(Array.isArray(person?.emails)?person.emails:[]),person?.primary_email,typeof person?.email==='string'?person.email:null].map(e=>normalize(typeof e==='object'?e?.value:e)).filter(Boolean))];
  const title=normalize(lead.data?.title),company=normalize(organization?.name);
  const search=query.trim();const pattern='%'+search.replace(/[\\%_]/g,'\\$&')+'%';
  const r=(await db.query(`WITH candidates AS MATERIALIZED (
   SELECT id,coalesce(nullif(data->>'projectName',''),name) project_name,data->>'companyName' company_name,data->>'contactName' contact_name,data->>'email' contact_email,data->>'dateReceived' intake_date,status,data->>'trelloLink' trello_reference,(data->>'isTest'='true' OR data->>'is_test'='true' OR coalesce(data->>'projectName',name,'') ~* '(^|[^a-z])(test|demo|sample)([^a-z]|$)') marked_test,
    ($2<>'' AND lower(btrim(coalesce(nullif(data->>'projectName',''),name)))=$2) title_match,
    lower(btrim(data->>'email'))=ANY($3::text[]) email_match,($4<>'' AND lower(btrim(data->>'companyName'))=$4) company_match
   FROM projects WHERE archived=false AND deleted_at IS NULL
    AND (CASE WHEN $5<>'' THEN (coalesce(data->>'projectName',name,'') ILIKE $6 ESCAPE E'\\\\' OR coalesce(data->>'companyName','') ILIKE $6 ESCAPE E'\\\\' OR coalesce(data->>'email','') ILIKE $6 ESCAPE E'\\\\')
     ELSE ($2<>'' AND lower(btrim(coalesce(nullif(data->>'projectName',''),name)))=$2 OR lower(btrim(data->>'email'))=ANY($3::text[]) OR $4<>'' AND lower(btrim(data->>'companyName'))=$4) END)
   ) SELECT transaction_timestamp() checked_at,(SELECT count(*)::int FROM candidates) total,
   (SELECT coalesce(jsonb_agg(p ORDER BY id),'[]') FROM (SELECT * FROM candidates ORDER BY id LIMIT 20 OFFSET $1) p) items`,[offset,title,emails,company,search,pattern])).rows[0];
  return {leadId,checkedAt:r.checked_at,total:r.total,limit:20,offset,query:search,items:r.items.map(p=>({projectId:p.id,projectName:plain(p.project_name),companyName:plain(p.company_name),contactName:plain(p.contact_name),contactEmail:plain(p.contact_email),intakeDate:plain(p.intake_date),documentStatus:plain(p.status),safeTrelloReference:safeTrelloReference(p.trello_reference),testStatus:p.marked_test?'marked_test':'unknown',matchReasons:[...(p.title_match?['project_title']:[]),...(p.email_match?['contact_email']:[]),...(p.company_match?['company_name']:[])]})),coverage:{partial:true,source:'dedicated_app_inventory',linkStatus:'unverified',matching:search?'manual_inventory_search':'exact_title_email_company',orderStatus:'unknown',wordpressCompleteness:'unknown',currentTrello:'unavailable'}};
 });
}
const operationReasons=new Set(['membership_unverified','membership_generation_changed','send_ownership_unverified','another_send_owns_or_reused_contact_campaign','membership_read_failed','enrollment_receipt_requires_review','membership_absent','membership_ambiguous','generation_unverified','conditional_generation_stop_unverified']);
const sendStates=new Set(['enrolled','sent','bounced','replied','unsubscribed','failed','switched']);
export async function readDeliveryEvidence(pool,{companyId,viewer,resolveVisibleMailboxes}={}){
 return readAdmin(pool,{companyId,viewer},async db=>{
  const mailboxes=[...new Set((await boundedSnapshotRead(resolveVisibleMailboxes(viewer,db))).map(normalize).filter(Boolean))];
  const r=(await db.query(`WITH identities AS MATERIALIZED (${identitySql} AND s.lifecycle IN ('active','archived')),
   enrollments AS MATERIALIZED (
    SELECT s.id,s.pipedrive_lead_id,s.sent_at,s.status,s.apollo_sequence_id,s.apollo_emailer_message_id,s.apollo_contact_id,d.contact_email_snapshot,m.email,identities.data->>'title' title
    FROM sdr_sends s JOIN identities ON identities.entity_id=s.pipedrive_lead_id
    JOIN sdr_drafts d ON d.id=s.draft_id AND d.pipedrive_lead_id=s.pipedrive_lead_id JOIN sdr_mailboxes m ON m.id=s.mailbox_id
    WHERE lower(btrim(m.email))=ANY($2::text[])
   ), page AS (SELECT * FROM enrollments ORDER BY sent_at DESC,id LIMIT 50), detailed AS (
    SELECT p.*,receipt.value receipt,ops.items operations,ops.total operation_total FROM page p
    LEFT JOIN LATERAL(SELECT jsonb_build_object('providerMessageId',f.provider_message_id,'occurredAt',f.occurred_at,'observedAt',f.observed_at) value
     FROM sdr_message_facts f WHERE f.provider='apollo' AND f.provider_message_id=p.apollo_emailer_message_id AND f.direction='out' AND f.provider_status='completed' AND NOT f.is_test
      AND isfinite(f.occurred_at) AND f.occurred_at<=transaction_timestamp() AND f.campaign_id=p.apollo_sequence_id AND nullif(btrim(f.campaign_id),'') IS NOT NULL
      AND nullif(lower(btrim(f.prospect_email)),'')=nullif(lower(btrim(p.contact_email_snapshot)),'') AND lower(btrim(f.mailbox_email))=lower(btrim(p.email))
      AND f.link_status IN ('verified','unmatched') AND (f.pipedrive_lead_id IS NULL OR f.pipedrive_lead_id=p.pipedrive_lead_id AND f.link_status='verified')
      AND NOT EXISTS(SELECT 1 FROM sdr_sends competing WHERE competing.apollo_emailer_message_id=f.provider_message_id AND competing.id<>p.id)
      AND (SELECT count(*) FROM sdr_message_facts other WHERE other.provider='apollo' AND other.provider_message_id=f.provider_message_id)=1
    ) receipt ON true
    LEFT JOIN LATERAL(WITH scoped AS MATERIALIZED (SELECT o.id,o.kind,o.state,o.reason,o.updated_at FROM sdr_provider_operations o WHERE o.lead_id=p.pipedrive_lead_id AND o.campaign_id=p.apollo_sequence_id AND o.contact_id=p.apollo_contact_id
     AND o.expected_membership->>'sendId'=p.id::text AND (NOT(o.expected_membership ? 'companyId') OR o.expected_membership->>'companyId'=$1)
     AND (NOT(o.expected_membership ? 'leadId') OR o.expected_membership->>'leadId'=p.pipedrive_lead_id)
     AND (NOT(o.expected_membership ? 'campaignId') OR o.expected_membership->>'campaignId'=p.apollo_sequence_id)
     AND (NOT(o.expected_membership ? 'contactId') OR o.expected_membership->>'contactId'=p.apollo_contact_id))
     SELECT (SELECT count(*)::int FROM scoped) total,(SELECT coalesce(jsonb_agg(o ORDER BY updated_at DESC,id),'[]') FROM (SELECT * FROM scoped ORDER BY updated_at DESC,id LIMIT 10)o) items)ops ON true
   ) SELECT transaction_timestamp() checked_at,(SELECT count(*)::int FROM enrollments) total,(SELECT coalesce(jsonb_agg(d ORDER BY sent_at DESC,id),'[]') FROM detailed d)items`,[companyId,mailboxes])).rows[0];
  const safety=(await db.query(`WITH identities AS MATERIALIZED (${identitySql} AND s.lifecycle IN ('active','archived')),
   scoped AS MATERIALIZED (SELECT p.decision_key,p.lead_id,p.actual_outcome,p.actual_reasons,p.created_at,d.id draft_id,d.revision,identities.data->>'title' title,m.email
    FROM sdr_policy_decisions p JOIN identities ON identities.entity_id=p.lead_id
    JOIN sdr_drafts d ON d.pipedrive_lead_id=p.lead_id AND p.action_key='draft:'||d.id::text||':'||d.revision::text
    JOIN sdr_mailboxes m ON m.id=d.assigned_mailbox_id WHERE p.company_id=$1 AND lower(btrim(m.email))=ANY($2::text[]) AND p.actual_outcome IN ('hold','review'))
   SELECT (SELECT count(*)::int FROM scoped) total,(SELECT coalesce(jsonb_agg(p ORDER BY created_at DESC,decision_key),'[]') FROM (SELECT * FROM scoped ORDER BY created_at DESC,decision_key LIMIT 50)p)items`,[companyId,mailboxes])).rows[0];
  const safeReasons=new Set(['outreach_held','provider_state_requires_review','scheduled_for_future','source_context_incomplete','award_only_requires_matching_sequence','reviewed_context_changed','project_role_unverified','cadence_unverified','draft_review_context_changed','cohort_context_changed']);
  return {checkedAt:r.checked_at,total:r.total,limit:50,items:r.items.map(p=>({sendId:p.id,leadId:p.pipedrive_lead_id,projectTitle:plain(p.title),mailbox:plain(p.email),historicalRecipient:plain(p.contact_email_snapshot),localEnrollmentAt:p.sent_at,storedStatus:sendStates.has(p.status)?p.status:'unknown',receipt:p.receipt,operationTotal:p.operation_total,operations:p.operations.map(o=>({id:o.id,kind:['stop','enroll'].includes(o.kind)?o.kind:'unknown',state:['reserved','unresolved','confirmed','superseded','protected_external_state'].includes(o.state)?o.state:'unknown',reason:o.reason?(operationReasons.has(o.reason)?o.reason:'unclassified'):null,updatedAt:o.updated_at}))})),safetyChecks:{total:safety.total,limit:50,items:safety.items.map(p=>({decisionId:p.decision_key,leadId:p.lead_id,projectTitle:plain(p.title),draftId:p.draft_id,draftRevision:String(p.revision),mailbox:plain(p.email),firstRecordedAt:p.created_at,outcome:p.actual_outcome,reasons:[...new Set((Array.isArray(p.actual_reasons)?p.actual_reasons:[]).map(reason=>safeReasons.has(reason)?reason:'unclassified'))]}))},coverage:{partial:true,visibleMailboxes:mailboxes.length,receiptMatching:'unique_direct_message_id',historicalRefusals:'unavailable',providerHistory:'collected_records_only'}};
 });
}
