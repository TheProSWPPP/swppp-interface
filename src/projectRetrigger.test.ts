import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {changedProjectFields,reconcileProjectSave,requestProjectSave} from './projectPersistence';
import {prepareRetriggerSave,readRetriggerResult,requestProjectRetrigger,validateLookupMetadata} from './projectRetrigger';
// @ts-expect-error The server merge is JavaScript; exercise it at the real client transport boundary.
import {mergeProjectPatch} from '../lib/projectGenerationResults.js';
import type {Project} from './data';

const base={id:'fixture',status:'Pending Review',projectAddress:'Fixture address',projectName:'Fixture',soilData:'Staff soil',waterway:'Staff river',latitude:'30',longitude:'-97',phone:'old',environmentLookupStatus:{soil:'complete',species:'no-qualifying-results'},environmentLookupNotes:{species:'Earlier selected county scope.'}} as unknown as Project;
const success={soilData:'New soil',waterway:'New river',latitude:'30.25',longitude:'-97.5',landDisturbanceArea:'2',environmentLookupStatus:{soil:'complete',waterway:'complete',coordinates:'complete'},environmentLookupNotes:{}};

describe('explicit project retrigger persistence',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it('failure keeps staff information and earlier scope history while making failure durable through the actual App PUT helper',async()=>{
  const result=readRetriggerResult({environmentLookupStatus:{overall:'failed',waterway:'failed'},environmentLookupNotes:{overall:'Provider unavailable; review needed.'}});
  const prepared=prepareRetriggerSave(base,base,base,result);const request=changedProjectFields(base,prepared.submitted,prepared.provenance);
  vi.stubGlobal('window',{fetch:async(url:string,init:RequestInit)=>{
   expect(url).toBe('/api/projects/fixture');expect(init.method).toBe('PUT');expect(init.credentials).toBe('include');
   const body=JSON.parse(String(init.body));expect(body.__expectedValues).toEqual({environmentLookupStatus:{soil:'complete',species:'no-qualifying-results'},environmentLookupNotes:{species:'Earlier selected county scope.'}});
   return Response.json(mergeProjectPatch(base,body,body.__expectedValues));
  }});
  const saved=await requestProjectSave(request.patch,request.expected);
  expect(saved).toMatchObject({status:'Pending Review',soilData:'Staff soil',waterway:'Staff river',environmentLookupStatus:{soil:'complete',species:'no-qualifying-results',waterway:'failed',overall:'failed'},environmentLookupNotes:{species:'Earlier selected county scope.',overall:'Provider unavailable; review needed.'}});
  expect(Object.keys(request.patch).sort()).toEqual(['environmentLookupNotes','environmentLookupStatus','id']);
  expect(result.failed).toBe(true);
 });
 it('successful retrigger saves typed field changes and provenance with complete CAS expectations',async()=>{
  const prepared=prepareRetriggerSave(base,base,base,readRetriggerResult(success));const {patch,expected}=changedProjectFields(base,prepared.submitted,prepared.provenance);
  expect(expected).toMatchObject({soilData:'Staff soil',waterway:'Staff river',latitude:'30',longitude:'-97',landDisturbanceArea:null,environmentLookupStatus:base.environmentLookupStatus,environmentLookupNotes:base.environmentLookupNotes});
  vi.stubGlobal('window',{fetch:async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));return Response.json(mergeProjectPatch(base,body,body.__expectedValues));}});
  expect(await requestProjectSave(patch,expected)).toMatchObject({soilData:'New soil',waterway:'New river',landDisturbanceArea:2,environmentLookupStatus:{overall:'complete'}});
 });
 it('concurrent producer history causes a CAS conflict instead of overwriting newer history',async()=>{
  const prepared=prepareRetriggerSave(base,base,base,readRetriggerResult({}));const {patch,expected}=changedProjectFields(base,prepared.submitted,prepared.provenance);
  const server={...base,environmentLookupStatus:{overall:'review-required'},environmentLookupNotes:{overall:'Newer history'}};
  vi.stubGlobal('window',{fetch:async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));try{return Response.json(mergeProjectPatch(server,body,body.__expectedValues));}catch(error){const e=error as Error & {status:number;conflicts:string[];project:Project};return Response.json({error:e.message,conflicts:e.conflicts,project:e.project},{status:e.status});}}});
  await expect(requestProjectSave(patch,expected)).rejects.toMatchObject({conflicts:['environmentLookupStatus','environmentLookupNotes'],project:{environmentLookupNotes:{overall:'Newer history'}}});
 });
 it('preserves staff text and coordinate pairs edited during lookup and keeps new typing after the save',()=>{
  const current={...base,soilData:'Typed soil',latitude:'31',phone:'Typed phone'};const prepared=prepareRetriggerSave(base,base,current,readRetriggerResult(success));
  expect(prepared.submitted).toMatchObject({soilData:'Typed soil',latitude:'31',longitude:'-97',waterway:'New river',phone:'Typed phone'});
  const {expected}=changedProjectFields(base,prepared.submitted,prepared.provenance);expect(expected.phone).toBe('old');
  const latestTyping={...current,phone:'Still typing'};const server={...prepared.submitted,...prepared.provenance.metadata};
  expect(reconcileProjectSave(latestTyping,prepared.submitted,server,current)).toMatchObject({phone:'Still typing',environmentLookupStatus:{overall:'complete'}});
 });
 it('omits stale lookup business changes when lookup inputs changed during the request',()=>{
  const current={...base,projectAddress:'New address'};const prepared=prepareRetriggerSave(base,base,current,readRetriggerResult(success));
  expect(prepared.submitted).toMatchObject({projectAddress:'New address',soilData:'Staff soil',waterway:'Staff river'});expect(prepared.provenance.metadata.environmentLookupStatus.overall).toBe('review-required');expect(prepared.needsReview).toBe(true);
 });
 it('does not replace business data or status approved by staff while the lookup was pending',()=>{
  const current={...base,status:'Approved for Generation' as const};const prepared=prepareRetriggerSave(base,base,current,readRetriggerResult(success));
  expect(prepared.submitted).toMatchObject({status:'Approved for Generation',soilData:'Staff soil',waterway:'Staff river'});expect(prepared.needsReview).toBe(true);
 });
 it('ordinary manual saves continue excluding lookup history',()=>{
  expect(changedProjectFields(base,{...base,soilData:'Manual',environmentLookupStatus:{overall:'failed'}})).toEqual({patch:{id:'fixture',soilData:'Manual'},expected:{soilData:'Staff soil'}});
 });
 it.each([{},null,[],{...success,id:'other-project'},{...success,soilData:42},{...success,environmentLookupStatus:'complete'},{...success,environmentLookupStatus:{overall:'success'}},{...success,environmentLookupStatus:{arbitrary:'complete'}},{...success,environmentLookupNotes:{overall:'x'.repeat(301)}},{...success,environmentLookupNotes:{overall:'Bad\u0000note'}},{...success,environmentLookupNotes:{arbitrary:'Raw private body'}},{...success,environmentLookupNotes:[]}])('rejects malformed or empty responses without adopting their business fields: %j',value=>{
  const result=readRetriggerResult(value);expect(result.failed).toBe(true);expect(result.updates).toEqual({});expect(result.metadata.environmentLookupStatus.overall).toBe('failed');expect(result.metadata.environmentLookupNotes.overall!.length).toBeLessThanOrEqual(300);
  const prepared=prepareRetriggerSave(base,base,base,result);expect(prepared.submitted.soilData).toBe('Staff soil');
 });
 it('failed field cannot replace staff information even when response carries plausible text',()=>{
  const result=readRetriggerResult({soilData:'Unverified provider soil',environmentLookupStatus:{soil:'failed',overall:'failed'},environmentLookupNotes:{overall:'Soil failed'}});
  expect(result.updates).not.toHaveProperty('soilData');expect(prepareRetriggerSave(base,base,base,result).submitted.soilData).toBe('Staff soil');
 });
 it('metadata-only complete response is an empty result rather than a successful lookup',()=>{
  expect(readRetriggerResult({environmentLookupStatus:{overall:'complete'},environmentLookupNotes:{}}).failed).toBe(true);
 });
 it('partial successful results retain unreturned failure and scope history for review',()=>{
  const prior={...base,environmentLookupStatus:{soil:'failed',waterway:'failed',species:'no-qualifying-results'},environmentLookupNotes:{species:'Earlier selected county scope.',overall:'Earlier lookup failure'}} as unknown as Project;
  const result=readRetriggerResult({soilData:'Verified soil',environmentLookupStatus:{soil:'complete'},environmentLookupNotes:{}});
  const prepared=prepareRetriggerSave(prior,prior,prior,result);
  expect(prepared.provenance.metadata).toMatchObject({environmentLookupStatus:{soil:'complete',waterway:'failed',species:'no-qualifying-results'},environmentLookupNotes:{species:'Earlier selected county scope.'}});
  expect(prepared.provenance.metadata.environmentLookupNotes).not.toHaveProperty('overall');expect(prepared.needsReview).toBe(true);
 });
 it('explicit provenance rejects malformed metadata and missing expected values before sending',()=>{
  expect(()=>validateLookupMetadata({environmentLookupStatus:{overall:'done'},environmentLookupNotes:{}})).toThrow('Invalid lookup result');
  expect(()=>changedProjectFields(base,base,{metadata:{environmentLookupStatus:{overall:'failed'},environmentLookupNotes:{}},expected:{} } as never)).toThrow('Missing expected lookup history');
 });
});

