import { createHash } from 'node:crypto';

const text=value=>value===undefined||value===null||value===''?null:String(value);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export function classifyActor({meta={},ownReceipt=null,authenticatedAction=null}={}) {
  const local=authenticatedAction?.authenticated===true?authenticatedAction:null;
  const matched=ownReceipt?.status==='confirmed'&&text(ownReceipt.actionId)&&text(meta.id)&&
    text(ownReceipt.companyId)===text(meta.company_id)&&text(ownReceipt.entity)===text(meta.entity)&&text(ownReceipt.entityId)===text(meta.entity_id)&&
    text(ownReceipt.providerReceipt?.eventId)===text(meta.id);
  return {
    source:meta.change_source==='app'?'pipedrive_app':meta.change_source==='api'?'pipedrive_api':local?.execution==='interactive'?'sdr_ui':local?.execution==='automatic'?'service':'unknown',
    accountId:text(meta.user_id??local?.accountId),actionId:matched?text(ownReceipt.actionId):text(local?.actionId),
    execution:local&&['interactive','automatic'].includes(local.execution)?local.execution:'unknown',
    ownership:matched?'matched_own_receipt':'external_or_unknown',
  };
}

export function canonicalDecisionContext(input={}) {
  const context={};
  for(const key of ['companyId','leadId','personId','recipientEmail','organizationId','personOrganizationId','projectRole','stage','trigger','mailboxId','sequenceId','scheduledFor','overrideDecisionId','roleExceptionId','cadence'])context[key]=text(input[key]);
  if(context.recipientEmail)context.recipientEmail=context.recipientEmail.trim().toLowerCase()||null;
  if(context.scheduledFor&&Number.isFinite(Date.parse(context.scheduledFor)))context.scheduledFor=new Date(context.scheduledFor).toISOString();
  context.cadence=context.cadence||'review';
  return context;
}
export const hashDecisionContext=input=>createHash('sha256').update(JSON.stringify(canonicalDecisionContext(input))).digest('hex');
export function hashContextDependencies(input) {
  const dependencies=canonicalDecisionContext(input);
  for(const key of ['projectRole','cadence','roleExceptionId','overrideDecisionId'])delete dependencies[key];
  return createHash('sha256').update(JSON.stringify(dependencies)).digest('hex');
}


