import {expect,it} from 'vitest';
import {readWorkspaceView,workspaceViews} from '../navigation';
it('retains all staff routes and existing project deep links',()=>{
  for(const route of workspaceViews)expect(readWorkspaceView(`#/${route}`)).toBe(route);
  expect(readWorkspaceView('#project-request-123')).toBe('dashboard');
  expect(readWorkspaceView('#/documents')).toBe('dashboard');
  expect(readWorkspaceView('#/sdr?lead=crm-id')).toBe('sdr');
  expect(readWorkspaceView('#/sdr?tab=inbox&connected=user')).toBe('sdr');
});
it('opens SDR on a new, legacy overview or unknown route',()=>{
  expect(readWorkspaceView('')).toBe('sdr');
  expect(readWorkspaceView('#/overview')).toBe('sdr');
  expect(readWorkspaceView('#/unknown')).toBe('sdr');
});
