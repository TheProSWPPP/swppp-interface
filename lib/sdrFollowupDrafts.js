import {createHash} from 'node:crypto';
import {leadVisibilityScope} from './sdrAccess.js';

const fail=(code,current)=>Object.assign(new Error(code),{code,current});
const scalar=value=>{const v=value&&typeof value==='object'?value.id??value.value:null;return ['string','number'].includes(typeof (v??value))?String(v??value):null;};
const plain=value=>Array.from(String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()).slice(0,600).join('');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function readCurrent(db,{companyId,leadId,viewer}){
 if(typeof companyId!=='string'||!companyId||typeof leadId!=='string'||!leadId||leadId.length>200||viewer?.machine||
  !['admin','sdr'].includes(viewer?.role)||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(viewer?.sub||''))throw fail('session_required');
 const user=await db.query('SELECT 1 FROM sdr_users WHERE id=$1 AND role=$2 AND active',[viewer.sub,viewer.role]);
 if(!user.rowCount)throw fail('session_required');
 if((await db.query("SELECT 1 FROM sdr_crm_scope_coverage WHERE company_id=$1 AND error_category='permission' LIMIT 1",[companyId])).rowCount)throw fail('lead_unavailable');
 const scope=leadVisibilityScope(viewer,'visible');
 const lead=(await db.query(`SELECT source.data FROM sdr_lead_state visible
  JOIN sdr_crm_snapshots source ON source.company_id=$1 AND source.entity='lead' AND source.entity_id=visible.pipedrive_lead_id
  WHERE visible.crm_company_id=$1 AND visible.pipedrive_lead_id=$2 AND source.lifecycle='active'
   AND source.access_status='accessible' AND NOT source.is_test AND ${scope.sql('$3')}`,[companyId,leadId,...(scope.requires?[scope.value]:[])])).rows[0];
 if(!lead)throw fail('lead_unavailable');
 const personId=scalar(lead.data?.person_id);
 const person=personId?(await db.query("SELECT data FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='person' AND entity_id=$2 AND lifecycle='active' AND access_status='accessible' AND NOT is_test",[companyId,personId])).rows[0]?.data:null;
 const emails=Array.isArray(person?.emails)?person.emails:Array.isArray(person?.email)?person.email:[];
 const addresses=emails.map(e=>typeof e?.value==='string'?e.value.trim().toLowerCase():'');
 for(const field of [person?.primary_email,person?.email])if(typeof field==='string')addresses.push(field.trim().toLowerCase());
 const holds=(await db.query(`SELECT id,reason,provider_stop_status AS "providerStopStatus",scope_kind AS "scopeKind",scope_id AS "scopeId"
  FROM sdr_outreach_controls WHERE company_id=$1 AND status='active' AND
  (lead_id=$2 OR lead_id IS NULL AND (scope_kind='channel' AND scope_id='email' OR scope_kind='recipient' AND lower(scope_id)=ANY($3::text[]))) ORDER BY id`,[companyId,leadId,addresses])).rows;

 // Only direct, unambiguous project records. Any deal path is withheld, including a
 // second path back to this lead. This deliberately avoids interpreting loose links.
 const records=(await db.query(`SELECT source.entity,source.entity_id,source.data,source.source_updated_at
  FROM sdr_crm_links link JOIN sdr_crm_snapshots source ON source.company_id=link.company_id
   AND source.entity=link.entity AND source.entity_id=link.entity_id
  WHERE link.company_id=$1 AND link.link_type='lead' AND link.linked_id=$2 AND link.entity IN ('note','activity')
   AND source.lifecycle='active' AND source.access_status='accessible' AND NOT source.is_test
     AND (source.entity<>'note' OR regexp_replace(COALESCE(source.data->>'content',''),'<[^>]*>','','g') !~ '^\\[Auto\\] \\[Prepared response — unsent\\]\\[SDR prepared handoff [0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}\\]')
   AND NOT EXISTS(SELECT 1 FROM sdr_crm_links other WHERE other.company_id=link.company_id AND other.entity=link.entity
    AND other.entity_id=link.entity_id AND (other.link_type='deal' OR other.link_type='lead' AND other.linked_id<>$2))
  ORDER BY source.entity,source.entity_id`,[companyId,leadId])).rows;
 const draft=(await db.query(`SELECT subject,body,revision,context_token AS "contextToken",updated_at AS "updatedAt"
  FROM sdr_followup_drafts WHERE company_id=$1 AND lead_id=$2 AND author_id=$3`,[companyId,leadId,viewer.sub])).rows[0]||null;
 const contextToken=hash({companyId,leadId,lead:lead.data,person:person||null,holds,records:records.map(r=>({entity:r.entity,id:r.entity_id,data:r.data,sourceUpdatedAt:r.source_updated_at?.toISOString()||null}))});
 const recent=[...records].sort((a,b)=>String(b.source_updated_at?.toISOString()||'').localeCompare(String(a.source_updated_at?.toISOString()||''))||a.entity_id.localeCompare(b.entity_id)).slice(0,20);
 return {draft,contextToken,contextChanged:Boolean(draft&&draft.contextToken!==contextToken),context:{
  lead:{title:plain(lead.data?.title),ownerId:scalar(lead.data?.owner_id),personId,contactName:plain(person?.name)},
  records:recent.map(r=>({id:r.entity_id,entity:r.entity,subject:plain(r.data?.subject),text:plain(r.entity==='note'?r.data?.content:r.data?.note),textTruncated:String(r.entity==='note'?r.data?.content??'':r.data?.note??'').length>600,type:scalar(r.data?.type),done:r.data?.done===true,dueDate:r.data?.due_date||null,ownerId:scalar(r.data?.owner_id??r.data?.user_id),sourceUpdatedAt:r.source_updated_at})),
  holds:holds.map(h=>({id:h.id,reason:plain(h.reason),providerStopStatus:h.providerStopStatus})),limited:records.length>20,coverage:'partial',orderLink:'unverified'
 }};
}

