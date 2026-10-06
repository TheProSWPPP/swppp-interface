import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {registerSdrOutreachControlRoutes} from '../sdrOutreachControlRoutes.js';
const db=reportingTestDb('control_routes');
describe.skipIf(!db)('control authorization and current context',()=>{
 let server,base,hash='v1';
 beforeAll(async()=>{
  await db.setup();await db.pool.query(`CREATE TABLE sdr_sends(status text,apollo_sequence_id text,apollo_contact_id text,sent_at timestamptz,draft_id text,pipedrive_lead_id text);CREATE TABLE sdr_drafts(id text,contact_email_snapshot text);`);await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-outreach-controls.sql',import.meta.url),'utf8'));
  await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-crm-proposals.sql',import.meta.url),'utf8'));
  const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers['x-user'])req.sdrUser={sub:req.headers['x-user'],role:req.headers['x-role']||'sdr'};next();});
  registerSdrOutreachControlRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async(req,id)=>req.sdrUser.sub==='rep'&&id==='visible',readContext:async()=>({companyId:'42',leadId:'visible',contextHash:hash})});
  server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
 });
 afterAll(async()=>{await new Promise(r=>server.close(r));await db.close();});
 const request=(path,body,user='rep')=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(user?{'x-user':user}:{})},...(body?{body:JSON.stringify(body)}:{})});
 it('denies anonymous and hidden leads',async()=>{
  expect((await request('/api/sdr/leads/visible/controls',null,null)).status).toBe(401);
  expect((await request('/api/sdr/leads/hidden/controls')).status).toBe(404);
 });
 it('prevents cross-project scope and rejects resolutions after context changes',async()=>{
  expect((await request('/api/sdr/leads/visible/controls',{scope:{kind:'lead',id:'other'},reason:'hold',contextHash:'v1'})).status).toBe(400);
  const created=await request('/api/sdr/leads/visible/controls',{scope:{kind:'lead',id:'visible'},reason:'Callback promised',contextHash:'v1'});
  expect(created.status).toBe(201);const c=await created.json();
  hash='v2';
  expect((await request(`/api/sdr/leads/visible/controls/${c.id}/resolve`,{expectedVersion:1,contextHash:'v1',decision:'release',evidence:'reviewed'})).status).toBe(409);
  const state=await (await request('/api/sdr/leads/visible/controls')).json();
  expect(state.applicationActionsBlocked).toBe(true);
  expect(state.providerStopStatus).toBe('unverified');
 });
});
