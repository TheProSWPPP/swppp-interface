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
  registerSdrOutreachControlRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async(req,id)=>req.sdrUser.sub==='rep'&&id==='visible',readContext:async()=>({companyId:'42',leadId:'visible',contextHash:hash,recipientEmail:'current@example.test'})});
  server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
 });
 afterAll(async()=>{await new Promise(r=>server.close(r));await db.close();});
 const request=(path,body,user='rep',role='sdr')=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(user?{'x-user':user,'x-role':role}:{})},...(body?{body:JSON.stringify(body)}:{})});
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
 it('shows applicable account restrictions and all project controls once, without exposing unrelated recipients',async()=>{
  const project=await (await request('/api/sdr/leads/visible/controls',{scope:{kind:'lead',id:'visible'},reason:'Project review',contextHash:hash})).json();
  const add=async(lead,kind,scope,reason)=>(await db.pool.query(`INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,reason,context_hash,actor,owner_id) VALUES('42',$1,$2,$3,$4,'old-context','{}','rep') RETURNING *`,[lead,kind,scope,reason])).rows[0];
  const recipient=await add(null,'recipient','current@example.test','Recipient requested no further contact');
  const other=await add(null,'recipient','other@example.test','Unrelated recipient');
  const previousDraft=await add('visible','draft','previous-draft','Earlier draft restriction');
  const result=await request('/api/sdr/leads/visible/controls');expect(result.status).toBe(200);const state=await result.json();
  expect(state.applicationActionsBlocked).toBe(true);expect(state.providerStopStatus).toBe('unverified');
  expect(state.controls.filter(c=>c.id===project.id)).toHaveLength(1);
  expect(state.controls.find(c=>c.id===project.id)).toMatchObject({canResolveOnProject:true});
  expect(state.controls.find(c=>c.id===recipient.id)).toMatchObject({reason:recipient.reason,scope_kind:'recipient',canResolveOnProject:false,provider_stop_status:'unverified'});
  expect(state.controls.find(c=>c.id===previousDraft.id)).toMatchObject({reason:previousDraft.reason,canResolveOnProject:true});
  expect(state.controls.some(c=>c.id===other.id)).toBe(false);
  const resolve=await request(`/api/sdr/leads/visible/controls/${recipient.id}/resolve`,{expectedVersion:1,contextHash:hash,decision:'release',evidence:'Cannot release an account restriction here'},'rep','admin');
  expect(resolve.status).toBe(404);
  expect((await db.pool.query('SELECT status,version FROM sdr_outreach_controls WHERE id=$1',[recipient.id])).rows[0]).toEqual({status:'active',version:1});
  const release=await request(`/api/sdr/leads/visible/controls/${project.id}/resolve`,{expectedVersion:1,contextHash:hash,decision:'release',evidence:'Project reviewed'});
  expect(release.status).toBe(200);expect((await release.json()).resolved).toBe(true);
 });

});
