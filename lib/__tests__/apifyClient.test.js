import {describe,it,expect} from 'vitest';
import {createApifyClient,APIFY_ACTORS} from '../apifyClient.js';

const respond=(status,body)=>async()=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
describe('Apify client',()=>{
 it('treats an empty dataset as an error, never as zero found',async()=>{
  const apify=createApifyClient({token:'secret-token-123',transport:respond(200,[])});
  await expect(apify.runActor({actor:APIFY_ACTORS.profileSearch,input:{}})).rejects.toMatchObject({code:'apify_empty_result'});
 });
 it('returns an empty list only when the caller allows it',async()=>{
  const apify=createApifyClient({token:'secret-token-123',transport:respond(200,[])});
  expect(await apify.runActor({actor:APIFY_ACTORS.postSearch,input:{},allowEmpty:true})).toEqual([]);
 });
 it('never puts the token in a thrown message',async()=>{
  for(const transport of [respond(401,{error:'bad'}),respond(500,{}),async()=>{throw new Error('fetch failed https://api.apify.com/v2/acts?token=secret-token-123')},async()=>new Response('not json',{status:200})]){
   const apify=createApifyClient({token:'secret-token-123',transport});
   const error=await apify.runActor({actor:APIFY_ACTORS.profileSearch,input:{}}).catch(e=>e);
   expect(error).toBeInstanceOf(Error);expect(`${error.message} ${error.code} ${error.stack}`).not.toContain('secret-token-123');
  }
 });
 it('posts to the pinned actor run-sync endpoint and refuses unpinned actors',async()=>{
  const seen=[];const apify=createApifyClient({token:'t',transport:async(url,options)=>{seen.push({url:String(url),body:options.body});return new Response('[{"id":1}]',{status:200})}});
  expect(await apify.runActor({actor:APIFY_ACTORS.profileScraper,input:{urls:['x']},timeoutSecs:60})).toEqual([{id:1}]);
  expect(seen[0].url).toBe('https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items?token=t&timeout=60');
  await expect(apify.runActor({actor:'someone~else',input:{}})).rejects.toMatchObject({code:'apify_actor_unpinned'});
  await expect(createApifyClient({token:''}).runActor({actor:APIFY_ACTORS.profileSearch})).rejects.toMatchObject({code:'apify_unconfigured'});
 });
});
