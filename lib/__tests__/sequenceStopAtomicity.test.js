import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import { cancelInFlightOutreach } from '../emailVerifyRefresh.js';
import { runAutoSwitch } from '../sdrAutoSwitch.js';
const db = reportingTestDb('stop_atomicity');
const apollo = { removeContactsFromSequence: async () => ({}), getContact: async () => ({ id: 'contact', contact_campaign_statuses: [] }) };
(db ? describe : describe.skip)('confirmed stop persistence', () => {
  beforeAll(async () => {
    await db.setup();
    for (const name of ["sdr-provider-operations","sdr-outreach-controls"]) await db.pool.query(await readFile(new URL(`../../migrations/2026-10-07-${name}.sql`,import.meta.url),"utf8"));
    await db.pool.query(`CREATE TABLE sdr_sends(id text PRIMARY KEY,pipedrive_lead_id text,status text,apollo_sequence_id text,apollo_contact_id text,
      enrolled_trigger text,enrolled_person_id text,enrolled_org_id text,mailbox_id text,draft_id text,sent_at timestamptz,switched_at timestamptz,last_status_at timestamptz,updated_at timestamptz);
      CREATE TABLE sdr_drafts(id text,pipedrive_lead_id text,status text,reject_reason text,contact_email_snapshot text);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text,trigger_type text,pipedrive_person_id text,pipedrive_org_id text,lead_title text);
      CREATE TABLE sdr_mailboxes(id text,owner_user_id text);
      CREATE TABLE sdr_engagement_events(source text,apollo_sequence_id text,pipedrive_lead_id text,occurred_at timestamptz,payload jsonb,apollo_event_id text UNIQUE,event_type text,process_status text,process_error text,processed_at timestamptz);
      CREATE FUNCTION reject_evidence_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'evidence persistence unavailable'; END; $$;
      CREATE TRIGGER fail_evidence BEFORE UPDATE ON sdr_engagement_events FOR EACH ROW EXECUTE FUNCTION reject_evidence_update();`);
  });
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE sdr_outreach_control_decisions,sdr_outreach_controls,sdr_provider_membership_observations,sdr_provider_operations,sdr_sends,sdr_drafts,sdr_lead_state,sdr_mailboxes,sdr_engagement_events;
      ALTER TABLE sdr_engagement_events ENABLE TRIGGER fail_evidence;
      INSERT INTO sdr_sends(id,pipedrive_lead_id,status,apollo_sequence_id,apollo_contact_id,enrolled_trigger,enrolled_person_id,enrolled_org_id,mailbox_id)
      VALUES('send','lead','enrolled','seq','contact','CM','person','old-org','mailbox');
      INSERT INTO sdr_lead_state VALUES('lead','CM','person','new-org','Project');
      INSERT INTO sdr_mailboxes VALUES('mailbox','owner');
      INSERT INTO sdr_engagement_events(apollo_event_id,event_type,process_status,process_error,processed_at) VALUES('verify-stop:send','sequence_stop_unconfirmed','error','pending',NULL),
       ('auto-switch-stop:send','sequence_stop_unconfirmed','error','pending',NULL);`);
  });
  afterAll(async () => { await db.close(); });

  it('keeps drafts and sending hold intact through evidence failure and never confirms an absent stop', async () => {
    let clears=0;
    await db.pool.query("INSERT INTO sdr_drafts VALUES ('staff','lead','edited',NULL,'staff@example.test'),('approved','lead','approved',NULL,'approved@example.test'),('rejected','lead','rejected','staff decision','rejected@example.test')");
    const before=(await db.pool.query('SELECT * FROM sdr_drafts ORDER BY id')).rows;
    await expect(cancelInFlightOutreach(db.pool,{leadId:'lead',companyId:'company'}, {...apollo,updateLead:async()=>{clears++;}})).rejects.toThrow('evidence persistence unavailable');
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_outreach_controls WHERE status='active'")).rows[0].n).toBe(1);
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE id='send'")).rows[0].status).toBe('enrolled');
    await db.pool.query('ALTER TABLE sdr_engagement_events DISABLE TRIGGER fail_evidence');
    const retry=await cancelInFlightOutreach(db.pool,{leadId:'lead',companyId:'company'}, {...apollo,updateLead:async()=>{clears++;}});
    expect(retry).toMatchObject({cancelledDrafts:0,removedEnrollments:0,unresolvedRemovals:1,applicationActionsBlocked:true});
    expect(clears).toBe(0);
    expect((await db.pool.query('SELECT * FROM sdr_drafts ORDER BY id')).rows).toEqual(before);
    expect((await db.pool.query("SELECT process_status FROM sdr_engagement_events WHERE apollo_event_id='verify-stop:send'")).rows[0].process_status).toBe('error');
  });

  it.each([false, true])('keeps auto-switch retryable after evidence failure (stop only: %s)', async stopOnly => {
    if (stopOnly) await db.pool.query('UPDATE sdr_mailboxes SET owner_user_id=NULL');
    let enrollments = 0;
    await runAutoSwitch(db.pool, {
      apollo, buildDraft: async () => ({ apollo_sequence_id: 'new-seq', contact_email_snapshot: 'new@example.test' }),
      enrollDrafts: async () => { enrollments++; return { enrolled: 1 }; },
    }).catch(error => { expect(error.message).toContain('evidence persistence unavailable'); });
    expect((await db.pool.query("SELECT status FROM sdr_sends WHERE id='send'")).rows[0].status).toBe('enrolled');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM sdr_drafts')).rows[0].n).toBe(0);
    expect(enrollments).toBe(0);
    expect((await db.pool.query("SELECT process_status FROM sdr_engagement_events WHERE apollo_event_id='auto-switch-stop:send'")).rows[0].process_status).toBe('error');
  });
});