async function transaction(pool,fn){
 const db=await pool.connect();
 try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const result=await fn(db);await db.query('COMMIT');return result;}
 catch(error){await db.query('ROLLBACK');if(error.code==='40001'||error.code==='23505')throw fail('revision_conflict');throw error;}
 finally{db.release();}
}
export function readFollowupDraft(pool,input){return transaction(pool,db=>readCurrent(db,input));}
export function saveFollowupDraft(pool,input){
 const allowed=['companyId','leadId','viewer','subject','body','expectedRevision','contextToken','acknowledgeContext'];
 if(Object.keys(input).some(key=>!allowed.includes(key))||typeof input.subject!=='string'||input.subject.length>500||typeof input.body!=='string'||!input.body.trim()||input.body.length>20000||
  !Number.isInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.contextToken!=='string'||!/^[a-f0-9]{64}$/.test(input.contextToken)||
  input.acknowledgeContext!==undefined&&typeof input.acknowledgeContext!=='boolean')throw fail('invalid_draft');
 return transaction(pool,async db=>{
  const current=await readCurrent(db,input);
  if((current.draft?.revision||0)!==input.expectedRevision)throw fail('revision_conflict',current);
  if(current.contextToken!==input.contextToken||current.contextChanged&&!input.acknowledgeContext)throw fail('context_changed',current);
  const values=[input.companyId,input.leadId,input.viewer.sub,input.subject,input.body,current.contextToken];
  const saved=input.expectedRevision===0?await db.query(`INSERT INTO sdr_followup_drafts(company_id,lead_id,author_id,subject,body,context_token)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING revision`,values):await db.query(`UPDATE sdr_followup_drafts SET subject=$4,body=$5,context_token=$6,revision=revision+1,updated_at=now()
   WHERE company_id=$1 AND lead_id=$2 AND author_id=$3 AND revision=$7 RETURNING revision`,[...values,input.expectedRevision]);
  if(!saved.rowCount)throw fail('revision_conflict');
  return readCurrent(db,input);
 });
}
