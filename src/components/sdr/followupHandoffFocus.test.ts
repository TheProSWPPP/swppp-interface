import {afterEach,expect,it,vi} from 'vitest';
import {restoreHandoffFocus} from './followupHandoffState';
afterEach(()=>vi.unstubAllGlobals());
it('restores the panel when an async result removes the focused action',()=>{
 const body={} as HTMLElement;
 const documentState={body,activeElement:body};
 const panel={focus:()=>{documentState.activeElement=panel as HTMLElement;}} as HTMLElement;
 vi.stubGlobal('document',documentState);
 expect(restoreHandoffFocus).toBeTypeOf('function');restoreHandoffFocus(panel);
 expect(documentState.activeElement).toBe(panel);
});
it('preserves focus on an existing dialog control',()=>{
 const body={} as HTMLElement,control={} as HTMLElement;
 const documentState={body,activeElement:control};
 const panel={focus:()=>{documentState.activeElement=panel as HTMLElement;}} as HTMLElement;
 vi.stubGlobal('document',documentState);
 expect(restoreHandoffFocus).toBeTypeOf('function');restoreHandoffFocus(panel);
 expect(documentState.activeElement).toBe(control);
});
