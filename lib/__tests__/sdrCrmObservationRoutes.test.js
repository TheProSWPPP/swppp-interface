import { describe,it,expect,beforeAll,afterAll } from 'vitest';
import fs from 'node:fs/promises';
import express from 'express';
import { reportingTestDb } from './reportingTestDb.js';
import { registerSdrCrmObservationRoutes } from '../sdrCrmObservationRoutes.js';

const db=reportingTestDb('crm_observation_routes');
const testDb=db?describe:describe.skip;
testDb('CRM observation routes',()=>{
  let server,base;
  beforeAll(async()=>{
    await db.setup();await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql',import.meta.url),'utf8'));await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-manual-protection.sql',import.meta.url),'utf8'));
    await db.pool.query('CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text); CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id uuid,status text)');
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.sdrUser={role:req.headers['x-role']};next();});
    registerSdrCrmObservationRoutes(app,{pool:db.pool,companyId:'42',authorizeWebhook:req=>req.headers.authorization==='Basic valid',canViewLead:(_req,id)=>id==='lead-1'});
    server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
  it('rejects non-admin and invisible lead reads without exposing content',async()=>{
    const denied=await fetch(`${base}/api/sdr/crm/leads/lead-1/observations`,{headers:{'x-role':'sdr'}});
    expect(denied.status).toBe(403);
    const hidden=await fetch(`${base}/api/sdr/crm/leads/lead-2/observations`,{headers:{'x-role':'admin'}});
    expect(hidden.status).toBe(404);
  });
  it('returns stable admin history, followups and health envelopes',async()=>{
    const headers={'x-role':'admin'};
    expect(await (await fetch(`${base}/api/sdr/crm/leads/lead-1/observations`,{headers})).json()).toMatchObject({lead:null,items:[],revisions:[],source:'pipedrive',freshness:{scopes:[],inbox:{pending:0}}});
    expect(await (await fetch(`${base}/api/sdr/crm/leads/lead-1/followups`,{headers})).json()).toMatchObject({leadId:'lead-1',items:[],source:'pipedrive',freshness:{scopes:[]}});
    expect(await (await fetch(`${base}/api/sdr/crm/followups`,{headers})).json()).toMatchObject({items:[],nextCursor:null,source:'pipedrive',freshness:{scopes:[]}});
    expect(await (await fetch(`${base}/api/sdr/crm/health`,{headers})).json()).toMatchObject({scopes:[],inbox:{pending:0}});
  });
  it('acknowledges authenticated webhooks only after inbox persistence',async()=>{
    const body={meta:{id:'route-1',company_id:'42',version:'2.0',entity:'lead',entity_id:'lead-1',action:'change',timestamp:'2026-10-05T12:00:00Z'},data:{id:'lead-1'}};
    const bad=await fetch(`${base}/api/sdr/crm/webhooks/pipedrive`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    expect(bad.status).toBe(401);
    const good=await fetch(`${base}/api/sdr/crm/webhooks/pipedrive`,{method:'POST',headers:{'Content-Type':'application/json',authorization:'Basic valid'},body:JSON.stringify(body)});
    expect(good.status).toBe(202);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM sdr_crm_event_inbox WHERE event_id='route-1'")).rows[0].n).toBe(1);
  });
});

it('keeps the CRM user directory admin-only and reports source failures',async()=>{
  const routes=new Map();let reads=0,fail=false;
  registerSdrCrmObservationRoutes({get:(path,handler)=>routes.set(path,handler),post:()=>{}},{
    pool:{},companyId:'42',canViewLead:async()=>true,listUsers:async()=>{reads++;if(fail)throw new Error('provider');return [{id:'7',name:'Derek'}];},
  });
  const handler=routes.get('/api/sdr/crm/users');
  const response=()=>({code:200,body:null,status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
  const denied=response();await handler({sdrUser:{role:'sdr'}},denied);
  expect(denied.code).toBe(403);expect(reads).toBe(0);
  const allowed=response();await handler({sdrUser:{role:'admin'}},allowed);
  expect(allowed.body).toMatchObject({users:[{id:'7',name:'Derek'}]});
  fail=true;const unavailable=response();await handler({sdrUser:{role:'admin'}},unavailable);
  expect(unavailable.code).toBe(503);expect(unavailable.body).toEqual({error:'CRM user directory unavailable'});
});
