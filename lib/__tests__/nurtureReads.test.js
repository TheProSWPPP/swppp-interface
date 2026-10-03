import {afterEach,describe,expect,it,vi} from 'vitest';
import express from 'express';
import {registerNurtureRoutes} from '../nurtureRoutes.js';
import {readNurtureAutomationStatus} from '../nurtureAutomationStatus.js';
const originalFetch=globalThis.fetch;
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()});
describe('truthful nurture metadata',()=>{
 it('distinguishes missingconfiguration from unreachableprovider',async()=>{expect(await readNurtureAutomationStatus({base:'https://example.test'})).toEqual({configured:false});vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({message:'Unauthorized'},401)));expect(await readNurtureAutomationStatus({base:'https://example.test',key:'test'})).toMatchObject({configured:true,error:expect.any(String)});});
 it('does not mislabel a failed execution history as no runs',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response({id:'w',name:'Completion',active:true})).mockResolvedValueOnce(response({message:'Unauthorized'},401)));expect(await readNurtureAutomationStatus({base:'https://example.test',key:'test',workflowId:'w'})).toMatchObject({error:expect.any(String)});});
 it('returns verifiedworkflowandexecutionmetadata',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response({id:'w',name:'Completion',active:true})).mockResolvedValueOnce(response({data:[{status:'error',startedAt:'2026-10-03T10:00:00Z'}]})));expect(await readNurtureAutomationStatus({base:'https://example.test',key:'test',workflowId:'w'})).toMatchObject({configured:true,active:true,lastRun:{status:'error'}});});
 it('rejects malformedworkflowdata',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({})));expect(await readNurtureAutomationStatus({base:'https://example.test',key:'test'})).toMatchObject({error:expect.any(String)});});
 it.each(['limit=-1','limit=0','limit=101','limit=1x','offset=-1','offset=1.5','limit=2&limit=3'])('rejects invalidpagination %s before a provider call',async(query)=>{
  vi.stubEnv('BREVO_API_KEY','test');const mocked=vi.fn();vi.stubGlobal('fetch',mocked);const app=express();registerNurtureRoutes(app,null);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{const r=await originalFetch(`http://127.0.0.1:${server.address().port}/api/sdr/nurture/lists/1/contacts?${query}`);expect(r.status).toBe(400);expect(mocked).not.toHaveBeenCalled()}finally{await new Promise(r=>server.close(r))}
 });
 it.each(['campaigns/123%2FsendNow%3F/test','Campaigns/123%2FsendNow%3F/test','lists/12%2F..%2FemailCampaigns%2F123','LISTS/12%2F..%2FemailCampaigns%2F123'])('rejects encoded path injection %s before provider dispatch',async(path)=>{
  vi.stubEnv('BREVO_API_KEY','test');const mocked=vi.fn();vi.stubGlobal('fetch',mocked);const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser={role:'sdr'};next()});registerNurtureRoutes(app,null);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{const r=await originalFetch(`http://127.0.0.1:${server.address().port}/api/sdr/nurture/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({emailTo:['staff@example.test']})});expect(r.status).toBe(400);expect(mocked).not.toHaveBeenCalled()}finally{await new Promise(r=>server.close(r))}
 });
 it.each([['POST','contacts'],['PATCH','contacts/person%40example.test'],['POST','lists/6/contacts/add'],['POST','lists/6/contacts/remove']])('requiresadmin for automation-sensitive %s %s',async(method,path)=>{
  vi.stubEnv('BREVO_API_KEY','test');const mocked=vi.fn();vi.stubGlobal('fetch',mocked);const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser={role:'sdr'};next()});registerNurtureRoutes(app,null);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{const r=await originalFetch(`http://127.0.0.1:${server.address().port}/api/sdr/nurture/${path}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify({email:'person@example.test',listIds:[6],emails:['person@example.test']})});expect(r.status).toBe(403);expect(mocked).not.toHaveBeenCalled()}finally{await new Promise(r=>server.close(r))}
 });

});
