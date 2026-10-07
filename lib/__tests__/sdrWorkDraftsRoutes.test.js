import {it,expect,vi} from 'vitest';
import {registerSdrWorkDraftsRoutes} from '../sdrWorkDraftsRoutes.js';
async function invoke(user,query,rows=[]){let handler,status=200,body;const pool={query:vi.fn(async()=>({rows}))};registerSdrWorkDraftsRoutes({get(_path,fn){handler=fn;}},{pool});await handler({sdrUser:user,query},{status(value){status=value;return this;},json(value){body=value;return this;}});return{status,body,pool};}
it('rejects anonymous access and malformed filters before querying',async()=>{expect((await invoke(null,{view:'open'})).status).toBe(401);for(const query of [{view:['open']},{view:'failed',mailbox:'other'},{view:'all'},{}]){const result=await invoke({sub:'rep',role:'sdr'},query);expect(result.status).toBe(400);expect(result.pool.query).not.toHaveBeenCalled();}});
it('scopes representatives to their assigned drafts and preserves failed action window',async()=>{const result=await invoke({sub:'rep-id',role:'sdr'},{view:'failed'});const [sql,values]=result.pool.query.mock.calls[0];expect(sql).toContain('d.assigned_user_id=$1');expect(values).toEqual(['rep-id']);expect(sql).toContain("d.status='failed'");expect(sql).toContain("d.updated_at>=now()-interval '7 days'");expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);});
it('loads all open statuses and signals truncation explicitly',async()=>{const rows=Array.from({length:251},(_,i)=>({id:String(i)}));const result=await invoke({sub:'admin',role:'admin'},{view:'open'},rows);expect(result.body.drafts).toHaveLength(250);expect(result.body.hasMore).toBe(true);expect(result.pool.query.mock.calls[0][0]).toContain("('pending','approved','edited')");});

it('retains enrollment retry evidence when the existing feature is enabled',async()=>{vi.stubEnv('SDR_ENROLLMENT_RETRY_ENABLED','true');try{const result=await invoke({sub:'admin',role:'admin'},{view:'open'});const sql=result.pool.query.mock.calls[0][0];expect(sql).toContain('ea.status AS enrollment_status');expect(sql).toContain('ea.category AS enrollment_category');expect(sql).toContain('LEFT JOIN sdr_enrollment_attempts ea ON ea.draft_id=d.id');}finally{vi.unstubAllEnvs();}});
import {checkViewedDraft} from '../sdrDraftRevision.js';
it.each(['open','failed'])('includes trusted revision/context on the %s work queue response',async view=>{
 const draft={id:'draft',revision:'7',status:view==='failed'?'failed':'pending',contact_email_snapshot:'buyer@example.test',assigned_mailbox_id:'sender',apollo_sequence_id:'sequence',metadata:{}};
 const response=await invoke({sub:'rep',role:'sdr'},{view},[draft]);const row=response.body.drafts[0];
 expect(row.revision).toBe('7');expect(row.contextHash).toMatch(/^[a-f0-9]{64}$/);
 if(view==='open')expect(checkViewedDraft({draft,expectedRevision:row.revision,expectedContextHash:row.contextHash})).toEqual({allowed:true});
});
