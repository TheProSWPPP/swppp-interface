import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {recordCompletedOutreach,attemptSequenceMarkerProposal,openActivityAlert} from '../sdrEngagementReceipts.js';
const db=reportingTestDb('engagement_receipts');
describe.skipIf(!db)('completed-message outreach ledger',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_engagement_events(apollo_event_id text PRIMARY KEY,event_type text,apollo_emailer_message_id text,payload jsonb);
 CREATE TABLE sdr_message_facts(provider text,provider_message_id text,provider_status text,link_status text,pipedrive_lead_id text,campaign_id text,prospect_email text,mailbox_email text,occurred_at timestamptz);
 CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz,sender_name text,sender_email text,subject text,external_ref text,updated_at timestamptz,PRIMARY KEY(pipedrive_lead_id,source));`);});
 afterAll(async()=>await db.close());
 beforeEach(async()=>await db.pool.query('TRUNCATE sdr_engagement_events,sdr_message_facts,sdr_outreach_log'));
 const send={id:'send',pipedrive_lead_id:'lead',apollo_sequence_id:'campaign',contact_email_snapshot:'person@example.test'};
 const save=(id,type,payload)=>db.pool.query('INSERT INTO sdr_engagement_events VALUES($1,$2,$3,$4)',[id,type,payload.emailer_message_id||null,payload]);
 const sent={emailer_message_id:'message',created_at:'2026-10-07T12:00:00Z',sequence_id:'campaign',email:'person@example.test',from_email:'rep@example.test'};
 it.each(['enrolled','email_opened','email_replied'])('never calls %s a completed send',async type=>{
  await save('event',type,sent);expect(await recordCompletedOutreach(db.pool,{eventId:'event',sendRow:send,sendMatch:'message_id'})).toMatchObject({recorded:false});
  expect((await db.pool.query('SELECT * FROM sdr_outreach_log')).rows).toHaveLength(0);
 });
 it('records exact email_sent at provider time once, not enrollment or replay time',async()=>{
  await save('event','email_sent',sent);
  await recordCompletedOutreach(db.pool,{eventId:'event',sendRow:send,sendMatch:'message_id'});
  const first=(await db.pool.query('SELECT * FROM sdr_outreach_log')).rows[0];
  await recordCompletedOutreach(db.pool,{eventId:'event',sendRow:send,sendMatch:'message_id'});
  expect((await db.pool.query('SELECT * FROM sdr_outreach_log')).rows).toEqual([first]);
  expect(first).toMatchObject({sent_at:new Date(sent.created_at),external_ref:'apollo:message',source:'interface'});
 });
 it('rejects missing actual timestamp and fallback-only project attribution',async()=>{
  await save('missing-time','email_sent',{...sent,created_at:null});await save('fallback','email_sent',sent);
  expect(await recordCompletedOutreach(db.pool,{eventId:'missing-time',sendRow:send,sendMatch:'message_id'})).toMatchObject({recorded:false});
  expect(await recordCompletedOutreach(db.pool,{eventId:'fallback',sendRow:send,sendMatch:'sequence_email'})).toMatchObject({recorded:false});
 });
 it('accepts a corroborated completed fact and uses its actual completion time',async()=>{
  await save('fact','email_sent',sent);
  await db.pool.query("INSERT INTO sdr_message_facts VALUES('apollo','message','completed','verified','lead','campaign','person@example.test','rep@example.test','2026-10-07T11:59:59Z')");
  expect(await recordCompletedOutreach(db.pool,{eventId:'fact',sendRow:send,sendMatch:'sequence_email'})).toMatchObject({recorded:true,sentAt:'2026-10-07T11:59:59.000Z'});
 });
});
describe('receipt-safe notifications',()=>{
 it('keeps a protected marker proposal distinct from append-only reply processing',async()=>{
  const pd={updateLead:vi.fn(async()=>{throw Object.assign(Error('proposal'),{code:'crm_change_requires_review'});})};
  expect(await attemptSequenceMarkerProposal(pd,'lead','field')).toEqual({status:'proposal_pending'});
 });
 it('does not infer intent or identity from opens',()=>{
  const notice=openActivityAlert({leadTitle:'Project',recipient:'person@example.test',opens:3,link:'https://example.test/lead',pdLink:'https://example.test/crm'});
  expect(notice.subject).toBe('Open activity: Project');
  expect(notice.bodyText).toContain('do not confirm interest');
  expect(notice.bodyHtml).not.toMatch(/high intent|hot lead|strong interest/i);
 });
});
