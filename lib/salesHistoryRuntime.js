import {fetchSalesHistory,storeSalesHistory} from './pipedriveSalesHistory.js';

// Reads Pipedrive and writes reporting facts only. Never enters SDR outreach.
export function createSalesHistoryRuntime({pool,apiToken,fetchHistory=fetchSalesHistory,storeHistory=storeSalesHistory,
 schedule=setInterval,cancel=clearInterval,onError=()=>console.error('[sales-history] refresh failed; retained facts remain available')}={}) {
 let timer=null,running=false;
 const run=async()=>{
  if(running)return {skipped:'running'};
  running=true;
  let db,locked=false;
  try {
   db=await pool.connect();
   locked=(await db.query("SELECT pg_try_advisory_lock(hashtext('pipedrive_sales_history_refresh')) AS locked")).rows[0].locked;
   if(!locked)return {skipped:'locked'};
   return await storeHistory(pool,await fetchHistory({apiToken}));
  } finally {
   try{if(locked)await db.query("SELECT pg_advisory_unlock(hashtext('pipedrive_sales_history_refresh'))");}
   finally{db?.release();running=false;}
  }
 };
 const tick=()=>void run().catch(onError);
 return {run,start({enabled=false}={}){
  if(!enabled||timer!==null)return;
  if(!pool||!apiToken)throw Error('sales_history_configuration_required');
  timer=schedule(tick,6*60*60*1000);tick();
 },stop(){if(timer!==null)cancel(timer);timer=null;}};
}
