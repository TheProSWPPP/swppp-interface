import {it,expect} from 'vitest';
import {groupFollowups,followupNextAction,followupDue,chicagoDay} from './followupView';
import type {CrmFollowUp} from '../../lib/sdrCrmApi';
const task=(id:string,leadId='a',dueDate='2026-10-07'):CrmFollowUp=>({id,leadId,subject:'Call buyer',type:'call',note:null,ownerId:'derek',dueDate,dueTime:null,done:false,sourceUpdatedAt:null,observedAt:null,sourceUrl:null});
it('preserves separate manual task dates and owners when grouping paginated project rows',()=>{
 const second={...task('2','a','2026-10-12'),ownerId:'sarah'};
 const groups=groupFollowups([task('1'),task('3','b'),second,task('1')]);
 expect(groups).toHaveLength(2);expect(groups[0].tasks.map(x=>[x.id,x.dueDate,x.ownerId])).toEqual([['1','2026-10-07','derek'],['2','2026-10-12','sarah']]);
});
it('prioritizes restrictions over recent reply attention without inferring response absence',()=>{
 const replied={...task('1'),attention:{reason:'recent_verified_reply' as const,providerMessageId:'r1',sourceMessageId:'m1',threadId:'t1',mailbox:'rep@example.test',receivedAt:'2026-10-06',detectedAt:'2026-10-06',factObservedAt:'2026-10-06',linkEvidence:'verified'}};
 expect(followupNextAction({...replied,restrictions:[{id:'h',reason:'Opt out',providerStopStatus:'unverified'}]})).toContain('restriction');
 expect(followupNextAction(replied)).toContain('original task in Pipedrive');
 expect(followupNextAction({...replied,lastReply:{receivedAt:'2026-10-06',intent:'interested',staffResponseAt:'2026-10-07'}})).toContain('original task in Pipedrive');
});
it('uses the Chicago day across midnight and DST without shifting scheduled dates',()=>{
 expect(chicagoDay(new Date('2026-10-08T02:00:00Z'))).toBe('2026-10-07');
 expect(followupDue('2026-11-01','2026-11-02')).toBe('1d overdue');
 expect(followupDue('2026-10-12','2026-10-07')).toBe('In 5d');
});
