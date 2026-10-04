import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import * as collision from '../apolloCollision.js';

// Run against an isolated local PostgreSQL instance. Temporary tables cannot
// alter the application database, and external database URLs are rejected.
const databaseUrl = process.env.SDR_TEST_DATABASE_URL;
const NOW = Date.parse('2026-10-04T21:00:00Z');
let client;

describe.skipIf(!databaseUrl)('Apollo contact cooldown with completed messages', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local test database required');
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE TEMP TABLE sdr_sends (apollo_contact_id text, sent_at timestamptz);
      CREATE TEMP TABLE sdr_message_facts (provider text, direction text, prospect_email text,
        provider_status text, occurred_at timestamptz)`);
    await client.query('SET search_path = pg_temp');
  });
  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.sdr_sends, pg_temp.sdr_message_facts');
    await client.query("INSERT INTO pg_temp.sdr_sends VALUES ('contact-a','2026-09-11T14:00:00Z')");
  });
  afterAll(async () => { await client?.end(); });

  it('blocks a recent follow-up even when enrollment is older than the cooldown', async () => {
    await client.query("INSERT INTO pg_temp.sdr_message_facts VALUES ('apollo','out','estimator@example.test','completed','2026-09-22T14:00:00Z')");
    const days = await collision.readContactSendDaysAgo(client, {
      apolloContactId: 'contact-a', recipientEmail: 'estimator@example.test', now: NOW,
    });
    expect(days).toBe(12);
    expect(days <= 14).toBe(true);
  });

  it('matches the recipient across projects and normalizes whitespace and case', async () => {
    await client.query("INSERT INTO pg_temp.sdr_message_facts VALUES ('apollo','out',' ESTIMATOR@EXAMPLE.TEST ','completed','2026-09-30T16:00:00Z')");
    expect(await collision.readContactSendDaysAgo(client, {
      apolloContactId: 'contact-a', recipientEmail: ' Estimator@example.test ', now: NOW,
    })).toBe(4);
  });

  it('ignores inbound, unfinished, other-provider and different-recipient observations', async () => {
    await client.query(`INSERT INTO pg_temp.sdr_message_facts VALUES
      ('apollo','in','estimator@example.test','completed','2026-10-04T16:00:00Z'),
      ('apollo','out','estimator@example.test','scheduled','2026-10-04T16:00:00Z'),
      ('gmail','out','estimator@example.test','completed','2026-10-04T16:00:00Z'),
      ('apollo','out','someone-else@example.test','completed','2026-10-04T16:00:00Z')`);
    expect(await collision.readContactSendDaysAgo(client, {
      apolloContactId: 'contact-a', recipientEmail: 'estimator@example.test', now: NOW,
    })).toBe(23);
  });

  it('preserves a newer ledger date when no recent completed message is recorded', async () => {
    await client.query("INSERT INTO pg_temp.sdr_sends VALUES ('contact-a','2026-10-02T16:00:00Z'), ('contact-b','2026-10-04T16:00:00Z')");
    expect(await collision.readContactSendDaysAgo(client, {
      apolloContactId: 'contact-a', recipientEmail: 'estimator@example.test', now: NOW,
    })).toBe(2);
  });

  it('returns unknown rather than a fabricated age when neither source is dated', async () => {
    expect(await collision.readContactSendDaysAgo(client, {
      apolloContactId: 'contact-b', recipientEmail: 'missing@example.test', now: NOW,
    })).toBeNull();
  });

  it('requires review if contact history cannot be read', async () => {
    // This connection owns only temporary fixture tables.
    await client.query('ALTER TABLE pg_temp.sdr_message_facts RENAME TO unavailable_message_facts');
    try {
      await expect(collision.readContactSendDaysAgo(client, {
        apolloContactId: 'contact-a', recipientEmail: 'estimator@example.test', now: NOW,
      })).rejects.toMatchObject({ code: 'contact_history_unverified', status: 503, preserveDraft: true });
    } finally {
      await client.query('ALTER TABLE pg_temp.unavailable_message_facts RENAME TO sdr_message_facts');
    }
  });
});
