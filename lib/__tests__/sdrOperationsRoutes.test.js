import {it,expect,vi} from 'vitest';
import {registerSdrOperationsRoutes} from '../sdrOperationsRoutes.js';
async function run({user={sub:'rep',role:'rep'},query={},url,read,error}={}) {
 let handler,status=200,body;const resolve=vi.fn(async()=>['rep@example.test']);const connect=vi.fn(async()=>{throw error||new Error('PRIVATE DB ERROR');});
 registerSdrOperationsRoutes({get(path,h){expect(path).toBe('/api/sdr/operations/replies');handler=h;}},{pool:{connect},resolveVisibleMailboxes:resolve,...(read?{read}: {})});
 await handler({sdrUser:user,query,originalUrl:url},{status(n){status=n;return this;},json(b){body=b;return this;}});return {status,body,resolve,connect};
}
it('requires authenticated identity before scope or database access',async()=>{const r=await run({user:null});expect(r.status).toBe(401);expect(r.resolve).not.toHaveBeenCalled();expect(r.connect).not.toHaveBeenCalled();});
it('rejects unauthorized mailbox without accessing database',async()=>{const r=await run({query:{mailbox:'other@example.test'}});expect(r.status).toBe(403);expect(r.connect).not.toHaveBeenCalled();});
it.each([{limit:'0'},{limit:'26'},{limit:'1.1'},{limit:['1','2']},{asOf:'yesterday'},{asOf:'2999-01-01T00:00:00Z'},{asOf:'2020-01-01T00:00:00Z'},{extra:'yes'},{mailbox:''},{cursor:''},{asOf:['2026-10-03T00:00:00Z','2026-10-03T00:00:00Z']}])('rejects malformed query before database: %j',async(query)=>{const r=await run({query});expect(r.status).toBe(400);expect(r.connect).not.toHaveBeenCalled();});
it('rejects repeated raw parameters even if parser collapsed them',async()=>{const r=await run({query:{limit:'1'},url:'/api/sdr/operations/replies?limit=1&limit=1'});expect(r.status).toBe(400);expect(r.connect).not.toHaveBeenCalled();});
it('passes permission-derived scope and normalized allowed filter',async()=>{
 const read=vi.fn(async(_p,o)=>({state:'available',total:1,mailboxes:o.visibleMailboxes,mailbox:o.mailbox}));
 const r=await run({query:{mailbox:'REP@example.test',limit:'1'},read});expect(r.status).toBe(200);expect(r.body.mailboxes).toEqual(['rep@example.test']);expect(r.body.mailbox).toBe('rep@example.test');
});
it('sanitizes unrelated database failure',async()=>{const r=await run();expect(r.status).toBe(503);expect(r.body).toEqual({error:'replies_unavailable'});});
it('returns missing schema as HTTP 200 unavailable with null count',async()=>{const r=await run({error:Object.assign(new Error('PRIVATE TABLE'),{code:'42P01'})});expect(r.status).toBe(200);expect(r.body).toMatchObject({state:'unavailable',total:null,items:[]});});

it('accepts a valid scoped cursor on the registered route and rejects reused identity scope',async()=>{
 const cursor=Buffer.from(JSON.stringify({v:2,visibilitySnapshot:'10:20:10,14,15',asOf:new Date().toISOString(),mailbox:null,scope:['rep@example.test'],receivedAt:new Date(Date.now()-60000).toISOString(),id:'reply-29'})).toString('base64url');
 const read=async()=>({state:'available',total:30});
 expect((await run({query:{cursor},read})).status).toBe(200);
 const wrong=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(cursor,'base64url').toString()),scope:['other@example.test']})).toString('base64url');
 const result=await run({query:{cursor:wrong},read});expect(result.status).toBe(400);expect(result.connect).not.toHaveBeenCalled();
});

it.each(['','bad','10:20','0:20:','20:10:','10:20:20','10:20:9','10:20:14,10','10:20:10,10','01:20:','1:18446744073709551616:','1:2: '+ '1'.repeat(9000)])('rejects malformed visibility snapshot before database: %s',async(visibilitySnapshot)=>{
 const r=await run({query:{asOf:new Date().toISOString(),visibilitySnapshot}});expect(r.status).toBe(400);expect(r.connect).not.toHaveBeenCalled();
});
it('requires asOf when an explicit visibility snapshot is supplied',async()=>{
 const r=await run({query:{visibilitySnapshot:'10:20:10,14,15'}});expect(r.status).toBe(400);expect(r.connect).not.toHaveBeenCalled();
});
it('accepts string xid values above JS safe integer precision without rounding',async()=>{
 const visibilitySnapshot='9007199254740993:9007199254740995:9007199254740993';
 const r=await run({query:{asOf:new Date().toISOString(),visibilitySnapshot},read:async(_p,o)=>({state:'available',visibilitySnapshot:o.visibilitySnapshot})});
 expect(r.status).toBe(200);expect(r.body.visibilitySnapshot).toBe(visibilitySnapshot);
});
it('rejects repeated visibility snapshot even if the query parser collapsed values',async()=>{
 const snapshot='10:20:10,14,15';const r=await run({query:{asOf:new Date().toISOString(),visibilitySnapshot:snapshot},url:`/api/sdr/operations/replies?visibilitySnapshot=${snapshot}&visibilitySnapshot=${snapshot}`});
 expect(r.status).toBe(400);expect(r.connect).not.toHaveBeenCalled();
});
