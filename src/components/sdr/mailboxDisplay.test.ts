import {expect,it} from 'vitest';
import {mailboxStatus,healthScoreText} from './mailboxDisplay';
it('labels mailboxes by what they are doing, not the raw Apollo flag',()=>{
  expect(mailboxStatus({warmup_status:'pending',active:true,delivered_14d:73}).label).toBe('Sending');
  expect(mailboxStatus({warmup_status:'pending',active:true,delivered_14d:0}).label).toBe('Not sending yet');
  expect(mailboxStatus({warmup_status:'pending',active:true}).label).toBe('Not sending yet');
  expect(mailboxStatus({warmup_status:'warming',active:true,delivered_14d:5}).label).toBe('Warming up');
  expect(mailboxStatus({warmup_status:'ready',active:true}).label).toBe('Ready');
  expect(mailboxStatus({warmup_status:'warming',active:false}).label).toBe('Turned off');
});
it('shows "Not synced" instead of a 0.00 health score',()=>{
  expect(healthScoreText({deliverability_score:null,last_health_check_at:null})).toBe('Not synced');
  expect(healthScoreText({deliverability_score:0,last_health_check_at:'2026-06-23T23:08:31Z'})).toBe('Not synced');
  expect(healthScoreText({deliverability_score:'0.00' as unknown as number,last_health_check_at:null})).toBe('Not synced');
  expect(healthScoreText({deliverability_score:'88.80' as unknown as number,last_health_check_at:'2026-06-23T23:08:31Z'})).toBe('88.8 (as of Jun 23, 2026)');
});
