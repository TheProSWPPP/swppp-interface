// One durable claim per imported row. A timeout never authorizes creating the lead again.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status})};
const ordered=x=>Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x??null;
const stable=x=>JSON.stringify(ordered(x));
export async function ensureImportReceipts(pool){await pool.query(`CREATE TABLE IF NOT EXISTS lead_import_receipts (
 row_id uuid PRIMARY KEY REFERENCES lead_import_rows(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES lead_import_jobs(id) ON DELETE CASCADE,
 attempt_id text NOT NULL, state text NOT NULL CHECK(state IN ('started','confirmed','review_required')),
 source_snapshot jsonb NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
)`)}
async function transaction(pool,fn){const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}}
const source=row=>({raw_data:row.raw_data,cleaned_data:row.cleaned_data});
function identity({jobId,rowId,attemptId}){if(!UUID.test(jobId||'')||!UUID.test(rowId||'')||typeof attemptId!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(attemptId))fail('Invalid import attempt',400)}
export async function claimImportRow(pool,input){identity(input);const {jobId,rowId,attemptId}=input;return transaction(pool,async db=>{
 const job=(await db.query('SELECT status FROM lead_import_jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];if(!job)fail('Import job not found',404);if(job.status!=='uploading')fail('Import job is not uploading');
 const row=(await db.query('SELECT * FROM lead_import_rows WHERE id=$1 AND job_id=$2 FOR UPDATE',[rowId,jobId])).rows[0];if(!row)fail('Import row not found',404);
 if(row.status!=='approved'||row.pipedrive_lead_id)fail('Import row is not eligible');
 const claimed=await db.query("INSERT INTO lead_import_receipts(row_id,job_id,attempt_id,state,source_snapshot) VALUES($1,$2,$3,'started',$4) ON CONFLICT(row_id) DO NOTHING RETURNING row_id",[rowId,jobId,attemptId,JSON.stringify(source(row))]);
 if(!claimed.rowCount)fail('This row has already been attempted; reconcile it before retrying');
 return {claimed:true,row};
})}
function normalizeResult(value){const valid=value?.version===1&&['confirmed','review_required'].includes(value?.state);const leadId=valid&&typeof value.lead_id==='string'&&UUID.test(value.lead_id)?value.lead_id:null;const confirmed=valid&&value.state==='confirmed'&&!!leadId;
 return {version:1,state:confirmed?'confirmed':'review_required',lead_id:leadId,reason:confirmed?null:leadId?'provider_steps_incomplete':'provider_outcome_unconfirmed'};
}
export async function completeImportRow(pool,input){identity(input);const {jobId,rowId,attemptId}=input,result=normalizeResult(input.result);return transaction(pool,async db=>{
 await db.query('SELECT id FROM lead_import_jobs WHERE id=$1 FOR UPDATE',[jobId]);
 const row=(await db.query('SELECT * FROM lead_import_rows WHERE id=$1 AND job_id=$2 FOR UPDATE',[rowId,jobId])).rows[0];if(!row)fail('Import row not found',404);
 const claim=(await db.query('SELECT * FROM lead_import_receipts WHERE row_id=$1 AND job_id=$2 FOR UPDATE',[rowId,jobId])).rows[0];if(!claim||claim.attempt_id!==attemptId)fail('Import attempt mismatch');
 if(claim.state!=='started'){if(stable(claim.result)!==stable(result))fail('Import outcome already recorded');return {ok:true,state:claim.state}}
 const changed=row.status!=='approved'||!!row.pipedrive_lead_id||stable(source(row))!==stable(claim.source_snapshot);
 const state=changed?'review_required':result.state;
 await db.query('UPDATE lead_import_receipts SET state=$2,result=$3,updated_at=now() WHERE row_id=$1',[rowId,state,JSON.stringify(result)]);
 if(!changed)await db.query('UPDATE lead_import_rows SET status=$2,pipedrive_lead_id=$3,error_message=$4,updated_at=now() WHERE id=$1 AND job_id=$5',[rowId,state==='confirmed'?'uploaded':'error',result.lead_id,state==='confirmed'?null:result.lead_id?'Lead created; some import steps need review. Do not recreate this lead.':'Pipedrive outcome not confirmed. Check the existing attempt before retrying.',jobId]);
 else await db.query("UPDATE lead_import_rows SET status=CASE WHEN status='approved' THEN 'error' ELSE status END,pipedrive_lead_id=COALESCE(pipedrive_lead_id,$2),error_message=$3,updated_at=now() WHERE id=$1 AND job_id=$4",[rowId,result.lead_id,'Row changed during upload. '+(result.lead_id?'Created lead '+result.lead_id+' needs review. Do not recreate it.':'Pipedrive outcome is unconfirmed; check the attempt before retrying.'),jobId]);
 await db.query('UPDATE lead_import_jobs SET uploaded_rows=(SELECT count(*) FROM lead_import_rows r LEFT JOIN lead_import_receipts c ON c.row_id=r.id AND c.job_id=r.job_id WHERE r.job_id=$1 AND r.status=\'uploaded\' AND r.pipedrive_lead_id IS NOT NULL AND (c.state IS NULL OR c.state=\'confirmed\')),updated_at=now() WHERE id=$1',[jobId]);
 return {ok:true,state};
})}
export async function finalizeImportJob(pool,jobId){if(!UUID.test(jobId||''))fail('Invalid job ID',400);return transaction(pool,async db=>{
 const job=(await db.query('SELECT * FROM lead_import_jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];if(!job)fail('Import job not found',404);
 const rows=(await db.query('SELECT r.status,r.pipedrive_lead_id,c.state AS receipt_state FROM lead_import_rows r LEFT JOIN lead_import_receipts c ON c.row_id=r.id AND c.job_id=r.job_id WHERE r.job_id=$1',[jobId])).rows;
 const uploaded=rows.filter(r=>r.status==='uploaded'&&UUID.test(r.pipedrive_lead_id||'')&&(!r.receipt_state||r.receipt_state==='confirmed')).length;
 const incomplete=rows.filter(r=>r.receipt_state&&r.receipt_state!=='confirmed'||!['uploaded','rejected'].includes(r.status)||r.status==='uploaded'&&!UUID.test(r.pipedrive_lead_id||'')).length;
 const done=Number.isInteger(job.total_rows)&&rows.length===job.total_rows&&!incomplete;
 const status=done?'done':'error',error=done?null:'Import needs review. Some rows lack a confirmed Pipedrive result. Do not repeat the import until those attempts are checked.';
 await db.query('UPDATE lead_import_jobs SET status=$2,uploaded_rows=$3,error_message=$4,updated_at=now() WHERE id=$1',[jobId,status,uploaded,error]);return {ok:true,status,uploaded_rows:uploaded};
})}
