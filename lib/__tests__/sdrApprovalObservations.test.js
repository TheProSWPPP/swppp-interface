import {EventEmitter} from 'node:events';
import {describe,it,expect,vi} from 'vitest';
import {createApprovalObserver} from '../sdrApprovalObservations.js';
const id='11111111-1111-4111-8111-111111111111';
const request=()=>({params:{id},sdrUser:{sub:'staff',machine:false}});
function response(){const res=new EventEmitter();res.statusCode=409;res.json=function(...args){this.originalArgs=args;return this;};return res;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(){for(let n=0;n<5;n++)await tick();}

describe('approval response observer',()=>{
 it('records only after finish and preserves response arguments, this and return value',async()=>{
  const saved=[];const o=createApprovalObserver({companyId:'13105180',write:async e=>{saved.push(e);return true;}});const res=response();const body={code:'daily_cap_reached',error:'private buyer text',draft:{body:'secret'}};
  o.middleware(request(),res,()=>{});expect(res.json(body,'extra')).toBe(res);expect(res.originalArgs).toEqual([body,'extra']);expect(saved).toEqual([]);
  res.emit('finish');res.emit('finish');await settled();expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({companyId:'13105180',draftId:id,origin:'interactive',httpStatus:409,responseCode:'daily_cap_reached',category:'capacity',kind:'http_refusal'});
  expect(JSON.stringify(saved)).not.toContain('secret');expect(JSON.stringify(saved)).not.toContain('buyer');expect(o.stats()).toMatchObject({finished:1,persisted:1,queued:0});
 });
 it('keeps denied and invalid draft references aggregate-only',async()=>{
  const saved=[];const o=createApprovalObserver({companyId:'13105180',write:async e=>{saved.push(e);return true;}});
  for(const status of [401,403,404]){const res=response();res.statusCode=status;o.middleware(request(),res,()=>{});res.json({code:'outreach_held'});res.emit('finish');}
  const res=response();o.middleware({...request(),params:{id:'private-injected-text'}},res,()=>{});res.emit('finish');await settled();expect(saved).toEqual([]);expect(o.stats()).toMatchObject({denied:3,droppedInvalid:1});
 });
 it('does not inspect getters, inherited codes or nested draft content',async()=>{
  const saved=[];const o=createApprovalObserver({companyId:'13105180',write:async e=>{saved.push(e);return true;}});const getter=vi.fn(()=>{throw Error('must not run');});
  for(const body of [Object.create({code:'daily_cap_reached'}),Object.defineProperty({},'code',{get:getter}),{code:'private text'},{code:'x'.repeat(5000)},{draft:Object.defineProperty({},'status',{get:getter})}]){
   const res=response();res.statusCode=200;o.middleware(request(),res,()=>{});res.json(body);res.emit('finish');
  }
  await settled();expect(getter).not.toHaveBeenCalled();expect(saved).toHaveLength(5);expect(saved.every(e=>e.responseCode==='unknown'&&e.kind==='http_success_response'&&e.category==='unknown')).toBe(true);
 });
 it('preserves an original json exception without inventing a completed response',async()=>{
  const saved=[];const o=createApprovalObserver({companyId:'13105180',write:async e=>{saved.push(e);return true;}});const error=Error('original');const res=response();res.json=()=>{throw error;};
  o.middleware(request(),res,()=>{});expect(()=>res.json({code:'outreach_held'})).toThrow(error);res.emit('close');await settled();expect(saved).toEqual([]);expect(o.stats().abandoned).toBe(1);
 });
 it('contains setup failures and does not swallow downstream errors',()=>{
  const o=createApprovalObserver({companyId:'13105180',write:async()=>true});const res=response();Object.defineProperty(res,'json',{value:res.json,writable:false});let next=0;expect(()=>o.middleware(request(),res,()=>next++)).not.toThrow();expect(next).toBe(1);const error=Error('downstream');expect(()=>o.middleware(request(),response(),()=>{throw error;})).toThrow(error);
 });
 it('does not count an idempotent duplicate as an inserted row',async()=>{
  const o=createApprovalObserver({companyId:'13105180',write:async()=>false});const res=response();o.middleware(request(),res,()=>{});res.emit('finish');await settled();expect(o.stats()).toMatchObject({persisted:0,duplicate:1});
 });
 it('does not capture unauthenticated or unconfigured requests',async()=>{
  const write=vi.fn();for(const companyId of [undefined,'foreign','13105180']){const o=createApprovalObserver({companyId,write});const res=response();let next=0;o.middleware(companyId==='13105180'?{params:{id}}:request(),res,()=>next++);res.json({code:'outreach_held'});res.emit('finish');expect(next).toBe(1);}await settled();expect(write).not.toHaveBeenCalled();
 });
 it('drops full queues and failed inserts without blocking or retrying',async()=>{
  let release;let calls=0;const pending=new Promise(r=>release=r);const o=createApprovalObserver({companyId:'13105180',maxQueued:2,write:async()=>{calls++;await pending;throw Error('db unavailable');}});
  for(let n=0;n<5;n++){const res=response();o.middleware(request(),res,()=>{});expect(res.json({code:'outreach_held'})).toBe(res);res.emit('finish');}
  expect(calls).toBe(0);await tick();expect(calls).toBe(1);expect(o.stats().droppedFull).toBe(3);release();await settled();expect(calls).toBe(2);expect(o.stats()).toMatchObject({persisted:0,failedOrUncertain:2,queued:0});
 });
 it('retains distinct finished requests and never calls a 500 outcome a definite refusal',async()=>{
  const saved=[];const o=createApprovalObserver({companyId:'13105180',write:async e=>{saved.push(e);return true;}});for(let i=0;i<2;i++){const res=response();res.statusCode=500;o.middleware({...request(),sdrUser:{sub:'machine',machine:true}},res,()=>{});res.json({code:'provider_receipt_unverified'});res.emit('finish');res.emit('close');}await settled();expect(new Set(saved.map(e=>e.id)).size).toBe(2);expect(saved.every(e=>e.origin==='machine'&&e.kind==='http_error')).toBe(true);expect(o.stats().abandoned).toBe(0);
 });
});
