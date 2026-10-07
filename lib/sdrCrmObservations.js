import { CRM_OBSERVATION_SCOPES } from './pipedriveObservationClient.js';
import { randomUUID } from 'node:crypto';
import { leadVisibilityScope } from './sdrAccess.js';
import { controlApplies } from './sdrOutreachControls.js';
import { classifyActor } from './sdrChangeJournal.js';

const ENTITIES=new Set(['lead','deal','activity','note','person','organization']);
const ACTIONS=new Set(['create','change','delete']);
const id=value=>value===null||value===undefined||String(value)===''?null:String(value);
const category=error=>error?.status===401||error?.status===403?'permission':error?.status===404?'not_found':error?.status===429?'rate_limit':error?.status>=500?'provider':'invalid_or_unavailable';
const timestamp=value=>{const normalized=typeof value==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)?value.replace(' ','T')+'Z':value;const time=new Date(normalized);if(!Number.isFinite(+time))throw new Error('invalid_event_timestamp');return time.toISOString();};
const sourceTime=(data,fallback)=>{const raw=data?.update_time||data?.last_edit||data?.add_time||fallback;return timestamp(raw);};
const entityId=value=>id(typeof value==='object'&&value!==null?value.id:value);
const sourceUrl=(host,entity,entityIdValue,data)=>{
  if(!host||!/^([a-z0-9-]+\.)+pipedrive\.com$/i.test(host))return null;
  let target=entity,targetId=entityIdValue;
  if(entity==='note'||entity==='activity') {
    const parent=[['lead',data?.lead_id],['deal',data?.deal_id],['person',data?.person_id],['organization',data?.org_id]].find(([,value])=>entityId(value));
    if(!parent)return null;
    [target,targetId]=[parent[0],entityId(parent[1])];
  }
  const path=target==='lead'?'leads/inbox':target==='person'?'person':target==='organization'?'organization':'deal';
  return `https://${host}/${path}/${encodeURIComponent(targetId)}`;
};
const linksFor=(entity,entityIdValue,data)=>{
  const links=[];
  const add=(type,value,field)=>{const linked=entityId(value);if(linked)links.push({type,id:linked,evidence:`pipedrive:${field}`});};
  if(entity==='lead')add('lead',entityIdValue,'self');
  if(entity==='deal')add('deal',entityIdValue,'self');
  if(entity==='person')add('person',entityIdValue,'self');
  if(entity==='organization')add('organization',entityIdValue,'self');
  for(const [type,field] of [['lead','lead_id'],['deal','deal_id'],['person','person_id'],['organization','org_id']])add(type,data?.[field],field);
  if(entity==='lead')add('organization',data?.organization_id,'organization_id');
  if(entity==='deal')add('lead',data?.source_lead_id,'source_lead_id');
  return links;
};
const reviewTitle=(entity,data)=>entity==='activity'?data?.subject:entity==='lead'||entity==='deal'?data?.title:null;
export function validateReviewedCrmExclusion(input={}) {
  const companyId=id(input.companyId),entity=input.entity,matchType=input.matchType,matchValue=String(input.matchValue||'').trim();
  const decision=input.decision||'exclude',evidence=String(input.evidence||'').trim(),reviewedBy=String(input.reviewedBy||'').trim();
  if(!companyId||!ENTITIES.has(entity)||!['id','title_pattern'].includes(matchType)||!['exclude','include'].includes(decision)||
    !matchValue||!evidence||!reviewedBy||matchType==='title_pattern'&&(!['lead','deal','activity'].includes(entity)||matchValue.length<3))throw new Error('invalid_reviewed_crm_exclusion');
  return {companyId,entity,matchType,matchValue,decision,evidence,reviewedBy};
}
async function reviewedRuleFor(db,companyId,entity,recordId,data){
  const title=reviewTitle(entity,data)||null;
  return (await db.query(`SELECT decision,evidence FROM sdr_crm_reviewed_exclusions
    WHERE company_id=$1 AND entity=$2 AND (match_type='id' AND match_value=$3 OR match_type='title_pattern' AND $4::text IS NOT NULL AND strpos(lower($4),lower(match_value))>0)
    ORDER BY CASE WHEN match_type='id' THEN 0 ELSE 1 END,reviewed_at DESC LIMIT 1`,[companyId,entity,recordId,title])).rows[0]||null;
}
async function applyReviewedExclusion(db,companyId,entity,recordId){
  const row=(await db.query('SELECT data FROM sdr_crm_snapshots WHERE company_id=$1 AND entity=$2 AND entity_id=$3',[companyId,entity,recordId])).rows[0];
  if(!row)return;
  const rule=await reviewedRuleFor(db,companyId,entity,recordId,row.data);
  if(rule)await db.query('UPDATE sdr_crm_snapshots SET is_test=$4,test_evidence=$5 WHERE company_id=$1 AND entity=$2 AND entity_id=$3',
    [companyId,entity,recordId,rule.decision==='exclude',rule.evidence]);
}
export async function filterReviewedCrmEvidence(pool,{companyId,evidence}={}){
  if(!companyId||!evidence||typeof evidence!=='object')throw new Error('company_and_evidence_required');
  const result={...evidence,errors:[...(evidence.errors||[])],notes:[],activities:[],reviewedExclusions:[]};
  let blocked=false;
  for(const [field,entity] of [['lead','lead'],['person','person'],['organization','organization']]){
    const item=evidence[field],recordId=id(item?.id);
    if(!recordId)continue;
    const rule=await reviewedRuleFor(pool,String(companyId),entity,recordId,item);
    if(rule?.decision==='exclude'){
      result[field]=null;blocked=true;
      result.errors.push({category:'reviewed_test',entity,id:recordId,evidence:rule.evidence});
      result.reviewedExclusions.push({entity,id:recordId,evidence:rule.evidence});
    }
  }
  if(blocked){result.complete=false;return result;}
  for(const [field,entity] of [['notes','note'],['activities','activity']])for(const item of evidence[field]||[]){
    const recordId=id(item?.id);
    const rule=recordId?await reviewedRuleFor(pool,String(companyId),entity,recordId,item):null;
    if(rule?.decision==='exclude')result.reviewedExclusions.push({entity,id:recordId,evidence:rule.evidence});
    else result[field].push(item);
  }
  return result;
}
export async function recordReviewedCrmExclusion(pool,input){
  const rule=validateReviewedCrmExclusion(input);
  return transaction(pool,async db=>{
    await db.query(`INSERT INTO sdr_crm_reviewed_exclusions(company_id,entity,match_type,match_value,decision,evidence,reviewed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,entity,match_type,match_value) DO UPDATE SET
      decision=EXCLUDED.decision,evidence=EXCLUDED.evidence,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now()`,
      [rule.companyId,rule.entity,rule.matchType,rule.matchValue,rule.decision,rule.evidence,rule.reviewedBy]);
    const field=rule.entity==='activity'?'subject':'title';
    const rows=(await db.query(`SELECT entity_id FROM sdr_crm_snapshots WHERE company_id=$1 AND entity=$2 AND
      ($3='id' AND entity_id=$4 OR $3='title_pattern' AND strpos(lower(COALESCE(data->>$5,'')),lower($4))>0)`,
      [rule.companyId,rule.entity,rule.matchType,rule.matchValue,field])).rows;
    for(const row of rows)await applyReviewedExclusion(db,rule.companyId,rule.entity,row.entity_id);
    return {reviewed:rows.length,rule};
  });
}
async function transaction(pool,fn){const db=typeof pool.connect==='function'?await pool.connect():pool;try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{if(db!==pool)db.release();}}

