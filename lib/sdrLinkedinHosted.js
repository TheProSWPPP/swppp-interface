import { randomUUID } from 'node:crypto';
import { linkedinHash } from './sdrLinkedinStore.js';

const fail = code => Object.assign(new Error(code), { code });

export async function requestLinkedinHostedReconnect({ pool, client, companyId, accountId, actor, notifyUrl, enabled = false, now = new Date() }) {
  if (!enabled || !pool || !client || !companyId || !accountId || !actor || !/^https:\/\//.test(notifyUrl || '')) throw fail('hosted_auth_disabled');
  const name = randomUUID();
  const expiresOn = new Date(now.getTime() + 10 * 60_000);
  await pool.query(`INSERT INTO sdr_linkedin_hosted_sessions(company_id,account_id,name_hash,requested_by,expires_at) VALUES($1,$2,$3,$4,$5)`,
    [companyId, accountId, linkedinHash(name), actor, expiresOn]);
  const url = await client.hostedReconnect({ notifyUrl, name, expiresOn: expiresOn.toISOString() });
  return { url, expiresAt: expiresOn.toISOString() };
}

export async function completeLinkedinHostedReconnect({ pool, client, companyId, accountId, payload, enabled = false, now = new Date() }) {
  if (!enabled || !pool || !client) throw fail('hosted_auth_disabled');
  if (!payload || payload.status !== 'RECONNECTED' || payload.account_id !== accountId || typeof payload.name !== 'string') throw fail('callback_mismatch');
  const db = await pool.connect();
  let session;
  try {
    await db.query('BEGIN');
    session = (await db.query(`SELECT * FROM sdr_linkedin_hosted_sessions WHERE company_id=$1 AND account_id=$2 AND name_hash=$3 FOR UPDATE`,
      [companyId, accountId, linkedinHash(payload.name)])).rows[0];
    if (!session || session.status !== 'pending' || new Date(session.expires_at) <= now) throw fail('callback_expired_or_reused');
    await db.query("UPDATE sdr_linkedin_hosted_sessions SET status='verifying' WHERE id=$1", [session.id]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
  // A callback is a pointer, never proof of account identity. A failed read
  // leaves this nonce claimed for manual review rather than accepting a replay.
  const [account, self] = await Promise.all([client.getAccount(), client.getSelf()]);
  if (account?.id !== accountId || account.type !== 'LINKEDIN' || !Array.isArray(account.sources) || !account.sources.length || !account.sources.every(source => source.status === 'OK') || !/^ACo/.test(self?.provider_id || '')) throw fail('connected_identity_unverified');
  const final = await pool.connect();
  try {
    await final.query('BEGIN');
    const result = await final.query(`UPDATE sdr_linkedin_hosted_sessions SET status='verified',completed_at=$2 WHERE id=$1 AND status='verifying' RETURNING id`, [session.id, now]);
    if (result.rowCount !== 1) throw fail('callback_replayed');
    await final.query(`INSERT INTO sdr_linkedin_accounts(company_id,account_id,sender_provider_id,status,status_observed_at,mode)
      VALUES($1,$2,$3,'healthy',$4,'disabled') ON CONFLICT(company_id,account_id) DO UPDATE SET sender_provider_id=EXCLUDED.sender_provider_id,status='healthy',status_observed_at=EXCLUDED.status_observed_at,mode='disabled'`,
    [companyId, accountId, self.provider_id, now]);
    await final.query('COMMIT');
  } catch (error) {
    await final.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { final.release(); }
  return { verified: true, accountId, mode: 'disabled' };
}
