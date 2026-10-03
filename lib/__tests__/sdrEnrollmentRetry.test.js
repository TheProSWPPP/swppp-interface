import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import * as retry from '../sdrEnrollmentRetry.js';
const monday = new Date('2026-10-05T15:00:00Z');
describe('enrollment refusal policy', () => {
  it('classifies definite capacity/rate-limit/CRM deferrals', () => {
    expect(retry.classifyEnrollmentRefusal({ httpStatus: 409, code: 'daily_cap_reached' })).toMatchObject({ category: 'capacity', retryable: true });
    expect(retry.classifyEnrollmentRefusal({ httpStatus: 429, retryAfterSec: 1800 })).toEqual({ category: 'rate_limit', retryable: true, retryAfterMs: 1800000 });
    expect(retry.classifyEnrollmentRefusal({ httpStatus: 503, code: 'crm_unverified' })).toMatchObject({ category: 'crm_unverified', retryable: true });
  });
  it('never retries uncertainty from a network failure or generic 5xx', () => {
    expect(retry.classifyEnrollmentRefusal({ message: 'PRIVATE TOKEN' })).toEqual({ category: 'enrollment_uncertain', retryable: false, retryAfterMs: null });
    expect(retry.classifyEnrollmentRefusal({ httpStatus: 500 })).toMatchObject({ category: 'enrollment_uncertain', retryable: false });
    expect(retry.classifyEnrollmentRefusal({ httpStatus: 500, preEnrollment: true })).toMatchObject({ category: 'provider_error', retryable: true });
  });
  it.each(['campaign_conflict','customer','invalid_address','crm_archived','crm_missing','draft_expired','contact_changed','replied','unsubscribed'])('holds %s for review', (code) => {
    expect(retry.classifyEnrollmentRefusal({ httpStatus: 409, code })).toEqual({ category: code, retryable: false, retryAfterMs: null });
  });
  it.each([['existing_customer','customer'],['draft_too_old','draft_expired'],['already_outreached','contact_cooldown'],['email_unverified','email_unverified'],['apollo_skipped','apollo_skipped']])('maps actual server refusal %s to bounded category %s', (code,category) => {
    expect(retry.classifyEnrollmentRefusal({httpStatus:409,code})).toEqual({category,retryable:false,retryAfterMs:null});
  });
  it('keeps arbitrary provider errors/body text out of categories', () => {
    expect(retry.classifyEnrollmentRefusal({ httpStatus: 409, code: 'PRIVATE TOKEN', message: 'PRIVATE BUYER BODY' })).toEqual({ category: 'unclassified', retryable: false, retryAfterMs: null });
  });
});
const db = reportingTestDb('enrollment_retry');
const pool = db?.pool;
const ids = ['10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003'];
describe.skipIf(!pool)('durable enrollment recovery (isolated SQL)', () => {
  beforeAll(async () => {
    await db.setup();
    await pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY,status text,sent_at timestamptz,created_at timestamptz,
      assigned_user_id uuid,assigned_mailbox_id uuid,initiated_by text,contact_email_snapshot text,subject text,body text);
      CREATE TABLE sdr_sends(id uuid PRIMARY KEY,draft_id uuid,status text)`);
    await pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-enrollment-retry.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { vi.unstubAllEnvs(); await db.close(); });
  beforeEach(async () => {
    vi.stubEnv('SDR_ENROLLMENT_RETRY_ENABLED', 'true');
    await pool.query('TRUNCATE sdr_enrollment_attempts,sdr_sends,sdr_drafts');
    for (const [i,id] of ids.entries()) await pool.query(`INSERT INTO sdr_drafts(id,status,created_at,assigned_user_id,assigned_mailbox_id,initiated_by,contact_email_snapshot,subject,body)
      VALUES($1,'pending',$2,$3,$3,$4,'buyer@example.test','original subject','PRIVATE BODY')`, [id,monday,ids[0],i===1?'auto-switch':'auto']);
  });
  const record = (id, result = {}) => retry.recordEnrollmentAttempt(pool,id,{ origin: 'auto', now: monday,...result });
  const claim = (now = monday, options = {}) => retry.listDueEnrollmentRetries(pool,{ now,...options });
  it('does not adopt ordinary/manual historical pending drafts', async () => {
    expect(await claim()).toEqual([]);
    expect(await retry.recordEnrollmentAttempt(pool,ids[0],{ origin:'manual',httpStatus:429,now:monday })).toMatchObject({ skipped:'not_automatic' });
    expect((await pool.query('SELECT * FROM sdr_enrollment_attempts')).rows).toHaveLength(0);
  });
  it('creates a pre-request lease once, so a crash cannot become a blind initial retry', async () => {
    const [first,duplicate] = await Promise.all([retry.beginEnrollmentAttempt(pool,ids[0],{ origin:'auto',now:monday }),retry.beginEnrollmentAttempt(pool,ids[0],{ origin:'auto',now:monday })]);
    expect([first,duplicate].filter((row) => row?.lease_token)).toHaveLength(1);
    expect(await claim(new Date('2026-10-05T15:11:00Z'))).toEqual([]);
    expect((await pool.query('SELECT status,category FROM sdr_enrollment_attempts')).rows[0]).toEqual({status:'review',category:'enrollment_uncertain'});
  });
  it('defers 409 capacity to the next business day, then keeps one accepted receipt', async () => {
    const first = await record(ids[0],{httpStatus:409,code:'daily_cap_reached'});
    expect(first.status).toBe('pending');
    expect(first.next_retry_at.toISOString()).toBe('2026-10-06T13:00:00.000Z');
    expect(await claim(new Date('2026-10-05T20:00:00Z'))).toEqual([]);
    const [due] = await claim(new Date('2026-10-06T15:00:00Z'));
    const accepted = await record(ids[0],{accepted:true,receiptId:'provider-enrollment-1',leaseToken:due.lease_token,now:new Date('2026-10-06T15:00:00Z')});
    expect(accepted).toMatchObject({status:'accepted',attempt_count:2,provider_receipt_id:'provider-enrollment-1'});
    await record(ids[0],{httpStatus:429,leaseToken:due.lease_token});
    expect((await pool.query('SELECT status,attempt_count,provider_receipt_id FROM sdr_enrollment_attempts')).rows[0]).toMatchObject({status:'accepted',attempt_count:2,provider_receipt_id:'provider-enrollment-1'});
    expect(await claim(new Date('2026-10-07T15:00:00Z'))).toEqual([]);
  });
  it('honours 429 retry-after and business hours over the weekend', async () => {
    const row = await record(ids[0],{httpStatus:429,retryAfterSec:3600,now:new Date('2026-10-09T21:30:00Z')});
    expect(row.next_retry_at.toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(await claim(new Date('2026-10-10T15:00:00Z'))).toEqual([]);
  });
  it('renews only a running, matching, unexpired lease', async () => {
    const initial=await retry.beginEnrollmentAttempt(pool,ids[0],{origin:'auto',now:monday,leaseMs:60000});
    const renewAt=new Date(monday.getTime()+30000);
    expect(await retry.renewEnrollmentLease(pool,ids[0],initial.lease_token,{now:renewAt,leaseMs:120000})).toBe(true);
    expect((await pool.query('SELECT lease_expires_at FROM sdr_enrollment_attempts')).rows[0].lease_expires_at.toISOString()).toBe('2026-10-05T15:02:30.000Z');
    expect(await retry.renewEnrollmentLease(pool,ids[0],ids[1],{now:renewAt})).toBe(false);
    expect(await retry.renewEnrollmentLease(pool,ids[0],initial.lease_token,{now:new Date('2026-10-05T15:02:30Z')})).toBe(false);
    await record(ids[0],{httpStatus:429,leaseToken:initial.lease_token,now:renewAt});
    expect(await retry.renewEnrollmentLease(pool,ids[0],initial.lease_token,{now:renewAt})).toBe(false);
  });
  it('an expired lease cannot be revived before an internal request', async () => {
    const initial=await retry.beginEnrollmentAttempt(pool,ids[0],{origin:'auto',now:monday,leaseMs:1000});
    expect(await retry.renewEnrollmentLease(pool,ids[0],initial.lease_token,{now:new Date(monday.getTime()+1001)})).toBe(false);
    expect((await pool.query('SELECT lease_expires_at FROM sdr_enrollment_attempts')).rows[0].lease_expires_at.getTime()).toBe(monday.getTime()+1000);
  });
  it('a duplicate refusal receipt with the same lease cannot increment or reschedule twice', async () => {
    const initial=await retry.beginEnrollmentAttempt(pool,ids[0],{origin:'auto',now:monday});
    const result={httpStatus:429,leaseToken:initial.lease_token};
    const first=await record(ids[0],result);
    const duplicate=await record(ids[0],result);
    expect(duplicate.attempt_count).toBe(1);
    expect(duplicate.next_retry_at).toEqual(first.next_retry_at);
    expect(await retry.beginEnrollmentAttempt(pool,ids[0],{origin:'auto',now:monday})).toBeNull();
  });
  it('a stale worker token cannot overwrite another claimed attempt', async () => {
    const initial=await retry.beginEnrollmentAttempt(pool,ids[0],{origin:'auto',now:monday});
    await record(ids[0],{httpStatus:429,leaseToken:initial.lease_token});
    const [due]=await claim(new Date('2026-10-05T16:00:00Z'));
    await record(ids[0],{accepted:true,receiptId:'stale-result',leaseToken:initial.lease_token});
    const receipt=(await pool.query('SELECT status,lease_token,attempt_count,provider_receipt_id FROM sdr_enrollment_attempts')).rows[0];
    expect(receipt).toEqual({status:'running',lease_token:due.lease_token,attempt_count:1,provider_receipt_id:null});
  });
  it('a confirmed late receipt can reconcile a dead lease without any automatic replay', async () => {
    const initial=await retry.beginEnrollmentAttempt(pool,ids[0],{origin:'auto',now:monday});
    await claim(new Date('2026-10-05T15:11:00Z'));
    const row=await record(ids[0],{accepted:true,receiptId:'confirmed-provider-receipt',leaseToken:initial.lease_token,now:new Date('2026-10-05T15:12:00Z')});
    expect(row).toMatchObject({status:'accepted',provider_receipt_id:'confirmed-provider-receipt',attempt_count:1});
    expect(await claim(new Date('2026-10-06T15:00:00Z'))).toEqual([]);
  });
  it('capacity retries follow Chicago daylight saving changes',async()=>{
    const row=await record(ids[0],{httpStatus:409,code:'daily_cap_reached',now:new Date('2026-10-30T15:00:00Z')});
    expect(row.next_retry_at.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });
  it('claims one draft once under two concurrent workers', async () => {
    await record(ids[0],{httpStatus:429});
    const [a,b] = await Promise.all([claim(new Date('2026-10-05T16:00:00Z')),claim(new Date('2026-10-05T16:00:00Z'))]);
    expect([...a,...b]).toHaveLength(1);
    expect([...a,...b][0]).toMatchObject({draft_id:ids[0],origin:'auto',assigned_user_id:ids[0],status:'running'});
  });
  it('retains distinct ordinary/auto-switch origin and original draft snapshots', async () => {
    await record(ids[0],{httpStatus:429});
    await record(ids[1],{origin:'auto-switch',httpStatus:429});
    const due = await claim(new Date('2026-10-05T16:00:00Z'));
    expect(due.map((row)=>row.origin).sort()).toEqual(['auto','auto-switch']);
    expect((await pool.query('SELECT contact_email_snapshot,subject,body FROM sdr_drafts WHERE id=$1',[ids[0]])).rows[0]).toEqual({contact_email_snapshot:'buyer@example.test',subject:'original subject',body:'PRIVATE BODY'});
    expect(JSON.stringify((await pool.query('SELECT * FROM sdr_enrollment_attempts')).rows)).not.toContain('PRIVATE BODY');
  });
  it.each(['customer','contact_changed','crm_archived','replied','campaign_conflict'])('a retry stopped by refreshed guards (%s) never re-enters the scheduler', async (code) => {
    await record(ids[0],{httpStatus:429});
    const [due] = await claim(new Date('2026-10-05T16:00:00Z'));
    const row = await record(ids[0],{httpStatus:409,code,leaseToken:due.lease_token,now:new Date('2026-10-05T16:00:00Z')});
    expect(row).toMatchObject({status:'review',category:code,next_retry_at:null});
    expect(await claim(new Date('2026-10-06T15:00:00Z'))).toEqual([]);
  });
  it('never recovers an uncertain transport/provider outcome automatically', async () => {
    await record(ids[0],{httpStatus:500,message:'PRIVATE TOKEN'});
    expect(await claim(new Date('2026-10-06T15:00:00Z'))).toEqual([]);
    const row = (await pool.query('SELECT * FROM sdr_enrollment_attempts')).rows[0];
    expect(row).toMatchObject({status:'review',category:'enrollment_uncertain'});
    expect(JSON.stringify(row)).not.toContain('PRIVATE TOKEN');
  });
  it('an expired claim enters review instead of creating a second uncertain enrollment', async () => {
    await record(ids[0],{httpStatus:429});
    expect(await claim(new Date('2026-10-05T16:00:00Z'))).toHaveLength(1);
    expect(await claim(new Date('2026-10-05T16:11:00Z'))).toEqual([]);
    expect((await pool.query('SELECT status,category FROM sdr_enrollment_attempts')).rows[0]).toEqual({status:'review',category:'enrollment_uncertain'});
  });
  it('stops automatic attempts after five definite refusals', async () => {
    await record(ids[0],{httpStatus:429,retryAfterSec:1});
    for(let i=1;i<5;i++) {
      const now=new Date(monday.getTime()+i*60000);
      const [due]=await claim(now);
      await record(ids[0],{httpStatus:429,retryAfterSec:1,leaseToken:due.lease_token,now});
    }
    expect((await pool.query('SELECT status,attempt_count,next_retry_at FROM sdr_enrollment_attempts')).rows[0]).toMatchObject({status:'exhausted',attempt_count:5,next_retry_at:null});
    expect(await claim(new Date('2026-10-06T15:00:00Z'))).toEqual([]);
  });
  it('does not claim terminal, already enrolled or expired drafts', async () => {
    for(const id of ids) await record(id,{httpStatus:429});
    await pool.query("UPDATE sdr_drafts SET status='rejected' WHERE id=$1",[ids[0]]);
    await pool.query("INSERT INTO sdr_sends(id,draft_id,status) VALUES($1,$2,'enrolled')",[ids[0],ids[1]]);
    await pool.query("UPDATE sdr_drafts SET created_at='2026-09-01T00:00:00Z' WHERE id=$1",[ids[2]]);
    expect(await claim(new Date('2026-10-05T16:00:00Z'))).toEqual([]);
    expect((await pool.query('SELECT status FROM sdr_enrollment_attempts')).rows.every(row=>row.status==='review')).toBe(true);
  });
  it('default flag-off path needs no migration', async () => {
    vi.stubEnv('SDR_ENROLLMENT_RETRY_ENABLED','false');
    const noDb={query(){throw new Error('must not access DB');}};
    expect(await retry.listDueEnrollmentRetries(noDb)).toEqual([]);
    expect(await retry.renewEnrollmentLease(noDb,ids[0],ids[1])).toBe(false);
    expect(await retry.recordEnrollmentAttempt(noDb,ids[0],{origin:'auto',httpStatus:429})).toMatchObject({skipped:'disabled'});
  });
});
