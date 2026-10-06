import {useEffect,useState} from 'react';
import {getMetrics,type MetricsQuery,type MetricsResponse} from '../../lib/sdrMetricsApi';
import {runLatestRead} from '../../lib/sdrReadRequest';
export function useWorkspaceMetrics(query:MetricsQuery,enabled:boolean){
 const [reload,setReload]=useState(0);
 const [history,setHistory]=useState<MetricsResponse['company_sales']>();
 const key=JSON.stringify([query,reload]);
 const [result,setResult]=useState<{key:string;data:MetricsResponse|null;error:boolean}>({key:'',data:null,error:false});
 useEffect(()=>{
  if(!enabled)return;
  return runLatestRead(signal=>getMetrics(query,signal),{
   success:data=>{setResult({key,data,error:false});if(data.company_sales)setHistory(data.company_sales);},
   error:()=>setResult({key,data:null,error:true}),
   settled:()=>{},
  });
 },[query,enabled,key]);
 const current=enabled&&result.key===key;
 return {history:enabled?history:undefined,data:current?result.data:null,error:current&&result.error,loading:enabled&&!current,refresh:()=>setReload(value=>value+1)};
}
