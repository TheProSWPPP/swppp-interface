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
