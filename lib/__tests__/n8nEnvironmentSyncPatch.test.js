import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { patchDocumentStatusWorkflow } from '../n8nDocumentStatusPatch.js';
import { patchJobOrderEnvironmentOutput, patchRouterEnvironmentSync } from '../n8nEnvironmentSyncPatch.js';
import { mergeProjectPatch } from '../projectGenerationResults.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/document-status-router.json', import.meta.url)));
const receipt = {documentKey:'job-order',validatedPdf:true,id:'id:fixture',path:'/Fixture/Job order.pdf',size:123,contentHash:'a'.repeat(64)};
const environment = {soilData:'',waterway:'Verified Creek',endangeredSpecies:'Whooping crane',ms4Operator:'County MS4',county:'Fixture County'};
const project = {id:'fixture',status:'Approved for Generation',soilData:'',waterway:'',endangeredSpecies:'',ms4Operator:'',county:'Fixture County',environmentLookupStatus:{soil:'failed',ms4:'review-required'},generationNote:null};
function run(name, row, base = project, otherRows = []) {
  const workflow = patchRouterEnvironmentSync(patchDocumentStatusWorkflow(fixture));
  const values = {
    'Normalize & Route Data':[{json:{id:base.id,stateTemplate:'Oklahoma',callbackBase:base,requiredDocuments:[]}}],
    'Call Trello Card ':[{json:{idCard:'fixture'}}],
    'JO-ONLY - JOB-ORDER':[{json:row},...otherRows.map(json=>({json}))],
  };
  const $ = key => ({isExecuted:key in values,all:()=>values[key]||[],first:()=>values[key]?.[0]});
  return new Function('$',workflow.nodes.find(node=>node.name===name).parameters.jsCode)($)[0].json;
}

describe('verified job-order environment synchronization',()=>{
  it.each(['Prepare Status Update','Prepare Status Update JO-ONLY'])('copies available printed values with CAS and keeps failure/review flags in %s',name=>{
    const output=run(name,{documentOutput:receipt,environmentData:environment,environmentLookupStatus:project.environmentLookupStatus});
    expect(output).toMatchObject({status:'Generated',waterway:'Verified Creek',endangeredSpecies:'Whooping crane',ms4Operator:'County MS4',environmentLookupStatus:{soil:'failed',ms4:'review-required'}});
    expect(output).not.toHaveProperty('soilData');
    expect(output.__expectedValues).toMatchObject({waterway:'',endangeredSpecies:'',ms4Operator:''});
    const {projectId,__expectedValues,...patch}=output;
    expect(projectId).toBe(project.id);
    expect(mergeProjectPatch(project,patch,__expectedValues).waterway).toBe('Verified Creek');
    expect(()=>mergeProjectPatch({...project,waterway:'Staff edit'},patch,__expectedValues)).toThrow('These fields changed');
  });
  it('never replaces nonempty staff input with another lookup value',()=>{
    const output=run('Prepare Status Update',{documentOutput:receipt,environmentData:environment},{...project,waterway:'Staff river'});
    expect(output).not.toHaveProperty('waterway');
  });
  it.each([undefined,{...receipt,validatedPdf:false},{...receipt,contentHash:'bad'}])('does not copy environment values without a valid linked receipt %j',documentOutput=>{
    const output=run('Prepare Status Update',{documentOutput,environmentData:environment});
    expect(output).not.toHaveProperty('waterway');expect(output).not.toHaveProperty('ms4Operator');
  });
  it('does not borrow environment data from another unverified output row',()=>{
    expect(run('Prepare Status Update',{documentOutput:receipt},project,[{environmentData:environment}])).not.toHaveProperty('waterway');
  });
  it('ignores malformed values and unknown fields',()=>{
    const output=run('Prepare Status Update',{documentOutput:receipt,environmentData:{soilData:null,waterway:[],ms4Operator:'x'.repeat(501),email:'untrusted'}});
    expect(output).not.toHaveProperty('soilData');expect(output).not.toHaveProperty('waterway');expect(output).not.toHaveProperty('ms4Operator');expect(output).not.toHaveProperty('email');
  });
  it('only adds an object assignment from the actual PDF formatter to the child return',()=>{
    const before={nodes:[{name:'Edit Fields',parameters:{assignments:{assignments:[{name:'documentOutput',value:'unchanged'}]}}}],connections:{preserved:{main:[]}}};
    const after=patchJobOrderEnvironmentOutput(before);
    expect(after.nodes[0].parameters.assignments.assignments[0]).toEqual(before.nodes[0].parameters.assignments.assignments[0]);
    const added=after.nodes[0].parameters.assignments.assignments[1];
    const value=new Function('$','return '+added.value.slice(3,-2))(()=>({first:()=>({json:environment})}));
    expect(value).toEqual(environment);expect(after.connections).toEqual(before.connections);expect(before.nodes[0].parameters.assignments.assignments).toHaveLength(1);
  });
});
