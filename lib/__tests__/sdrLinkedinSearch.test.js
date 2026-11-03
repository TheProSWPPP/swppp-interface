import {describe,it,expect} from 'vitest';
import {searchLane,titleRank,verifyLaneDAuthor,createSalesNavSearch,stateFromLocation,configuredStates,SALESNAV_DAILY_SEARCH_CAP} from '../sdrLinkedinSearch.js';
import {APIFY_ACTORS} from '../apifyClient.js';

const NOW=new Date('2026-11-03T16:00:00Z');
const started=months=>{const d=new Date(NOW);d.setUTCMonth(d.getUTCMonth()-months);return {month:d.getUTCMonth()+1,year:d.getUTCFullYear()}};
const profile=(id,{months=4,title='Director of Preconstruction',company='Big GC',location='Dallas, Texas, United States',headcount}={})=>({publicIdentifier:id,linkedinUrl:`https://www.linkedin.com/in/${id}`,firstName:'Pat',lastName:id,location:{linkedinText:location},currentPosition:[{position:title,companyName:company,dateRange:{start:started(months)},...(headcount!==undefined?{companyHeadcount:headcount}:{})}]});
const fakeApify=byActor=>{const runs=[];return {runs,configured:true,runActor:async({actor,input,allowEmpty})=>{runs.push({actor,input});const items=byActor(actor,input)||[];if(!items.length&&!allowEmpty)throw Object.assign(new Error('apify_empty_result'),{code:'apify_empty_result'});return items}}};

describe('lane search',()=>{
 it('keeps lane A people who started 3 to 6 months ago and drops 2 and 7',async()=>{
  const apify=fakeApify((actor,input)=>input.recentlyPostedOnLinkedIn?[profile('active',{months:4})]:[profile('active',{months:4}),profile('two',{months:2}),profile('three',{months:3}),profile('six',{months:6}),profile('seven',{months:7})]);
  const result=await searchLane({lane:'A',apify,params:{states:['TX']},now:NOW});
  expect(result.kept.map(p=>p.publicIdentifier).sort()).toEqual(['active','six','three']);
  expect(result.people.find(p=>p.publicIdentifier==='active').active30d).toBe(true);
  expect(result.people.find(p=>p.publicIdentifier==='three').active30d).toBe(false);
  expect(apify.runs[0].input).toMatchObject({currentJobTitles:['Director of Preconstruction','VP Preconstruction','Preconstruction Director','Chief Estimator','Senior Project Manager'],companyHeadcount:['E','F','G','H','I'],locations:['Texas, United States'],yearsAtCurrentCompanyIds:['1'],recentlyPostedOnLinkedIn:true});
  expect(apify.runs[1].input.recentlyPostedOnLinkedIn).toBeUndefined();
 });
 it('ranks Directors of Preconstruction, then Chief Estimators, then Senior PMs; plain Estimator is off',()=>{
  expect(['Director of Preconstruction','VP Preconstruction','Vice President of Pre-Construction','Chief Estimator','Sr. Project Manager','Senior Project Manager','Estimator','Project Manager'].map(titleRank)).toEqual([1,1,1,2,3,3,9,9]);
 });
 it('drops a lane D SWPPP consultant and an author under 201 staff, and keeps a precon director',async()=>{
  const post=(id,headline)=>({postUrl:`https://www.linkedin.com/posts/${id}`,text:'New SWPPP rules this month',author:{name:`Pat ${id}`,headline,profileUrl:`https://www.linkedin.com/in/${id}/`}});
  const apify=fakeApify((actor,input)=>{if(actor!==APIFY_ACTORS.profileSearch)return [];const id=input.lastNames[0];if(id==='small')return [];return [profile(id,{title:id==='env'?'Director of Preconstruction':'Director of Preconstruction',company:id==='env'?'Acme Environmental Consulting':'Big GC'})]});
  expect(await verifyLaneDAuthor({post:post('consultant','SWPPP Consultant at Stormwater Pros'),apify,states:['TX'],now:NOW})).toEqual({ok:false,reason:'vendor_or_consultant'});
  expect(await verifyLaneDAuthor({post:post('small','Director of Preconstruction at Tiny GC'),apify,states:['TX'],now:NOW})).toEqual({ok:false,reason:'author_not_buyer'});
  expect(await verifyLaneDAuthor({post:post('env','Director of Preconstruction'),apify,states:['TX'],now:NOW})).toEqual({ok:false,reason:'vendor_or_consultant'});
  expect((await verifyLaneDAuthor({post:post('real','Director of Preconstruction at Big GC'),apify,states:['TX'],now:NOW})).ok).toBe(true);
  expect(apify.runs.at(-1).input).toMatchObject({companyHeadcount:['E','F','G','H','I'],firstNames:['Pat'],lastNames:['real']});
  const headcount=fakeApify(()=>[profile('known',{headcount:150})]);
  expect(await verifyLaneDAuthor({post:post('known','Director of Preconstruction'),apify:headcount,states:['TX'],now:NOW})).toEqual({ok:false,reason:'headcount_below_201'});
 });
 it('reads states from a location and the configured list',()=>{
  expect(stateFromLocation('Dallas, Texas, United States',['TX'])).toBe('TX');expect(stateFromLocation('Tulsa, OK',['TX'])).toBeNull();expect(stateFromLocation('Greater Houston',['TX'])).toBeNull();
  expect(configuredStates('tx, ok,ZZ')).toEqual(['TX','OK']);expect(configuredStates('')).toEqual([]);
 });
});

