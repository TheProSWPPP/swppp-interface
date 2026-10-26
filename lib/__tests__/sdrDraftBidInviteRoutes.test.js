import express from 'express';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import {BID_INVITE_MESSAGE} from '../bidInviteGuard.js';
// The manual draft routes refuse a bid-sheet contact before any draft is generated or stored.
const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('app.post("/api/sdr/drafts/generate", async (req, res) => {'),source.indexOf('// Every mutation binds the user to the revision and context they actually viewed.'));
let server,base,bidFor,deps;
beforeAll(async()=>{
 vi.stubEnv('DATABASE_URL','synthetic-test-only');vi.stubEnv('PIPEDRIVE_API_TOKEN','synthetic-test-only');
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser={sub:'rep',role:'admin'};next()});
 deps={app,pool:{query:vi.fn()},N8N_CALLBACK_SECRET:'secret',leadVisibleTo:async()=>true,BID_INVITE_MESSAGE,
  bidInviteLeadFor:vi.fn(async(...args)=>bidFor(...args)),
  prepareDraftCreation:vi.fn(async()=>({})),draftCreationOrigin:()=>'interactive',mailboxAssignmentError:async()=>null,commitDraftCreation:vi.fn(),
  buildDraftFromLead:vi.fn(async()=>({pipedrive_lead_id:'cold-lead',contact_id_snapshot:'person-1',contact_email_snapshot:'buyer@gc.test'}))};
 new Function(...Object.keys(deps),block)(...Object.values(deps));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
afterAll(async()=>{await new Promise(r=>server.close(r));vi.unstubAllEnvs();});
beforeEach(()=>{vi.clearAllMocks();});
const post=(path,body)=>fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
it('generate refuses a Bid Invite lead before generating anything',async()=>{
 bidFor=async(_db,{leadId})=>leadId==='bid-lead'?'bid-lead':null;
 const response=await post('/api/sdr/drafts/generate',{pipedrive_lead_id:'bid-lead'});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'bid_invite_warm_lead',error:BID_INVITE_MESSAGE});
 expect(deps.buildDraftFromLead).not.toHaveBeenCalled();expect(deps.commitDraftCreation).not.toHaveBeenCalled();
});
it('generate refuses a cold lead whose live contact is on an open Bid Invite lead, without storing a draft',async()=>{
 bidFor=async(_db,{personId})=>personId==='person-1'?'bid-lead':null;
 const response=await post('/api/sdr/drafts/generate',{pipedrive_lead_id:'cold-lead'});
 expect(response.status).toBe(409);expect((await response.json()).code).toBe('bid_invite_warm_lead');
 expect(deps.bidInviteLeadFor).toHaveBeenLastCalledWith(deps.pool,{leadId:'cold-lead',personId:'person-1',emails:['buyer@gc.test']});
 expect(deps.commitDraftCreation).not.toHaveBeenCalled();
});
it('creating a draft directly refuses a bid-sheet contact',async()=>{
 bidFor=async(_db,{emails})=>emails.includes('buyer@gc.test')?'bid-lead':null;
 const response=await post('/api/sdr/drafts',{pipedrive_lead_id:'cold-lead',contact_id_snapshot:'person-2',contact_email_snapshot:'buyer@gc.test',trigger_type:'CM',subject:'s',body:'b'});
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'bid_invite_warm_lead',error:BID_INVITE_MESSAGE});
 expect(deps.prepareDraftCreation).not.toHaveBeenCalled();expect(deps.commitDraftCreation).not.toHaveBeenCalled();
});
