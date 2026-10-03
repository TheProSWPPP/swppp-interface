// Metadata reads only. HTTP failures must never become an inactive/empty workflow.
export async function readNurtureAutomationStatus({ base, key, workflowId = 'leHobBPAhlFaBpfc' }) {
 if (!key) return { configured: false };
 try {
  const read = async path => {
   const response = await fetch(`${base.replace(/\/$/, '')}/api/v1/${path}`, {headers:{'X-N8N-API-KEY':key,accept:'application/json'},signal:AbortSignal.timeout(15000),redirect:'error'});
   if (!response.ok) throw new Error('Workflow status could not be verified. Retry the connection.');
   return response.json();
  };
  const wf = await read(`workflows/${workflowId}`);
  if (wf.id !== workflowId || typeof wf.active !== 'boolean') throw new Error('Workflow status could not be verified. Retry the connection.');
  const ex = await read(`executions?workflowId=${workflowId}&limit=1`);
  if (!Array.isArray(ex.data)) throw new Error('Recent workflow activity could not be verified. Retry the connection.');
  const last = ex.data[0];
  return { configured:true,name:wf.name||'Project completion',active:wf.active,lastRun:last?{status:last.status||'unknown',startedAt:last.startedAt||null}:null };
 } catch { return {configured:true,error:'Workflow status could not be verified. Retry the connection.'}; }
}
