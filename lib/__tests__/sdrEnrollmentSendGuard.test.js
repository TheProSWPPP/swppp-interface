import {expect,it} from 'vitest';
import {enrollmentSendBlock} from '../sdrEnrollmentSendGuard.js';
const now=new Date('2026-10-05T15:00:00Z');
const active={status:'running',lease_token:'one',lease_expires_at:'2026-10-05T15:10:00Z'};
it('allows a current machine lease and ordinary unattempted human approval',()=>{
 expect(enrollmentSendBlock(active,{machine:true,leaseToken:'one',now})).toBeNull();
 expect(enrollmentSendBlock(null)).toBeNull();
});
it('holds uncertain or already accepted outcomes even for a human approver',()=>{
 expect(enrollmentSendBlock({status:'review',category:'enrollment_uncertain'})).toBe('enrollment_uncertain');
 expect(enrollmentSendBlock({status:'accepted'})).toBe('already_sent');
});
it('blocks a human racing an automatic request and stale machine tokens',()=>{
 expect(enrollmentSendBlock(active,{now})).toBe('enrollment_in_progress');
 expect(enrollmentSendBlock(active,{machine:true,leaseToken:'old',now})).toBe('enrollment_in_progress');
 expect(enrollmentSendBlock(active,{machine:true,leaseToken:'one',now:new Date('2026-10-05T15:11:00Z')})).toBe('enrollment_in_progress');
 expect(enrollmentSendBlock({status:'pending'},{machine:true,leaseToken:'one',now})).toBe('enrollment_lease_missing');
 expect(enrollmentSendBlock(null,{machine:true})).toBe('enrollment_lease_missing');
});
