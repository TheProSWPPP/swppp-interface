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
  const found=company=>({status:'found',person:{company}});
  expect(classifyOldCustomer(row,found('Crossland Construction')).status).toBe('moved');
  expect(classifyOldCustomer(row,found('Flintco, LLC')).status).toBe('same_company');
  expect(classifyOldCustomer(row,found('Flintco Construction')).status).toBe('ambiguous');
  expect(classifyOldCustomer(row,{status:'not_found'}).status).toBe('not_found');
  expect(classifyOldCustomer(row,{status:'ambiguous'}).status).toBe('ambiguous');
 });
 it('stages only a single confident match that moved; an ambiguous name is never staged',async()=>{
  const rows=[{id:'1',full_name:'Randy Smith',first_name:'Randy',last_name:'Smith',company:'Flintco',company_key:companyKey('Flintco'),linkedin_url:null},{id:'2',full_name:'John Lee',first_name:'John',last_name:'Lee',company:'Flintco',company_key:companyKey('Flintco'),linkedin_url:null},{id:'3',full_name:'Amy Park',first_name:'Amy',last_name:'Park',company:'Manhattan',company_key:companyKey('Manhattan'),linkedin_url:'https://www.linkedin.com/in/amypark/'}];
  const updates=[];const pool={query:async(sql,params)=>{if(/^SELECT \* FROM sdr_linkedin_old_customers/.test(sql))return {rows};updates.push({id:params[0],status:params[1]});return {rows:[]}}};
  const person=(id,company)=>({publicIdentifier:id,linkedinUrl:`https://www.linkedin.com/in/${id}/`,firstName:'X',lastName:id,currentPosition:[{position:'Senior Project Manager',companyName:company}]});
  const apify={configured:true,runActor:async({actor,input})=>{
   if(actor===APIFY_ACTORS.profileScraper)return [person('amypark','Manhattan')];
   if(input.lastNames[0]==='Smith')return [person('randysmith','Crossland Construction')];
   return [person('johnlee1','Big GC'),person('johnlee2','Other GC')];
  }};
  const moved=[],replacements=[];
  const result=await checkOldCustomers(pool,{companyId:'13105180',limit:10,apify,actor:'admin',stageMoved:async({row})=>{moved.push(row.full_name);return {staged:{name:row.full_name}}},stageReplacement:async({company})=>{replacements.push(company);return {staged:[]}}});
  expect(Object.fromEntries(updates.map(u=>[u.id,u.status]))).toEqual({'1':'moved','2':'ambiguous','3':'same_company'});
  expect(moved).toEqual(['Randy Smith']);expect(result.counts).toMatchObject({checked:3,moved:1,ambiguous:1,same_company:1,stagedB:1});
  expect(replacements.sort()).toEqual(['Flintco','Manhattan']);
 });
});
