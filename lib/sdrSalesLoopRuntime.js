import {createGeminiSalesLoopGenerator} from './sdrSalesLoopGenerator.js';

const fail=code=>Object.assign(new Error(code),{code});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const modelName=/^[a-zA-Z0-9_.-]{1,100}$/;

// These are process-local admission limits, not a persisted monetary budget.
export function createSupervisedPreparationPolicy({enabled=false,companyId,reviewerIds=[],apiKey,model,generate,maxAttempts=10,now=Date.now}={}){
 if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>10)throw fail('preparation_configuration');
 const validIds=Array.isArray(reviewerIds)&&reviewerIds.length>0&&reviewerIds.length<=10&&reviewerIds.every(id=>typeof id==='string'&&uuid.test(id));
 const reviewers=new Set(validIds?reviewerIds:[]),attempts=new Map();
 const configured=enabled===true&&companyId==='13105180'&&validIds&&typeof apiKey==='string'&&apiKey.trim()&&typeof model==='string'&&modelName.test(model)&&typeof generate==='function';
 const available=viewer=>Boolean(configured&&!viewer?.machine&&viewer?.role==='admin'&&reviewers.has(viewer.sub));
 return {available,admit(viewer,sourceRef){
  if(!available(viewer))throw fail('preparation_forbidden');
  if(!['crm_note','reviewed_crm_excerpt'].includes(sourceRef?.kind))throw fail('source_not_permitted');
  const at=now();
  if(!Number.isFinite(at))throw fail('preparation_limit');
  const recent=(attempts.get(viewer.sub)||[]).filter(time=>time>at-3600000);
  if(recent.length>=maxAttempts)throw fail('preparation_limit');
  attempts.set(viewer.sub,[...recent,at]);
 }};
}

export function createSalesLoopRuntime({env={},companyId,apiKey,createGenerator=createGeminiSalesLoopGenerator}={}){
 const model=env.SDR_FOLLOWUP_PREPARATION_MODEL;
 const reviewerIds=String(env.SDR_FOLLOWUP_PREPARATION_REVIEWER_IDS||'').split(',').map(id=>id.trim()).filter(Boolean);
 const enabled=env.SDR_FOLLOWUP_PREPARATION_ENABLED==='true'&&companyId==='13105180'&&typeof apiKey==='string'&&Boolean(apiKey.trim())&&typeof model==='string'&&modelName.test(model)&&reviewerIds.length>0&&reviewerIds.length<=10&&reviewerIds.every(id=>uuid.test(id));
 const generate=enabled?createGenerator({apiKey,model}):undefined;
 return {enabled,generate,policy:createSupervisedPreparationPolicy({enabled,companyId,reviewerIds,apiKey,model,generate})};
}
