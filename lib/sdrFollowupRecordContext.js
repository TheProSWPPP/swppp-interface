import {leadVisibilityScope} from './sdrAccess.js';

const UTC_SPACE=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const UTC_Z=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function sourceTimestamp(value){
 if(typeof value!=='string')return null;
 const match=UTC_SPACE.exec(value)||UTC_Z.exec(value);
 if(!match)return null;
 const [year,month,day,hour,minute,second]=match.slice(1).map(Number);
 const date=new Date(Date.UTC(year,month-1,day,hour,minute,second));
 if(!Number.isFinite(+date)||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day||
   date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==second)return null;
 return date.toISOString();
}

function preview(value){
 const plain=String(value??'').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi,entity=>
  ({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[entity.toLowerCase()]||entity)).replace(/\s+/g,' ').trim();
 const chars=Array.from(plain);
 return {text:chars.slice(0,300).join('')+(chars.length>300?'…':''),truncated:chars.length>300};
}

function verifiedParentUrl(value,paths){
 if(!value)return null;
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='proswpppllc.pipedrive.com'||url.username||url.password||url.search||url.hash)return null;
  const match=/^\/(leads\/inbox|deal)\/([^/]+)\/?$/.exec(url.pathname);
  if(!match)return null;
  const type=match[1]==='deal'?'deal':'lead',parentId=decodeURIComponent(match[2]);
  const path=paths.find(path=>path.type===type&&path.id===parentId);
  return path?{url:url.toString(),path}:null;
 }catch{return null;}
}

