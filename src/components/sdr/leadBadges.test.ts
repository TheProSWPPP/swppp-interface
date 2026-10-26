import {expect,it} from 'vitest';
import {failureSupersededByLaterEmail} from './leadBadges';
it('treats an old failed app send as history once the contact was emailed later',()=>{
  const failed={send_status:'failed',send_sent_at:'2026-10-07T12:00:00Z'};
  expect(failureSupersededByLaterEmail({...failed,outreach_sent_at:'2026-10-26T12:00:00Z'})).toBe(true);
  expect(failureSupersededByLaterEmail({...failed,last_outgoing_mail_time:'2026-10-26T12:00:00Z'})).toBe(true);
  expect(failureSupersededByLaterEmail({...failed,outreach_sent_at:'2026-10-01T12:00:00Z'})).toBe(false);
  expect(failureSupersededByLaterEmail({...failed})).toBe(false);
  expect(failureSupersededByLaterEmail({send_status:'sent',send_sent_at:'2026-10-07T12:00:00Z',outreach_sent_at:'2026-10-26T12:00:00Z'})).toBe(false);
});
