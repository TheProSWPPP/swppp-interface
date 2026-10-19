import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import fs from 'node:fs/promises';
import { requestLinkedinHostedReconnect, completeLinkedinHostedReconnect } from '../sdrLinkedinHosted.js';

const url = process.env.SDR_TEST_DATABASE_URL;
if (!url) throw Error('SDR_TEST_DATABASE_URL required');
if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('local database required');
const schema = `linkedin_hosted_${process.pid}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(await fs.readFile(new URL('../../migrations/2026-10-16-sdr-linkedin-channel.sql', import.meta.url), 'utf8'));
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

describe('v1 hosted reconnect binding', () => {
  it('keeps the route inert without a separate enablement', async () => {
    await expect(requestLinkedinHostedReconnect({ pool, companyId: '13105180', accountId: 'sender', actor: 'owner', client: { hostedReconnect: async () => { throw Error('should not call'); } }, notifyUrl: 'https://fixture.test/notify' })).rejects.toMatchObject({ code: 'hosted_auth_disabled' });
  });
  it('requires exact callback name and account, verifies provider read, and rejects reuse', async () => {
    let name;
    const client = {
      hostedReconnect: async input => { name = input.name; expect(input.notifyUrl).toBe('https://fixture.test/notify'); return 'https://account.unipile.com/synthetic'; },
      getAccount: async () => ({ id: 'sender', type: 'LINKEDIN', sources: [{ status: 'OK' }] }),
      getSelf: async () => ({ provider_id: 'ACo-me' }),
    };
    const args = { pool, client, companyId: '13105180', accountId: 'sender', enabled: true };
    const link = await requestLinkedinHostedReconnect({ ...args, actor: 'admin', notifyUrl: 'https://fixture.test/notify' });
    expect(link.url).toBe('https://account.unipile.com/synthetic');
    await expect(completeLinkedinHostedReconnect({ ...args, payload: { status: 'RECONNECTED', account_id: 'other', name } })).rejects.toMatchObject({ code: 'callback_mismatch' });
    await expect(completeLinkedinHostedReconnect({ ...args, payload: { status: 'RECONNECTED', account_id: 'sender', name: 'guessed' } })).rejects.toMatchObject({ code: 'callback_expired_or_reused' });
    expect(await completeLinkedinHostedReconnect({ ...args, payload: { status: 'RECONNECTED', account_id: 'sender', name } })).toMatchObject({ verified: true, mode: 'disabled' });
    await expect(completeLinkedinHostedReconnect({ ...args, payload: { status: 'RECONNECTED', account_id: 'sender', name } })).rejects.toMatchObject({ code: 'callback_expired_or_reused' });
    expect((await pool.query("SELECT sender_provider_id,mode FROM sdr_linkedin_accounts WHERE account_id='sender'")).rows[0]).toMatchObject({ sender_provider_id: 'ACo-me', mode: 'disabled' });
  });
});
