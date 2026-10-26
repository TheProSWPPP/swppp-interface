import {afterEach,describe,expect,it,vi} from 'vitest';
import {createInboxReadCache,readInboxMailbox,readInboxPages,inboxReadHealth,isGmailQuotaError,invalidateInboxMailbox} from '../sdrInboxOverview.js';
import {listThreadPage} from '../gmailInbox.js';

const quota=()=>Object.assign(new Error("Gmail GET /threads → 403: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"),{status:403,reason:'rateLimitExceeded'});
const thread=id=>({id,subject:`Subject ${id}`,messages:[]});
function setup({pages}={}){
  let clock=1_000_000;
  const cache=createInboxReadCache({now:()=>clock,freshMs:30_000,baseBackoffMs:60_000,maxBackoffMs:600_000});
  const calls=[];
  const gmailInbox={listThreadPage:vi.fn(async(token,options)=>{calls.push(options);return pages?pages(options,calls.length):{threads:[thread('a'),thread('b')],nextPageToken:null};})};
  const deps={accessTokenForMailbox:async mailbox=>`token:${mailbox}`,gmailInbox};
  return {cache,deps,gmailInbox,calls,tick:ms=>{clock+=ms;}};
}

describe('shared inbox read cache',()=>{
  it('shares one Gmail read between requests that arrive together',async()=>{
    const {cache,deps,gmailInbox}=setup();
    const [first,second]=await Promise.all([readInboxMailbox('rep@x.test',deps,{cache}),readInboxMailbox('rep@x.test',deps,{cache})]);
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(1);
    expect(first.threads.map(t=>t.id)).toEqual(['a','b']);
    expect(second.coverage.status).toBe('complete');
  });
  it('reuses a fresh copy for 30 seconds, then reads again; an explicit refresh reads at once',async()=>{
    const {cache,deps,gmailInbox,tick}=setup();
    await readInboxMailbox('rep@x.test',deps,{cache});
    tick(10_000);await readInboxMailbox('rep@x.test',deps,{cache});
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(1);
    await readInboxMailbox('rep@x.test',deps,{cache,force:true});
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(2);
    tick(31_000);await readInboxMailbox('rep@x.test',deps,{cache});
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(3);
    invalidateInboxMailbox('REP@x.test',cache);await readInboxMailbox('rep@x.test',deps,{cache});
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(4);
  });
  it('keeps showing the last good copy, marked stale, while Google rate-limits the mailbox, and backs off',async()=>{
    let fail=false;
    const {cache,deps,gmailInbox,tick}=setup({pages:()=>{if(fail)throw quota();return {threads:[thread('a'),thread('b'),thread('c')],nextPageToken:null};}});
    await readInboxMailbox('rep@x.test',deps,{cache});
    fail=true;tick(31_000);
    const stale=await readInboxMailbox('rep@x.test',deps,{cache});
    expect(stale.threads.map(t=>t.id)).toEqual(['a','b','c']);
    expect(stale.coverage).toMatchObject({status:'stale',issue:'google_limit',checkedAt:new Date(1_000_000).toISOString()});
    expect(Date.parse(stale.coverage.retryAt)).toBe(1_000_000+31_000+60_000);
    // No more Gmail calls during the backoff, even for an explicit refresh.
    tick(20_000);await readInboxMailbox('rep@x.test',deps,{cache,force:true});
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(2);
    // A second limit doubles the wait.
    tick(41_000);const again=await readInboxMailbox('rep@x.test',deps,{cache});
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(3);
    expect(Date.parse(again.coverage.retryAt)-(1_000_000+92_000)).toBe(120_000);
    fail=false;tick(121_000);
    const back=await readInboxMailbox('rep@x.test',deps,{cache});
    expect(back.coverage).toMatchObject({status:'complete'});
    expect(back.coverage.issue).toBeUndefined();
  });
  it('reports an unread mailbox as an error with nothing invented when there is no earlier copy',async()=>{
    const {cache,deps}=setup({pages:()=>{throw quota();}});
    const result=await readInboxPages(['rep@x.test'],deps,{cache});
    expect(result.threads).toEqual([]);
    expect(result.coverage).toMatchObject({complete:false,mailboxes:[{mailbox:'rep@x.test',status:'error',issue:'google_limit'}]});
  });
  it('does not back off on other failures, so a fixed token is read on the next request',async()=>{
    let fail=true;
    const {cache,deps,gmailInbox}=setup({pages:()=>{if(fail)throw Object.assign(new Error('token refresh failed'),{status:400});return {threads:[thread('a')],nextPageToken:null};}});
    expect((await readInboxMailbox('rep@x.test',deps,{cache})).coverage).toMatchObject({status:'error',issue:'read_failed',retryAt:null});
    fail=false;
    expect((await readInboxMailbox('rep@x.test',deps,{cache})).coverage.status).toBe('complete');
    expect(gmailInbox.listThreadPage).toHaveBeenCalledTimes(2);
  });
  it('shares the live read state with System checks',async()=>{
    let fail=false;
    const {cache,deps,tick}=setup({pages:()=>{if(fail)throw quota();return {threads:[thread('a')],nextPageToken:'more'};}});
    expect(inboxReadHealth(['rep@x.test'],cache)).toEqual([{mailbox:'rep@x.test',status:'not_checked',checkedAt:null,issue:null,retryAt:null}]);
    await readInboxMailbox('rep@x.test',deps,{cache});
    expect(inboxReadHealth(['rep@x.test'],cache)[0]).toMatchObject({status:'current',issue:null});
    fail=true;tick(31_000);await readInboxMailbox('rep@x.test',deps,{cache});
    expect(inboxReadHealth(['REP@x.test'],cache)[0]).toMatchObject({mailbox:'REP@x.test',status:'stale',issue:'google_limit'});
  });
  it('recognises Google rate-limit answers only',()=>{
    expect(isGmailQuotaError(quota())).toBe(true);
    expect(isGmailQuotaError({status:429})).toBe(true);
    expect(isGmailQuotaError({status:403,reason:'userRateLimitExceeded'})).toBe(true);
    expect(isGmailQuotaError({status:403,reason:'insufficientPermissions',message:'Insufficient Permission'})).toBe(false);
    expect(isGmailQuotaError({status:500,message:'quota'})).toBe(false);
    expect(isGmailQuotaError(null)).toBe(false);
  });
});

describe('Gmail thread page reads',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('skips unchanged threads by historyId and keeps at most five reads in flight',async()=>{
    let inflight=0,peak=0,gets=0,history='1';
    vi.stubGlobal('fetch',vi.fn(async url=>{
      if(/\/threads\?/.test(url))return {ok:true,json:async()=>({threads:Array.from({length:12},(_,i)=>({id:`t${i}`,historyId:i===3?history:'1'}))})};
      gets++;inflight++;peak=Math.max(peak,inflight);await new Promise(r=>setTimeout(r,5));inflight--;
      return {ok:true,json:async()=>({messages:[{id:'m',labelIds:[],payload:{headers:[{name:'Subject',value:String(url)}]}}]})};
    }));
    const metadataCache=new Map();
    const first=await listThreadPage('token',{metadataCache,concurrency:5});
    expect(first.threads).toHaveLength(12);
    expect(gets).toBe(12);
    expect(peak).toBeLessThanOrEqual(5);
    history='2';
    const second=await listThreadPage('token',{metadataCache,concurrency:5});
    expect(gets).toBe(13);
    expect(second.threads.map(t=>t.id)).toEqual(first.threads.map(t=>t.id));
  });
});