describe('fixed retrigger request endpoint',()=>{
 beforeEach(()=>vi.unstubAllGlobals());afterEach(()=>vi.unstubAllGlobals());
 it.each(['http','network','json'])('reports %s provider failure with safe durable history',async(kind)=>{
  vi.stubGlobal('window',{fetch:async()=>{if(kind==='network')throw new Error('PRIVATE exception');if(kind==='http')return new Response('PRIVATE body',{status:503});return new Response('PRIVATE invalid JSON',{status:200});}});
  const result=await requestProjectRetrigger({projectName:'Fixture'});expect(result.failed).toBe(true);expect(result.updates).toEqual({});expect(result.metadata.environmentLookupStatus.overall).toBe('failed');expect(JSON.stringify(result)).not.toContain('PRIVATE');
 });
 it('returns validated lookup results from the existing controlled endpoint',async()=>{
  vi.stubGlobal('window',{fetch:async(url:string,init:RequestInit)=>{expect(url).toBe('https://proswppp.app.n8n.cloud/webhook/re-trigger');expect(JSON.parse(String(init.body))).toEqual({projectName:'Fixture'});return Response.json(success);}});
  expect(await requestProjectRetrigger({projectName:'Fixture'})).toMatchObject({failed:false,updates:{soilData:'New soil'}});
 });
});
