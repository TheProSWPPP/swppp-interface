import {describe,it,expect} from 'vitest';
let state:Record<string,unknown>;
try{state=await import('./followupDraftState');}catch{state={};}
describe('private draft editor state',()=>{
 it('detects unsaved text without autosave',()=>{
  expect(state.isUnsaved).toBeTypeOf('function');
  const dirty=state.isUnsaved as (a:{subject:string;body:string},b:{subject:string;body:string})=>boolean;
  expect(dirty({subject:'s',body:'b'},{subject:'s',body:'b'})).toBe(false);
  expect(dirty({subject:'s',body:'edited'},{subject:'s',body:'b'})).toBe(true);
 });
 it('retains local text on context and revision conflicts',()=>{
  expect(state.applyConflict).toBeTypeOf('function');
  const apply=state.applyConflict as (local:{subject:string;body:string},current:unknown)=>{subject:string;body:string;acknowledged:boolean};
  expect(apply({subject:'My subject',body:'Unsaved text'},{draft:{subject:'Other',body:'Saved elsewhere',revision:2}})).toMatchObject({subject:'My subject',body:'Unsaved text',acknowledged:false});
 });
});
