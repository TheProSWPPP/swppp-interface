import {afterEach,expect,it,vi} from 'vitest';
import {listMailThreadMessages,getMailMessage,listActivitiesPage} from '../pipedriveClient.js';

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('reads individual Pipedrive messages with body only on explicit request',async()=>{
  vi.stubEnv('PIPEDRIVE_API_TOKEN','fixture-token');
  const urls=[];
  vi.stubGlobal('fetch',async url=>{urls.push(new URL(url));return {ok:true,text:async()=>JSON.stringify({success:true,data:[{id:9}]})};});
  expect((await listMailThreadMessages(123)).data).toEqual([{id:9}]);
  await getMailMessage(9,{includeBody:true});
  expect(urls.map(u=>u.pathname)).toEqual(['/v1/mailbox/mailThreads/123/mailMessages','/v1/mailbox/mailMessages/9']);
  expect(urls[0].searchParams.has('include_body')).toBe(false);
  expect(urls[1].searchParams.get('include_body')).toBe('1');
});
it('requests all-user activity scope with lead filter and preserves pagination',async()=>{
  vi.stubEnv('PIPEDRIVE_API_TOKEN','fixture-token');
  let url;
  vi.stubGlobal('fetch',async input=>{url=new URL(input);return {ok:true,text:async()=>JSON.stringify({success:true,data:[{id:1}],additional_data:{pagination:{more_items_in_collection:true,next_start:100}}})};});
  expect(await listActivitiesPage({leadId:'lead-1',start:0,limit:100})).toMatchObject({data:[{id:1}],pagination:{more_items_in_collection:true,next_start:100}});
  expect(url.searchParams.get('user_id')).toBe('0');
  expect(url.searchParams.get('lead_id')).toBe('lead-1');
});
