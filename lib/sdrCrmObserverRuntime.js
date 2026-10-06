import { CRM_OBSERVATION_SCOPES } from './pipedriveObservationClient.js';
import { processPendingPipedriveEvents, reconcilePipedriveScope } from './sdrCrmObservations.js';
// Independent, read-only source collector. In particular it never calls the
// six-hour mirror sync, auto-switch, draft generation or enrollment paths.
export function createSdrCrmObserverRuntime({pool,client,companyId,processor=processPendingPipedriveEvents,reconciler=reconcilePipedriveScope,schedule=setInterval,cancel=clearInterval}) {
  let eventsRunning=false;
  let reconcileRunning=false;
  let cycleRunning=false;
  let nextScope=0;
  let started=false;
  const timers=[];
  const runEvents=async()=>{
    if(eventsRunning) return {skipped:'running'};
    eventsRunning=true;
    try {return await processor(pool,{client,companyId});}
    finally {eventsRunning=false;}
  };
  const runScope=async scope=>{
    if(reconcileRunning) return {skipped:'running'};
    if(!CRM_OBSERVATION_SCOPES.includes(scope)) throw new Error('invalid_reconciliation_scope');
    reconcileRunning=true;
    try {return await reconciler(pool,{client,companyId,scope,maxPages:2});}
    finally {reconcileRunning=false;}
  };
  const runNextScope=()=>runScope(CRM_OBSERVATION_SCOPES[nextScope++ % CRM_OBSERVATION_SCOPES.length]);
  const runReconciliationCycle=async()=>{
    if(cycleRunning) return {skipped:'running'};
    cycleRunning=true;
    try {
      const results=[];
      for(const scope of CRM_OBSERVATION_SCOPES) results.push(await runScope(scope));
      return results;
    } finally {cycleRunning=false;}
  };
  const tick=work=>()=>Promise.resolve().then(work).catch(error=>console.error('[crm-observer]',error));
  return {
    runEvents,runScope,runNextScope,runReconciliationCycle,
    start({observerEnabled=false}={}) {
      if(started) return;
      if(observerEnabled&&(!pool||!client||!companyId)) throw new Error('crm_observer_configuration_required');
      started=true;
      if(observerEnabled) {
        timers.push(schedule(tick(runEvents),30_000));
        timers.push(schedule(tick(runReconciliationCycle),5*60_000));
      }
    },
    stop() {for(const timer of timers.splice(0)) cancel(timer);started=false;},
  };
}
