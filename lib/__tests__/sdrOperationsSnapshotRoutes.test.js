import {it,expect} from 'vitest';
let api;try{api=await import('../sdrOperationsSnapshotRoutes.js');}catch{api={};}
const viewer={sub:'00000000-0000-0000-0000-000000000001',role:'admin'};
it('registers only a no-store GET and rejects missing sessions, machines, staff and query overrides',async()=>{
 expect(api.registerSdrOperationsSnapshotRoutes).toBeTypeOf('function');let handler;
 api.registerSdrOperationsSnapshotRoutes({get:(path,h)=>{expect(path).toBe('/api/sdr/health/operations');handler=h;}},{pool:{},companyId:'42',read:async()=>({eligibleSupply:null})});
 for(const [user,query,status] of [[null,{},401],[{...viewer,machine:true},{},403],[{...viewer,role:'sdr'},{},403],[viewer,{companyId:'other'},400],[viewer,{},200]]){
  const res={code:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.code=v;return this;},json(v){this.value=v;return this;}};
  await handler({sdrUser:user,query},res);expect(res.code).toBe(status);expect(res.headers['Cache-Control']).toBe('no-store');if(status!==200)expect(res.value.eligibleSupply).toBeUndefined();
 }
});