export async function recordChangeIntent(db,{actionId,companyId,entity,entityId,expectedFields,proposedFields,actor,reason,contextHash}) {
  if(![actionId,companyId,entity,entityId,reason,contextHash].every(text)||!expectedFields||!proposedFields||!actor)throw Error('change_intent_required');
  // No conflict update: reusing an action ID must never overwrite earlier evidence.
  await db.query(`INSERT INTO sdr_change_intents(action_id,company_id,entity,entity_id,expected_fields,proposed_fields,actor,reason,context_hash)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,[String(actionId),String(companyId),entity,String(entityId),JSON.stringify(expectedFields),JSON.stringify(proposedFields),JSON.stringify(actor),reason,contextHash]);
  return {actionId:String(actionId)};
}
export async function recordChangeReceipt(db,{actionId,status,providerReceipt=null,observedFields=null}) {
  if(!actionId||!['confirmed','unresolved','failed','superseded','protected_external_state'].includes(status))throw Error('invalid_change_receipt');
  await db.query(`INSERT INTO sdr_change_receipts(action_id,status,provider_receipt,observed_fields) VALUES($1,$2,$3::jsonb,$4::jsonb)`,
    [String(actionId),status,JSON.stringify(providerReceipt),JSON.stringify(observedFields)]);
}

// One SQL statement supplies one MVCC snapshot. Provider reads are never claimed
// to be conditional-write guarantees. Missing source or reviewed role stays partial.
export async function readDecisionContext(pool,leadId,{companyId=null,draftId=null}={}) {
  const rows=(await pool.query(`SELECT to_jsonb(l) AS local, to_jsonb(s) AS lead,
    to_jsonb(p) AS person, to_jsonb(o) AS organization, to_jsonb(d) AS draft,
    EXISTS(SELECT 1 FROM sdr_crm_scope_coverage c WHERE c.company_id=s.company_id AND c.error_category='permission'
      AND c.scope IN ('leads_active','leads_archived','persons','organizations')) AS scope_denied
    FROM (SELECT $1::text AS lead_id) request
    LEFT JOIN sdr_lead_state l ON l.pipedrive_lead_id=request.lead_id AND ($2::text IS NULL OR l.crm_company_id IS NULL OR l.crm_company_id=$2)
    LEFT JOIN sdr_crm_snapshots s ON s.entity='lead' AND s.entity_id=request.lead_id AND ($2::text IS NULL OR s.company_id=$2)
    LEFT JOIN sdr_crm_snapshots p ON p.company_id=s.company_id AND p.entity='person' AND p.entity_id=COALESCE(s.data->'person_id'->>'id',s.data->>'person_id')
    LEFT JOIN sdr_crm_snapshots o ON o.company_id=s.company_id AND o.entity='organization' AND o.entity_id=COALESCE(s.data->'organization_id'->>'id',s.data->>'organization_id')
    LEFT JOIN LATERAL (SELECT * FROM sdr_drafts candidate WHERE candidate.pipedrive_lead_id=request.lead_id
      AND ($3::text IS NULL AND candidate.status IN ('pending','approved','edited') OR candidate.id::text=$3)
      ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1) d ON true`,[String(leadId),text(companyId),text(draftId)])).rows;
  const row=rows.length===1?rows[0]:{};
  const accessible=s=>s?.access_status==='accessible'&&s.lifecycle==='active'&&!s.is_test;
  const lead=accessible(row.lead)?row.lead.data:null, person=accessible(row.person)?row.person.data:null;
  const local=row.local||{},review=local.safety_context||{},draft=row.draft||{};
  const hasTriggerOverride=Boolean(text(local.trigger_override));
  const identity=value=>text(value&&typeof value==='object'?value.id:value);
  const primary=Array.isArray(person?.email)?(person.email.find(e=>e.primary)||person.email[0])?.value:person?.primary_email||person?.email;
  const context=canonicalDecisionContext({companyId:companyId??row.lead?.company_id,leadId,personId:identity(lead?.person_id),organizationId:identity(lead?.organization_id),personOrganizationId:identity(person?.org_id),recipientEmail:primary,
    projectRole:review.projectRole,stage:lead?.['7c1852c27664d1118f75660223a6af9e99d10f2c'],trigger:local.trigger_override??local.trigger_type,
    mailboxId:draft.assigned_mailbox_id,sequenceId:draft.apollo_sequence_id,scheduledFor:draft.scheduled_for,
    overrideDecisionId:hasTriggerOverride?review.overrideDecisionId:null,roleExceptionId:review.roleExceptionId,cadence:review.cadence});
  const reviewed=Boolean(review.identityHash===hashContextDependencies(context)&&text(review.evidence));
  const technicalComplete=Boolean((!local.crm_company_id||local.crm_company_id===context.companyId)&&[row.lead,row.person,row.organization].every(s=>s?.source_updated_at)&&!row.scope_denied&&lead&&person&&accessible(row.organization)&&context.companyId&&context.personId&&context.organizationId&&context.recipientEmail&&context.stage&&context.trigger&&context.mailboxId&&context.sequenceId&&(!hasTriggerOverride||context.overrideDecisionId));
  const businessReviewed=Boolean(reviewed&&context.projectRole&&context.roleExceptionId&&['award_only','standard'].includes(context.cadence));
  const complete=technicalComplete&&businessReviewed;
  const revisionEvidence=[row.lead,row.person,row.organization].map(s=>s?{source:s.source_updated_at,read:s.source_read_started_at,access:s.access_status,lifecycle:s.lifecycle}:null);
  const contextHash=hashDecisionContext(context);
  const reviewEvidence=reviewed?{status:'reviewed',contextHash,evidence:review.evidence,actor:review.actor??null}:{status:'unknown'};
  return {...context,draftId:text(draft.id),draftRevision:Number.isInteger(draft.revision)?draft.revision:null,hasTriggerOverride,reviewEvidence,technicalComplete,businessReviewed,sourceRevision:createHash('sha256').update(JSON.stringify(stable(revisionEvidence))).digest('hex'),complete,contextHash};
}