export async function receivePipedriveEvent(pool,payload,{companyId}={}) {
  const meta=payload?.meta;
  if(!companyId||!meta||String(meta.company_id)!==String(companyId)||meta.version!=='2.0'||!ENTITIES.has(meta.entity)||!ACTIONS.has(meta.action)||!id(meta.id)||!id(meta.entity_id))throw new Error('invalid_pipedrive_event');
  const occurred=timestamp(meta.timestamp);
  const result=await pool.query(`INSERT INTO sdr_crm_event_inbox(company_id,event_id,entity,entity_id,action,source_at,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(company_id,event_id) DO NOTHING RETURNING event_id`,
    [String(companyId),String(meta.id),meta.entity,String(meta.entity_id),meta.action,occurred,JSON.stringify(payload)]);
  return {inserted:result.rowCount===1,eventId:String(meta.id)};
}

async function observe(db,{companyId,entity,entityId:recordId,data,sourceAt,origin,eventId=null,action='change',previous=null,lifecycle,mergedToId=null,host=null,accessProofAt=null,eventPayload=null}) {
  const observedAt=(await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
  const proofAt=accessProofAt||observedAt;
  const recordTime=data?sourceTime(data,sourceAt):timestamp(sourceAt);
  const state=lifecycle||(data?.is_archived?'archived':'active');
  const link=sourceUrl(host,entity,recordId,data??(action==='delete'?previous:null));
  const ownReceipt=eventId?(await db.query(`SELECT i.action_id AS "actionId", i.company_id AS "companyId",i.entity,i.entity_id AS "entityId",r.status,r.provider_receipt AS "providerReceipt"
    FROM sdr_change_intents i JOIN sdr_change_receipts r ON r.action_id=i.action_id
    WHERE i.company_id=$1 AND i.entity=$2 AND i.entity_id=$3 AND r.status='confirmed' AND r.provider_receipt->>'eventId'=$4
    ORDER BY r.id DESC LIMIT 1`,[companyId,entity,recordId,eventId])).rows[0]:null;
  const actor=classifyActor({meta:eventPayload?.meta,ownReceipt});
  // A delayed event and its later GET are two distinct pieces of evidence.
  // Never join historical `previous` to hydrated current data as one transaction.
  const historicalData=eventPayload?eventPayload.data:data;
  await db.query(`INSERT INTO sdr_crm_revisions(company_id,entity,entity_id,origin,event_id,source_at,observed_at,action,lifecycle,data,previous,source_url,event_payload,observed_data,actor_evidence,observation_source_at,source_read_started_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17) ON CONFLICT(company_id,event_id) DO NOTHING`,
    [companyId,entity,recordId,origin,eventId,sourceAt,observedAt,action,state,historicalData?JSON.stringify(historicalData):null,previous?JSON.stringify(previous):null,link,
      eventPayload?JSON.stringify(eventPayload):null,data?JSON.stringify(data):null,JSON.stringify(actor),recordTime,proofAt]);
  const result=await db.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,observed_at,lifecycle,merged_to_id,source_event_id,source_url,source_read_started_at)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(company_id,entity,entity_id) DO UPDATE SET data=EXCLUDED.data,source_updated_at=EXCLUDED.source_updated_at,
    observed_at=EXCLUDED.observed_at,source_read_started_at=EXCLUDED.source_read_started_at,
    lifecycle=EXCLUDED.lifecycle,merged_to_id=EXCLUDED.merged_to_id,
    source_event_id=EXCLUDED.source_event_id,source_url=COALESCE(EXCLUDED.source_url,sdr_crm_snapshots.source_url),
    access_status=CASE WHEN EXCLUDED.data IS NOT NULL AND (sdr_crm_snapshots.access_checked_at IS NULL OR sdr_crm_snapshots.access_checked_at<=$11::timestamptz)
      THEN 'accessible' ELSE sdr_crm_snapshots.access_status END,
    access_checked_at=CASE WHEN EXCLUDED.data IS NOT NULL AND (sdr_crm_snapshots.access_checked_at IS NULL OR sdr_crm_snapshots.access_checked_at<=$11::timestamptz)
      THEN now() ELSE sdr_crm_snapshots.access_checked_at END
    WHERE (sdr_crm_snapshots.lifecycle NOT IN ('deleted','merged') OR $11::timestamptz>COALESCE(sdr_crm_snapshots.source_read_started_at,'-infinity'::timestamptz))
      AND (((EXCLUDED.lifecycle='unresolved' OR sdr_crm_snapshots.lifecycle='unresolved')
        AND sdr_crm_snapshots.lifecycle NOT IN ('deleted','merged')
        AND $11::timestamptz>COALESCE(sdr_crm_snapshots.source_read_started_at,'-infinity'::timestamptz))
      OR (EXCLUDED.lifecycle!='unresolved' AND sdr_crm_snapshots.lifecycle!='unresolved' AND (
        EXCLUDED.source_updated_at>sdr_crm_snapshots.source_updated_at
      OR (sdr_crm_snapshots.source_updated_at IS NULL AND EXCLUDED.source_updated_at IS NOT NULL)
      OR (EXCLUDED.source_updated_at IS NOT DISTINCT FROM sdr_crm_snapshots.source_updated_at
        AND sdr_crm_snapshots.lifecycle NOT IN ('deleted','merged')
        AND $11::timestamptz>COALESCE(sdr_crm_snapshots.source_read_started_at,'-infinity'::timestamptz)))))
    RETURNING entity_id`,[companyId,entity,recordId,data?JSON.stringify(data):null,recordTime,observedAt,state,mergedToId,eventId,link,proofAt]);
  if(result.rowCount&&data) {
    await db.query('DELETE FROM sdr_crm_links WHERE company_id=$1 AND entity=$2 AND entity_id=$3',[companyId,entity,recordId]);
    for(const linked of linksFor(entity,recordId,data))await db.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[companyId,entity,recordId,linked.type,linked.id,linked.evidence]);
  }
  if(result.rowCount&&action==='delete'&&previous)for(const linked of linksFor(entity,recordId,previous))await db.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[companyId,entity,recordId,linked.type,linked.id,linked.evidence]);
  if(data)await db.query("UPDATE sdr_crm_snapshots SET access_status='accessible',access_checked_at=now() WHERE company_id=$1 AND entity=$2 AND entity_id=$3 AND (access_checked_at IS NULL OR access_checked_at<=$4::timestamptz)",[companyId,entity,recordId,proofAt]);
  await applyReviewedExclusion(db,companyId,entity,recordId);
  return {updated:result.rowCount===1};
}

export async function processPendingPipedriveEvents(pool,{client,companyId,sourceHost,batchSize=25,leaseSeconds=60,maxAttempts=8,retryDelayMs=30000}={}) {
  if(!client||!companyId)throw new Error('client_and_company_required');
  const count=Math.max(1,Math.min(100,Number(batchSize)||25));
  let processed=0,failed=0;
  const seen=[];
  for(let i=0;i<count;i++) {
    const leaseToken=randomUUID();
    const claimed=await pool.query(`WITH due AS (SELECT company_id,event_id FROM sdr_crm_event_inbox
      WHERE company_id=$1 AND event_id <> ALL($3::text[]) AND ((status='pending' AND retry_at<=now()) OR (status='leased' AND lease_until<=now()))
      ORDER BY received_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE sdr_crm_event_inbox e SET status='leased',lease_until=now()+($2::int*interval '1 second'),lease_token=$4::uuid,attempts=e.attempts+1
      FROM due WHERE e.company_id=due.company_id AND e.event_id=due.event_id RETURNING e.*`,[String(companyId),leaseSeconds,seen,leaseToken]);
    const row=claimed.rows[0];if(!row)break;
    seen.push(row.event_id);
    try {
      let data=null,lifecycle=null;
      const accessProofAt=(await pool.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
      if(row.action==='delete')lifecycle=row.payload?.meta?.merged_to_id?'merged':'deleted';
      else try {data=await client.getEntity(row.entity,row.entity_id);}catch(error){if(error?.status===404)lifecycle='unresolved';else throw error;}
      const applied=await transaction(pool,async db=>{
        const lease=(await db.query("SELECT lease_token FROM sdr_crm_event_inbox WHERE company_id=$1 AND event_id=$2 AND status='leased' FOR UPDATE",[String(companyId),row.event_id])).rows[0];
        if(lease?.lease_token!==leaseToken)return false;
        await observe(db,{companyId:String(companyId),entity:row.entity,entityId:row.entity_id,data,sourceAt:row.source_at,
          origin:'webhook',eventId:row.event_id,action:row.action,previous:row.payload?.previous,eventPayload:row.payload,lifecycle,
          mergedToId:id(row.payload?.meta?.merged_to_id),host:row.payload?.meta?.host||sourceHost||client.sourceHost,accessProofAt});
        await db.query("UPDATE sdr_crm_event_inbox SET status='done',lease_until=NULL,lease_token=NULL,error_category=NULL,processed_at=now() WHERE company_id=$1 AND event_id=$2 AND lease_token=$3::uuid",[String(companyId),row.event_id,leaseToken]);
        return true;
      });if(applied)processed++;
    }catch(error){
      const dead=Number(row.attempts)>=maxAttempts;
      const recorded=await transaction(pool,async db=>{
        const lease=(await db.query("SELECT lease_token FROM sdr_crm_event_inbox WHERE company_id=$1 AND event_id=$2 AND status='leased' FOR UPDATE",[String(companyId),row.event_id])).rows[0];
        if(lease?.lease_token!==leaseToken)return false;
        if(error?.status===401||error?.status===403)await db.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,lifecycle,access_status,access_checked_at,source_read_started_at)
          VALUES($1,$2,$3,'unresolved','denied',statement_timestamp(),statement_timestamp()) ON CONFLICT(company_id,entity,entity_id) DO UPDATE SET
          access_status='denied',access_checked_at=statement_timestamp(),source_read_started_at=statement_timestamp()`,[String(companyId),row.entity,row.entity_id]);
        await db.query(`UPDATE sdr_crm_event_inbox SET status=$3,lease_until=NULL,lease_token=NULL,retry_at=now()+($4::int*interval '1 millisecond'),error_category=$5
          WHERE company_id=$1 AND event_id=$2 AND lease_token=$6::uuid`,[String(companyId),row.event_id,dead?'dead':'pending',retryDelayMs,category(error),leaseToken]);
        return true;
      });if(recorded)failed++;
    }
  }
  return {processed,failed};
}

