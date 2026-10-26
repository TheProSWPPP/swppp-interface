import {expect,it} from 'vitest';
import {jobScopeLabel,jobIssueLabel} from './systemCheckLabels';
it('turns run scopes into plain names',()=>{
  expect(jobScopeLabel('account')).toBeNull();
  expect(jobScopeLabel('gmail:admin@proswppp.co:recent')).toBe('admin@proswppp.co · newest mail');
  expect(jobScopeLabel('gmail:admin@proswppp.co:recent-head')).toBe('admin@proswppp.co · newest mail, quick check');
  expect(jobScopeLabel('gmail:dc@proswppp.co:history')).toBe('dc@proswppp.co · older mail');
  expect(jobScopeLabel('pipedrive:pipedrive-company:13105180:user:19499202:recent:inbox')).toBe('Pipedrive inbox · newest mail');
  expect(jobScopeLabel('pipedrive:pipedrive-company:13105180:user:19499202:recent-head:archive')).toBe('Pipedrive archived mail · newest mail, quick check');
  expect(jobScopeLabel('th@proswppp.co')).toBe('th@proswppp.co');
});
it('explains run issues in words',()=>{
  expect(jobIssueLabel(null)).toBeNull();
  expect(jobIssueLabel('permission')).toMatch(/reconnected/);
  expect(jobIssueLabel('crm_lead_page_cap')).toBe('Issue: crm lead page cap.');
});
