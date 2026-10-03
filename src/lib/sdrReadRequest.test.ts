import { afterEach,expect,it,vi } from 'vitest';
import { sdrFetch } from './sdrApi';
import { sdrReadRequest,runLatestRead } from './sdrReadRequest';
vi.mock('./sdrApi',()=>({sdrFetch:vi.fn()}));
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('bounds even an unresponsive transport and cleans linked cancellation',async()=>{
 vi.useFakeTimers();const parent=new AbortController();const remove=vi.spyOn(parent.signal,'removeEventListener');
 vi.mocked(sdrFetch).mockImplementation(()=>new Promise(()=>{}));
 const promise=sdrReadRequest('/read',parent.signal);const assertion=expect(promise).rejects.toThrow('Request took too long. Please retry.');
 await vi.advanceTimersByTimeAsync(12000);await assertion;expect(remove).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('cancels linked reads and cleans timers on cancellation and success',async()=>{
 vi.useFakeTimers();vi.mocked(sdrFetch).mockImplementation(()=>new Promise(()=>{}));const parent=new AbortController();
 const promise=sdrReadRequest('/read',parent.signal);const assertion=expect(promise).rejects.toMatchObject({name:'AbortError'});parent.abort();await assertion;expect(vi.getTimerCount()).toBe(0);
 vi.mocked(sdrFetch).mockResolvedValue({ok:true});await expect(sdrReadRequest('/read')).resolves.toEqual({ok:true});expect(vi.getTimerCount()).toBe(0);
});
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
it('publishes current success while a comparison remains pending',async()=>{
 const current=deferred<string>(),previous=deferred<string>();const events:string[]=[];
 runLatestRead(()=>current.promise,{success:value=>events.push(value),error:()=>{},settled:()=>events.push('current settled')});
 runLatestRead(()=>previous.promise,{success:value=>events.push(value),error:()=>{},settled:()=>events.push('comparison settled')});
 current.resolve('current');await Promise.resolve();await Promise.resolve();expect(events).toEqual(['current','current settled']);
 previous.resolve('previous');await Promise.resolve();await Promise.resolve();expect(events).toContain('comparison settled');
});
it('prevents obsolete successes, failures and finally from publishing after rapid filters',async()=>{
 const old=deferred<string>(),failed=deferred<string>();const publish=vi.fn();
 const stop=runLatestRead(()=>old.promise,{success:publish,error:publish,settled:publish});const stopFailure=runLatestRead(()=>failed.promise,{success:publish,error:publish,settled:publish});
 stop();stopFailure();old.resolve('old');failed.reject(new Error('old failure'));await Promise.resolve();await Promise.resolve();expect(publish).not.toHaveBeenCalled();
});

it('rejects HTML fallback for every bounded read, including metrics and health',async()=>{
 for(const payload of ['<!doctype html>',{raw:'<!doctype html>'},null,[]]) {
  vi.mocked(sdrFetch).mockResolvedValue(payload);await expect(sdrReadRequest('/api/sdr/health')).rejects.toThrow('Data is unavailable');
 }
});
it('does not start an already cancelled read',async()=>{
 const controller=new AbortController();controller.abort();await expect(sdrReadRequest('/read',controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(sdrFetch).not.toHaveBeenCalled();
});
