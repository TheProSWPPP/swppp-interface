import {leadVisibilityScope} from './sdrAccess.js';
import {readCrmSyncHealth} from './sdrCrmObservations.js';

// This is an evidence review, never an instruction to contact or proof of missed work.
// No provider reads/writes, task creation, inferred dates or automatic intent decisions.
export async function readFollowupReview(pool,{companyId,viewer,limit=40,cursor=null,asOf=new Date().toISOString()}={}) {
 if(!companyId)throw new Error('company_required');
 if(!['admin','sdr'].includes(viewer?.role)||viewer.machine||viewer.role==='sdr'&&!viewer.sub)throw new Error('invalid_viewer');
 const filters=JSON.stringify([String(companyId),viewer.role,viewer.sub||null]);
 let page=null;
 if(cursor){
  try{page=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw new Error('invalid_cursor');}
  if(page?.filters!==filters||typeof page.id!=='string'||page.id.length>200||!Number.isFinite(Date.parse(page.at))||!Number.isFinite(Date.parse(page.asOf)))throw new Error('invalid_cursor');
 }
 const end=new Date(page?.asOf||asOf);
 if(!Number.isFinite(+end))throw new Error('invalid_as_of');
 const n=Math.max(1,Math.min(100,Math.floor(Number(limit)||40)));
 const freshness=await readCrmSyncHealth(pool,{companyId});
 if(freshness.scopes.some(s=>s.errorCategory==='permission'))return {items:[],nextCursor:null,freshness,unavailable:'permission_denied'};
 const scope=leadVisibilityScope(viewer,'visible');
 const rows=(await pool.query(`WITH relations AS (
   SELECT entity,entity_id,linked_id AS lead_id FROM sdr_crm_links WHERE company_id=$1 AND link_type='lead'
   UNION
   SELECT child.entity,child.entity_id,parent.linked_id FROM sdr_crm_links child
     JOIN sdr_crm_links parent ON parent.company_id=child.company_id AND parent.entity='deal' AND parent.entity_id=child.linked_id AND parent.link_type='lead'
     WHERE child.company_id=$1 AND child.link_type='deal'
 ), unique_links AS (
   SELECT entity,entity_id,min(lead_id) AS lead_id FROM relations GROUP BY entity,entity_id HAVING count(DISTINCT lead_id)=1
 ), evidence AS (
   SELECT s.*,linked.lead_id FROM sdr_crm_snapshots s JOIN unique_links linked ON linked.entity=s.entity AND linked.entity_id=s.entity_id
   WHERE s.company_id=$1 AND s.access_status='accessible' AND s.lifecycle='active' AND NOT s.is_test
     AND s.source_updated_at BETWEEN $2::timestamptz-INTERVAL '90 days' AND $2::timestamptz
     AND ((s.entity='note' AND length(trim(regexp_replace(COALESCE(s.data->>'content',''),'<[^>]*>','','g')))>0
       AND regexp_replace(COALESCE(s.data->>'content',''),'<[^>]*>','','g') !~* '^\\s*\\[auto\\]')
       OR (s.entity='activity' AND s.data->>'done'='true' AND s.data->>'type'='call' AND length(trim(COALESCE(s.data->>'note','')))>0))
     AND NOT EXISTS(SELECT 1 FROM sdr_crm_links child LEFT JOIN sdr_crm_snapshots parent ON parent.company_id=child.company_id AND parent.entity='deal' AND parent.entity_id=child.linked_id
       WHERE child.company_id=s.company_id AND child.entity=s.entity AND child.entity_id=s.entity_id AND child.link_type='deal'
       AND (parent.entity_id IS NULL OR parent.access_status!='accessible' OR parent.lifecycle IN ('unresolved','deleted','merged') OR parent.is_test))
 ), open_task_leads AS MATERIALIZED (
   SELECT DISTINCT r.lead_id FROM relations r JOIN sdr_crm_snapshots a ON a.company_id=$1 AND a.entity=r.entity AND a.entity_id=r.entity_id
   WHERE a.entity='activity' AND a.lifecycle='active' AND a.access_status='accessible' AND NOT a.is_test AND COALESCE(a.data->>'done','false')!='true'
 ), projects AS (
   SELECT lead.entity_id AS lead_id,lead.data,lead.source_url,max(e.source_updated_at) AS latest_at
   FROM sdr_crm_snapshots lead JOIN evidence e ON e.lead_id=lead.entity_id
   WHERE lead.company_id=$1 AND lead.entity='lead' AND lead.lifecycle='active' AND lead.access_status='accessible' AND NOT lead.is_test
     AND EXISTS(SELECT 1 FROM sdr_lead_state visible WHERE visible.pipedrive_lead_id=lead.entity_id AND visible.crm_company_id=$1 AND ${scope.requires?scope.sql('$3'):'($3::text IS NULL)'})
     AND lead.entity_id NOT IN (SELECT lead_id FROM open_task_leads)
   GROUP BY lead.entity_id,lead.data,lead.source_url
 ), page_projects AS MATERIALIZED (
   SELECT * FROM projects p WHERE ($4::timestamptz IS NULL OR p.latest_at<$4 OR (p.latest_at=$4 AND p.lead_id>$5))
   ORDER BY p.latest_at DESC,p.lead_id LIMIT $6
 ) SELECT p.*,details.evidence FROM page_projects p
 CROSS JOIN LATERAL (SELECT jsonb_agg(v ORDER BY v."sourceUpdatedAt" DESC,v.id) AS evidence FROM
   (SELECT entity_id AS id,entity,COALESCE(data->>'content',data->>'note') AS text,data->>'subject' AS subject,
     source_updated_at AS "sourceUpdatedAt",observed_at AS "observedAt",source_url AS "sourceUrl"
     FROM evidence WHERE lead_id=p.lead_id ORDER BY source_updated_at DESC,entity_id LIMIT 5) v) details
 ORDER BY p.latest_at DESC,p.lead_id`,[String(companyId),end.toISOString(),scope.value,page?.at||null,page?.id||null,n+1])).rows;
 const items=rows.slice(0,n).map(row=>({leadId:row.lead_id,title:row.data?.title||null,ownerId:String(row.data?.owner_id?.id||row.data?.owner_id?.value||row.data?.owner_id||'' )||null,ownerName:row.data?.owner_name||null,sourceUrl:row.source_url,latestAt:row.latest_at,evidence:row.evidence}));
 const last=rows[n-1];
 return {items,nextCursor:rows.length>n?Buffer.from(JSON.stringify({filters,id:last.lead_id,at:last.latest_at,asOf:end.toISOString()})).toString('base64url'):null,freshness};
}
