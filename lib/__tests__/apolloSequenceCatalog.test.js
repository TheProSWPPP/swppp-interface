import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthHealth, listSequenceCatalog } from '../apolloClient.js';
const item=(id)=>({id,name:id,active:true,num_steps:1});
const detail=(id)=>({emailer_steps:[{id:`${id}-s`,position:1,type:'auto_email'}],emailer_touches:[{emailer_step_id:`${id}-s`,emailer_template_id:`${id}-t`}],emailer_templates:[{id:`${id}-t`,subject:'Hello',body_html:'<p>Message</p>'}]});
describe('Apollo sequence catalog correctness',()=>{
 it('exhausts provider pages and deduplicates sequences before details',async()=>{
  const search=vi.fn().mockResolvedValueOnce({emailer_campaigns:[item('a'),item('b')],pagination:{total_pages:2}}).mockResolvedValueOnce({emailer_campaigns:[item('b'),item('c')],pagination:{total_pages:2}});
  const read=vi.fn(async(id)=>detail(id));
  const result=await listSequenceCatalog({search,detail:read,perPage:2});
  expect(result.coverage).toBe('complete');expect(result.sequences.map(s=>s.id)).toEqual(['a','b','c']);expect(read).toHaveBeenCalledTimes(3);expect(search.mock.calls[1][0].page).toBe(2);
 });
 it('keeps healthy sequences and marks a failed detail partial',async()=>{
  const result=await listSequenceCatalog({search:async()=>({emailer_campaigns:[item('a'),item('b')]}),detail:async(id)=>{if(id==='b')throw Object.assign(new Error('private key/body'),{status:429});return detail(id);}});
  expect(result.coverage).toBe('partial');expect(result.sequences[0].steps).toHaveLength(1);expect(result.sequences[1]).toMatchObject({id:'b',steps:[],coverage:'partial',errorCategory:'apollo_429'});expect(JSON.stringify(result)).not.toContain('private');
 });
 it('marks malformed catalog responses partial instead of successful empty data',async()=>{
  expect(await listSequenceCatalog({search:async()=>({}),detail:async()=>({})})).toMatchObject({coverage:'partial',errorCategory:'invalid_catalog',sequences:[]});
 });
 it('does not treat a capped catalog as complete',async()=>{
  const result=await listSequenceCatalog({search:async()=>({emailer_campaigns:[item('a')]}),detail:async(id)=>detail(id),perPage:1,maxPages:1});
  expect(result).toMatchObject({coverage:'partial',errorCategory:'catalog_page_limit'});
 });
 it('retains non-email steps and distinguishes missing template links',async()=>{
  const d=detail('a');d.emailer_steps.push({id:'call',position:2,type:'call'},{id:'broken',position:3,type:'auto_email'});
  d.emailer_touches.push({emailer_step_id:'broken',emailer_template_id:'missing'});
  const result=await listSequenceCatalog({search:async()=>({emailer_campaigns:[item('a')]}),detail:async()=>d});
  expect(result.sequences[0]).toMatchObject({num_steps:3,coverage:'partial',errorCategory:'template_links_incomplete',omitted_steps:[{position:2,step_type:'call',reason:'non_email'},{position:3,step_type:'auto_email',reason:'missing_template'}]});expect(result.sequences[0].steps).toHaveLength(1);
 });
 it('a normal non-email touch without a template remains complete',async()=>{
  const d=detail('a');d.emailer_steps.push({id:'call',position:2,type:'call'});d.emailer_touches.push({emailer_step_id:'call',emailer_template_id:null});
  const result=await listSequenceCatalog({search:async()=>({emailer_campaigns:[item('a')]}),detail:async()=>d});
  expect(result).toMatchObject({coverage:'complete',errorCategory:null});expect(result.sequences[0]).toMatchObject({coverage:'complete',num_steps:2,omitted_steps:[{position:2,step_type:'call',reason:'non_email'}]});
 });
 it('a non-email touch with a non-null unresolved template is partial',async()=>{
  const d=detail('a');d.emailer_steps.push({id:'task',position:2,type:'task'});d.emailer_touches.push({emailer_step_id:'task',emailer_template_id:'missing'});
  expect(await listSequenceCatalog({search:async()=>({emailer_campaigns:[item('a')]}),detail:async()=>d})).toMatchObject({coverage:'partial',errorCategory:'template_links_incomplete'});
 });
 it('does not hang the whole catalog when one provider detail stalls',async()=>{
  const result=await listSequenceCatalog({search:async()=>({emailer_campaigns:[item('a')]}),detail:()=>new Promise(()=>{}),timeoutMs:10});
  expect(result).toMatchObject({coverage:'partial',errorCategory:'time_budget'});expect(result.sequences[0].errorCategory).toBe('time_budget');
 });
});

describe('Apollo quota headers',()=>{
 afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
 it('missing quota headers stay unknown while an explicit zero stays zero',async()=>{
  vi.stubEnv('APOLLO_API_KEY','test-only');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:429,headers:new Headers({'x-hourly-requests-left':'0'}),text:async()=>'{"error":"rate_limited"}'}));
  await expect(getAuthHealth()).rejects.toMatchObject({rateLimit:{dayLeft:null,hourLeft:0,minuteLeft:null}});
 });
});
