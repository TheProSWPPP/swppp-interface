// Metadata collection only. No provider writes, action queues or sales decisions.
import * as gmailClient from './gmailInbox.js';
import * as pipedriveClient from './pipedriveClient.js';
import {observeConversationMessage,pipedriveMessageObservation} from './sdrConversationHistory.js';
import {threadReplyEvidence} from './sdrOutgoingReplyEvidence.js';
const norm=value=>String(value || '').trim().toLowerCase();
const errorCategory=e=>e?.category || (e?.status===401||e?.status===403?'permission':e?.status===429?'rate_limit':'unavailable');
const PIPEDRIVE_ORDERING_VERSION=2;
const folderClock=(thread,folder)=>stamp(thread[folder==='sent'?'last_message_sent_timestamp':folder==='inbox'?'last_message_received_timestamp':'last_message_timestamp']);
const fail=category=>Object.assign(new Error(category),{category});
const limit=(value,fallback,max)=>Number.isInteger(value)&&value>0?Math.min(value,max):fallback;
const stamp=value=>{
  const utc=typeof value==='string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ','T')+'Z':value;
  return utc && Number.isFinite(+new Date(utc)) ? new Date(utc).toISOString():null;
};
function nextOffset(page,start,{nested=false}={}) {
  if(nested && (page.pagination==null || typeof page.pagination==='object' && !Array.isArray(page.pagination) && Object.keys(page.pagination).length===0)) return null; // This endpoint may return the whole thread.
  const p=page.pagination;
  if(!p || typeof p.more_items_in_collection!=='boolean') throw fail('pagination_invalid');
  if(!p.more_items_in_collection) return null;
  if(!Number.isInteger(p.next_start)||p.next_start<=start||!page.data.length) throw fail('pagination_invalid');
  return p.next_start;
}
function threadSnapshot(t) {
  return Object.fromEntries(['id','lead_id','deal_id','person_id','account_id','message_count','version','last_message_timestamp','last_message_sent_timestamp','last_message_received_timestamp','update_time'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]]));
}
function fingerprint(t) {
  if(!Number.isInteger(t.message_count)||!stamp(t.last_message_timestamp)) return null;
  return JSON.stringify([t.version??null,t.message_count,stamp(t.last_message_timestamp),t.lead_id??null,t.deal_id??null,t.person_id??null,t.account_id??null]);
}
export function createConversationSyncRuntime({pool,getToken,gmail=gmailClient,pipedrive=pipedriveClient,accounts=[],accountKey,
  schedule=(fn,ms)=>setInterval(fn,ms),cancel=clearInterval,now=()=>new Date(),runJob,
  pageSize=10,requestBudget=2,folders=['sent','inbox','archive'],recentIntervalMs=15*60000,historyIntervalMs=60*60000}={}) {
  const size=limit(pageSize,10,25),budget=limit(requestBudget,2,5);
  let timers=[],started=false;
  const save=async(db,provider,account,scope,state,status,counts,error=null)=>{
    await db.query(`INSERT INTO sdr_conversation_sync_state(provider,account_key,scope,state,status,counts,error_category)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider,account_key,scope) DO UPDATE SET
      state=EXCLUDED.state,status=EXCLUDED.status,counts=EXCLUDED.counts,error_category=EXCLUDED.error_category,checked_at=now()`,
      [provider,account,scope,JSON.stringify(state),status,JSON.stringify(counts),error]);
  };
  async function collect(provider,account,scope,{head=false,history=false,folder}={}) {
    const work=async()=>{
      const db=await pool.connect();const lock=`conversation-sync:${provider}:${account}:${scope}`;let acquired=false;
      let state={},counts={requests:0,pages:0,observed:0,inserted:0,skippedThreads:0};
      try {
        acquired=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lock])).rows[0].acquired;
        if(!acquired) return {provider,account,scope,coverage:'partial',skipped:'locked',counts};
        const saved=(await db.query('SELECT state,status FROM sdr_conversation_sync_state WHERE provider=$1 AND account_key=$2 AND scope=$3',[provider,account,scope])).rows[0];
        if(history && saved?.state.done) return {provider,account,scope,coverage:'complete',counts};
        state=saved?.state || {};
        const current=now();
        // Folder ordering changed from the generic clock. Replay only the affected
        // recent window; completed messages remain idempotent and history keeps its cursor.
        const upgrade=provider==='pipedrive' && !history && state.to && state.orderingVersion!==PIPEDRIVE_ORDERING_VERSION;
        if(upgrade) state={from:state.from,to:state.to,start:0,orderingVersion:PIPEDRIVE_ORDERING_VERSION};
        if(!upgrade && (head || !state.to || state.done)) {
          const previousTo=state.to;
          state={from:history?null:new Date(head?+current-15*60000:previousTo?+new Date(previousTo)-10*60000:+current-48*3600000).toISOString(),
            to:history?new Date(+current-48*3600000).toISOString():current.toISOString(),start:0};
        }
        if(provider==='pipedrive' && !history) state.orderingVersion=PIPEDRIVE_ORDERING_VERSION;
        if(provider==='gmail') {
          const token=await getToken(account);
          const query=`in:anywhere ${state.from?`after:${Math.floor(+new Date(state.from)/1000)} `:''}before:${Math.floor(+new Date(state.to)/1000)}`;
          let page,restarted=false;
          try { counts.requests++;page=await gmail.listThreadPage(token,{query,pageToken:state.pageToken||undefined,maxResults:size}); }
          catch(error) {
            if(!state.pageToken || error.status!==400 || !/page.?token|invalid.*argument/i.test(String(error.message))) throw error;
            restarted=true;state.pageToken=null;state.restarts=(state.restarts||0)+1;
            counts.requests++;page=await gmail.listThreadPage(token,{query,maxResults:size});
          }
          if(!Array.isArray(page?.threads) || page.nextPageToken!=null && typeof page.nextPageToken!=='string') throw fail('pagination_invalid');
          for(const thread of page.threads) {
            if(!thread.id || !Array.isArray(thread.messages)) throw fail('page_invalid');
            const evidence=threadReplyEvidence(thread,account);
            for(const m of thread.messages) {
              const result=await observeConversationMessage(db,{provider:'gmail',account,id:m.id,threadId:thread.id,internetMessageId:m.messageId,
                from:m.from,to:m.to,cc:m.cc,occurredAt:m.receivedAt,direction:m.lastOutbound===true?'out':m.lastOutbound===false?'in':'unknown',origin:'Unknown',sourceEvidence:evidence.get(m.id)});
              counts.observed++;counts.inserted+=result.inserted;
            }
          }
          counts.pages++;
          if(page.nextPageToken && page.nextPageToken===state.pageToken) {state.pageToken=null;throw fail('pagination_frozen');}
          state.pageToken=page.nextPageToken || null;
          state.done=!state.pageToken;
          // An expired-cursor restart never claims complete in the same pass.
          if(restarted) state.done=false;
        } else {
          while(counts.requests<budget && !state.done) {
            if(!state.threads) {
              counts.requests++;
              const page=await pipedrive.listMailThreads({folder,start:state.start||0,limit:size});
              if(!Array.isArray(page?.data)) throw fail('page_invalid');
              let next=nextOffset(page,state.start||0);
              let scoped=page.data;
              if(!history) {
                let previous=state.lastThreadAt ? +new Date(state.lastThreadAt) : Infinity;
                for(const thread of page.data) {
                  const at=folderClock(thread,folder);
                  if(!at || +new Date(at)>previous) state.orderingUnverified=true;
                  if(at) previous=+new Date(at);
                }
                if(Number.isFinite(previous)) state.lastThreadAt=new Date(previous).toISOString();
                if(!state.orderingUnverified) {
                  const cutoff=page.data.findIndex(t=>+new Date(folderClock(t,folder))<+new Date(state.from));
                  if(cutoff>=0) {scoped=page.data.slice(0,cutoff);next=null;state.cutoffReached=true;}
                }
              }
              state.threads=scoped.map(t=>{if(!t.id) throw fail('page_invalid');return threadSnapshot(t);});
              state.index=0;state.messageStart=0;state.next=next;counts.pages++;
              await save(db,provider,account,scope,state,'partial',counts);
            }
            if(state.index>=state.threads.length) {
              if(head || state.next===null) {state.done=true;state.limited=state.next!==null;break;}
              state.start=state.next;delete state.threads;continue;
            }
            const thread=state.threads[state.index],fp=fingerprint(thread);
            const latest=folderClock(thread,folder),updated=stamp(thread.update_time);
            if(!history && !state.messageStart && latest && +new Date(latest)<+new Date(state.from) && (!updated || +new Date(updated)<+new Date(state.from))) {state.index++;counts.skippedThreads++;continue;}
            const prior=fp?(await db.query('SELECT fingerprint FROM sdr_conversation_sync_threads WHERE provider=$1 AND account_key=$2 AND thread_id=$3',[provider,account,String(thread.id)])).rows[0]:null;
            if(!state.messageStart && fp && prior?.fingerprint===fp) {state.index++;counts.skippedThreads++;continue;}
            if(counts.requests>=budget) break;
            counts.requests++;
            const page=await pipedrive.listMailThreadMessages(thread.id,{start:state.messageStart||0,limit:size});
            if(!Array.isArray(page?.data)) throw fail('page_invalid');
            const next=nextOffset(page,state.messageStart||0,{nested:true});
            for(const m of page.data) {
              const result=await observeConversationMessage(db,pipedriveMessageObservation(m,thread,account));
              counts.observed++;counts.inserted+=result.inserted;
            }
            counts.pages++;
            if(next===null) {
              if(fp) await db.query(`INSERT INTO sdr_conversation_sync_threads(provider,account_key,thread_id,fingerprint) VALUES($1,$2,$3,$4)
                ON CONFLICT(provider,account_key,thread_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,completed_at=now()`,[provider,account,String(thread.id),fp]);
              state.index++;state.messageStart=0;
            } else state.messageStart=next;
            if(state.index>=state.threads.length && state.next===null) state.done=true;
            await save(db,provider,account,scope,state,state.done?'complete':'partial',counts);
          }
        }
        const complete=state.done&&!state.limited&&!state.orderingUnverified;
        await save(db,provider,account,scope,state,complete?'complete':'partial',counts,state.orderingUnverified?'ordering_unverified':null);
        return {provider,account,scope,coverage:complete?'complete':'partial',counts};
      } catch(error) {
        const category=errorCategory(error);
        if(acquired) await save(db,provider,account,scope,state,'error',counts,category);
        return {provider,account,scope,coverage:'partial',errorCategory:category,counts};
      } finally {
        try {if(acquired) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}
        finally {db.release();}
      }
    };
    return runJob ? runJob({provider,account,scope,work}) : work();
  }
  async function run(mode) {
    const list=typeof accounts==='function'?await accounts():accounts;
    const scopes=[];
    for(const account of [...new Set((list || []).map(norm))].filter(Boolean)) {
      if(mode==='recent') scopes.push(await collect('gmail',account,'recent-head',{head:true}));
      scopes.push(await collect('gmail',account,mode,{history:mode==='history'}));
    }
    if(accountKey) for(const folder of folders) {
      if(!['sent','inbox','archive'].includes(folder)) throw new Error('invalid_folder');
      if(mode==='recent') scopes.push(await collect('pipedrive',norm(accountKey),`recent-head:${folder}`,{head:true,folder}));
      scopes.push(await collect('pipedrive',norm(accountKey),`${mode}:${folder}`,{history:mode==='history',folder}));
    }
    return {coverage:scopes.length&&scopes.every(r=>r.coverage==='complete')?'complete':'partial',scopes};
  }
  const runRecent=()=>run('recent'),runHistory=()=>run('history');
  return {runRecent,runHistory,runCycle:async()=>({recent:await runRecent(),history:await runHistory()}),
    start:async()=>{if(started) return {skipped:'already_started'};started=true;
      timers=[schedule(()=>runRecent().catch(()=>{}),recentIntervalMs),schedule(()=>runHistory().catch(()=>{}),historyIntervalMs)];
      for(const timer of timers) timer?.unref?.();return runRecent();},
    stop:()=>{for(const timer of timers) cancel(timer);timers=[];started=false;}};
}
