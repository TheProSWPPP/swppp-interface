import {stageCandidate,resolveIdentity,readCandidate} from './sdrLinkedinStore.js';
import {verifyLinkedinWebhook,ingestLinkedinEvent} from './sdrLinkedinSync.js';
import {readLinkedinDraft,saveLinkedinDraft} from './sdrLinkedinDrafts.js';
import {readLinkedinMetrics} from './sdrLinkedinReporting.js';
import {requestLinkedinHostedReconnect,completeLinkedinHostedReconnect} from './sdrLinkedinHosted.js';
import fs from 'node:fs/promises';
import {registerLinkedinAccount,setLinkedinAccountMode,saveLinkedinCampaign,approveLinkedinCampaign,auditLinkedinAdmin} from './sdrLinkedinAdmin.js';
import {stageLane,previewProspectDay,stageMovedContact,defaultCustomerCheck} from './sdrLinkedinProspect.js';
import {importOldCustomers,checkOldCustomers,listOldCustomers} from './sdrLinkedinOldCustomers.js';
import {approveLaneDCopy,draftLaneDLines} from './sdrLinkedinLaneDCopy.js';
import {listReplyAlerts,markReplyAlertHandled} from './sdrLinkedinReplyAlerts.js';
import {createSalesNavSearch,configuredStates} from './sdrLinkedinSearch.js';
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const human=req=>req.sdrUser&&!req.sdrUser.machine&&['admin','sdr'].includes(req.sdrUser.role)&&req.sdrUser.sub;
const error=(res,code,status=503)=>res.status(status).json({error:code});
const adminCodes=new Set(['invalid_account_settings','connected_identity_unverified','sender_changed','invalid_mode','account_unregistered','account_unverified','campaign_config_incomplete','sender_mismatch','budget_above_cap','invalid_expiry','campaign_unavailable','invalid_cohort','cohort_unverified','assignment_unverified','invalid_revision','campaign_already_approved','account_mismatch','cohort_mismatch','campaign_not_approvable','invalid_limit','review_scope_required','invalid_lane','owner_unconfigured','states_unconfigured','apify_unconfigured','apify_empty_result','apify_authentication','apify_budget','apify_rejected','apify_invalid_result','apify_unavailable','apify_actor_unpinned','search_unavailable','company_required','salesnav_search_cap','salesnav_disabled','salesnav_probe_empty','salesnav_unavailable','salesnav_lane_unsupported','candidate_not_in_copy_review','copy_line_required','candidate_unavailable','invalid_request','source_retired','import_scope_required','use_old_customer_check','account_unhealthy']);
const conflicts=new Set(['campaign_revision_conflict','revision_conflict']);
const only=(body,keys)=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(k=>keys.includes(k));
export function registerSdrLinkedinRoutes(app,{pool,companyId='13105180',accountId,mode='disabled',webhookSecret,client,hostedAuthEnabled=false,hostedNotifyUrl,apify=null,upload=null,searchSource='apify',ownerId=null,prospectEnabled=()=>process.env.SDR_LINKEDIN_PROSPECT_ENABLED==='true',states=()=>configuredStates(),customerCheck=defaultCustomerCheck,draftLaneD=draftLaneDLines,readCards,readDeals}={}){
 // Admin-only production writers. Each change is audited; none of them sends anything.
 const admin=(handler)=>async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req)||req.sdrUser.role!=='admin')return error(res,'admin_required',403);if(!pool||!accountId)return error(res,'not_connected');try{return await handler(req,res,req.sdrUser.username||req.sdrUser.sub)}catch(e){if(conflicts.has(e.code))return error(res,e.code,409);if(adminCodes.has(e.code))return res.status(400).json({error:e.code,...(e.detail?{reasons:e.detail}:{})});return error(res,'linkedin_admin_unavailable')}};
 app.post('/api/sdr/linkedin/admin/account',admin(async(req,res,actor)=>{const b=req.body;if(!only(b,['readBudget','timezone']))return error(res,'invalid_request',400);if(!client)return error(res,'not_connected');return res.json(await registerLinkedinAccount({pool,client,companyId,accountId,actor,readBudget:b.readBudget,timezone:b.timezone||'America/Chicago'}))}));
 app.post('/api/sdr/linkedin/admin/account/mode',admin(async(req,res,actor)=>{const b=req.body;if(!only(b,['mode']))return error(res,'invalid_request',400);return res.json(await setLinkedinAccountMode({pool,companyId,accountId,actor,mode:b.mode}))}));
 app.post('/api/sdr/linkedin/admin/campaigns',admin(async(req,res,actor)=>{const b=req.body;if(!only(b,['config','expiresAt','candidateIds']))return error(res,'invalid_request',400);return res.status(201).json(await saveLinkedinCampaign({pool,companyId,accountId,actor,config:b.config,expiresAt:b.expiresAt,candidateIds:b.candidateIds}))}));
 app.post('/api/sdr/linkedin/admin/campaigns/:campaignId',admin(async(req,res,actor)=>{const b=req.body;if(!uuid.test(req.params.campaignId||''))return error(res,'invalid_id',400);if(!only(b,['expectedRevision','config','expiresAt','candidateIds'])||!Number.isInteger(b.expectedRevision))return error(res,'invalid_request',400);return res.json(await saveLinkedinCampaign({pool,companyId,accountId,actor,campaignId:req.params.campaignId,expectedRevision:b.expectedRevision,config:b.config,expiresAt:b.expiresAt,candidateIds:b.candidateIds}))}));
 app.post('/api/sdr/linkedin/admin/campaigns/:campaignId/approve',admin(async(req,res,actor)=>{const b=req.body;if(!uuid.test(req.params.campaignId||''))return error(res,'invalid_id',400);if(!only(b,['expectedRevision'])||!Number.isInteger(b.expectedRevision))return error(res,'invalid_request',400);const row=await approveLinkedinCampaign({pool,companyId,accountId,actor,campaignId:req.params.campaignId,expectedRevision:b.expectedRevision});return res.json({id:row.id,revision:row.revision,status:row.status,approvalDigest:row.approval_digest,cohortDigest:row.cohort_digest,approvedAt:row.approved_at,expiresAt:row.expires_at})}));
 app.post('/api/sdr/linkedin/hosted/reconnect',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req)||req.sdrUser.role!=='admin')return error(res,'admin_required',403);if(req.body&&Object.keys(req.body).length)return error(res,'invalid_request',400);try{return res.json(await requestLinkedinHostedReconnect({pool,client,companyId,accountId,actor:req.sdrUser.sub,notifyUrl:hostedNotifyUrl,enabled:hostedAuthEnabled}))}catch{return error(res,'hosted_auth_unavailable')}});
 app.post('/webhook/sdr-linkedin/hosted',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(k=>!['name','account_id','status'].includes(k)))return error(res,'invalid_callback',400);try{return res.json(await completeLinkedinHostedReconnect({pool,client,companyId,accountId,payload:req.body,enabled:hostedAuthEnabled}))}catch(e){return error(res,e.code==='callback_mismatch'||e.code==='callback_expired_or_reused'?'callback_rejected':'hosted_auth_unavailable',e.code==='callback_mismatch'||e.code==='callback_expired_or_reused'?400:503)}});
 app.post('/webhook/sdr-linkedin',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!verifyLinkedinWebhook({headers:req.headers,secret:webhookSecret}))return error(res,'unauthorized',401);if(!pool||!accountId||!req.body||Buffer.byteLength(JSON.stringify(req.body))>64*1024)return error(res,'webhook_unavailable',503);try{const event=await ingestLinkedinEvent(pool,{companyId,boundAccountId:accountId,payload:req.body});return res.json({accepted:true,id:event.id})}catch(e){return error(res,['account_mismatch','invalid_event','unknown_event'].includes(e.code)?e.code:'webhook_unavailable',e.code?400:503)}});
 app.get('/api/sdr/linkedin/review',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req))return error(res,'session_required',403);if(!pool||!accountId)return error(res,'not_connected');try{const admin=req.sdrUser.role==='admin';const candidates=(await pool.query(`SELECT id,source,source_id,profile_url,segment,territory,firm,role,person_id,owner_id,state,hold_reason,revision,created_at,lane,priority,title_rank,active_30d FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND ($3::text IS NULL OR owner_id=$3) ORDER BY priority,created_at DESC LIMIT 200`,[companyId,accountId,admin?null:req.sdrUser.sub])).rows;const accountRow=(await pool.query('SELECT product,status,status_observed_at,mode,coverage FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,accountId])).rows[0]||null;const account=admin?accountRow:accountRow?{status:accountRow.status,mode:accountRow.mode}:null;return res.json({mode,candidates,account})}catch{return error(res,'not_connected')}});
 app.get('/api/sdr/linkedin/candidates/:candidateId',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req))return error(res,'session_required',403);if(!uuid.test(req.params.candidateId||''))return error(res,'invalid_id',400);try{const row=await readCandidate(pool,{companyId,accountId,candidateId:req.params.candidateId});if(!row||req.sdrUser.role!=='admin'&&row.owner_id!==req.sdrUser.sub)return error(res,'not_found',404);return res.json(row)}catch{return error(res,'not_connected')}});
 app.post('/api/sdr/linkedin/candidates',async(req,res)=>{if(!human(req)||req.sdrUser.role!=='admin')return error(res,'admin_required',403);const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['source','sourceId','observedAt','profileUrl','segment','territory','firm','role'].includes(k)))return error(res,'invalid_candidate',400);try{return res.status(201).json(await stageCandidate(pool,{companyId,accountId,sourceRow:b,actor:req.sdrUser.sub}))}catch(e){return error(res,e.code||'stage_unavailable',e.code?400:503)}});
 app.post('/api/sdr/linkedin/candidates/:candidateId/identity',async(req,res)=>{if(!human(req)||req.sdrUser.role!=='admin')return error(res,'admin_required',403);if(!uuid.test(req.params.candidateId||''))return error(res,'invalid_id',400);const b=req.body;if(!b||!Number.isInteger(b.expectedRevision)||!b.evidence||Object.keys(b).some(k=>!['expectedRevision','evidence'].includes(k)))return error(res,'invalid_identity',400);try{const current=await readCandidate(pool,{companyId,accountId,candidateId:req.params.candidateId});if(!current)return error(res,'not_found',404);return res.json(await resolveIdentity(pool,{candidateId:current.id,expectedRevision:b.expectedRevision,evidence:b.evidence,actor:req.sdrUser.sub}))}catch(e){return error(res,e.code||'identity_unavailable',e.code==='revision_conflict'?409:e.code?400:503)}});
 app.get('/api/sdr/linkedin/drafts/:candidateId',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req))return error(res,'session_required',403);if(!uuid.test(req.params.candidateId||''))return error(res,'invalid_id',400);try{const draft=await readLinkedinDraft(pool,{candidateId:req.params.candidateId,companyId,accountId,viewer:req.sdrUser});return draft?res.json(draft):error(res,'not_found',404)}catch{return error(res,'draft_unavailable')}});
 app.patch('/api/sdr/linkedin/drafts/:draftId',async(req,res)=>{if(!human(req))return error(res,'session_required',403);if(!uuid.test(req.params.draftId||''))return error(res,'invalid_id',400);const b=req.body;if(!b||Object.keys(b).some(k=>!['expectedRevision','contextHash','body'].includes(k))||!Number.isInteger(b.expectedRevision)||typeof b.contextHash!=='string'||typeof b.body!=='string')return error(res,'invalid_draft',400);try{return res.json(await saveLinkedinDraft(pool,{draftId:req.params.draftId,...b,viewer:req.sdrUser,companyId,accountId}))}catch(e){return error(res,e.code||'draft_unavailable',e.code==='revision_conflict'||e.code==='context_changed'?409:e.code==='draft_unavailable'?404:503)}});
 app.get('/api/sdr/linkedin/metrics',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req))return error(res,'session_required',403);const {cohort,from,to}=req.query;if(Object.keys(req.query).some(k=>!['cohort','from','to'].includes(k))||[from,to].some(v=>v&&!Number.isFinite(new Date(v).getTime())))return error(res,'invalid_filter',400);try{return res.json(await readLinkedinMetrics(pool,{companyId,accountId,cohort,from,to,viewer:req.sdrUser}))}catch{return error(res,'metrics_unavailable')}});
 // Prospect lanes (Derek, 2026-11-03). Every route is admin-only unless noted, audited where it
 // changes state, and none of them sends anything on LinkedIn.
 const lanesOf=['A','B','C','D'];
 const salesNav=()=>searchSource==='unipile_salesnav'&&client?createSalesNavSearch({pool,client,companyId,accountId}):null;
 const flag=value=>value===true||value==='1'||value==='true';
 const runStage=({lane,limit,dryRun,actor,currentCompanies})=>stageLane({pool,client,apify,salesNav:dryRun?null:salesNav(),source:dryRun?'apify':searchSource,lane,limit,dryRun,companyId,accountId,actor,ownerId,states:states(),currentCompanies,customerCheck,draftLaneD,readCards,readDeals});
 app.post('/api/sdr/linkedin/admin/lanes/:lane/stage',admin(async(req,res,actor)=>{
  const b=req.body||{},lane=String(req.params.lane||'').toUpperCase();
  if(!only(b,['limit','dryRun','company'])||!lanesOf.includes(lane))return error(res,'invalid_request',400);
  if(lane==='B')return error(res,'use_old_customer_check',400);
  const dryRun=flag(b.dryRun);
  // Real staging spends Apify credit and one seat read per finalist: its own switch. A dry run does neither seat read nor insert.
  if(!dryRun&&!prospectEnabled())return error(res,'prospect_disabled',409);
  if(!apify?.configured||!dryRun&&!client)return error(res,'not_connected');
  if(lane==='C'&&(typeof b.company!=='string'||!b.company.trim()))return error(res,'company_required',400);
  return res.json(await runStage({lane,limit:b.limit??25,dryRun,actor,currentCompanies:lane==='C'?[b.company.trim()]:undefined}));
 }));
 app.post('/api/sdr/linkedin/admin/old-customers/import',admin(async(req,res,actor)=>{
  let csvText=typeof req.body?.csvText==='string'?req.body.csvText:null;
  if(upload&&req.is?.('multipart/form-data')){
   await new Promise((resolve,reject)=>upload.single('file')(req,res,cause=>cause?reject(Object.assign(new Error('invalid_request'),{code:'invalid_request'})):resolve()));
   if(req.file?.path){try{if(req.file.size>5*1024*1024)return error(res,'file_too_large',400);csvText=await fs.readFile(req.file.path,'utf8')}finally{await fs.unlink(req.file.path).catch(()=>{})}}
  }
  if(!csvText)return error(res,'invalid_request',400);
  const dryRun=flag(req.query?.dryRun)||flag(req.body?.dryRun);
  const result=await importOldCustomers(pool,{companyId,csvText,actor,dryRun});
  if(!dryRun)await auditLinkedinAdmin(pool,{companyId,accountId,actor,action:'old_customers.import',targetId:result.importId,detail:{rows:result.rows,inserted:result.inserted,updated:result.updated,errors:result.errors.length}});
  return res.json(result);
 }));
 app.post('/api/sdr/linkedin/admin/old-customers/check',admin(async(req,res,actor)=>{
  const b=req.body||{};if(!only(b,['limit']))return error(res,'invalid_request',400);
  if(!prospectEnabled())return error(res,'prospect_disabled',409);
  if(!apify?.configured||!client)return error(res,'not_connected');
  if(!ownerId)return error(res,'owner_unconfigured',400);
  const result=await checkOldCustomers(pool,{companyId,limit:b.limit??25,apify,actor,
   stageMoved:({row,person})=>stageMovedContact({pool,client,companyId,accountId,actor,ownerId,row,person,states:states()}),
   stageReplacement:({company})=>runStage({lane:'C',limit:10,dryRun:false,actor,currentCompanies:[company]})});
  await auditLinkedinAdmin(pool,{companyId,accountId,actor,action:'old_customers.check',detail:result.counts});
  return res.json(result);
 }));
 app.get('/api/sdr/linkedin/admin/old-customers',admin(async(req,res)=>res.json(await listOldCustomers(pool,{companyId}))));
 // The dry run reads local tables only: no provider call, no seat read.
 app.get('/api/sdr/linkedin/admin/dry-run',admin(async(req,res)=>res.json(await previewProspectDay(pool,{companyId,accountId}))));
 app.post('/api/sdr/linkedin/admin/candidates/:candidateId/lane-d-copy',admin(async(req,res,actor)=>{
  const b=req.body;if(!uuid.test(req.params.candidateId||''))return error(res,'invalid_id',400);
  if(!only(b,['expectedRevision','topic','reaction','decision'])||!Number.isInteger(b.expectedRevision)||!['approve','reject'].includes(b.decision)||b.decision==='approve'&&(typeof b.topic!=='string'||typeof b.reaction!=='string'))return error(res,'invalid_request',400);
  const row=await approveLaneDCopy(pool,{companyId,accountId,candidateId:req.params.candidateId,expectedRevision:b.expectedRevision,topic:b.topic,reaction:b.reaction,decision:b.decision,actor});
  return res.json({id:row.id,state:row.state,revision:row.revision});
 }));
 app.get('/api/sdr/linkedin/replies',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req))return error(res,'session_required',403);if(!pool||!accountId)return error(res,'not_connected');try{return res.json({alerts:await listReplyAlerts(pool,{companyId,accountId,viewer:req.sdrUser})})}catch{return error(res,'not_connected')}});
 app.post('/api/sdr/linkedin/replies/:alertId/handled',async(req,res)=>{res.set?.('Cache-Control','no-store');if(!human(req))return error(res,'session_required',403);if(!uuid.test(req.params.alertId||''))return error(res,'invalid_id',400);if(!pool||!accountId)return error(res,'not_connected');try{return res.json(await markReplyAlertHandled(pool,{companyId,accountId,alertId:req.params.alertId,actor:req.sdrUser.username||req.sdrUser.sub,viewer:req.sdrUser}))}catch(e){return e.code==='not_found'?error(res,'not_found',404):error(res,'not_connected')}});
}
