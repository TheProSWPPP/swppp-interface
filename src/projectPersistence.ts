import type {Project} from './data';
import {validateLookupMetadata,type LookupProvenance} from './projectRetrigger';
export type ProjectPatch = Partial<Project> & {id:string};
export type ProjectSaver = (patch:ProjectPatch,expected?:Record<string,unknown>) => Promise<Project | void> | Project | void;
const serverFields = new Set(['id','generation','generationState','generationRunId','generationContextDigest','runId','contextDigest','environmentLookupStatus','environmentLookupNotes','generationNote']);
const equal = (a:unknown,b:unknown) => JSON.stringify(a??null)===JSON.stringify(b??null);
export function changedProjectFields(base:Project,current:Project,provenance?:LookupProvenance){
 const patch:ProjectPatch={id:base.id},expected:Record<string,unknown>={};
 for(const key of Object.keys(current) as (keyof Project)[]){if(!serverFields.has(key)&&!equal(base[key],current[key])){(patch as Record<string,unknown>)[key]=current[key]??null;expected[key]=base[key]??null;}}
 if(provenance){
  const metadata=validateLookupMetadata(provenance.metadata);
  Object.assign(patch,metadata);
  for(const key of ['environmentLookupStatus','environmentLookupNotes'] as const){
   if(!Object.hasOwn(provenance.expected,key))throw new Error('Missing expected lookup history');
   expected[key]=provenance.expected[key]??null;
  }
 }
 return {patch,expected};
}
export async function requestProjectSave(patch:ProjectPatch,expected?:Record<string,unknown>):Promise<Project>{
 const response=await window.fetch(`/api/projects/${patch.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({...patch,...(expected?{__expectedValues:expected}:{})})});
 const data=await response.json();
 if(!response.ok)throw Object.assign(new Error(data.error||`HTTP ${response.status}`),{conflicts:data.conflicts,project:data.project});
 return data;
}
export function reconcileProjectSave(current:Project,submitted:Project,server:Project,beforeSubmit:Project=submitted){
 const merged={...server};
 for(const key of Object.keys(current) as (keyof Project)[]){if(!serverFields.has(key)&&!equal(current[key],beforeSubmit[key]))(merged as unknown as Record<string,unknown>)[key]=current[key];}
 return merged;
}
export function preserveDirtyBaseline(current:Project,base:Project,latest:Project){
 const next={...latest};
 for(const key of Object.keys(current) as (keyof Project)[]){if(!serverFields.has(key)&&!equal(current[key],base[key]))(next as unknown as Record<string,unknown>)[key]=base[key];}
 return next;
}
