import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {addBusinessDays,chicagoNow,planBidFollowUp,planAfterBid,runBidFollowUpClock,BID_FU1_SUBJECT,BID_FU2_SUBJECT,bidFu1Note,bidFu2Note} from '../bidFollowUpClock.js';

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

describe('Task 1 plan',()=>{
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

describe('Task 2 plan',()=>{
 const bid='2026-10-23'; // Fri; +5 business days = Fri 10-30
 const handled=new Set(['fu1']);
 it('waits for Task 1 to be handled first',()=>{
  expect(planAfterBid({bidDate:bid,now:at('2026-10-29')})).toBeNull();
 });
 it('lands 5 business days after the bid, whether Task 1 was created or skipped',()=>{
  expect(planAfterBid({bidDate:bid,now:at('2026-10-28'),marks:handled})).toBeNull();
  expect(planAfterBid({bidDate:bid,now:at('2026-10-29'),marks:handled})).toEqual({step:'fu2',subject:BID_FU2_SUBJECT,dueDate:'2026-10-30'});
 });
 it('skips a contact who has written in',()=>{
  expect(planAfterBid({bidDate:bid,now:at('2026-10-29'),marks:handled,repliedSinceBid:true})).toEqual({step:'fu2',skip:'contact_replied'});
 });
});

describe('task notes',()=>{
 it('greet the contact by first name, or with no name when there is none',()=>{
  expect(bidFu1Note('rodger caffey')).toContain('<p>Hey Rodger,</p>');
  expect(bidFu2Note('Katie Caffey')).toContain('<p>Hey Katie,</p>');
  for(const name of [null,'','  ','estimating@gc.test']) expect(bidFu1Note(name)).toContain('<p>Hey,</p>');
  expect(bidFu1Note('Rodger')+bidFu2Note(null)).not.toContain('[First Name]');
 });
});

const db=reportingTestDb('bid_followup_clock');
describe.skipIf(!db)('bid follow-up clock (Postgres)',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`
  CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,person_email text,lead_origin text,bid_date date,crm_status text,lead_title text,person_name text);
  CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz,PRIMARY KEY(pipedrive_lead_id,source));`);});
 afterAll(()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_lead_state,sdr_outreach_log');await db.pool.query('DROP TABLE IF EXISTS bid_followup_marks');});
 const now=new Date('2026-10-27T11:00:00Z'); // Tue 06:00 Chicago
 const pd=()=>({addActivity:vi.fn(async a=>({id:777,...a})),getPerson:vi.fn(async()=>({last_incoming_mail_time:null})),getLead:vi.fn(async()=>({owner_id:4242}))});
 const lead=(id,origin,bid,email=`${id}@x.test`,title='City Hall Addition',name='Rodger Caffey')=>db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,$2,$3,$4,$5,'active',$6,$7)`,[id,'p-'+id,email,origin,bid,title,name]);

 it('creates Task 1 once for a bid-sheet lead, for the lead owner, and ignores everything else',async()=>{
  await lead('a','Bid Invite: BuildingConnected','2026-10-30');
  await lead('b','CMD','2026-10-30');
  await lead('c',null,'2026-10-30');
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:1});
  expect(client.addActivity).toHaveBeenCalledTimes(1);
  expect(client.addActivity.mock.calls[0][0]).toMatchObject({leadId:'a',personId:'p-a',subject:BID_FU1_SUBJECT,dueDate:'2026-10-28',type:'task',userId:4242,note:bidFu1Note('Rodger Caffey')});
  expect(client.addActivity.mock.calls[0][0].note).toContain('Hey Rodger,');
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:0});
  expect(client.addActivity).toHaveBeenCalledTimes(1);
 });

 it('skips Task 1 when the same person was already emailed about the same project, then adds Task 2 after the bid',async()=>{
  await lead('a','Bid Invite','2026-10-30','Buyer@X.test');
  await lead('old','CMD',null,'buyer@x.test',' city hall addition');
  await db.pool.query(`INSERT INTO sdr_outreach_log VALUES('old','pipedrive','2026-10-20T15:00:00Z')`);
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:0,skipped:1});
  expect(client.addActivity).not.toHaveBeenCalled();
  const later=new Date('2026-11-05T11:00:00Z'); // Thu, day before bid+5bd
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:later})).toMatchObject({created:1});
  expect(client.addActivity.mock.calls[0][0]).toMatchObject({subject:BID_FU2_SUBJECT,dueDate:'2026-11-06',type:'task',note:bidFu2Note('Rodger Caffey')});
 });

 it('still adds Task 1 when that person was only emailed about a different project (e.g. an LBA Bid Conf)',async()=>{
  await lead('a','Bid Invite','2026-10-30','buyer@x.test');
  await lead('lba','CMD',null,'buyer@x.test','Some Other Road Job');
  await db.pool.query(`INSERT INTO sdr_outreach_log VALUES('lba','pipedrive','2026-10-20T15:00:00Z')`);
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:1,skipped:0});
 });

 it('adds Task 2 after the bid even when Task 1 was created',async()=>{
  await lead('a','Bid Invite','2026-10-30');
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:1});
  const later=new Date('2026-11-05T11:00:00Z');
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:later})).toMatchObject({created:1});
  expect(client.addActivity.mock.calls[1][0]).toMatchObject({subject:BID_FU2_SUBJECT,dueDate:'2026-11-06'});
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:later})).toMatchObject({created:0});
 });

 it('skips Task 2 when the contact wrote in after the bid',async()=>{
  await lead('a','Bid Invite','2026-10-30');
  const client=pd();
  await runBidFollowUpClock(db.pool,{pd:client,now});
  client.getPerson.mockResolvedValue({last_incoming_mail_time:'2026-11-02 15:00:00'});
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:new Date('2026-11-05T11:00:00Z')})).toMatchObject({created:0,skipped:1});
 });

 it('releases the claim when Pipedrive refuses, so the next run retries',async()=>{
  await lead('a','Bid Invite','2026-10-30');
  const client=pd();client.addActivity.mockRejectedValueOnce(new Error('boom'));
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({failed:1});
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:1});
 });

 it('a new bid still gets Task 1 when more than a window of older bids are waiting for Task 2',async()=>{
  for(let i=0;i<55;i++) await lead('old'+i,'Bid Invite','2026-10-26');
  await db.pool.query(`CREATE TABLE IF NOT EXISTS bid_followup_marks (pipedrive_lead_id TEXT NOT NULL, step TEXT NOT NULL, outcome TEXT NOT NULL, due_date DATE, activity_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (pipedrive_lead_id, step))`);
  await db.pool.query(`INSERT INTO bid_followup_marks(pipedrive_lead_id,step,outcome,due_date) SELECT pipedrive_lead_id,'fu1','created','2026-10-22' FROM sdr_lead_state`);
  await lead('new','Bid Invite','2026-10-30');
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now})).toMatchObject({created:1});
  expect(client.addActivity.mock.calls.map(c=>c[0].leadId)).toEqual(['new']);
  // and when Task 2 is due, the old bids get it even with a full Task 1 window
  for(let i=0;i<55;i++) await lead('next'+i,'Bid Invite','2026-11-27');
  const later=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:later,now:new Date('2026-10-30T11:00:00Z'),limit:50})).toMatchObject({created:50});
  expect(later.addActivity.mock.calls.every(c=>c[0].subject===BID_FU2_SUBJECT)).toBe(true);
 });

 it('Task 2 only counts mail since Task 1 was due as the contact writing back',async()=>{
  await lead('b','Bid Invite','2026-10-26');
  const client=pd();
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:new Date('2026-10-22T11:00:00Z')})).toMatchObject({created:1}); // Task 1 due Thu 10-22
  // plans emailed two weeks before the bid: not an answer, Task 2 is made
  client.getPerson.mockResolvedValue({last_incoming_mail_time:'2026-10-12 15:00:00'});
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:new Date('2026-10-30T11:00:00Z')})).toMatchObject({created:1,skipped:0});
  // a reply after Task 1 was due: no Task 2
  await lead('c','Bid Invite','2026-10-26','c@x.test');
  await db.pool.query(`INSERT INTO bid_followup_marks(pipedrive_lead_id,step,outcome,due_date) VALUES('c','fu1','created','2026-10-22')`);
  client.getPerson.mockResolvedValue({last_incoming_mail_time:'2026-10-23 15:00:00'});
  expect(await runBidFollowUpClock(db.pool,{pd:client,now:new Date('2026-10-30T11:00:00Z')})).toMatchObject({created:0,skipped:1});
 });
});
