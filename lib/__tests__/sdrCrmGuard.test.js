import { describe, expect, it } from 'vitest';
import * as guard from '../sdrCrmGuard.js';

describe('CRM enrollment guard', () => {
  it.each([
    [null, false, 'crm_missing'],
    [{ id: 'a', is_archived: true }, false, 'crm_archived'],
    [{ id: 'a', is_archived: false }, true, null],
    [{ id: 'a' }, false, 'crm_unverified'],
    [{ id: 'a', is_archived: 'false' }, false, 'crm_unverified'],
  ])('checks explicit CRM status for %j', (lead, allowed, reason) => {
    expect(guard.checkCrmLead(lead)).toEqual({ allowed, reason });
  });

  it('rechecks a lead archived after mirror sync and prevents enrollment', async () => {
    const result = await guard.verifyCrmLead('a', { getLead: async () => ({ id: 'a', is_archived: true }) });
    expect(result).toMatchObject({ allowed: false, reason: 'crm_archived', retryable: false });
  });

  it.each([429, 403, 500, undefined])('fails closed with retryable unverified on API error %s', async status => {
    const result = await guard.verifyCrmLead('a', { getLead: async () => { throw Object.assign(new Error('token=private'), { status }); } });
    expect(result).toEqual({ allowed: false, reason: 'crm_unverified', retryable: true, lead: null });
  });

  it('distinguishes 404 from confirmed archival', async () => {
    expect(await guard.verifyCrmLead('a', { getLead: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } })).toMatchObject({ allowed: false, reason: 'crm_missing', retryable: false });
  });

  it('does not authorize the wrong lead returned by the provider', async () => {
    expect(await guard.verifyCrmLead('a', { getLead: async () => ({ id: 'b', is_archived: false }) })).toMatchObject({ allowed: false, reason: 'crm_unverified', retryable: true });
  });

  it('does not authorize after lifecycle persistence fails', async () => {
    expect(await guard.verifyCrmLead('a', { lifecycleEnabled: true, pool: { query: async () => { throw new Error('database offline'); } }, getLead: async () => ({ id: 'a', is_archived: false }) })).toMatchObject({ allowed: false, reason: 'crm_unverified', retryable: true });
  });
});
