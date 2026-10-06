import { expect, it, vi } from 'vitest';
import { createSdrCrmObserverRuntime } from '../sdrCrmObserverRuntime.js';

it('runs observation work independently and prevents overlapping worker and scope runs', async () => {
  let finish;
  const processor = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const reconciler = vi.fn(async () => ({status:'complete'}));
  const runtime = createSdrCrmObserverRuntime({pool:{},client:{},companyId:'test',processor,reconciler});
  const first = runtime.runEvents();
  expect(await runtime.runEvents()).toMatchObject({skipped:'running'});
  finish({processed:1});
  expect(await first).toEqual({processed:1});
  await runtime.runScope('notes');
  expect(reconciler).toHaveBeenCalledWith({},expect.objectContaining({companyId:'test',scope:'notes'}));
  expect(processor).toHaveBeenCalledTimes(1);
});

it('does not schedule any collection when all flags are off', () => {
  const schedule=vi.fn();
  const runtime=createSdrCrmObserverRuntime({pool:{},client:{},companyId:'test',processor:vi.fn(),reconciler:vi.fn(),schedule});
  runtime.start({observerEnabled:false,mailEnabled:false});
  expect(schedule).not.toHaveBeenCalled();
});
it('visits every CRM scope in one bounded catch-up cycle and does not duplicate timers',async()=>{
  const intervals=[];
  const schedule=vi.fn((work,ms)=>{intervals.push({work,ms});return intervals.length;});
  const reconciler=vi.fn(async()=>({status:'partial'}));
  const runtime=createSdrCrmObserverRuntime({pool:{},client:{},companyId:'test',processor:async()=>({}),reconciler,schedule});
  runtime.start({observerEnabled:true});runtime.start({observerEnabled:true});
  expect(schedule).toHaveBeenCalledTimes(2);
  await runtime.runReconciliationCycle();
  expect(reconciler).toHaveBeenCalledTimes(8);
  for(const [,options] of reconciler.mock.calls) expect(options.maxPages).toBe(2);
});
