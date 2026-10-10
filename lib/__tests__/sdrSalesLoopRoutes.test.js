import {describe,it,expect,vi} from 'vitest';
import {registerSdrSalesLoopRoutes} from '../sdrSalesLoopRoutes.js';
const viewer={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};
const context={lead:{id:'A',title:'Library',ownerId:'7',personId:'12',contactName:'Pat'},tasks:[],coverage:{partial:true}};
const response=()=>({statusCode:200,set(){return this;},status(value){this.statusCode=value;return this;},json(value){this.value=value;return this;}});
describe('sales loop routes',()=>{
 it('projects only the configured company and active visible lead context',async()=>{
  const handlers={},readContext=vi.fn(async()=>context);
  registerSdrSalesLoopRoutes({get:(_path,fn)=>handlers.read=fn,post:(_path,fn)=>handlers.prepare=fn},{pool:{},companyId:'42',readContext,readObservations:async()=>({publication:null,outcomes:[]})});
  const res=response();await handlers.read({params:{leadId:'A'},sdrUser:viewer,query:{}},res);
  expect(res.statusCode).toBe(200);expect(res.value).toMatchObject({leadId:'A',owner:{id:'7'},quote:{sent:'unknown'},handoff:{awareness:'unknown'}});
  expect(readContext).toHaveBeenCalledWith({}, {companyId:'42',leadId:'A',viewer});
 });
 it('keeps disabled runtime generation unavailable before any source or model call',async()=>{
  const handlers={},prepare=vi.fn();
  registerSdrSalesLoopRoutes({get:()=>{},post:(_path,fn)=>handlers.prepare=fn},{pool:{},companyId:'42',prepare,enabled:false});
  const res=response();await handlers.prepare({params:{leadId:'A'},sdrUser:viewer,body:{sourceRef:{kind:'crm_note',id:'n'},editorRequestVersion:1}},res);
  expect(res.statusCode).toBe(503);expect(res.value).toEqual({error:'preparation_unavailable'});expect(prepare).not.toHaveBeenCalled();
 });
 it('reads authorized observations after visibility, then projects only exact context evidence',async()=>{
  const handlers={},order=[];
  const readContext=vi.fn(async()=>{order.push('context');return context;});
  const readObservations=vi.fn(async()=>{order.push('observations');return {publication:{companyId:'42',leadId:'A',status:'confirmed',noteId:'n1',readbackVerified:true},outcomes:[{kind:'outgoing_reply',companyId:'wrong',leadId:'A',source:'connected_gmail',linkage:'direct_unique',providerMessageId:'wrong'},{kind:'incoming_reply',companyId:'42',leadId:'A',sourceId:'in-1',linkage:'direct_unique'}]};});
  registerSdrSalesLoopRoutes({get:(_path,fn)=>handlers.read=fn,post:()=>{}},{pool:{},companyId:'42',readContext,readObservations});
  const res=response();await handlers.read({params:{leadId:'A'},sdrUser:viewer,query:{}},res);
  expect(order).toEqual(['context','observations']);
  expect(readObservations).toHaveBeenCalledWith({}, {companyId:'42',leadId:'A',viewer,context,resolveVisibleMailboxes:undefined});
  expect(res.value).toMatchObject({handoff:{publication:'confirmed',noteId:'n1'},incoming:[{sourceId:'in-1'}],outgoing:{status:'unknown'}});
 });
 it('rejects client-supplied owner, tenant, text and linkage assertions',async()=>{
  const handlers={};registerSdrSalesLoopRoutes({get:()=>{},post:(_path,fn)=>handlers.prepare=fn},{pool:{},companyId:'42',enabled:true,prepare:vi.fn()});
  for(const field of ['companyId','ownerId','sourceText','leadId','match']){
   const res=response();await handlers.prepare({params:{leadId:'A'},sdrUser:viewer,body:{sourceRef:{kind:'crm_note',id:'n'},editorRequestVersion:1,[field]:'attack'}},res);
   expect(res.statusCode).toBe(400);
  }
 });
});
