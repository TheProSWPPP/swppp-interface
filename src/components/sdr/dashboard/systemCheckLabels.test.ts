import {describe,expect,it} from 'vitest';
import {jobScopeLabel,jobIssueLabel,softVerdictSummary} from './systemCheckLabels';
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

describe('soft-verdict line in the replenishment check', () => {
  it('shows enrolled, capped and bounce-held unconfirmed addresses', () => {
    expect(softVerdictSummary({softEnrolled:12,softCapped:3,softPausedBounce:0,softDailyCap:40})).toBe('Unconfirmed (catch-all) addresses, last run: 12 enrolled, 3 held by the daily limit of 40.');
    expect(softVerdictSummary({softEnrolled:0,softCapped:0,softPausedBounce:5,softBouncingSequences:1})).toBe('Unconfirmed (catch-all) addresses, last run: 0 enrolled, 5 held because a sequence is bouncing 4% or more.');
    expect(softVerdictSummary({softEnrolled:0,softGuardUnavailable:1})).toContain('could not be read');
  });
  it('says nothing for runs from before the soft rule', () => {
    expect(softVerdictSummary({created:3,enrolled:2})).toBeNull();
    expect(softVerdictSummary(undefined)).toBeNull();
  });
});
