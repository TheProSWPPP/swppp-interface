import {it,expect,vi} from 'vitest';
import {registerSdrOrderReconciliationRoutes} from '../sdrOrderReconciliationRoutes.js';

async function invoke({user={sub:'admin',role:'admin'},query={},url,read=async()=>({state:'available',items:[],total:0})}={}){
 let handler,status=200,body;const spy=vi.fn(read);
 registerSdrOrderReconciliationRoutes({get(path,fn){expect(path).toBe('/api/sdr/order-reconciliation');handler=fn;}},{pool:{},read:spy});
 await handler({sdrUser:user,query,originalUrl:url},{status(n){status=n;return this;},json(v){body=v;return this;}});
 return {status,body,read:spy};
}
it('denies anonymous and non-admin reads before touching sources',async()=>{
 for(const user of [null,{sub:'rep',role:'rep'}]){const r=await invoke({user});expect(r.status).toBe(user?403:401);expect(r.read).not.toHaveBeenCalled();}
});
it.each([{limit:'0'},{limit:'101'},{limit:'1.5'},{offset:'-1'},{offset:'1.1'},{other:'x'},{limit:['1','2']}])('rejects malformed paging: %j',async(query)=>{
 const r=await invoke({query});expect(r.status).toBe(400);expect(r.read).not.toHaveBeenCalled();
});
it('rejects repeated raw paging keys',async()=>{
 const r=await invoke({query:{limit:'2'},url:'/api/sdr/order-reconciliation?limit=2&limit=2'});expect(r.status).toBe(400);expect(r.read).not.toHaveBeenCalled();
});
it('passes bounded paging and returns read-only result',async()=>{
 const r=await invoke({query:{limit:'2',offset:'3'},read:async(_pool,options)=>({state:'available',items:[],total:5,options})});
 expect(r.status).toBe(200);expect(r.body.options).toEqual({limit:2,offset:3});
});
it('sanitizes source failures',async()=>{
 const r=await invoke({read:async()=>{throw new Error('private token');}});expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('private token');
});
