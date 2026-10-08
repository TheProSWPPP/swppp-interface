import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { it, expect, vi } from 'vitest';
const source = readFileSync(new URL('../../src/components/SdrInterface.tsx', import.meta.url), 'utf8');
const transpile = (s) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
it('Priority rejects ineligible sends and future timestamps even with enough opens', () => {
    const block = source.slice(source.indexOf('const HIGH_INTENT_WINDOW_MS'), source.indexOf('// Priority "dismissed"'));
    const isHot = new Function(`${transpile(block)};return isHot;`)();
    const lead = { replies: 0, opens: 4, clicks: 0, send_status: 'sent', last_intent_at: new Date().toISOString(), priority_eligible: true };
    expect(isHot(lead)).toBe(true);
    expect(isHot({ ...lead, priority_eligible: false })).toBe(false);
    expect(isHot({ ...lead, last_intent_at: new Date(Date.now() + 100000).toISOString() })).toBe(false);
});
function inboxLinkHarness(findLeadThread,initial='#/sdr?inboxLead=one'){
    const start = source.indexOf('  useEffect(() => {', source.indexOf('// Deep-link from a forwarded reply'));
    const end = source.indexOf('  useEffect(() => {', start + 10);
    const target = new EventTarget();
    const window = { location: { hash: initial }, history: { replaceState: vi.fn() }, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) };
    let opened = null,drawer=null,notice=null;
    const sdrApi = {findLeadThread};
    let cleanup = () => { };
    new Function('useEffect', 'window', 'sdrApi', 'goInbox', 'setDeepLeadId','setInboxLinkNotice', transpile(source.slice(start, end)))((fn) => cleanup = fn(), window, sdrApi, (v) => { opened = v.threadId; }, v=>{drawer=v;}, v=>{notice=v;});
    return {navigate(id){window.location.hash=`#/sdr?inboxLead=${id}`;target.dispatchEvent(new Event('hashchange'));},get opened(){return opened;},get drawer(){return drawer;},get notice(){return notice;},cleanup};
}
const flush=()=>new Promise(r=>setTimeout(r,0));
it('opens a second inboxLead hash without remount and ignores an older pending lookup', async () => {
    let resolveFirst = () => { };
    const h=inboxLinkHarness(async id=>id==='one'?await new Promise(r=>{resolveFirst=r;}):{threadId:'second',mailbox:'rep@test'});
    h.navigate('two');
    await flush();
    expect(h.opened).toBe('second');
    resolveFirst({ threadId: 'first', mailbox: 'rep@test' });
    await flush();
    expect(h.opened).toBe('second');expect(h.notice).toBeNull();
    h.cleanup();
});
it('shows generic empty and failure notices with lead drawer fallback',async()=>{
    const empty=inboxLinkHarness(async()=>({mailbox:null,threadId:null}));await flush();
    expect(empty.drawer).toBe('one');expect(empty.notice).toBe('No available inbox thread was found for this project. Check Pipedrive and other conversations.');empty.cleanup();
    const failure=inboxLinkHarness(async()=>{throw Error('private mailbox detail');});await flush();
    expect(failure.drawer).toBe('one');expect(failure.notice).toBe('Inbox search is unavailable. Check the project in Pipedrive.');failure.cleanup();
});
it('ignores an older rejection after a newer empty lookup and clears notice on later success',async()=>{
    let rejectFirst=()=>{};
    const h=inboxLinkHarness(async id=>id==='one'?await new Promise((_resolve,reject)=>{rejectFirst=reject;}):id==='two'?emptyThread:{threadId:'third',mailbox:'rep@test'});
    const emptyThread={threadId:null,mailbox:null};
    h.navigate('two');await flush();expect(h.drawer).toBe('two');expect(h.notice).toContain('No available inbox thread');
    rejectFirst(Error('private detail'));await flush();expect(h.drawer).toBe('two');expect(h.notice).toContain('No available inbox thread');
    h.navigate('three');await flush();expect(h.opened).toBe('third');expect(h.notice).toBeNull();h.cleanup();
});
it('clears a stale fallback notice when navigation leaves the inbox lead hash',async()=>{
    const h=inboxLinkHarness(async()=>({threadId:null,mailbox:null}));await flush();
    expect(h.notice).toContain('No available inbox thread');
    h.navigate('');await flush();
    expect(h.notice).toBeNull();h.cleanup();
});
