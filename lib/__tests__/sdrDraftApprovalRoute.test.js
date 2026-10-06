import express from 'express';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {checkViewedDraft,draftContextHash,checkDraftSchedule} from '../sdrDraftRevision.js';
const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('app.post("/api/sdr/drafts/:id/approve-and-send"'),source.indexOf('app.get("/api/projects"'));
let server,base,draft,provider;
const original={id:'draft',pipedrive_lead_id:'lead',revision:5,status:'pending',subject:'Reviewed subject',body:'Reviewed body',contact_id_snapshot:'person',contact_email_snapshot:'buyer@example.test',assigned_mailbox_id:'sender',apollo_sequence_id:'sequence',metadata:{}};
beforeAll(async()=>{
 vi.stubEnv('DATABASE_URL','synthetic-test-only');vi.stubEnv('APOLLO_API_KEY','synthetic-test-only');
 provider={matchContactByEmail:vi.fn(),updateContactCustomFields:vi.fn(),addContactsToSequence:vi.fn()};
 const pool={query:vi.fn(async()=>({rows:[draft]}))};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser={sub:'rep',role:'sdr'};next()});
 new Function('app','pool','ownerScope','checkViewedDraft','checkDraftSchedule','apolloClient',block)(app,pool,()=>({requires:false}),checkViewedDraft,checkDraftSchedule,provider);
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
afterAll(async()=>{await new Promise(r=>server.close(r));vi.unstubAllEnvs();});
it.each(['missing','revision','recipient','sender','sequence','schedule'])('refuses %s stale approval at the real HTTP route before any provider mutation',async change=>{
 draft={...original,metadata:{}};let body={expectedRevision:5,expectedContextHash:draftContextHash(original)};
 if(change==='missing')body={};if(change==='revision')draft.revision=6;
 if(change==='recipient')draft.contact_email_snapshot='new@example.test';if(change==='sender')draft.assigned_mailbox_id='other';if(change==='sequence')draft.apollo_sequence_id='other';if(change==='schedule')draft.scheduled_for='2099-01-01T00:00:00Z';
 const response=await fetch(`${base}/api/sdr/drafts/draft/approve-and-send`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 expect(response.status).toBe(409);expect((await response.json()).code).toBe(change==='missing'?'draft_version_required':'draft_stale');
 for(const mutate of Object.values(provider))expect(mutate).not.toHaveBeenCalled();
});
it('does not let generic override bypass a future schedule',async()=>{
 draft={...original,scheduled_for:'2099-01-01T00:00:00Z'};
 const response=await fetch(`${base}/api/sdr/drafts/draft/approve-and-send`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:5,expectedContextHash:draftContextHash(draft),override:true})});
 expect(response.status).toBe(409);expect((await response.json()).code).toBe('scheduled_for_future');for(const mutate of Object.values(provider))expect(mutate).not.toHaveBeenCalled();
});
