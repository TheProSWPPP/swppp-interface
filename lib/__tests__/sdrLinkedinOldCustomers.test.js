import {describe,it,expect} from 'vitest';
import {parseOldCustomerCsv,classifyOldCustomer,checkOldCustomers} from '../sdrLinkedinOldCustomers.js';
import {APIFY_ACTORS} from '../apifyClient.js';
import {companyKey} from '../permitMatch.js';

describe('old customer CSV',()=>{
 it('accepts the header variants Derek might send',()=>{
  for(const header of ['Name,Company,Email,LinkedIn','Full Name,Company Name,Primary Email,LinkedIn URL','contact name,customer,email,linkedin profile','Contact,Company,Email,Linkedin Profile']){
   const {rows,errors}=parseOldCustomerCsv(`${header}\nRandy Smith,Flintco,randy@flintco.com,linkedin.com/in/randysmith`);
   expect(errors,header).toEqual([]);expect(rows,header).toMatchObject([{fullName:'Randy Smith',firstName:'Randy',lastName:'Smith',company:'Flintco',email:'randy@flintco.com',linkedinUrl:'https://www.linkedin.com/in/randysmith/'}]);
  }
  expect(parseOldCustomerCsv('First Name,Last Name,Company\nSteve,Jones,Crossland').rows).toMatchObject([{fullName:'Steve Jones',company:'Crossland'}]);
 });
 it('rejects a row whose LinkedIn link is not a profile, and rows missing a name or company',()=>{
  const {rows,errors}=parseOldCustomerCsv('Name,Company,LinkedIn\nRandy Smith,Flintco,https://www.linkedin.com/company/flintco\n,Flintco,\nSteve Jones,,\nAmy Lee,Manhattan,');
  expect(rows.map(r=>r.fullName)).toEqual(['Amy Lee']);
  expect(errors).toEqual([{row:2,reason:'linkedin_url_not_profile'},{row:3,reason:'name_and_company_required'},{row:4,reason:'name_and_company_required'}]);
  expect(parseOldCustomerCsv('Email,Phone\na@b.c,1').errors).toEqual([{row:1,reason:'headers_unrecognized'}]);
 });
 it('collapses duplicates on name plus company',()=>{
  expect(parseOldCustomerCsv('Name,Company,Email\nRandy Smith,Flintco,a@x.com\nrandy smith,Flintco Inc,b@x.com\nRandy Smith,Crossland,c@x.com').rows).toHaveLength(2);
 });
 it('classifies moved, same company, not found and ambiguous',()=>{
  const row={company:'Flintco',company_key:companyKey('Flintco')};
  const found=(company,pastCompanies=['Flintco Inc'])=>({status:'found',person:{company,pastCompanies}});
  expect(classifyOldCustomer(row,found('Crossland Construction')).status).toBe('moved');
  // A same-name person at another company is not 'moved' unless Flintco is a finished job on their profile.
  expect(classifyOldCustomer(row,found('Crossland Construction',[]))).toMatchObject({status:'ambiguous',reason:'old_company_not_in_experience'});
  expect(classifyOldCustomer(row,found('Crossland Construction',['Flintco Construction'])).status).toBe('ambiguous');
  expect(classifyOldCustomer(row,found('Flintco, LLC')).status).toBe('same_company');
  expect(classifyOldCustomer(row,found('Flintco Construction')).status).toBe('ambiguous');
  expect(classifyOldCustomer(row,{status:'not_found'}).status).toBe('not_found');
  expect(classifyOldCustomer(row,{status:'ambiguous'}).status).toBe('ambiguous');
 });
 it('stages only a single confident match that moved; an ambiguous name is never staged',async()=>{
  const rows=[{id:'1',full_name:'Randy Smith',first_name:'Randy',last_name:'Smith',company:'Flintco',company_key:companyKey('Flintco'),linkedin_url:null},{id:'2',full_name:'John Lee',first_name:'John',last_name:'Lee',company:'Flintco',company_key:companyKey('Flintco'),linkedin_url:null},{id:'3',full_name:'Amy Park',first_name:'Amy',last_name:'Park',company:'Manhattan',company_key:companyKey('Manhattan'),linkedin_url:'https://www.linkedin.com/in/amypark/'}];
  const updates=[];const pool={query:async(sql,params)=>{if(/^SELECT \* FROM sdr_linkedin_old_customers/.test(sql))return {rows};updates.push({id:params[0],status:params[1]});return {rows:[]}}};
  const person=(id,company)=>({publicIdentifier:id,linkedinUrl:`https://www.linkedin.com/in/${id}/`,firstName:'X',lastName:id,currentPosition:[{position:'Senior Project Manager',companyName:company}],experience:[{position:'Senior Project Manager',companyName:company,endDate:{text:'Present'}},{position:'Project Manager',companyName:'Flintco',endDate:{text:'Mar 2026'}}]});
  const apify={configured:true,runActor:async({actor,input})=>{
   if(actor===APIFY_ACTORS.profileScraper)return [person('amypark','Manhattan')];
   if(input.lastNames[0]==='Smith')return [person('randysmith','Crossland Construction')];
   return [person('johnlee1','Big GC'),person('johnlee2','Other GC')];
  }};
  const moved=[],replacements=[];
  const result=await checkOldCustomers(pool,{companyId:'13105180',limit:10,apify,actor:'admin',stageMoved:async({row})=>{moved.push(row.full_name);return {staged:{name:row.full_name}}},stageReplacement:async({company})=>{replacements.push(company);return {staged:[]}}});
  expect(Object.fromEntries(updates.map(u=>[u.id,u.status]))).toEqual({'1':'moved','2':'ambiguous','3':'same_company'});
  expect(moved).toEqual(['Randy Smith']);expect(result.counts).toMatchObject({checked:3,moved:1,ambiguous:1,same_company:1,stagedB:1});
  // Only a contact who left triggers the lane C search for their replacement; Amy is still at Manhattan.
  expect(replacements).toEqual(['Flintco']);
 });
 it('records moved only once staging decided, and stops and restricts the account on a 401',async()=>{
  const mk=(id,name)=>({id,full_name:name,first_name:name.split(' ')[0],last_name:name.split(' ')[1],company:'Flintco',company_key:companyKey('Flintco'),linkedin_url:null});
  const rows=[mk('1','Randy Smith'),mk('2','Steve Jones'),mk('3','Amy Park'),mk('4','Bo Diaz')];
  const updates=[],restricted=[];const pool={query:async(sql,params)=>{if(/^SELECT \* FROM sdr_linkedin_old_customers/.test(sql))return {rows};if(/status='restricted'/.test(sql)){restricted.push(params[1]);return {rows:[]}}updates.push({id:params[0],status:params[1],evidence:JSON.parse(params[7])});return {rows:[]}}};
  const apify={configured:true,runActor:async({input})=>[{publicIdentifier:input.lastNames[0].toLowerCase(),linkedinUrl:`https://www.linkedin.com/in/${input.lastNames[0].toLowerCase()}/`,firstName:'X',lastName:input.lastNames[0],currentPosition:[{position:'Chief Estimator',companyName:'Crossland Construction'}],experience:[{companyName:'Flintco',endDate:{text:'2025'}}]}]};
  const calls=[];
  const stageMoved=async({row})=>{calls.push(row.full_name);if(row.id==='1')return {skipped:'pipedrive_active_sequence'};if(row.id==='2')throw Object.assign(new Error('x'),{code:'stage_unavailable'});throw Object.assign(new Error('authentication'),{code:'authentication',status:401})};
  const replacements=[];
  const result=await checkOldCustomers(pool,{companyId:'13105180',accountId:'derek',limit:10,apify,actor:'admin',stageMoved,stageReplacement:async({company})=>{replacements.push(company);return {staged:[]}}});
  expect(updates.map(u=>[u.id,u.status])).toEqual([['1','moved'],['2','error'],['3','error']]);
  expect(updates[0].evidence.stageSkipped).toBe('pipedrive_active_sequence');expect(updates[2].evidence.error).toBe('authentication');
  expect(calls).toEqual(['Randy Smith','Steve Jones','Amy Park']);
  expect(restricted).toEqual(['derek']);expect(result.stopped).toBe('authentication');
  expect(replacements).toEqual([]);
 });
 it('records a permanent staging refusal as final instead of retrying it forever (QA N6)',async()=>{
  const mk=(id,name)=>({id,full_name:name,first_name:name.split(' ')[0],last_name:name.split(' ')[1],company:'Flintco',company_key:companyKey('Flintco'),linkedin_url:null});
  const rows=[mk('1','Randy Smith'),mk('2','Steve Jones'),mk('3','Amy Park'),mk('4','Bo Diaz')];
  const updates=[];const pool={query:async(sql,params)=>{if(/^SELECT \* FROM sdr_linkedin_old_customers/.test(sql))return {rows};updates.push({id:params[0],status:params[1],evidence:JSON.parse(params[7])});return {rows:[]}}};
  const apify={configured:true,runActor:async({input})=>[{publicIdentifier:input.lastNames[0].toLowerCase(),linkedinUrl:`https://www.linkedin.com/in/${input.lastNames[0].toLowerCase()}/`,firstName:'X',lastName:input.lastNames[0],currentPosition:[{position:'Chief Estimator',companyName:'Crossland Construction'}],experience:[{companyName:'Flintco',endDate:{text:'2025'}}]}]};
  // provider_rejected is final for a 4xx only; the client raises the same code for a 5xx read.
  const codes={'1':['already_candidate'],'2':['provider_rejected',404],'3':['read_unavailable'],'4':['provider_rejected',503]};
  const result=await checkOldCustomers(pool,{companyId:'13105180',accountId:'derek',limit:10,apify,actor:'admin',stageMoved:async({row})=>{const [code,status]=codes[row.id];throw Object.assign(new Error(code),{code,status})}});
  expect(updates.map(u=>[u.id,u.status,u.evidence.stageRefused||u.evidence.error])).toEqual([['1','moved','already_candidate'],['2','moved','provider_rejected'],['3','error','read_unavailable'],['4','error','provider_rejected']]);
  expect(result.counts).toMatchObject({moved:2,error:2,stageRefused:2});
 });
});