describe('Unipile Sales Navigator adapter',()=>{
 const fakePool=row=>{const state={...row};const query=async(sql,params)=>{if(/SELECT search_budget_day/.test(sql))return {rows:[{...state}]};if(/SET search_budget_day/.test(sql)){state.search_budget_day=params[2];state.search_used=params[3];return {rows:[]}}if(/coverage=coverage\|\|/.test(sql)){state.coverage={...state.coverage,...JSON.parse(params[2])};return {rows:[]}}if(/status='restricted'/.test(sql)){state.status='restricted';return {rows:[]}}return {rows:[]}};return {state,query,connect:async()=>({query,release(){}})}};
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(NOW);
 it('refuses the 11th search of the day',async()=>{
  const pool=fakePool({status:'healthy',coverage:{salesNavProbedAt:'2026-11-01T00:00:00Z'},search_budget_day:day,search_used:SALESNAV_DAILY_SEARCH_CAP-1});let calls=0;
  const search=createSalesNavSearch({pool,client:{searchSalesNav:async()=>{calls++;return {items:[{id:'x'}]}}},companyId:'c',accountId:'a',now:()=>NOW});
  expect(await search.search({lane:'A',params:{}})).toHaveLength(1);
  await expect(search.search({lane:'A',params:{}})).rejects.toMatchObject({code:'salesnav_search_cap'});expect(calls).toBe(1);
 });
 it('turns itself off when the first probe returns no items',async()=>{
  const pool=fakePool({status:'healthy',coverage:{},search_budget_day:null,search_used:0});let calls=0;
  const search=createSalesNavSearch({pool,client:{searchSalesNav:async({limit})=>{calls++;expect(limit).toBe(5);return {items:[]}}},companyId:'c',accountId:'a',now:()=>NOW});
  await expect(search.search({lane:'A',params:{}})).rejects.toMatchObject({code:'salesnav_probe_empty'});
  expect(pool.state.coverage.salesNavDisabled).toBe(true);
  await expect(search.search({lane:'A',params:{}})).rejects.toMatchObject({code:'salesnav_disabled'});expect(calls).toBe(1);
 });
 it('restricts the account on a 401 and stops',async()=>{
  const pool=fakePool({status:'healthy',coverage:{salesNavProbedAt:'x'},search_budget_day:null,search_used:0});
  const search=createSalesNavSearch({pool,client:{searchSalesNav:async()=>{throw Object.assign(new Error('authentication'),{code:'authentication',status:401})}},companyId:'c',accountId:'a',now:()=>NOW});
  await expect(search.search({lane:'A',params:{}})).rejects.toMatchObject({code:'authentication'});
  expect(pool.state.status).toBe('restricted');
  await expect(search.search({lane:'A',params:{}})).rejects.toMatchObject({code:'account_unhealthy'});
 });
});
