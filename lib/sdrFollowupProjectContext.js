import {connectSnapshotRead} from './sdrSnapshotReadBounds.js';
import {CRM_OBSERVATION_SCOPES} from './pipedriveObservationClient.js';
import {leadVisibilityScope} from './sdrAccess.js';
import {readFollowupRecordContext} from './sdrFollowupRecordContext.js';
const fail=code=>Object.assign(new Error(code),{code});
const scalar=value=>{const v=value&&typeof value==='object'?value.id??value.value:value;return ['string','number'].includes(typeof v)?String(v):null;};
const plain=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const preview=value=>{const text=Array.from(plain(value));return {text:text.slice(0,600).join(''),truncated:text.length>600};};
function parentUrl(value,leadId){
 try{const url=new URL(value);if(url.protocol==='https:'&&url.hostname==='proswpppllc.pipedrive.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&decodeURIComponent(url.pathname).replace(/\/$/,'')===`/leads/inbox/${leadId}`)return url.toString();}catch{}
 return null;
}
export async function readFollowupProjectContext(pool,{companyId,leadId,viewer}){
 if(typeof companyId!=='string'||!companyId||typeof leadId!=='string'||!leadId||leadId.length>200)throw fail('invalid_context');
 if(viewer?.machine||!['admin','sdr'].includes(viewer?.role)||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(viewer?.sub||''))throw fail('session_required');
 const db=await connectSnapshotRead(pool);
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='5000ms'");
  if(!(await db.query('SELECT 1 FROM sdr_users WHERE id=$1 AND role=$2 AND active',[viewer.sub,viewer.role])).rowCount)throw fail('session_required');
  if((await db.query("SELECT 1 FROM sdr_crm_scope_coverage WHERE company_id=$1 AND error_category='permission' LIMIT 1",[companyId])).rowCount)throw fail('lead_unavailable');
  const scope=leadVisibilityScope(viewer,'visible');
  const source=(await db.query(`SELECT s.* FROM sdr_lead_state visible JOIN sdr_crm_snapshots s
   ON s.company_id=$1 AND s.entity='lead' AND s.entity_id=visible.pipedrive_lead_id
   WHERE visible.crm_company_id=$1 AND visible.pipedrive_lead_id=$2 AND s.lifecycle='active' AND s.access_status='accessible' AND NOT s.is_test AND ${scope.sql('$3')}`,[companyId,leadId,...(scope.requires?[scope.value]:[])])).rows[0];
  if(!source)throw fail('lead_unavailable');
  const personId=scalar(source.data?.person_id);
  const person=personId?(await db.query("SELECT data FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='person' AND entity_id=$2 AND lifecycle='active' AND access_status='accessible' AND NOT is_test",[companyId,personId])).rows[0]?.data:null;
  const rawEmails=Array.isArray(person?.emails)?person.emails:Array.isArray(person?.email)?person.email:[];
  const addresses=rawEmails.map(e=>typeof e?.value==='string'?e.value.trim().toLowerCase():'').filter(Boolean);
  for(const field of [person?.primary_email,person?.email])if(typeof field==='string'&&field.trim())addresses.push(field.trim().toLowerCase());
  const primary=rawEmails.find(e=>e.primary===true)?.value;
  const contactEmail=typeof primary==='string'?primary.trim().toLowerCase():addresses[0]||null;
  const holds=(await db.query(`SELECT id,reason,scope_kind AS "scopeKind",provider_stop_status AS "providerStopStatus"
   FROM sdr_outreach_controls WHERE company_id=$1 AND status='active' AND (channel IS NULL OR channel='email')
    AND (lead_id IS NULL OR lead_id=$2) AND (scope_kind='lead' AND scope_id=$2 OR scope_kind='recipient' AND lower(trim(scope_id))=ANY($3::text[]) OR scope_kind='channel' AND scope_id='email') ORDER BY id`,[companyId,leadId,addresses])).rows.map(h=>({...h,reason:plain(h.reason)}));
  // Open tasks have their own all-age population; notes cannot displace them.
  // Additional lead/deal paths are deliberately withheld rather than interpreted.
  const rows=(await db.query(`SELECT s.*,count(*) OVER()::int AS total FROM sdr_crm_links link
   JOIN sdr_crm_snapshots s ON s.company_id=link.company_id AND s.entity=link.entity AND s.entity_id=link.entity_id
   WHERE link.company_id=$1 AND link.entity='activity' AND link.link_type='lead' AND link.linked_id=$2
    AND s.lifecycle='active' AND s.access_status='accessible' AND NOT s.is_test AND s.data->>'done'='false'
    AND NOT EXISTS(SELECT 1 FROM sdr_crm_links other WHERE other.company_id=link.company_id AND other.entity=link.entity AND other.entity_id=link.entity_id
     AND (other.link_type='deal' OR other.link_type='lead' AND other.linked_id<>$2))
   ORDER BY nullif(s.data->>'due_date','') ASC NULLS LAST,nullif(s.data->>'due_time','') ASC NULLS LAST,s.entity_id LIMIT 20`,[companyId,leadId])).rows;
  const asOf=(await db.query('SELECT transaction_timestamp() AS at')).rows[0].at.toISOString();
  const recentRecords=(await readFollowupRecordContext(db,{companyId,viewer,leadIds:[leadId],asOf})).get(leadId);
  const scopes=(await db.query(`SELECT scope,status,checked_at AS "checkedAt",error_category AS "errorCategory" FROM sdr_crm_scope_coverage WHERE company_id=$1 AND scope=ANY($2::text[]) ORDER BY scope`,[companyId,CRM_OBSERVATION_SCOPES])).rows.map(r=>({...r,errorCategory:r.errorCategory?['permission','network','rate_limit','provider_error','authentication','unavailable','timeout'].includes(r.errorCategory)?r.errorCategory:'collection_error':null}));
  const openTaskCount=rows[0]?.total||0;
  const result={lead:{id:leadId,title:plain(source.data?.title),ownerId:scalar(source.data?.owner_id),ownerName:plain(source.data?.owner_id?.name)||null,personId,contactName:plain(person?.name)||null,contactEmail,sourceUpdatedAt:source.source_updated_at,observedAt:source.observed_at,sourceUrl:parentUrl(source.source_url,leadId)},
   holds,openTaskCount,tasksLimited:openTaskCount>rows.length,tasks:rows.map(r=>{const subject=preview(r.data?.subject),note=preview(r.data?.note);return {id:r.entity_id,type:scalar(r.data?.type),subject:subject.text,subjectTruncated:subject.truncated,note:note.text,noteTruncated:note.truncated,ownerId:scalar(r.data?.owner_id??r.data?.user_id),ownerName:plain(r.data?.owner_id?.name??r.data?.user_id?.name)||null,dueDate:r.data?.due_date||null,dueTime:r.data?.due_time||null,sourceUpdatedAt:r.source_updated_at,observedAt:r.observed_at,sourceUrl:parentUrl(r.source_url,leadId)};}),recentRecords,coverage:{partial:true,asOf,scopes,quoteStatus:'unknown',orderStatus:'unknown',emailStatus:'unavailable'}};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
