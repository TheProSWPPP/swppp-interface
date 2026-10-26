import {it,expect} from 'vitest';
import {registerSdrHealthRoutes} from '../sdrHealthRoutes.js';
async function run(user={sub:'rep',role:'rep'},query={}) {let handler,status=200,body,options;registerSdrHealthRoutes({get(_path,h){handler=h;}},{pool:{},resolveVisibleMailboxes:async()=>['mine@example.test'],health:async(_p,o)=>{options=o;return {state:'available',jobs:[]};}});await handler({sdrUser:user,query},{status(n){status=n;return this;},json(b){body=b;return this;}});return {status,body,options};}
it('rejects missing identity',async()=>{expect((await run(null)).status).toBe(401);});
it('withholds global details for reps and uses permission-derived mailbox scope',async()=>{const r=await run();expect(r.options.admin).toBe(false);expect(r.options.visibleMailboxes).toEqual(['mine@example.test']);});
it('rejects a mailbox scope override and allows admin detail',async()=>{expect((await run(undefined,{mailbox:'other@example.test'})).status).toBe(400);expect((await run({sub:'admin',role:'admin'})).options.admin).toBe(true);});
it('adds the live inbox read state to the same health answer',async()=>{
 let handler,body;
 registerSdrHealthRoutes({get(_path,h){handler=h;}},{pool:{},resolveVisibleMailboxes:async()=>['mine@example.test'],health:async()=>({state:'available',jobs:[]}),
  inboxReads:mailboxes=>mailboxes.map(mailbox=>({mailbox,status:'stale',issue:'google_limit'}))});
 await handler({sdrUser:{sub:'rep',role:'sdr'},query:{}},{status(){return this;},json(value){body=value;}});
 expect(body).toEqual({state:'available',jobs:[],inboxReads:[{mailbox:'mine@example.test',status:'stale',issue:'google_limit'}]});
});
