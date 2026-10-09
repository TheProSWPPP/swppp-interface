import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFollowupDraft} from './sdrFollowupDrafts.js';
import {leadVisibilityScope} from './sdrAccess.js';
const fail=code=>Object.assign(new Error(code),{code});
const scalar=v=>String(v?.id??v?.value??v??'');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const activeNote=n=>n&&n.deleted!==true&&n.is_deleted!==true&&n.active_flag!==false;
// Only the provider's equivalent line-break spellings normalize; every other byte is exact.
const samePreparedContent=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.replace(/<br(?: ?\/)?>/g,'<br>')===b.replace(/<br(?: ?\/)?>/g,'<br>');
const prepared=n=>/^\[Auto\] \[Prepared response — unsent\]\[SDR prepared handoff [0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\]/.test(String(n.content||'').replace(/<[^>]*>/g,''));
export function createFollowupHandoffs({pool,companyId,sourceHost,client,now=()=>new Date()}){
 if(!pool||!/^\d+$/.test(String(companyId))||sourceHost!=='proswpppllc.pipedrive.com')throw fail('handoff_configuration');
 const secret=randomBytes(32),projectUrl=id=>`https://${sourceHost}/leads/inbox/${encodeURIComponent(id)}`;
 const sign=payload=>{const data=Buffer.from(JSON.stringify(payload)).toString('base64url');return data+'.'+createHmac('sha256',secret).update(data).digest('hex');};
 const unpack=token=>{try{const [data,sig]=String(token).split('.'),wanted=createHmac('sha256',secret).update(data).digest('hex');if(sig?.length!==wanted.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(wanted)))throw Error();const value=JSON.parse(Buffer.from(data,'base64url'));if(value.expires<+now())throw Error();return value;}catch{throw fail('preview_expired');}};
 const receipt=row=>({id:row.id,status:row.status,noteId:row.provider_note_id,readbackVerified:row.readback_verified,projectUrl:projectUrl(row.lead_id),checkedAt:row.checked_at,revision:row.revision,...(row.status==='not_attempted'?{reason:'preview_expired'}:{})});
 const auth=input=>readFollowupDraft(pool,{companyId:String(companyId),leadId:input.leadId,viewer:input.viewer});
 const existing=async input=>(await pool.query('SELECT * FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2 AND author_id=$3 AND revision=$4',[String(companyId),input.leadId,input.viewer.sub,input.expectedRevision])).rows[0];
 async function unresolved(input){if((await pool.query("SELECT 1 FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2 AND status IN ('reserved','uncertain')",[String(companyId),input.leadId])).rowCount)throw fail('publication_unresolved');}
 function checkDraft(current,input){if(!current.draft||current.draft.revision!==input.expectedRevision)throw fail('revision_conflict');if(current.contextChanged||current.contextToken!==input.contextToken)throw fail('context_changed');}
 async function live(input,current){
  await client.validateIdentity();const e=await client.readEvidence(input.leadId);
  if(!e.complete||scalar(e.lead?.id)!==input.leadId||e.lead.is_archived!==false||e.lead.deleted===true||e.lead.is_deleted===true||!scalar(e.lead.owner_id)||!e.person||scalar(e.person.id)!==scalar(e.lead.person_id)||e.person.active_flag===false||e.person.deleted===true||e.person.is_deleted===true)throw fail('source_unavailable');
  if(scalar(e.lead.owner_id)!==current.context.lead.ownerId||scalar(e.person.id)!==current.context.lead.personId)throw fail('context_changed');
  if(!Array.isArray(e.notes)||!Array.isArray(e.activities)||e.notes.some(n=>scalar(n.lead_id)!==input.leadId)||e.activities.some(a=>scalar(a.lead_id)!==input.leadId))throw fail('source_unavailable');
  const records={...e,notes:e.notes.filter(n=>!prepared(n)).sort((a,b)=>scalar(a.id).localeCompare(scalar(b.id))),activities:[...e.activities].sort((a,b)=>scalar(a.id).localeCompare(scalar(b.id)))};
  const addresses=Array.isArray(e.person.emails)?e.person.emails:Array.isArray(e.person.email)?e.person.email:[];const address=(addresses.find(x=>x.primary)||addresses[0])?.value;
  if(!address||typeof address!=='string')throw fail('source_unavailable');
  return {evidence:records,liveHash:hash({...records,preparedNotes:e.notes.filter(prepared)}),owner:{id:scalar(e.lead.owner_id),name:e.lead.owner_id?.name||null},contact:{id:scalar(e.person.id),name:e.person.name||null,email:address}};
 }
 function render(current,data,p){
  const lines=['[Auto] [Prepared response — unsent]',`[SDR prepared handoff ${p.id}]`,`Prepared by SDR user ${p.author}. Review the current conversation and recipient before sending.`,`Project: ${data.evidence.lead.title||p.leadId}`,`Contact: ${data.contact.name||''} <${data.contact.email}>`,`Current owner ID: ${data.owner.id}`,`CRM checked: ${p.checkedAt}`,'Email reply coverage is unverified. The publisher must confirm their own latest-conversation review.','Active contact restrictions:',...(current.context.holds.length?current.context.holds.map(h=>`${h.reason}; provider stop: ${h.providerStopStatus}. Queued provider mail may still send.`):['None recorded in the available local evidence.']),'Proposed subject:',current.draft.subject,'Proposed message:',current.draft.body,'Existing tasks (unchanged):',...data.evidence.activities.filter(a=>!a.done).map(a=>`Task ${a.id}: ${a.subject||''}; due ${a.due_date||'undated'} ${a.due_time||''}; owner ${scalar(a.owner_id??a.user_id)}`),'CRM note excerpts (up to five, not send receipts):',...data.evidence.notes.slice(-5).map(n=>`Note ${n.id}: ${String(n.content||'').replace(/<[^>]*>/g,' ').slice(0,500)}`),`Project: ${projectUrl(p.leadId)}`];
  const html=lines.map(line=>escape(line).replace(/\r?\n/g,'<br>')).join('<br>');if(Buffer.byteLength(html,'utf8')>90000)throw fail('handoff_too_large');return html;
 }
 async function preview(input){
  const current=await auth(input);const prior=await existing(input)||(await pool.query("SELECT * FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2 AND author_id=$3 AND status IN ('reserved','uncertain')",[String(companyId),input.leadId,input.viewer.sub])).rows[0];if(prior)return {publication:receipt(prior),revision:prior.revision,replyCoverage:'unverified',requiresLatestConversationReview:true};
  checkDraft(current,input);await unresolved(input);const data=await live(input,current);const p={id:randomUUID(),companyId:String(companyId),leadId:input.leadId,author:input.viewer.sub,revision:input.expectedRevision,contextToken:input.contextToken,draftHash:hash(current.draft),liveHash:data.liveHash,checkedAt:now().toISOString(),expires:+now()+5*60000,publicationVersion:Number((await pool.query('SELECT count(*) AS n FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2',[String(companyId),input.leadId])).rows[0].n)};
  return {previewToken:sign(p),revision:p.revision,content:{subject:current.draft.subject,body:current.draft.body},noteHtml:render(current,data,p),owner:data.owner,contact:data.contact,leadId:input.leadId,checkedAt:p.checkedAt,replyCoverage:'unverified',requiresLatestConversationReview:true,sharesWith:'Users able to view this Pipedrive project',publication:null};
 }
 async function publish(input){
  let current=await auth(input);const prior=await existing(input);if(prior)return receipt(prior);
  if(input.latestConversationReviewed!==true)throw fail('conversation_review_required');checkDraft(current,input);await unresolved(input);
  const p=unpack(input.previewToken);if(p.companyId!==String(companyId)||p.leadId!==input.leadId||p.author!==input.viewer.sub||p.revision!==input.expectedRevision||p.contextToken!==input.contextToken||p.draftHash!==hash(current.draft))throw fail('context_changed');
  const data=await live(input,current);if(data.liveHash!==p.liveHash)throw fail('context_changed');current=await auth(input);checkDraft(current,input);if(hash(current.draft)!==p.draftHash)throw fail('revision_conflict');
  const content=render(current,data,p),db=await pool.connect();let row;
  try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`handoff:${companyId}:${input.leadId}`]);
   row=(await db.query('SELECT * FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2 AND author_id=$3 AND revision=$4',[String(companyId),input.leadId,input.viewer.sub,p.revision])).rows[0];
   if(row){await db.query('COMMIT');return receipt(row);}
   if((await db.query("SELECT 1 FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2 AND status IN ('reserved','uncertain')",[String(companyId),input.leadId])).rowCount)throw fail('publication_unresolved');
   if(Number((await db.query('SELECT count(*) AS n FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2',[String(companyId),input.leadId])).rows[0].n)!==p.publicationVersion)throw fail('context_changed');
   const scope=leadVisibilityScope(input.viewer,'visible');
   const locked=(await db.query(`SELECT d.* FROM sdr_followup_drafts d JOIN sdr_users u ON u.id=d.author_id AND u.active AND u.role=$5 JOIN sdr_lead_state visible ON visible.pipedrive_lead_id=d.lead_id AND visible.crm_company_id=d.company_id WHERE d.company_id=$1 AND d.lead_id=$2 AND d.author_id=$3 AND d.revision=$4 AND ${scope.sql('$6')} FOR UPDATE OF d`,[String(companyId),input.leadId,input.viewer.sub,p.revision,input.viewer.role,...(scope.requires?[scope.value]:[])])).rows[0];
   if(!locked||locked.context_token!==input.contextToken||locked.subject!==current.draft.subject||locked.body!==current.draft.body)throw fail('revision_conflict');
   if(p.expires<+now())throw fail('preview_expired');
   row=(await db.query(`INSERT INTO sdr_followup_handoffs(id,company_id,lead_id,author_id,revision,context_token,live_hash,content,evidence,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[p.id,String(companyId),input.leadId,input.viewer.sub,p.revision,p.contextToken,p.liveHash,content,{owner:data.owner,contact:data.contact,sourceCheckedAt:p.checkedAt,replyCoverage:'unverified',latestConversationReviewed:true,reviewBasis:'human_assertion',sourceEvidence:data.evidence},now()])).rows[0];await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  let noteId=null,verified=false,notAttempted=false;
  try{if(p.expires<+now()){notAttempted=true;throw fail('preview_expired');}const result=await client.addNote({leadId:input.leadId,content});noteId=result?.id?String(result.id):null;if(noteId){const note=await client.getNote(noteId);verified=activeNote(note)&&scalar(note.id)===noteId&&scalar(note.lead_id)===input.leadId&&samePreparedContent(note.content,content);}}catch{/* Unknown completion is never retried. */}
  const updated=(await pool.query("UPDATE sdr_followup_handoffs SET status=$2,provider_note_id=$3,readback_verified=$4,checked_at=now() WHERE id=$1 RETURNING *",[row.id,notAttempted?'not_attempted':verified?'confirmed':'uncertain',noteId,verified])).rows[0];return receipt(updated);
 }
 async function reconcile(input){
  await auth(input);const row=(await pool.query('SELECT * FROM sdr_followup_handoffs WHERE id=$1 AND company_id=$2 AND lead_id=$3 AND author_id=$4',[input.handoffId,String(companyId),input.leadId,input.viewer.sub])).rows[0];if(!row)throw fail('handoff_unavailable');if(['confirmed','not_attempted'].includes(row.status))return receipt(row);
  await client.validateIdentity();let candidates;
  try{if(row.provider_note_id)candidates=[await client.getNote(row.provider_note_id)];else{const page=await client.listNotes(row.lead_id);if(!page.complete)return receipt(row);candidates=page.items;}}catch{return receipt(row);}
  const found=candidates.filter(n=>activeNote(n)&&n.id&&scalar(n.lead_id)===row.lead_id&&samePreparedContent(n.content,row.content));if(found.length!==1)return receipt(row);
  return receipt((await pool.query("UPDATE sdr_followup_handoffs SET status='confirmed',provider_note_id=$2,readback_verified=true,checked_at=now() WHERE id=$1 RETURNING *",[row.id,String(found[0].id)])).rows[0]);
 }
 return {preview,publish,reconcile};
}
