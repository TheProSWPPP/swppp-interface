import {describe,it,expect} from 'vitest';import {startLinkedinRuntime} from '../sdrLinkedinRuntime.js';
describe('LinkedIn timer isolation',()=>{
 it('contains a rejected timer tick and backs off without leaking the error',async()=>{
  let installed,attempts=0;let time=new Date('2026-10-19T15:00:00Z');
  const runtime=startLinkedinRuntime({mode:'observe',companyId:'13105180',accountId:'isolation',pool:{},client:{},now:()=>time,scheduler:{setInterval:fn=>{installed=fn;return 1},clearInterval(){}},work:async()=>{attempts++;throw Object.assign(new Error('private provider detail'),{status:429})}});
  await runtime.ready;await expect(installed()).resolves.toMatchObject({coverage:'partial',errorCategory:'rate_limit'});
  expect(JSON.stringify(runtime.lastResult)).not.toContain('private provider detail');
  await runtime.tick();expect(attempts).toBe(1);
  time=new Date('2026-10-19T15:02:00Z');await runtime.tick();expect(attempts).toBe(2);runtime.stop();
 });
 it('does not schedule or read the provider when required schema is absent',async()=>{
  let scheduled=0,reads=0;
  const runtime=startLinkedinRuntime({mode:'observe',companyId:'13105180',accountId:'missing-schema',pool:{query:async()=>({rows:[]})},client:{getAccount:async()=>{reads++}},scheduler:{setInterval:()=>{scheduled++;return 1},clearInterval(){}}});
  await runtime.ready;expect(runtime.state).toBe('unavailable');expect(scheduled).toBe(0);expect(reads).toBe(0);
  await expect(runtime.tick()).resolves.toMatchObject({coverage:'partial',errorCategory:'missing_schema'});runtime.stop();
 });
 it('does not install a timer after stop during asynchronous preflight',async()=>{
  let finish,scheduled=0;
  const runtime=startLinkedinRuntime({mode:'observe',companyId:'13105180',accountId:'stopped-preflight',pool:{query:()=>new Promise(resolve=>{finish=resolve})},client:{},scheduler:{setInterval:()=>{scheduled++;return 1},clearInterval(){}}});
  runtime.stop();finish({rows:[]});await runtime.ready;expect(scheduled).toBe(0);expect(runtime.state).toBe('stopped');
 });
});
describe('LinkedIn runtime',()=>{it('does no work or scheduling by default',()=>{let scheduled=0;const runtime=startLinkedinRuntime({mode:'disabled',scheduler:{setInterval:()=>{scheduled++},clearInterval:()=>{}}});expect(runtime.state).toBe('disabled');expect(scheduled).toBe(0);runtime.stop()});it('serializes bounded ticks and stop clears timer',async()=>{let tick,cleared=false,work=0;const scheduler={setInterval:fn=>{tick=fn;return 1},clearInterval:()=>{cleared=true}};const runtime=startLinkedinRuntime({mode:'observe',companyId:'13105180',accountId:'sender',pool:{},client:{},scheduler,work:async()=>{work++;await new Promise(r=>setTimeout(r,5))}});await runtime.ready;await Promise.all([tick(),tick()]);expect(work).toBe(1);runtime.stop();expect(cleared).toBe(true)})});