export async function readFollowupRecordContext(db,{companyId,viewer,leadIds,asOf}={}){
 if(!companyId||typeof companyId!=='string'||!['admin','sdr'].includes(viewer?.role)||viewer.machine||
   viewer.role==='sdr'&&!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(viewer.sub||'')||
   !Array.isArray(leadIds)||leadIds.length>200||leadIds.some(id=>typeof id!=='string'||!id||id.length>200)||
   new Set(leadIds).size!==leadIds.length||typeof asOf!=='string'||!Number.isFinite(Date.parse(asOf)))throw new Error('invalid_followup_record_context');
 const scope=leadVisibilityScope(viewer,'visible');
 const ids=(await db.query(`SELECT requested.lead_id FROM unnest($2::text[]) AS requested(lead_id)
   JOIN sdr_lead_state visible ON visible.pipedrive_lead_id=requested.lead_id AND visible.crm_company_id=$1
   JOIN sdr_crm_snapshots lead ON lead.company_id=$1 AND lead.entity='lead' AND lead.entity_id=requested.lead_id
     AND lead.access_status='accessible' AND lead.lifecycle='active' AND NOT lead.is_test
   WHERE ${scope.sql('$3')}`,[companyId,leadIds,...(scope.requires?[scope.value]:[])])).rows.map(row=>row.lead_id);
 const result=new Map(leadIds.map(id=>[id,{status:ids.includes(id)?'available':'unavailable',reason:ids.includes(id)?null:'project_source_unavailable',note:null,completedCall:null}]));
 if(!ids.length)return result;
 const rows=(await db.query(`WITH page_leads AS MATERIALIZED (SELECT unnest($2::text[]) AS lead_id),
 candidate AS MATERIALIZED (
   SELECT link.entity,link.entity_id FROM sdr_crm_links link JOIN page_leads page ON page.lead_id=link.linked_id
     WHERE link.company_id=$1 AND link.link_type='lead' AND link.entity IN ('note','activity')
   UNION
   SELECT child.entity,child.entity_id FROM sdr_crm_links parent JOIN page_leads page ON page.lead_id=parent.linked_id
     JOIN sdr_crm_links child ON child.company_id=parent.company_id AND child.link_type='deal' AND child.linked_id=parent.entity_id
     WHERE parent.company_id=$1 AND parent.entity='deal' AND parent.link_type='lead' AND child.entity IN ('note','activity')
 ), resolved AS (
   SELECT link.entity,link.entity_id,
     min(CASE WHEN link.link_type='lead' THEN link.linked_id ELSE parent_lead.linked_id END) AS lead_id,
     count(DISTINCT CASE WHEN link.link_type='lead' THEN link.linked_id ELSE parent_lead.linked_id END) AS lead_count,
     bool_and(link.link_type='lead' OR (deal.entity_id IS NOT NULL AND deal.access_status='accessible'
       AND deal.lifecycle='active' AND NOT deal.is_test AND parent_lead.linked_id IS NOT NULL)) AS all_paths_valid,
     jsonb_agg(DISTINCT jsonb_build_object('type',link.link_type,'id',link.linked_id,
       'leadId',CASE WHEN link.link_type='lead' THEN link.linked_id ELSE parent_lead.linked_id END)) AS paths
   FROM candidate c JOIN sdr_crm_links link ON link.company_id=$1 AND link.entity=c.entity AND link.entity_id=c.entity_id
     AND link.link_type IN ('lead','deal')
   LEFT JOIN sdr_crm_snapshots deal ON link.link_type='deal' AND deal.company_id=link.company_id
     AND deal.entity='deal' AND deal.entity_id=link.linked_id
   LEFT JOIN sdr_crm_links parent_lead ON link.link_type='deal' AND parent_lead.company_id=link.company_id
     AND parent_lead.entity='deal' AND parent_lead.entity_id=link.linked_id AND parent_lead.link_type='lead'
   GROUP BY link.entity,link.entity_id
 ), sourced AS (
   SELECT s.*,r.lead_id,r.paths,
     CASE WHEN nullif(s.data->>'update_time','') IS NOT NULL THEN 'update_time'
       WHEN nullif(s.data->>'last_edit','') IS NOT NULL THEN 'last_edit' ELSE 'add_time' END AS source_field,
     coalesce(nullif(s.data->>'update_time',''),nullif(s.data->>'last_edit',''),nullif(s.data->>'add_time','')) AS raw_time
   FROM resolved r JOIN page_leads page ON page.lead_id=r.lead_id
   JOIN sdr_crm_snapshots s ON s.company_id=$1 AND s.entity=r.entity AND s.entity_id=r.entity_id
   WHERE r.lead_count=1 AND r.all_paths_valid AND s.access_status='accessible' AND s.lifecycle='active' AND NOT s.is_test
     AND (s.entity='note' OR s.entity='activity' AND s.data->>'done'='true' AND s.data->>'type'='call')
     AND (s.entity<>'note' OR regexp_replace(COALESCE(s.data->>'content',''),'<[^>]*>','','g') !~ '^\\[Auto\\] \\[Prepared response — unsent\\]\\[SDR prepared handoff [0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}\\]')
     AND s.source_updated_at BETWEEN $3::timestamptz-INTERVAL '90 days' AND $3::timestamptz
 ), ranked AS (
   SELECT *,row_number() OVER(PARTITION BY lead_id,entity ORDER BY source_updated_at DESC,observed_at DESC,entity_id DESC) AS rank
   FROM sourced WHERE
     (raw_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
       AND raw_time=to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
     OR (raw_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
       AND raw_time=to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
 ) SELECT lead_id,entity,entity_id,data,source_updated_at,observed_at,source_read_started_at,source_url,source_field,raw_time,paths
   FROM ranked WHERE rank=1`,[companyId,ids,asOf])).rows;
 for(const row of rows){
  const sourceAt=sourceTimestamp(row.raw_time);
  if(!sourceAt||sourceAt!==new Date(row.source_updated_at).toISOString())continue;
  const paths=(row.paths||[]).sort((a,b)=>a.type.localeCompare(b.type)||a.id.localeCompare(b.id));
  const verifiedParent=verifiedParentUrl(row.source_url,paths);
  const direct=paths.find(path=>path.type==='lead'&&path.id===row.lead_id);
  const primary=verifiedParent?.path||direct||paths[0];
  const linkEvidence=direct&&direct!==primary?[direct,primary]:[primary];
  const body=preview(row.entity==='note'?row.data?.content:row.data?.note),subject=preview(row.data?.subject);
  const record={id:row.entity_id,entity:row.entity,sourceUrl:verifiedParent?.url||null,linkEvidence,
   eventAt:row.entity==='note'?sourceTimestamp(row.data?.add_time):null,sourceUpdatedAt:sourceAt,sourceUpdatedField:row.source_field,
   observedAt:row.observed_at,sourceReadStartedAt:row.source_read_started_at,originStatus:'unknown',text:body.text,textTruncated:body.truncated,
   subject:subject.text||null,subjectTruncated:subject.truncated};
  result.get(row.lead_id)[row.entity==='note'?'note':'completedCall']=record;
 }
 return result;
}
