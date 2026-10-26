import {afterEach,expect,it,vi} from 'vitest';
import {getPerson,addActivity} from '../pipedriveClient.js';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const limited={ok:false,status:429,headers:{get:k=>k==='retry-after'?'1':null},text:async()=>JSON.stringify({success:false,error:'request over limit'})};
const ok={ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({success:true,data:{id:9}})};
it('waits and retries a read that hit the rate limit',async()=>{
 vi.useFakeTimers();vi.stubEnv('PIPEDRIVE_API_TOKEN','test-only');
 const fetch=vi.fn().mockResolvedValueOnce(limited).mockResolvedValueOnce(limited).mockResolvedValueOnce(ok);
 vi.stubGlobal('fetch',fetch);
 const p=getPerson(9);await vi.advanceTimersByTimeAsync(5000);
 expect(await p).toMatchObject({id:9});expect(fetch).toHaveBeenCalledTimes(3);
});
it('gives up on a read after 3 retries',async()=>{
 vi.useFakeTimers();vi.stubEnv('PIPEDRIVE_API_TOKEN','test-only');
 const fetch=vi.fn().mockResolvedValue(limited);vi.stubGlobal('fetch',fetch);
 const p=getPerson(9);const done=expect(p).rejects.toThrow('429');await vi.advanceTimersByTimeAsync(60000);await done;
 expect(fetch).toHaveBeenCalledTimes(4);
});
it('never repeats a write on the rate limit',async()=>{
 vi.stubEnv('PIPEDRIVE_API_TOKEN','test-only');
 const fetch=vi.fn().mockResolvedValue(limited);vi.stubGlobal('fetch',fetch);
 await expect(addActivity({subject:'Task',userId:7,strictAssignee:true})).rejects.toThrow('429');
 expect(fetch).toHaveBeenCalledTimes(1);
});
