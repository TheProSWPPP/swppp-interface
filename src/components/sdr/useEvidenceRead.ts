import {useEffect,useRef,useState} from 'react';
import {getToken,getUser} from '../../lib/sdrApi';
const identity=()=>typeof window!=='undefined'&&getUser()?.role==='admin'?getToken():null;
// User-triggered reads are invalidated on close, scope change and session change.
export function useEvidenceRead<T>(scope:string){
 const [session,setSession]=useState(identity),[open,setOpen]=useState(false),[loading,setLoading]=useState(false),[result,setResult]=useState<{scope:string;session:string|null;value:T}|null>(null),[error,setError]=useState('');
 const generation=useRef(0),request=useRef<AbortController|null>(null);
 const clear=()=>{generation.current++;request.current?.abort();setOpen(false);setLoading(false);setResult(null);setError('');};
 useEffect(()=>{const reset=()=>{setSession(identity());clear();};window.addEventListener('sdr-session-changed',reset);window.addEventListener('sdr-session-expired',reset);window.addEventListener('storage',reset);return()=>{window.removeEventListener('sdr-session-changed',reset);window.removeEventListener('sdr-session-expired',reset);window.removeEventListener('storage',reset);};},[]);
 useEffect(()=>{const requests=generation,transport=request;clear();return()=>{requests.current++;transport.current?.abort();};},[scope]);
 const load=async(read:(signal:AbortSignal)=>Promise<T>)=>{const token=identity(),attempt=++generation.current;if(!token)return;request.current?.abort();const controller=new AbortController();request.current=controller;setOpen(true);setResult(null);setError('');setLoading(true);
 try{const value=await read(controller.signal);if(attempt===generation.current&&token===identity())setResult({scope,session:token,value});}catch{if(attempt===generation.current&&token===identity())setError('Evidence unavailable. Check access or try again.');}finally{if(attempt===generation.current&&token===identity())setLoading(false);}};
 return {allowed:Boolean(session&&session===identity()),open,loading,error,data:result?.scope===scope&&result.session===identity()?result.value:null,load,close:clear};
}
