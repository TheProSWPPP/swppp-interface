import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {reportingTestDb} from './reportingTestDb.js';
import {resolveEventPolicy} from '../engagementSideEffectPolicy.js';
import {recordCompletedOutreach,attemptSequenceMarkerProposal,openActivityAlert} from '../sdrEngagementReceipts.js';
import {publishOutreachEvent} from '../sdrNotePublisher.js';
const db=reportingTestDb('engagement_route');
const pd={updateLead:vi.fn(),addNote:vi.fn(),addActivity:vi.fn()};let handler;
describe.skipIf(!db)('actual event route receipt semantics',()=>{
 beforeAll(async()=>{
  await db.setup();await db.pool.query(`CREATE TABLE sdr_sends(id text,pipedrive_lead_id text,draft_id text,apollo_sequence_id text,apollo_contact_id text,mailbox_id text,apollo_emailer_message_id text,sent_at timestamptz,status text,last_status_at timestamptz,updated_at timestamptz);
  CREATE TABLE sdr_drafts(id text,pipedrive_contact_id text,contact_email_snapshot text);
  CREATE TABLE sdr_mailboxes(id text,email text,pipedrive_sender_id int);
  CREATE TABLE sdr_engagement_events(id bigserial,source text,event_type text,apollo_event_id text UNIQUE,apollo_sequence_id text,apollo_emailer_message_id text,pipedrive_lead_id text,pipedrive_contact_id text,mailbox_email text,occurred_at timestamptz,payload jsonb,process_status text,processed_at timestamptz,process_error text);
  CREATE TABLE sdr_message_facts(provider text,provider_message_id text,provider_status text,link_status text,pipedrive_lead_id text,campaign_id text,prospect_email text,mailbox_email text,occurred_at timestamptz);
  CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz,sender_name text,sender_email text,subject text,external_ref text,updated_at timestamptz,PRIMARY KEY(pipedrive_lead_id,source));`);
  await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-note-events.sql',import.meta.url),'utf8'));
  const source=await fs.readFile(new URL('../../server.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('app.post("/api/sdr/events/ingest"'),source.indexOf('// Pipedrive field key for Sequence_Started'));
  const deps={app:{post:(...args)=>{handler=args.at(-1);}},express:{json:()=>()=>{}},pool:db.pool,crypto,resolveEventPolicy,engagementBackfillDone:async()=>true,fireHighIntentAlert:vi.fn(),pipedriveClient:pd,pdSequenceStartedKey:'marker',apolloClient:{},stopOwnedEnrollment:async()=>({status:'protected_external_state'}),setOutreachControl:vi.fn(),withProviderContactLock:vi.fn(),recordCompletedOutreach,attemptSequenceMarkerProposal,openActivityAlert,publishOutreachEvent:(pool,args)=>publishOutreachEvent(pool,args,{addNote:pd.addNote})};
  new Function(...Object.keys(deps),block)(...Object.values(deps));
 });
 afterAll(async()=>await db.close());afterEach(()=>vi.unstubAllEnvs());
 beforeEach(async()=>{
  vi.clearAllMocks();vi.stubEnv('DATABASE_URL','synthetic');vi.stubEnv('PIPEDRIVE_API_TOKEN','synthetic');vi.stubEnv('SDR_REPLY_ACTIONS_ENABLED','false');vi.stubEnv('APOLLO_API_KEY','');
  pd.updateLead.mockRejectedValue(Object.assign(Error('proposal retained'),{code:'crm_change_requires_review'}));pd.addNote.mockResolvedValue({id:'note'});pd.addActivity.mockResolvedValue({id:'task'});
  await db.pool.query(`TRUNCATE sdr_sends,sdr_drafts,sdr_mailboxes,sdr_engagement_events,sdr_note_events,sdr_outreach_log,sdr_message_facts;
  INSERT INTO sdr_sends VALUES('send','lead','draft','campaign','contact','mailbox','message','2026-10-01','enrolled',NULL,NULL);
  INSERT INTO sdr_drafts VALUES('draft','person','person@example.test');INSERT INTO sdr_mailboxes VALUES('mailbox','rep@example.test',7);`);
 });
 const invoke=async(type,id='event')=>{let output,code=200;await handler({body:{id,type,emailer_message_id:'message',email:'person@example.test',sequence_id:'campaign',created_at:'2026-10-07T12:00:00Z',from_email:'rep@example.test'}},{status:n=>{code=n;return {json:o=>{output=o;}};},json:o=>{output=o;}});expect(code).toBe(200);return output;};
 it('does not let a protected marker proposal swallow a truthful reply note or task',async()=>{
  await invoke('email_replied');expect(pd.addNote).toHaveBeenCalledTimes(1);expect(pd.addActivity).toHaveBeenCalledTimes(1);
  expect(pd.addNote.mock.calls[0][0].content).toContain('Reply received');expect(pd.addNote.mock.calls[0][0].content).not.toMatch(/hot lead|strong interest|Sequence_Started cleared/i);
  await invoke('email_replied');expect(pd.addNote).toHaveBeenCalledTimes(1);expect(pd.addActivity).toHaveBeenCalledTimes(1);
 });
 it('publishes a bounce receipt despite marker proposal and never claims a confirmed stop',async()=>{
  await invoke('email_bounced');expect(pd.addNote).toHaveBeenCalledTimes(1);expect(pd.addNote.mock.calls[0][0].content).toContain('delivery failure');expect(pd.addNote.mock.calls[0][0].content).not.toContain('Sequence stopped');
 });
 it('retains an uncertain note receipt without replaying an external note',async()=>{
  pd.addNote.mockRejectedValueOnce(Error('provider timed out after dispatch'));
  await invoke('email_replied');await invoke('email_replied');
  expect(pd.addNote).toHaveBeenCalledTimes(1);
  expect((await db.pool.query('SELECT status FROM sdr_note_events')).rows).toEqual([{status:'unresolved'}]);
 });
 it('records only actual sent-message time and does not replay the same note',async()=>{
  await invoke('email_sent');const first=(await db.pool.query('SELECT * FROM sdr_outreach_log')).rows[0];expect(first).toMatchObject({sent_at:new Date('2026-10-07T12:00:00Z'),external_ref:'apollo:message'});
  await invoke('email_sent');expect((await db.pool.query('SELECT * FROM sdr_outreach_log')).rows).toEqual([first]);expect(pd.addNote).toHaveBeenCalledTimes(1);expect(pd.addNote.mock.calls[0][0].content).toContain('Email sent');
 });
 it('does not claim a sent event when only a sequence-email fallback exists',async()=>{
  await db.pool.query('UPDATE sdr_sends SET apollo_emailer_message_id=NULL');await invoke('email_sent');
  expect((await db.pool.query('SELECT * FROM sdr_outreach_log')).rows).toHaveLength(0);expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('enrolled');expect(pd.addNote).not.toHaveBeenCalled();
 });
});
