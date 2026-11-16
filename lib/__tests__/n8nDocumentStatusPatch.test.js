import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import {patchDocumentStatusWorkflow} from '../n8nDocumentStatusPatch.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/document-status-router.json',import.meta.url),'utf8'));
const receipt=(key,path=`/Fixture/${key}.pdf`)=>({documentKey:key,validatedPdf:true,id:'id:fixture',path,size:1234,contentHash:'a'.repeat(64)});
function run(name,rows,route={}) {
 const w=patchDocumentStatusWorkflow(fixture);
 const values={'Normalize & Route Data':[{json:{id:'fixture',stateTemplate:'Texas Small',requiredDocuments:['SWPPP','Job Cover Letter','Construction Site Notice'],callbackBase:{status:'Approved for Generation'},...route}}],'Call Trello Card ':[{json:{idCard:'fixturecard'}}],...Object.fromEntries(Object.entries(rows).map(([key,value])=>[key,[{json:value}]]))};
 const $=key=>({isExecuted:key in values,all:()=>values[key]||[],first:()=>values[key]?.[0]});
 return new Function('$',w.nodes.find(n=>n.name===name).parameters.jsCode)($)[0].json;
}
for(const name of ['Prepare Status Update','Prepare Status Update JO-ONLY'])describe(name,()=>{
 it('records Generated despite independent OPS/environmental review requirements',()=>{
  const out=run(name,{'TX-SM - JOB-ORDER':{documentOutput:receipt('job-order'),environmentLookupStatus:{soil:'failed'}},'TX-SM - CSN':{documentOutput:receipt('site-notice')},'TX-SM - CL':{documentOutput:receipt('cover-letter')}});
  expect(out.status).toBe('Generated');expect(out.generationNote).toContain('SWPPP');expect(out.generationNote).toContain('Environmental');expect(out.environmentLookupStatus).toEqual({soil:'failed'});expect(out.__expectedValues.status).toBe('Approved for Generation');
 });
 it('keeps a verified job-order-only run scoped while retaining remaining package work',()=>{
  const out=run(name,{'JO-ONLY - JOB-ORDER':{documentOutput:receipt('job-order')}},{stateTemplate:'Unknown',requiredDocuments:['SWPPP']});expect(out.status).toBe('Generated');expect(out.generationNote).toContain('SWPPP');
 });
 it('classifies failed attempted output as incomplete when another PDF exists',()=>{
  expect(run(name,{'TX-SM - JOB-ORDER':{documentOutput:receipt('job-order')},'TX-SM - CSN':{error:'failed'},'TX-SM - CL':{documentOutput:receipt('cover-letter')}}).status).toBe('Generation Incomplete');
 });
 it('does not call an interrupted branch generated when expected CSN/CL never ran',()=>{
  const out=run(name,{'TX-SM - JOB-ORDER':{documentOutput:receipt('job-order')}});expect(out.status).toBe('Generation Incomplete');expect(out.generationNote).toContain('Site notice');
 });
 it('requires a verified job order even when ancillary files exist',()=>{
  expect(run(name,{'TX-SM - JOB-ORDER':{error:'failed'},'TX-SM - CSN':{documentOutput:receipt('site-notice')},'TX-SM - CL':{documentOutput:receipt('cover-letter')}}).status).toBe('Generation Incomplete');
 });
 it('classifies zero or invalid current PDF receipts as failed',()=>{
  expect(run(name,{}).status).toBe('Generation Failed');expect(run(name,{'JO-ONLY - JOB-ORDER':{documentOutput:{...receipt('job-order'),contentHash:'bad'}}}).status).toBe('Generation Failed');
 });
 it('accepts only the existing explicit missing-cover-template skip contract',()=>{
  const out=run(name,{'OK - JOB-ORDER':{documentOutput:receipt('job-order')},'OK - CL':{documentSkipped:{documentKey:'cover-letter',state:'Oklahoma',reason:'template_not_configured'}}},{stateTemplate:'Oklahoma',requiredDocuments:['SWPPP','Job Cover Letter']});expect(out.status).toBe('Generated');expect(out.generationNote).toContain('Cover letter skipped');
 });
});
it('makes a held generation attempt explicit while retaining CAS and the review explanation',()=>{
 const w=patchDocumentStatusWorkflow(fixture);const node=w.nodes.find(n=>n.name==='Prepare Routing Review');const body={id:'fixture',status:'Approved for Generation',generationNote:null};const out=new Function('$',node.parameters.jsCode)(()=>({first:()=>({json:{body}})}))[0].json;expect(out.status).toBe('Generation Failed');expect(out.generationNote).toContain('generation held');expect(out.__expectedValues).toEqual({status:body.status,generationNote:null});
});
it('preserves every other node and all connections',()=>{
 const w=patchDocumentStatusWorkflow(fixture);expect(w.connections).toEqual(fixture.connections);for(const n of fixture.nodes)if(!['Prepare Status Update','Prepare Status Update JO-ONLY','Prepare Routing Review'].includes(n.name))expect(w.nodes.find(x=>x.name===n.name)).toEqual(n);
});
