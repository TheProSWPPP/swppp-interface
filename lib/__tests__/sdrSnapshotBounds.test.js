import {it,expect,vi,afterEach} from 'vitest';
import {readFollowupProjectContext} from '../sdrFollowupProjectContext.js';
import {readOperationsSnapshot} from '../sdrOperationsSnapshot.js';
const viewer={sub:'00000000-0000-0000-0000-000000000001',role:'admin'};
afterEach(()=>vi.useRealTimers());
for(const [name,read] of [['project',readFollowupProjectContext],['operations',readOperationsSnapshot]])it(`${name} acquisition times out and releases a client arriving after abandonment`,async()=>{
 vi.useFakeTimers();let connect,releaseCount=0,outcome='pending';
 const promise=read({connect:()=>new Promise(resolve=>connect=resolve)},{companyId:'42',leadId:'A',viewer,resolveVisibleMailboxes:async()=>[]}).then(()=>outcome='success',()=>outcome='rejected');
 await vi.advanceTimersByTimeAsync(5000);expect(outcome).toBe('rejected');
 connect({release:()=>releaseCount++});await Promise.resolve();await promise;expect(releaseCount).toBe(1);
});
it('bounds a hanging mailbox resolver, rolls back and releases the transaction',async()=>{
 vi.useFakeTimers();let outcome='pending',released=false,rolledBack=false,leased;
 const db={query:async value=>{const text=typeof value==='string'?value:value.text;if(text==='ROLLBACK')rolledBack=true;return {rowCount:text.includes('FROM sdr_users')?1:0,rows:[]};},release:()=>released=true};
 const promise=readOperationsSnapshot({connect:async()=>db},{companyId:'42',viewer,resolveVisibleMailboxes:(_viewer,client)=>{leased=client;return new Promise(()=>{});}}).then(()=>outcome='success',()=>outcome='rejected');
 await vi.advanceTimersByTimeAsync(5000);expect(outcome).toBe('rejected');expect(leased).toBeDefined();expect(rolledBack).toBe(true);expect(released).toBe(true);await promise;
});
