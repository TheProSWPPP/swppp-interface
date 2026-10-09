import {afterEach,it,expect,vi} from 'vitest';
import {registerSdrOrderReconciliationRoutes} from '../sdrOrderReconciliationRoutes.js';
import {readOrderReconciliation} from '../sdrOrderReconciliation.js';

const admin={sub:'11111111-1111-4111-8111-111111111111',role:'admin'};
const result={state:'available',items:[],total:0};
function setup({user=admin,query={},url,companyId='13105180',read=async()=>result,currentAdmin=true,failSql,connect,readCards,readDeals,projects=[]}={}){
 let handler,status=200,body;const headers={},trace=[];
 const client={query:vi.fn(async(sql,args)=>{
  trace.push([sql,args]);if(failSql?.(sql))throw new Error('private database detail');
  if(sql.startsWith('SELECT 1 FROM sdr_users'))return {rowCount:currentAdmin?1:0};
  if(sql.startsWith('SELECT id, name'))return {rows:projects};
  if(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',"SET LOCAL statement_timeout='5000ms'",'COMMIT','ROLLBACK'].includes(sql))return {};
  throw new Error('Unexpected SQL: '+sql);
 }),release:vi.fn(()=>trace.push(['release']))};
 const pool={connect:vi.fn(connect||async function(){return client;}),query:vi.fn(()=>{throw new Error('Pool query forbidden');})};
 const spy=vi.fn(async(...args)=>{trace.push(['read']);return read(...args);});
 registerSdrOrderReconciliationRoutes({get(path,fn){expect(path).toBe('/api/sdr/order-reconciliation');handler=fn;}},{pool,companyId,read:spy,readCards,readDeals});
 return {client,pool,read:spy,trace,run:async()=>{
  await handler({sdrUser:user,query,originalUrl:url},{set(k,v){headers[k]=v;return this;},status(n){status=n;return this;},json(v){trace.push(['json']);body=v;return this;}});
  return {status,body,headers};
 }};
}
afterEach(()=>vi.useRealTimers());
it.each([null,{sub:admin.sub,role:'rep'},{...admin,machine:true},{...admin,sub:'admin'}])('denies noninteractive or invalid identities before sources: %j',async(user)=>{
 const hook=vi.fn(),s=setup({user,readCards:hook,readDeals:hook}),r=await s.run();
 expect(r.status).toBe(user?403:401);expect(r.headers).toEqual({'Cache-Control':'no-store'});expect(s.pool.connect).not.toHaveBeenCalled();expect(s.read).not.toHaveBeenCalled();expect(hook).not.toHaveBeenCalled();
});
it.each([undefined,'','other',13105180,' 13105180'])('fails closed for deployment scope %j',async(companyId)=>{
 const s=setup({companyId:companyId===undefined?null:companyId}),r=await s.run();expect(r.status).toBe(503);expect(s.pool.connect).not.toHaveBeenCalled();expect(s.read).not.toHaveBeenCalled();expect(r.headers['Cache-Control']).toBe('no-store');
});
it.each([{limit:'0'},{limit:'101'},{limit:'1.5'},{offset:'-1'},{offset:'1.1'},{other:'x'},{companyId:'13105180'},{limit:['1','2']}])('preserves malformed paging rejection: %j',async(query)=>{
 const s=setup({query}),r=await s.run();expect(r.status).toBe(400);expect(s.pool.connect).not.toHaveBeenCalled();expect(r.headers['Cache-Control']).toBe('no-store');
});
it('rejects repeated raw paging keys',async()=>{
 const s=setup({query:{limit:'2'},url:'/api/sdr/order-reconciliation?limit=2&limit=2'});expect((await s.run()).status).toBe(400);expect(s.read).not.toHaveBeenCalled();
});
it.each([{}, {limit:'2',offset:'3'}])('authorizes inside the same bounded readonly snapshot and preserves response: %j',async(query)=>{
 const s=setup({query}),r=await s.run();expect(r.status).toBe(200);expect(r.body).toEqual(result);
 expect(s.read).toHaveBeenCalledWith(s.client,{limit:Number(query.limit||50),offset:Number(query.offset||0)});
 expect(s.trace).toEqual([
  ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',undefined],["SET LOCAL statement_timeout='5000ms'",undefined],
  ["SELECT 1 FROM sdr_users WHERE id=$1 AND active AND role='admin'",[admin.sub]],['read'],['COMMIT',undefined],['json'],['release']
 ]);expect(s.pool.query).not.toHaveBeenCalled();expect(s.client.release).toHaveBeenCalledOnce();
});
it('rejects a missing, revoked or demoted database admin before reader and hooks',async()=>{
 const hook=vi.fn(),s=setup({currentAdmin:false,readCards:hook,readDeals:hook}),r=await s.run();expect(r.status).toBe(403);expect(s.read).not.toHaveBeenCalled();expect(hook).not.toHaveBeenCalled();expect(s.trace.map(x=>x[0])).toContain('ROLLBACK');expect(s.client.release).toHaveBeenCalledOnce();
});
it.each(['BEGIN','SET LOCAL','SELECT 1','COMMIT'])('sanitizes database failure at %s and releases',async(prefix)=>{
 const s=setup({failSql:sql=>sql.startsWith(prefix)}),r=await s.run();expect(r.status).toBe(503);expect(r.body).toEqual({error:'Order reconciliation temporarily unavailable'});expect(s.client.release).toHaveBeenCalledOnce();expect(s.trace.map(x=>x[0])).toContain('ROLLBACK');if(prefix!=='COMMIT')expect(s.read).not.toHaveBeenCalled();
});
it('sanitizes reader failure and rolls back',async()=>{
 const s=setup({read:async()=>{throw new Error('private token');}}),r=await s.run();expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('private token');expect(s.trace.map(x=>x[0])).toContain('ROLLBACK');expect(s.client.release).toHaveBeenCalledOnce();
});
it('handles connection rejection without touching sources',async()=>{
 const s=setup({connect:async()=>{throw new Error('private pool');}});expect((await s.run()).status).toBe(503);expect(s.read).not.toHaveBeenCalled();expect(s.client.release).not.toHaveBeenCalled();
});
it('bounds pool wait and releases a late client without using it',async()=>{
 vi.useFakeTimers();let resolve;const late={release:vi.fn(),query:vi.fn()},s=setup({connect:()=>new Promise(r=>{resolve=r;})});const response=s.run();await vi.advanceTimersByTimeAsync(4001);expect((await response).status).toBe(503);resolve(late);await Promise.resolve();await Promise.resolve();expect(late.release).toHaveBeenCalledOnce();expect(late.query).not.toHaveBeenCalled();expect(s.read).not.toHaveBeenCalled();
});
const cardId='aaaaaaaaaaaaaaaaaaaaaaaa';
const project={id:7,name:'Fixture project',status:'complete',data:{trelloLink:`https://trello.com/c/${cardId}`}};
const cards={cards:[{id:cardId,idList:'completed'}],completedListId:'completed',coverage:{kind:'current_board',complete:true,observedAt:'2026-10-01T00:00:00Z'}};
it.each(['fulfilled','rejected','sync_throw','hung'])('bounds independent hooks and keeps other source evidence: %s',async(mode)=>{
 vi.useFakeTimers();let rejectLate;
 const readCards=vi.fn(async()=>cards),readDeals=vi.fn(()=>{if(mode==='sync_throw')throw new Error('secret provider');if(mode==='rejected')return Promise.reject(new Error('secret provider'));if(mode==='hung')return new Promise((_,r)=>{rejectLate=r;});return {deals:[],coverage:{kind:'current_deals',complete:true,observedAt:'2026-10-01T00:00:00Z'}};});
 const s=setup({read:readOrderReconciliation,projects:[project],readCards,readDeals}),pending=s.run();await vi.advanceTimersByTimeAsync(4001);const r=await pending;
 expect(r.status).toBe(200);expect(readCards).toHaveBeenCalledWith(undefined);expect(readDeals).toHaveBeenCalledWith(undefined);expect(r.body.items[0]).toMatchObject({cardLinkState:'verified',cardId,jobCompleted:true});expect(r.body.sourceFailures).toEqual(mode==='fulfilled'?[]:['deals']);expect(JSON.stringify(r.body)).not.toContain('secret provider');expect(s.client.release).toHaveBeenCalledOnce();if(rejectLate){rejectLate(new Error('late private'));await Promise.resolve();}
});
it('retains successful deal coverage when card source times out',async()=>{
 vi.useFakeTimers();const s=setup({read:readOrderReconciliation,projects:[project],readCards:()=>new Promise(()=>{}),readDeals:async()=>({deals:[],coverage:{kind:'current_deals',complete:true,observedAt:'2026-10-01T00:00:00Z'}})});
 const pending=s.run();await vi.advanceTimersByTimeAsync(4001);const r=await pending;expect(r.status).toBe(200);expect(r.body.sourceFailures).toEqual(['cards']);expect(r.body.coverage.deals).toMatchObject({kind:'current_deals',complete:true});expect(r.body.coverage.cards.kind).toBe('unavailable');expect(r.body.items[0].cardLinkState).toBe('unobserved');
});
it('keeps inventory private when rollback also fails and still releases',async()=>{
 const s=setup({failSql:sql=>sql==='ROLLBACK',read:async()=>{throw new Error('secret');}}),r=await s.run();expect(r.status).toBe(503);expect(r.body).toEqual({error:'Order reconciliation temporarily unavailable'});expect(s.client.release).toHaveBeenCalledOnce();
});