const overlapSince=value=>value?new Date(new Date(value).getTime()-120000).toISOString():null;
export async function reconcilePipedriveScope(pool,{client,companyId,scope,sourceHost,maxPages=10,full=false}={}) {
  if(!client||!companyId||!CRM_OBSERVATION_SCOPES.includes(scope))throw new Error('invalid_reconciliation_scope');
  const key=String(companyId);
  const saved=(await pool.query('SELECT * FROM sdr_crm_scope_coverage WHERE company_id=$1 AND scope=$2',[key,scope])).rows[0];
  const fullDue=!saved?.last_full_at||Date.now()-new Date(saved.last_full_at).getTime()>=24*60*60*1000;
  const continuing=saved&&saved.status!=='complete'&&saved.cursor&&!(saved.scan_mode==='delta'&&(full||fullDue));
  let cursor=continuing?saved.cursor:null;
  let pages=continuing?Number(saved.pages):0,records=continuing?Number(saved.records):0;
  const windowStart=continuing?saved.window_started_at:new Date().toISOString();
  const scanMode=continuing?saved.scan_mode:(full||fullDue?'full':'delta');
  const since=scanMode==='full'?null:overlapSince(saved?.completed_through);
  const archiveDelta=scope==='leads_archived'&&scanMode==='delta'&&since;
  let lastArchiveTime=continuing&&saved.last_seen_source_at?new Date(saved.last_seen_source_at).getTime():null;
  let status='partial',errorCategory=null;
  const seen=new Set(cursor?[cursor]:[]);
  try {
    for(let i=0;i<Math.max(1,Math.min(100,Number(maxPages)||10));i++) {
      const accessProofAt=(await pool.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
      const page=await client.listScope(scope,{cursor,since});
      if(!page||!Array.isArray(page.items)||!(page.nextCursor===null||typeof page.nextCursor==='string'))throw new Error('invalid_pipedrive_page');
      if(page.nextCursor&&seen.has(page.nextCursor))throw new Error('repeated_pagination_cursor');
      let nextArchiveTime=lastArchiveTime,olderThanCutoff=false;
      if(scope==='leads_archived')for(const item of page.items){
        if(!item?.update_time)throw new Error('missing_archive_update_time');
        const current=new Date(timestamp(item.update_time)).getTime();
        if(nextArchiveTime!==null&&current>nextArchiveTime)throw new Error('archive_sort_inconsistent');
        nextArchiveTime=current;
        if(archiveDelta&&current<new Date(since).getTime())olderThanCutoff=true;
      }
      const nextCursor=archiveDelta&&olderThanCutoff?null:page.nextCursor;
      const nextPages=pages+1,nextRecords=records+page.items.length,nextStatus=nextCursor?'partial':'complete';
      await transaction(pool,async db=>{
        for(const item of page.items) {
          const recordId=id(item?.id);if(!recordId)throw new Error('invalid_pipedrive_entity');
          await observe(db,{companyId:key,entity:scope.startsWith('leads')?'lead':scope.startsWith('deals')?'deal':scope==='activities'?'activity':scope==='notes'?'note':scope==='persons'?'person':'organization',
            entityId:recordId,data:item,sourceAt:sourceTime(item,windowStart),origin:'reconciliation',lifecycle:scope.endsWith('_archived')?'archived':null,
            host:sourceHost||client.sourceHost,accessProofAt});
        }
        await db.query(`INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,cursor,window_started_at,completed_through,pages,records,error_category,completed_at,scan_mode,last_full_at,last_seen_source_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,CASE WHEN $3='complete' THEN now() ELSE NULL END,$9,$10,$11)
          ON CONFLICT(company_id,scope) DO UPDATE SET status=EXCLUDED.status,cursor=EXCLUDED.cursor,window_started_at=EXCLUDED.window_started_at,
          completed_through=EXCLUDED.completed_through,pages=EXCLUDED.pages,records=EXCLUDED.records,
          error_category=CASE WHEN EXCLUDED.status='complete' AND
            (sdr_crm_scope_coverage.error_category IS DISTINCT FROM 'permission' OR sdr_crm_scope_coverage.checked_at<=$12::timestamptz)
            THEN NULL ELSE sdr_crm_scope_coverage.error_category END,
          checked_at=now(),completed_at=EXCLUDED.completed_at,
          scan_mode=EXCLUDED.scan_mode,last_full_at=EXCLUDED.last_full_at,last_seen_source_at=EXCLUDED.last_seen_source_at`,
          [key,scope,nextStatus,nextCursor,windowStart,nextStatus==='complete'?windowStart:saved?.completed_through||null,nextPages,nextRecords,
            scanMode,nextStatus==='complete'&&scanMode==='full'?windowStart:saved?.last_full_at||null,nextCursor&&nextArchiveTime!==null?new Date(nextArchiveTime).toISOString():null,accessProofAt]);
      });
      cursor=nextCursor;pages=nextPages;records=nextRecords;status=nextStatus;lastArchiveTime=nextArchiveTime;
      if(!cursor)break;seen.add(cursor);
    }
  }catch(error){status='error';errorCategory=category(error);
    await pool.query(`INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,cursor,window_started_at,completed_through,pages,records,error_category,scan_mode,last_full_at,last_seen_source_at)
      VALUES($1,$2,'error',$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(company_id,scope) DO UPDATE SET status='error',cursor=EXCLUDED.cursor,window_started_at=EXCLUDED.window_started_at,
      pages=EXCLUDED.pages,records=EXCLUDED.records,
      error_category=CASE WHEN sdr_crm_scope_coverage.error_category='permission' THEN 'permission' ELSE EXCLUDED.error_category END,checked_at=now(),
      scan_mode=EXCLUDED.scan_mode,last_seen_source_at=EXCLUDED.last_seen_source_at`,
      [key,scope,cursor,windowStart,saved?.completed_through||null,pages,records,errorCategory,scanMode,saved?.last_full_at||null,lastArchiveTime===null?null:new Date(lastArchiveTime).toISOString()]);
  }
  return {scope,status,cursor,pages,records,completedThrough:status==='complete'?windowStart:saved?.completed_through||null,...(errorCategory?{errorCategory}:{})};
}

export async function readLeadCrmObservations(pool,{companyId,leadId,limit=100}={}) {
  if(!companyId||!leadId)throw new Error('company_and_lead_required');
  const key=String(companyId),target=String(leadId),n=Math.max(1,Math.min(200,Number(limit)||100));
  const leadRow=(await pool.query(`SELECT entity,entity_id,CASE WHEN access_status='accessible' THEN data ELSE NULL END AS data,
    lifecycle,source_updated_at,observed_at,source_url,is_test,test_evidence,access_status
    FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='lead' AND entity_id=$2`,[key,target])).rows[0]||null;
  const freshness=await readCrmSyncHealth(pool,{companyId:key});
  const scopeDenied=freshness.scopes.some(scope=>scope.errorCategory==='permission');
  const unavailable=scopeDenied?'permission_denied':!leadRow?'not_observed':leadRow.access_status==='denied'?'permission_denied':leadRow.lifecycle==='unresolved'?'unresolved':leadRow.is_test?'reviewed_test':null;
  if(unavailable)return {lead:scopeDenied&&leadRow?{...leadRow,data:null,access_status:'denied'}:leadRow,items:[],revisions:[],hasMore:{items:false,revisions:false},unavailable,source:'pipedrive',freshness};
  const linked=`EXISTS(SELECT 1 FROM sdr_crm_links direct WHERE direct.company_id=s.company_id AND direct.entity=s.entity AND direct.entity_id=s.entity_id AND direct.link_type='lead' AND direct.linked_id=$2)
    OR EXISTS(SELECT 1 FROM sdr_crm_links child JOIN sdr_crm_links deal ON deal.company_id=child.company_id AND deal.entity='deal' AND deal.entity_id=child.linked_id AND deal.link_type='lead' AND deal.linked_id=$2
      JOIN sdr_crm_snapshots parent_deal ON parent_deal.company_id=child.company_id AND parent_deal.entity='deal' AND parent_deal.entity_id=child.linked_id
        AND parent_deal.access_status='accessible' AND parent_deal.lifecycle!='unresolved' AND NOT parent_deal.is_test
      WHERE child.company_id=s.company_id AND child.entity=s.entity AND child.entity_id=s.entity_id AND child.link_type='deal')`;
  const deniedDeal=`NOT EXISTS(SELECT 1 FROM sdr_crm_links child_deal LEFT JOIN sdr_crm_snapshots parent_deal
    ON parent_deal.company_id=child_deal.company_id AND parent_deal.entity='deal' AND parent_deal.entity_id=child_deal.linked_id
    WHERE child_deal.company_id=s.company_id AND child_deal.entity=s.entity AND child_deal.entity_id=s.entity_id AND child_deal.link_type='deal'
      AND (parent_deal.entity_id IS NULL OR parent_deal.access_status!='accessible' OR parent_deal.lifecycle='unresolved' OR parent_deal.is_test))`;
  const snapshots=(await pool.query(`SELECT s.entity,s.entity_id,CASE WHEN s.access_status='accessible' THEN s.data ELSE NULL END AS data,
    s.lifecycle,s.source_updated_at,s.observed_at,s.source_url,s.is_test,s.test_evidence,s.access_status
    FROM sdr_crm_snapshots s WHERE s.company_id=$1 AND s.access_status='accessible' AND NOT s.is_test AND (${linked}) AND ${deniedDeal}
    ORDER BY s.observed_at DESC,s.entity,s.entity_id LIMIT $3`,[key,target,n+1])).rows;
  const revisions=(await pool.query(`SELECT r.entity,r.entity_id,r.origin,r.event_id,r.source_at,r.observed_at,r.action,r.lifecycle,r.data,r.previous,r.source_url,r.event_payload,r.observed_data,r.actor_evidence,r.observation_source_at,r.source_read_started_at
    FROM sdr_crm_revisions r JOIN sdr_crm_snapshots s ON s.company_id=r.company_id AND s.entity=r.entity AND s.entity_id=r.entity_id AND s.access_status='accessible' AND s.lifecycle!='unresolved'
    WHERE r.company_id=$1 AND NOT s.is_test AND (s.entity='lead' AND s.entity_id=$2 OR ${linked}) AND ${deniedDeal}
    ORDER BY r.observed_at DESC,r.id DESC LIMIT $3`,[key,target,n+1])).rows;
  return {lead:leadRow,items:snapshots.slice(0,n),revisions:revisions.slice(0,n),hasMore:{items:snapshots.length>n,revisions:revisions.length>n},source:'pipedrive',freshness};
}

export async function readLeadCrmFollowups(pool,{companyId,leadId,limit=100,activityType=null}={}) {
  if(!companyId||!leadId)throw new Error('company_and_lead_required');
  const result=await readCrmFollowups(pool,{companyId,leadId,limit,activityType});
  return {leadId:String(leadId),...result};
}

export async function readCrmFollowups(pool,{companyId,leadId=null,ownerId=null,lifecycle=null,activityType=null,limit=100,cursor=null,dueView='all',asOf=null,viewer=null,includeContext=false}={}) {
  if(!companyId)throw new Error('company_required');
  if(!['all','current','backlog','later'].includes(dueView))throw new Error('invalid_due_view');
  let page=null;
  if(typeof cursor==='string'&&cursor.startsWith('v1:')){
    try{page=JSON.parse(Buffer.from(cursor.slice(3),'base64url').toString());}catch{throw new Error('invalid_cursor');}
    if(!page||!/^\d{4}-\d{2}-\d{2}$/.test(page.today)||!Number.isInteger(page.rank)||!Number.isSafeInteger(page.day)||typeof page.id!=='string'||page.id.length>200)throw new Error('invalid_cursor');
  }
  const filterKey=JSON.stringify([String(companyId),leadId,ownerId,lifecycle,activityType,dueView,viewer?.role||null,viewer?.sub||null]);
  if(page&&page.filters!==filterKey)throw new Error('invalid_cursor');
  const today=page?.today||asOf||new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(today))throw new Error('invalid_as_of');
  const scope=viewer&&viewer.role!=='admin'?leadVisibilityScope(viewer,'visible'):null;
  if(lifecycle&&!['active','archived','deleted','merged'].includes(lifecycle))throw new Error('invalid_lifecycle');
  const offset=cursor===null||page?0:Number(cursor);
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('invalid_cursor');
  const n=Math.max(1,Math.min(200,Number(limit)||100)),key=String(companyId);
  const freshness=await readCrmSyncHealth(pool,{companyId:key});
  if(freshness.scopes.some(scope=>scope.errorCategory==='permission'))return {items:[],nextCursor:null,unavailable:'permission_denied',source:'pipedrive',freshness};
  const pageParam=scope?'$11':'$10';
  const rows=(await pool.query(`WITH candidates AS (SELECT s.entity_id,s.data,s.source_updated_at,s.observed_at,s.source_url,linked.lead_id,lead.lifecycle AS lead_lifecycle, due.local_date,due.local_time,
    lead.data->>'title' AS lead_title,lead.data AS lead_data,person.data AS person_data
    FROM sdr_crm_snapshots s
    CROSS JOIN LATERAL (SELECT
      CASE WHEN s.data->>'due_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND s.data->>'due_time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
        THEN to_char(((s.data->>'due_date')||'T'||(s.data->>'due_time')||'Z')::timestamptz AT TIME ZONE 'America/Chicago','YYYY-MM-DD')
        ELSE NULLIF(s.data->>'due_date','') END AS local_date,
      CASE WHEN s.data->>'due_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND s.data->>'due_time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
        THEN to_char(((s.data->>'due_date')||'T'||(s.data->>'due_time')||'Z')::timestamptz AT TIME ZONE 'America/Chicago','HH24:MI')
        ELSE NULL END AS local_time) due
    JOIN LATERAL (
      SELECT min(candidate.lead_id) AS lead_id FROM (
      SELECT direct.linked_id AS lead_id FROM sdr_crm_links direct WHERE direct.company_id=s.company_id AND direct.entity=s.entity AND direct.entity_id=s.entity_id AND direct.link_type='lead'
      UNION
      SELECT deal.linked_id AS lead_id FROM sdr_crm_links child JOIN sdr_crm_links deal ON deal.company_id=child.company_id AND deal.entity='deal' AND deal.entity_id=child.linked_id AND deal.link_type='lead'
        JOIN sdr_crm_snapshots parent_deal ON parent_deal.company_id=child.company_id AND parent_deal.entity='deal' AND parent_deal.entity_id=child.linked_id
          AND parent_deal.access_status='accessible' AND parent_deal.lifecycle!='unresolved' AND NOT parent_deal.is_test
        WHERE child.company_id=s.company_id AND child.entity=s.entity AND child.entity_id=s.entity_id AND child.link_type='deal'
      ) candidate HAVING count(DISTINCT candidate.lead_id)=1
    ) linked ON true
    JOIN sdr_crm_snapshots lead ON lead.company_id=s.company_id AND lead.entity='lead' AND lead.entity_id=linked.lead_id
    LEFT JOIN sdr_crm_snapshots person ON person.company_id=lead.company_id AND person.entity='person'
      AND person.entity_id=COALESCE(lead.data->'person_id'->>'value',lead.data->'person_id'->>'id',lead.data->>'person_id')
      AND person.access_status='accessible' AND person.lifecycle='active' AND NOT person.is_test
    WHERE s.company_id=$1 AND s.entity='activity' AND s.lifecycle='active' AND s.access_status='accessible' AND NOT s.is_test
      AND lead.access_status='accessible' AND lead.lifecycle!='unresolved' AND NOT lead.is_test
      AND NOT EXISTS(SELECT 1 FROM sdr_crm_links child_deal LEFT JOIN sdr_crm_snapshots parent_deal
        ON parent_deal.company_id=child_deal.company_id AND parent_deal.entity='deal' AND parent_deal.entity_id=child_deal.linked_id
        WHERE child_deal.company_id=s.company_id AND child_deal.entity=s.entity AND child_deal.entity_id=s.entity_id AND child_deal.link_type='deal'
          AND (parent_deal.entity_id IS NULL OR parent_deal.access_status!='accessible' OR parent_deal.lifecycle='unresolved' OR parent_deal.is_test))
      AND COALESCE((s.data->>'done')::boolean,false)=false
      AND ($3::text IS NULL OR lead.lifecycle=$3)
      AND ($4::text IS NULL OR linked.lead_id=$4)
      AND ($7::text IS NULL OR s.data->>'type'=$7
        OR $7='linkedin_reminder' AND COALESCE(s.data->>'subject','') ~* '(^|[^a-z])linkedin([^a-z]|$)'
        OR $7='non_linkedin' AND COALESCE(s.data->>'subject','') !~* '(^|[^a-z])linkedin([^a-z]|$)')
      AND ($9='all' OR $9='current' AND due.local_date BETWEEN to_char($8::date-14,'YYYY-MM-DD') AND to_char($8::date+7,'YYYY-MM-DD')
        OR $9='backlog' AND due.local_date<to_char($8::date-14,'YYYY-MM-DD')
        OR $9='later' AND (due.local_date IS NULL OR due.local_date>to_char($8::date+7,'YYYY-MM-DD')))
      ${scope?`AND EXISTS(SELECT 1 FROM sdr_lead_state visible WHERE visible.pipedrive_lead_id=linked.lead_id AND visible.crm_company_id=$1 AND ${scope.sql('$10')})`:''}
), ranked AS (SELECT candidates.*,
      CASE WHEN $9='current' THEN CASE WHEN local_date=$8::text THEN 0 WHEN local_date<$8::text THEN 1 ELSE 2 END ELSE 0 END AS sort_rank,
      CASE WHEN local_date IS NULL THEN 9999999 ELSE (local_date::date-DATE '1970-01-01') * CASE WHEN $9='current' AND local_date<$8::text THEN -1 ELSE 1 END END AS sort_day
      FROM candidates)
    SELECT ranked.*,
      (SELECT jsonb_agg(owner) FROM (SELECT COALESCE(data->>'owner_id',data->>'user_id') AS id,
        max(NULLIF(COALESCE(data->>'owner_name',data->>'user_name'),'')) AS name FROM candidates
        WHERE COALESCE(data->>'owner_id',data->>'user_id') IS NOT NULL GROUP BY 1 ORDER BY 1) owner) AS owners
    FROM ranked WHERE ($2::text IS NULL OR COALESCE(data->>'owner_id',data->>'user_id')=$2)
      AND (${pageParam}::jsonb IS NULL OR (sort_rank,sort_day,entity_id) >
        ((${pageParam}::jsonb->>'rank')::int,(${pageParam}::jsonb->>'day')::int,${pageParam}::jsonb->>'id'))
    ORDER BY sort_rank,sort_day,entity_id LIMIT $5 OFFSET $6`,
    [key,id(ownerId),lifecycle,id(leadId),n+1,offset,id(activityType),today,dueView,...(scope?[scope.value]:[]),page?JSON.stringify(page):null])).rows;
  const items=rows.slice(0,n).map(row=>({id:row.entity_id,leadId:row.lead_id,leadTitle:row.lead_title||null,leadLifecycle:row.lead_lifecycle,
    subject:row.data.subject||null,note:row.data.note||null,type:row.data.type||null,ownerId:id(row.data.owner_id??row.data.user_id),
    ownerName:row.data.owner_name||row.data.user_name||null,
    dueDate:row.data.due_date||null,dueTime:row.data.due_time||null,dueLocalDate:row.local_date,dueLocalTime:row.local_time,done:false,
    sourceUpdatedAt:row.source_updated_at,observedAt:row.observed_at,sourceUrl:row.source_url}));
  if(includeContext&&items.length){
    const ids=[...new Set(items.map(item=>item.leadId))];
    const controls=(await pool.query("SELECT id,lead_id,company_id,status,scope_kind,scope_id,channel,reason,provider_stop_status FROM sdr_outreach_controls WHERE company_id=$1 AND status='active' AND (lead_id IS NULL OR lead_id=ANY($2::text[]))",[key,ids])).rows;
    const replies=(await pool.query(`SELECT DISTINCT ON(pipedrive_lead_id) pipedrive_lead_id,received_at,intent,staff_response_at
      FROM sdr_reply_messages WHERE pipedrive_lead_id=ANY($1::text[]) AND link_status='verified' AND reply_kind='human'
      ORDER BY pipedrive_lead_id,received_at DESC,provider_message_id DESC`,[ids])).rows;
    for(const item of items){
      const row=rows.find(row=>row.entity_id===item.id),person=row.person_data;
      const emails=Array.isArray(person?.emails)?person.emails:Array.isArray(person?.email)?person.email:null;
      const email=String(emails?(emails.find(e=>e.primary)||emails[0])?.value||'':person?.primary_email||(typeof person?.email==='string'?person.email:'')||'').trim().toLowerCase()||null;
      const applicable=controls.filter(c=>controlApplies(c,{companyId:key,leadId:item.leadId,recipientEmail:email,channel:'email'}));
      const reply=replies.find(r=>r.pipedrive_lead_id===item.leadId);
      Object.assign(item,{leadOwnerId:entityId(row.lead_data?.owner_id),leadOwnerName:row.lead_data?.owner_name||null,
        contactName:person?.name||null,contactEmail:email,quoteStatus:'unverified',
        restrictions:applicable.filter(c=>c.scope_kind!=='recipient'||email&&c.scope_id.toLowerCase()===email).map(c=>({id:c.id,reason:c.reason,providerStopStatus:c.provider_stop_status})),
        outreachReviewRequired:applicable.length>0||!email,
        lastReply:reply?{receivedAt:reply.received_at,intent:reply.intent,staffResponseAt:reply.staff_response_at}:null});
    }
  }
  const last=rows[n-1];
  const nextCursor=rows.length>n?'v1:'+Buffer.from(JSON.stringify({today,filters:filterKey,rank:last.sort_rank,day:last.sort_day,id:last.entity_id})).toString('base64url'):null;
  return {items,owners:rows[0]?.owners||[],nextCursor,source:'pipedrive',freshness};
}

export async function readCrmSyncHealth(pool,{companyId}={}) {
  if(!companyId)throw new Error('company_required');
  const key=String(companyId);
  const scopes=(await pool.query(`SELECT scope,status,cursor,window_started_at AS "windowStartedAt",completed_through AS "completedThrough",scan_mode AS "scanMode",last_full_at AS "lastFullAt",pages,records,error_category AS "errorCategory",checked_at AS "checkedAt",completed_at AS "completedAt"
    FROM sdr_crm_scope_coverage WHERE company_id=$1 ORDER BY scope`,[key])).rows;
  const inbox=(await pool.query(`SELECT count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='leased')::int AS leased,
    count(*) FILTER(WHERE status='dead')::int AS dead,min(received_at) FILTER(WHERE status IN ('pending','leased')) AS "oldestPendingAt"
    FROM sdr_crm_event_inbox WHERE company_id=$1`,[key])).rows[0];
  return {scopes,inbox,observedAt:new Date().toISOString()};
}
