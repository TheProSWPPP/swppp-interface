import {expect,it} from 'vitest';
import {mailboxReadNote,inboxCoverageSummary,liveReadIssue,liveReadSentence} from './inboxReadStatus';

it('explains each mailbox read state in plain words, never raw status keys',()=>{
  const at='2026-10-26T20:41:00Z',retry='2026-10-26T20:43:00Z';
  expect(mailboxReadNote({mailbox:'a@x.co',status:'complete'})).toBeNull();
  expect(mailboxReadNote({mailbox:'a@x.co',status:'limited'})).toBe('a@x.co: showing its newest 100 conversations.');
  expect(mailboxReadNote({mailbox:'a@x.co',status:'stale',issue:'google_limit',checkedAt:at,retryAt:retry})).toBe('a@x.co: Google paused reading for a minute. Showing the copy from 3:41 PM CT; it updates again after 3:43 PM CT.');
  expect(mailboxReadNote({mailbox:'a@x.co',status:'error',issue:'google_limit',retryAt:retry})).toContain('Trying again after 3:43 PM CT');
  expect(mailboxReadNote({mailbox:'a@x.co',status:'error',issue:'read_failed'})).toContain('reconnect this mailbox');
  for(const status of ['limited','stale','error','disconnected'])expect(mailboxReadNote({mailbox:'a@x.co',status,issue:'google_limit'})).not.toMatch(/stale|google_limit|read_failed|limited\b/);
});

it('only warns when a mailbox could not be read; a long inbox is information',()=>{
  expect(inboxCoverageSummary({complete:true,mailboxes:[]})).toBeNull();
  expect(inboxCoverageSummary({complete:false,mailboxes:[{mailbox:'a@x.co',status:'complete'},{mailbox:'b@x.co',status:'limited'}]})).toMatchObject({tone:'info',notes:['b@x.co: showing its newest 100 conversations.']});
  expect(inboxCoverageSummary({complete:false,mailboxes:[{mailbox:'b@x.co',status:'stale',issue:'google_limit'}]})?.tone).toBe('warning');
});

it('lets System checks show a live read problem for the same mailbox',()=>{
  const reads=[{mailbox:'th@x.co',status:'stale',checkedAt:'2026-10-26T20:41:00Z',issue:'google_limit',retryAt:'2026-10-26T20:43:00Z'},{mailbox:'dc@x.co',status:'current',checkedAt:null,issue:null,retryAt:null}];
  expect(liveReadIssue('TH@x.co',reads)?.mailbox).toBe('th@x.co');
  expect(liveReadIssue('dc@x.co',reads)).toBeNull();
  expect(liveReadIssue('dc@x.co',undefined)).toBeNull();
  expect(liveReadSentence(reads[0])).toBe('Inbox page: Google paused reading th@x.co until about 3:43 PM CT. Showing the copy from 3:41 PM CT.');
});
