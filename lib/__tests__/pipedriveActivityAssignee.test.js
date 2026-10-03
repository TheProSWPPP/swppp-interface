import {afterEach,expect,it,vi} from 'vitest';
import {addActivity} from '../pipedriveClient.js';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('does not duplicate or reassign a strict reply task after an uncertain timeout',async()=>{
 vi.stubEnv('PIPEDRIVE_API_TOKEN','test-only');
 const fetch=vi.fn().mockRejectedValue(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}));
 vi.stubGlobal('fetch',fetch);
 await expect(addActivity({leadId:'lead',subject:'Reply task',userId:7,strictAssignee:true})).rejects.toThrow('timeout');
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(JSON.parse(fetch.mock.calls[0][1].body).user_id).toBe(7);
});
it('retains the confirmed assignee and actual provider receipt on success',async()=>{
 vi.stubEnv('PIPEDRIVE_API_TOKEN','test-only');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,text:async()=>JSON.stringify({success:true,data:{id:23,user_id:7}})}));
 expect(await addActivity({subject:'Reply task',userId:7,strictAssignee:true})).toMatchObject({id:23,user_id:7});
});
