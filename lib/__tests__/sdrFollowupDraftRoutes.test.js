import {describe,it,expect} from 'vitest';
let module;
try{module=await import('../sdrFollowupDraftRoutes.js');}catch{module={};}
describe('private draft routes',()=>{
 it('registers explicit read/save endpoints',()=>{expect(module.registerSdrFollowupDraftRoutes).toBeTypeOf('function');});
 it('requires human session before using the database',async()=>{
  const routes=new Map(),app={get:(p,h)=>routes.set('GET',h),put:(p,h)=>routes.set('PUT',h)};
  let calls=0;module.registerSdrFollowupDraftRoutes(app,{pool:{connect:()=>{calls++;throw Error('unexpected');}},companyId:'42'});
  for(const method of ['GET','PUT'])for(const viewer of [null,{role:'machine',sub:'id'},{role:'admin',machine:true}]){
   const res={statusCode:200,status(s){this.statusCode=s;return this;},json(value){this.value=value;return this;}};
   await routes.get(method)({sdrUser:viewer,params:{leadId:'A'},body:{}},res);expect(res.statusCode).toBe(403);
  }
  expect(calls).toBe(0);
 });
 it('fails closed with missing configured company',()=>{expect(()=>module.registerSdrFollowupDraftRoutes({},{pool:{},companyId:''})).toThrow();});
});
