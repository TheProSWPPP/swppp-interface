import type {Project} from './data';
export type ProjectPatch = Partial<Project> & {id:string};
export type ProjectSaver = (patch:ProjectPatch,expected?:Record<string,unknown>) => Promise<Project | void> | Project | void;
const serverFields = new Set(['id','generation','generationState','generationRunId','generationContextDigest','runId','contextDigest','environmentLookupStatus','environmentLookupNotes','generationNote']);
const equal = (a:unknown,b:unknown) => JSON.stringify(a??null)===JSON.stringify(b??null);
export function changedProjectFields(base:Project,current:Project){
 const patch:ProjectPatch={id:base.id},expected:Record<string,unknown>={};
 for(const key of Object.keys(current) as (keyof Project)[]){if(!serverFields.has(key)&&!equal(base[key],current[key])){(patch as Record<string,unknown>)[key]=current[key]??null;expected[key]=base[key]??null;}}
 return {patch,expected};
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
