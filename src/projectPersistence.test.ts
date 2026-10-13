import {describe,it,expect} from 'vitest';
import {changedProjectFields,reconcileProjectSave} from './projectPersistence';
import type {Project} from './data';
const base={id:'1',projectName:'Fixture',phone:'old',generation:{runId:'server'}} as unknown as Project;
describe('staff project persistence',()=>{
 it('sends only changed fields and expected previous values, excluding server metadata',()=>{expect(changedProjectFields(base,{...base,phone:'mine',generation:undefined})).toEqual({patch:{id:'1',phone:'mine'},expected:{phone:'old'}});});
 it('adopts authoritative unrelated values and preserves text entered while save was pending',()=>{const submitted={...base,phone:'mine'};const current={...submitted,phone:'still typing'};const server={...submitted,projectName:'Authoritative',generation:{runId:'latest'}} as unknown as Project;expect(reconcileProjectSave(current,submitted,server)).toMatchObject({projectName:'Authoritative',phone:'still typing',generation:{runId:'latest'}});});
 it('updates saved values from actual server response',()=>{const submitted={...base,phone:'mine'};expect(reconcileProjectSave(submitted,submitted,{...submitted,phone:'normalized'})).toMatchObject({phone:'normalized'});});
});

it('retains original expected values for dirty fields when another staff update arrives',async()=>{const {preserveDirtyBaseline}=await import('./projectPersistence');const current={...base,phone:'mine'};const latest={...base,phone:'other',projectName:'Other name'};const expected=preserveDirtyBaseline(current,base,latest);expect(changedProjectFields(expected,reconcileProjectSave(current,base,latest))).toEqual({patch:{id:'1',phone:'mine'},expected:{phone:'old'}});expect(expected.projectName).toBe('Other name');});

it('adopts an explicit status action while preserving only edits entered after submission',()=>{const before={...base,status:'Pending Review' as const};const submitted={...before,status:'Approved for Generation' as const};const current={...before,phone:'typed during request'};const server={...submitted};expect(reconcileProjectSave(current,submitted,server,before)).toMatchObject({status:'Approved for Generation',phone:'typed during request'});});

it('sends only staff changes when a stale form contains different lookup history',()=>{
 const saved={...base,waterway:'Old river',environmentLookupStatus:{waterway:'failed'},environmentLookupNotes:{overall:'Intake failed'},generationNote:'Review SWPPP'} as unknown as Project;
 const current={...saved,waterway:'Staff verified river',environmentLookupStatus:{waterway:'complete'},environmentLookupNotes:undefined,generationNote:undefined} as unknown as Project;
 expect(changedProjectFields(saved,current)).toEqual({patch:{id:'1',waterway:'Staff verified river'},expected:{waterway:'Old river'}});
});

it('retains authoritative lookup history during manual edits and keeps dirty field conflict expectations',async()=>{
 const {preserveDirtyBaseline}=await import('./projectPersistence');
 const saved={...base,waterway:'Old river',environmentLookupStatus:{waterway:'failed'},generationNote:'Old review'} as unknown as Project;
 const current={...saved,waterway:'My verified river',environmentLookupStatus:{waterway:'complete'},generationNote:'stale'} as unknown as Project;
 const latest={...saved,waterway:'Other staff river',environmentLookupStatus:{waterway:'review-required'},environmentLookupNotes:{overall:'Lookup requires review'},generationNote:'SWPPP upload failed'} as unknown as Project;
 const merged=reconcileProjectSave(current,saved,latest);
 const baseline=preserveDirtyBaseline(current,saved,latest);
 expect(merged).toMatchObject({waterway:'My verified river',environmentLookupStatus:{waterway:'review-required'},environmentLookupNotes:{overall:'Lookup requires review'},generationNote:'SWPPP upload failed'});
 expect(baseline).toMatchObject({waterway:'Old river',environmentLookupStatus:{waterway:'review-required'},generationNote:'SWPPP upload failed'});
 expect(changedProjectFields(baseline,merged)).toEqual({patch:{id:'1',waterway:'My verified river'},expected:{waterway:'Old river'}});
});
