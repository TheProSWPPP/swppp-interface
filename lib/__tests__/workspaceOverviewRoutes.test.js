import {expect,it} from 'vitest';
import {registerWorkspaceOverviewRoutes} from '../workspaceOverviewRoutes.js';
async function run(user={sub:'admin',role:'admin'},query={},failure=false){
 let handler,status=200,body,calls=0,sql;
 registerWorkspaceOverviewRoutes({get(path,h){expect(path).toBe('/api/sdr/workspace/summary');handler=h;}},{pool:{async query(text){calls++;sql=text;if(failure)throw Error('private connection detail');return {rows:[{status:'Pending Review',count:'3'},{status:'Complete',count:'9'},{status:'New',count:'2'},{status:'Processing',count:'1'},{status:'Ready',count:'4'}]};}}});
 await handler({sdrUser:user,query},{status(n){status=n;return this;},json(value){body=value;return this;}});
 return {status,body,calls,sql};
}
it('requires an authenticated administrator before reading document counts',async()=>{
 for(const user of [null,{role:'admin'},{sub:'rep',role:'sdr'}]){
  const result=await run(user);expect(result.status).toBe(user?.sub?403:401);expect(result.calls).toBe(0);
 }
});
it('rejects query overrides without a database read',async()=>{
 const result=await run(undefined,{archived:'true'});expect(result.status).toBe(400);expect(result.calls).toBe(0);
});
it('returns only aggregate document status, using a SELECT and no legacy mutation',async()=>{
 const result=await run();expect(result.status).toBe(200);expect(result.body.documents).toEqual({total:19,new:2,pending:3,processing:1,complete:9,ready:4,other:0});
 expect(result.sql.trim()).toMatch(/^SELECT/);expect(result.sql).toContain('archived = FALSE');expect(result.sql).not.toMatch(/UPDATE|INSERT|DELETE/i);expect(result.body).not.toHaveProperty('projects');
});
it('returns a retryable failure without disclosing connection details',async()=>{
 const result=await run(undefined,{},true);expect(result.status).toBe(503);expect(result.body).toEqual({error:'workspace_summary_unavailable'});
});
