import { sdrFetch } from './sdrApi';
// Bounded GETs only. Sending and other mutations keep their existing behavior.
export async function sdrReadRequest<T>(path:string,signal?:AbortSignal):Promise<T> {
  const controller=new AbortController();
  let rejectCancellation!:(reason:Error)=>void;
  const cancellation=new Promise<never>((_,reject)=>{rejectCancellation=reject;});
  const cancel=()=>{controller.abort();rejectCancellation(new DOMException('Aborted','AbortError'));};
  signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{controller.abort();rejectCancellation(new Error('Request took too long. Please retry.'));},12000);
  try {
    if(signal?.aborted) {cancel();return await cancellation;}
    const result=await Promise.race([sdrFetch<T>(path,{method:'GET',signal:controller.signal}),cancellation]);
    if(!result || typeof result!=='object' || Array.isArray(result)||'raw' in result) throw new Error('Data is unavailable. Please retry.');
    return result;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
// Each effect owns one generation; cleanup invalidates success, error AND settlement,
// even if an old transport ignores abort. Separate callers settle independently.
export function runLatestRead<T>(read:(signal:AbortSignal)=>Promise<T>,publish:{success:(value:T)=>void;error:(error:unknown)=>void;settled:()=>void}) {
  const controller=new AbortController();
  void read(controller.signal).then(value=>{if(!controller.signal.aborted) publish.success(value);},error=>{if(!controller.signal.aborted) publish.error(error);}).finally(()=>{if(!controller.signal.aborted) publish.settled();});
  return ()=>controller.abort();
}
