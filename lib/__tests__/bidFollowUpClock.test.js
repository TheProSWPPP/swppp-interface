import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {addBusinessDays,chicagoNow,planBidFollowUp,planAfterBid,runBidFollowUpClock,BID_FU1_SUBJECT,BID_FU2_SUBJECT} from '../bidFollowUpClock.js';

// 2026-10-22 is a Thursday.
const at=(today,hour=6)=>({today,hour});

describe('business days',()=>{
 it('skips weekends both ways',()=>{
  expect(addBusinessDays('2026-10-26',-2)).toBe('2026-10-22'); // Mon -> Thu
  expect(addBusinessDays('2026-10-23',5)).toBe('2026-10-30');  // Fri -> Fri
  expect(addBusinessDays('2026-10-23',1)).toBe('2026-10-26');  // Fri -> Mon
 });
 it('reads the Chicago calendar day',()=>{
  expect(chicagoNow(new Date('2026-10-22T04:30:00Z'))).toEqual({today:'2026-10-21',hour:23});
  expect(chicagoNow(new Date('2026-10-22T12:00:00Z'))).toEqual({today:'2026-10-22',hour:7});
 });
});

describe('Email 1 plan',()=>{
 const bid='2026-10-30'; // Fri; Email 1 target = Wed 10-28
 it('waits until the business day before the target',()=>{
  expect(planBidFollowUp({bidDate:bid,now:at('2026-10-22')})).toBeNull();
  expect(planBidFollowUp({bidDate:bid,now:at('2026-10-27')})).toEqual({step:'fu1',subject:BID_FU1_SUBJECT,dueDate:'2026-10-28'});
 });
 it('skips when the team already emailed that contact',()=>{
  expect(planBidFollowUp({bidDate:bid,now:at('2026-10-27'),teamTouchedRecently:true})).toEqual({step:'fu1',skip:'team_already_emailed'});
 });
 it('moves a late lead to the next safe day while still before bid day',()=>{
  expect(planBidFollowUp({bidDate:bid,now:at('2026-10-28',6)})).toMatchObject({dueDate:'2026-10-28'});
  expect(planBidFollowUp({bidDate:bid,now:at('2026-10-28',9)})).toMatchObject({dueDate:'2026-10-29'});
 });
 it('never lands on or after bid day',()=>{
  expect(planBidFollowUp({bidDate:bid,now:at('2026-10-29',9)})).toEqual({step:'fu1',skip:'too_late_for_before_bid'});
  expect(planBidFollowUp({bidDate:'2026-10-20',now:at('2026-10-22')})).toEqual({step:'fu1',skip:'too_late_for_before_bid'});
 });
 it('does nothing once Email 1 is handled',()=>{
  expect(planBidFollowUp({bidDate:bid,now:at('2026-10-27'),marks:new Set(['fu1'])})).toBeNull();
 });
});

describe('Email 2 plan (only when Email 1 was skipped)',()=>{
 const bid='2026-10-23'; // Fri; +5 business days = Fri 10-30
 const skipped=new Set(['fu1']);
 it('is never separate when Email 1 went out',()=>{
  expect(planAfterBid({bidDate:bid,now:at('2026-10-29'),marks:skipped,fu1Outcome:'created'})).toBeNull();
 });
 it('lands 5 business days after the bid',()=>{
  expect(planAfterBid({bidDate:bid,now:at('2026-10-28'),marks:skipped,fu1Outcome:'skipped:team_already_emailed'})).toBeNull();
  expect(planAfterBid({bidDate:bid,now:at('2026-10-29'),marks:skipped,fu1Outcome:'skipped:team_already_emailed'})).toEqual({step:'fu2',subject:BID_FU2_SUBJECT,dueDate:'2026-10-30'});
 });
 it('skips a contact who has written in',()=>{
  expect(planAfterBid({bidDate:bid,now:at('2026-10-29'),marks:skipped,fu1Outcome:'skipped:x',repliedSinceBid:true})).toEqual({step:'fu2',skip:'contact_replied'});
 });
});

const db=reportingTestDb('bid_followup_clock');
describe.skipIf(!db)('bid follow-up clock (Postgres)',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`
  CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,person_email text,lead_origin text,bid_date date,crm_status text);
  CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz,PRIMARY KEY(pipedrive_lead_id,source));`);});
 afterAll(()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_lead_state,sdr_outreach_log');await db.pool.query('DROP TABLE IF EXISTS bid_followup_marks');});
 const now=new Date('2026-10-27T11:00:00Z'); // Tue 06:00 Chicago
 const pd=()=>({addActivity:vi.fn(async a=>({id:777,...a})),getPerson:vi.fn(async()=>({last_incoming_mail_time:null}))});
 const lead=(id,origin,bid,email=`${id}@x.test`)=>db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,$2,$3,$4,$5,'active')`,[id,'p-'+id,email,origin,bid]);

 it('creates Email 1 once for a bid-sheet lead and ignores everything else',async()=>{
  await lead('a','Bid Invite: BuildingConnected','2026-10-30');
  await lead('b','CMD','2026-10-30');
  await lead('c',null,'2026-10-30');
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:1});
  expect(client.addActivity).toHaveBeenCalledTimes(1);
  expect(client.addActivity.mock.calls[0][0]).toMatchObject({leadId:'a',personId:'p-a',subject:BID_FU1_SUBJECT,dueDate:'2026-10-28',type:'email'});
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:0});
  expect(client.addActivity).toHaveBeenCalledTimes(1);
 });

 it('skips Email 1 when the team already emailed the same person on any lead, then sends Email 2 after the bid',async()=>{
  await lead('a','Bid Invite','2026-10-30','Buyer@X.test');
  await lead('old','CMD',null,'buyer@x.test');
  await db.pool.query(`INSERT INTO sdr_outreach_log VALUES('old','pipedrive','2026-10-20T15:00:00Z')`);
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:0,skipped:1});
  expect(client.addActivity).not.toHaveBeenCalled();
  const later=new Date('2026-11-05T11:00:00Z'); // Thu, day before bid+5bd
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:later})).toMatchObject({created:1});
  expect(client.addActivity.mock.calls[0][0]).toMatchObject({subject:BID_FU2_SUBJECT,dueDate:'2026-11-06'});
 });

 it('releases the claim when Pipedrive refuses, so the next run retries',async()=>{
  await lead('a','Bid Invite','2026-10-30');
  const client=pd();client.addActivity.mockRejectedValueOnce(new Error('boom'));
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({failed:1});
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:1});
 });
});
