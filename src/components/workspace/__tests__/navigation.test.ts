import {expect,it} from 'vitest';
import {readWorkspaceView,workspaceViews} from '../navigation';
it('retains all staff routes and existing project deep links',()=>{
  for(const route of workspaceViews)expect(readWorkspaceView(`#/${route}`)).toBe(route);
  expect(readWorkspaceView('#project-request-123')).toBe('dashboard');
  expect(readWorkspaceView('#/documents')).toBe('dashboard');
  expect(readWorkspaceView('#/sdr?lead=crm-id')).toBe('sdr');
  expect(readWorkspaceView('#/sdr?tab=inbox&connected=user')).toBe('sdr');
});
it('opens the overview on a new or unknown route',()=>{
  expect(readWorkspaceView('')).toBe('overview');
  expect(readWorkspaceView('#/unknown')).toBe('overview');
});
