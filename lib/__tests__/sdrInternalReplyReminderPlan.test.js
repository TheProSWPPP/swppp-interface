import {describe,it,expect} from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import * as reminders from '../sdrInternalReplyReminders.js';
const base={receivedAt:'2026-11-13T15:00:00Z',now:'2026-11-16T15:00:00Z',task:{id:1,done:false,due_date:'2026-11-13'},intent:'question',text:'Can you send the proposal?',notices:[]};
describe('internal reply reminder planning',()=>{
 it('waits until the next business morning and excludes weekends',()=>{
  expect(reminders.planReminder({...base,now:'2026-11-14T16:00:00Z'})).toBeNull();
  expect(reminders.planReminder({...base,now:'2026-11-16T14:59:00Z'})).toBeNull();
  expect(reminders.planReminder(base)?.step).toBe('owner');
 });
 it('does not notify completed or postponed Pipedrive tasks',()=>{
  expect(reminders.planReminder({...base,task:{...base.task,done:true}})).toBeNull();
  expect(reminders.planReminder({...base,task:{...base.task,due_date:'2026-11-18'}})).toBeNull();
 });
 it('honors a week requested by the buyer and holds unclear nurture timing',()=>{
  const x={...base,intent:'nurture',receivedAt:'2026-11-09T14:21:21Z',text:"I won't have an answer for another week or so if you would like to check back then?"};
  expect(reminders.planReminder({...x,now:'2026-11-13T15:00:00Z'})).toBeNull();
  expect(reminders.planReminder(x)?.step).toBe('owner');
  expect(reminders.planReminder({...x,text:'Check back when the funding situation changes'})).toBeNull();
 });
 it('escalates only after a confirmed owner reminder and another business day',()=>{
  expect(reminders.planReminder({...base,receivedAt:'2026-11-02T15:00:00Z'})?.step).toBe('owner');
  const notices=[{step:'owner',state:'sent',sent_at:'2026-11-16T15:00:00Z',local_day:'2026-11-16'}];
  expect(reminders.planReminder({...base,notices})).toBeNull();
  expect(reminders.planReminder({...base,now:'2026-11-17T15:00:00Z',notices})?.step).toBe('escalation');
  expect(reminders.planReminder({...base,now:'2026-11-17T15:00:00Z',notices:[{...notices[0],state:'uncertain'}]})).toBeNull();
 });
 it('prioritizes the explicit proposal deadline and does not send twice the same day',()=>{
  const x={...base,text:'Project bids November 23rd. Please have proposals to me by November 20th.',now:'2026-11-18T15:00:00Z'};
  expect(reminders.planReminder(x)?.step).toBe('deadline_2');
  expect(reminders.planReminder({...x,now:'2026-11-19T15:00:00Z'})?.step).toBe('deadline_1');
  expect(reminders.planReminder({...x,notices:[{step:'owner',state:'sent',sent_at:x.now,local_day:'2026-11-18'}]})).toBeNull();
 });
 it('does not treat quoted history as a new requested date',()=>{
  expect(reminders.planReminder({...base,intent:'nurture',text:'Not sure yet.\nFrom: Old sender\nCheck back in one week'})).toBeNull();
 });
 it('respects task due time and Chicago daylight saving changes',()=>{
  expect(reminders.planReminder({...base,task:{...base.task,due_date:'2026-11-16',due_time:'20:00'}})).toBeNull();
  const summer={...base,receivedAt:'2026-07-09T14:00:00Z',task:{...base.task,due_date:'2026-07-09'}};
  expect(reminders.planReminder({...summer,now:'2026-07-10T13:59:00Z'})).toBeNull();
  expect(reminders.planReminder({...summer,now:'2026-07-10T14:00:00Z'})?.step).toBe('owner');
 });
 it('renders a plain internal question with Pipedrive controls, no reply-to-customer action',()=>{
  const m=reminders.reminderEmail({task:{id:39093,subject:'Reply received: Cody - Pavilion'},step:'owner',buyer:'cody@example.test'});
  expect(m.bodyText).toContain('Was this request handled?');
  expect(m.bodyText).toContain('https://proswpppllc.pipedrive.com/activities/39093');
  expect(m.bodyText).toContain('mark the task done');
  expect(m.bodyText).toContain('move its due date');
  expect(m.bodyText).not.toContain('/#/sdr');
 });
});

describe('review regressions',()=>{
 it('gives the owner the postponed business day before escalation',()=>{
  const x={...base,task:{...base.task,due_date:'2026-11-20'},notices:[{step:'owner',state:'sent',sent_at:'2026-11-16T15:00:00Z',local_day:'2026-11-16'}]};
  expect(reminders.planReminder({...x,now:'2026-11-20T15:00:00Z'})).toBeNull();
  expect(reminders.planReminder({...x,now:'2026-11-23T15:00:00Z'})?.step).toBe('escalation');
 });
 it('honors a January date stated in November',()=>{
  expect(reminders.requestedTiming({intent:'nurture',receivedAt:'2026-11-20T15:00:00Z',text:'Please check back January 12.'}).requested).toBe('2027-01-12');
  expect(reminders.requestedTiming({intent:'question',receivedAt:'2026-11-20T15:00:00Z',text:'Please have proposals to me by January 8.'}).deadline).toBe('2027-01-08');
 });
 it('honors an explicit deferral in an interested reply without postponing for project dates',()=>{
  expect(reminders.planReminder({...base,intent:'interested',text:'Please check back in two weeks once the GC is selected.'})).toBeNull();
  expect(reminders.planReminder({...base,intent:'interested',text:'We start in two weeks. Can you send a proposal today?'})?.step).toBe('owner');
 });
 it('disables a misconfigured worker without crashing server startup',()=>{
  const source=fs.readFileSync(new URL('../../server.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('// Internal staff reminders'),source.indexOf('// Quiet-conversation clock:'));
  const logs=[];
  expect(()=>vm.runInNewContext(block,{process:{env:{DATABASE_URL:'local',PIPEDRIVE_API_TOKEN:'fixture',SDR_INTERNAL_REMINDERS_MODE:'live'}},createInternalReminderClient:()=>{throw Error('reminder_company_configuration');},console:{error:m=>logs.push(m)}})).not.toThrow();
  expect(logs).toHaveLength(1);
 });
});
