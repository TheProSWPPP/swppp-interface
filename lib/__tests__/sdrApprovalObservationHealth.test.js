import express from 'express';
import {it,expect} from 'vitest';
import * as api from '../sdrApprovalObservationHealth.js';
it('shows only process-local counters to a current interactive admin and denies scope overrides',async()=>{
 expect(api.registerApprovalObservationHealth).toBeTypeOf('function');let viewer,active=true,reads=0;const app=express();app.use((req,_res,next)=>{req.sdrUser=viewer;next();});
 const pool={connect:async()=>({query:async sql=>{if(sql.startsWith('SELECT 1')){reads++;return {rowCount:active?1:0};}return {};},release(){}})};
 api.registerApprovalObservationHealth(app,{companyId:'13105180',pool,stats:()=>({enabled:true,finished:2,persisted:1,coverage:'process_local_partial'})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api/sdr/health/approval-observations`;
 try{
  for(const [user,status] of [[null,401],[{sub:'staff',role:'sdr'},403],[{sub:'admin',role:'admin',machine:true},403],[{sub:'admin',role:'admin'},200]]){viewer=user;const r=await fetch(base);expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toBe('no-store');if(status===200)expect(await r.json()).toMatchObject({runtime:{finished:2,persisted:1},coverage:{partial:true,since:'process_boot',outcomes:'http_responses_only'}});}
  expect(reads).toBe(1);active=false;expect((await fetch(base)).status).toBe(403);expect((await fetch(base+'?companyId=foreign')).status).toBe(400);
 }finally{await new Promise(r=>server.close(r));}
});
