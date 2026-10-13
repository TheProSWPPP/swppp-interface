import crypto from 'node:crypto';
const INPUT_FIELDS = ['projectName','email','isIndustrial','plansUploaded','dateReceived','dueDate','specialRequirements','latitude','longitude','soilData','endangeredSpecies','waterway','landDisturbanceArea','tceqSegment','county','state','ms4Operator','noiType','waterbodyImpaired','bestManagementPractices','projectAddress','city','projectStartDate','projectFinishDate','projectDescription','swpppProjectDescription','companyName','contactName','phone','customerAddress','sequenceActivities','stateTemplateId','stateTemplateName','countyFips','24hrTurnaround','needHardCopy','certifiedInspection','eportalAccess','invoiceTotal','civilDrawingsLink'];
export const DOCUMENT_KEYS = ['swppp','cover_letter','site_notice','noi','not','job_order'];
const SERVER_FIELDS = new Set(['id','generation','generationState','generationRunId','generationContextDigest','contextDigest','runId','__expectedValues','__proto__','constructor','prototype']);
export const resultsEnabled = () => process.env.PROJECT_GENERATION_RESULTS_ENABLED === 'true';
function fail(message,status=400,extra={}){throw Object.assign(new Error(message),{status,...extra});}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value??null;}
const canonical = value => JSON.stringify(stable(value));
export function projectContextDigest(project){return crypto.createHash('sha256').update(canonical(Object.fromEntries(INPUT_FIELDS.map(k=>[k,project[k]??null])))).digest('hex');}
export function stripGenerationMetadata(value){return Object.fromEntries(Object.entries(value||{}).filter(([k])=>!SERVER_FIELDS.has(k)));}
export function projectGenerationView(project){return {...project,generationState:project.generation ? (projectContextDigest(project)===project.generation.contextDigest?'current':'stale'):'legacy'};}
export function mergeProjectPatch(project,updates,expectedValues){
 const patch=stripGenerationMetadata(updates);
 if(expectedValues!==undefined){if(!expectedValues||Array.isArray(expectedValues)||typeof expectedValues!=='object')fail('Invalid expected field values');
  const conflicts=Object.keys(patch).filter(k=>!Object.hasOwn(expectedValues,k)||canonical(project[k])!==canonical(expectedValues[k]));
  if(conflicts.length)fail('These fields changed since you opened the project',409,{conflicts,project:projectGenerationView(project)});
 }
 return {...project,...patch,id:project.id};
}
function exactKeys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('Unknown result fields');}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))fail(`Invalid ${label}`);return value;}
function fileUrl(value,provider){text(value,2048,'file URL');let url;try{url=new URL(value);}catch{fail('Invalid file URL');}if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)fail('Unsafe file URL');
 const path=url.pathname;
 const allowed=provider==='dropbox'&&['dropbox.com','www.dropbox.com'].includes(url.hostname)&&/^\/(?:s\/[^/]+\/[^/]+|scl\/fi\/[^/]+\/[^/]+)$/.test(path)
  ||provider==='google_drive'&&url.hostname==='drive.google.com'&&/^\/file\/d\/[^/]+\/(?:view|preview)$/.test(path);
 if(!allowed)fail('Individual supported file URL required');return url.toString();
}
export function normalizeResultEvent(body){
 if(Buffer.byteLength(JSON.stringify(body??null))>16384)fail('Result event too large',413);
 exactKeys(body,['eventId','runId','contextDigest','outputs']);
 const result={eventId:text(body.eventId,128,'event ID'),runId:text(body.runId,128,'run ID'),contextDigest:text(body.contextDigest,64,'context digest'),outputs:[]};
 if(!/^[a-f0-9]{64}$/.test(result.contextDigest))fail('Invalid context digest');
 if(!Array.isArray(body.outputs)||body.outputs.length<1||body.outputs.length>DOCUMENT_KEYS.length)fail('Invalid document results');
 const seen=new Set();
 result.outputs=body.outputs.map(o=>{exactKeys(o,['documentKey','outcome','provider','fileId','path','url','reasonCode','reason']);if(!DOCUMENT_KEYS.includes(o.documentKey)||seen.has(o.documentKey))fail('Unknown or duplicate document');seen.add(o.documentKey);
  if(o.outcome==='produced'){
   if(o.reasonCode!==undefined||o.reason!==undefined||!['dropbox','google_drive'].includes(o.provider))fail('Invalid produced result');
   const fileId=text(o.fileId,256,'file ID'),path=text(o.path,1024,'file path');if(!path.startsWith('/')||path.split('/').some(p=>p==='..'||p==='.')||path.endsWith('/')||path.includes('\\'))fail('Invalid file path');
   return {documentKey:o.documentKey,outcome:o.outcome,provider:o.provider,fileId,path,url:fileUrl(o.url,o.provider)};
  }
  if(!['failed','not_configured','review_required'].includes(o.outcome)||['provider','fileId','path','url'].some(k=>o[k]!==undefined))fail('Invalid document outcome');
  const reasonCode=text(o.reasonCode,64,'reason code');if(!/^[a-z0-9_]+$/.test(reasonCode))fail('Invalid reason code');
  return {documentKey:o.documentKey,outcome:o.outcome,reasonCode,reason:text(o.reason,300,'reason')};
 }).sort((a,b)=>a.documentKey.localeCompare(b.documentKey));return result;
}
export function applyResultEvent(project,body){
 const event=normalizeResultEvent(body),g=project.generation;
 if(!g||g.runId!==event.runId||g.contextDigest!==event.contextDigest||projectContextDigest(project)!==g.contextDigest)fail('Generation run or source context is no longer current',409);
 const prior=g.events.find(e=>e.eventId===event.eventId),digest=crypto.createHash('sha256').update(canonical(event)).digest('hex');
 if(prior){if(prior.digest!==digest)fail('Event ID conflicts with recorded result',409);return {project,duplicate:true};}
 if(g.events.length>=64)fail('Generation event limit reached',409);
 for(const o of event.outputs){if(g.outputs[o.documentKey]&&canonical(g.outputs[o.documentKey])!==canonical(o))fail('Document result already recorded',409);}
 return {project:{...project,generation:{...g,outputs:{...g.outputs,...Object.fromEntries(event.outputs.map(o=>[o.documentKey,o]))},events:[...g.events,{eventId:event.eventId,digest,receivedAt:new Date().toISOString()}]}},duplicate:false};
}
export async function mutateProject(pool,id,transform){
 const client=await pool.connect();try{await client.query('BEGIN');const r=await client.query('SELECT data, archived FROM projects WHERE id=$1 FOR UPDATE',[id]);if(!r.rows.length||r.rows[0].archived)fail('Project not found',404);const result=await transform(r.rows[0].data);await client.query('UPDATE projects SET name=$1,status=$2,data=$3 WHERE id=$4',[result.project.projectName,result.project.status,result.project,id]);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function updateProject(pool,id,updates,{expectedValues,enabled=resultsEnabled()}={}){
 return mutateProject(pool,id,current=>{let project=mergeProjectPatch(current,updates,expectedValues);const trigger=project.status!==current.status&&['Approved for Generation','Manual Processing'].includes(project.status);
 if(trigger&&project.status==='Approved for Generation'&&enabled)project={...project,generation:{schemaVersion:1,runId:crypto.randomUUID(),contextDigest:projectContextDigest(project),approvedAt:new Date().toISOString(),outputs:{},events:[]}};
 return {project,trigger};});
}
export async function mergePlanAnalysis(pool,id,analysis){return mutateProject(pool,id,current=>({project:{...current,planAnalysisSummary:analysis.summary||'',planAnalysisDate:new Date().toISOString(),planAnalysisRaw:analysis}}));}
export function callbackSecretValid(supplied,secret){if(typeof supplied!=='string'||typeof secret!=='string'||!secret)return false;const a=Buffer.from(supplied),b=Buffer.from(secret);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
export function registerGenerationResultRoute(app,{pool,secret,enabled=resultsEnabled}){app.post('/api/projects/:id/generation-results',async(req,res)=>{
 if(!enabled())return res.status(404).json({error:'Document results are not enabled'});
 if(!callbackSecretValid(req.get('X-N8N-Callback-Secret'),secret))return res.status(401).json({error:'Invalid callback authorization'});
 if(!pool)return res.status(503).json({error:'Document result storage unavailable'});
 try{const result=await mutateProject(pool,req.params.id,p=>applyResultEvent(p,req.body));return res.json({project:projectGenerationView(result.project),duplicate:result.duplicate});}catch(e){return res.status(e.status||500).json({error:e.status?e.message:'Unable to record document result'});}
 });}
