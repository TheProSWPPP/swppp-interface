import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('contact-read endpoint quota', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T15:00:00Z'));
    vi.stubEnv('APOLLO_API_KEY', 'fixture-key');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('blocks other contact reads after daily exhaustion without blocking a different endpoint', async () => {
    const calls=[];
    vi.stubGlobal('fetch', async url => {
      calls.push(String(url));
      return String(url).includes('/contacts/')
        ? new Response(JSON.stringify({message:'The maximum number of api calls allowed for api/v1/contacts/show is 2000 times per day.'}), {status:429})
        : new Response(JSON.stringify({healthy:true}));
    });
    const api=await import('../apolloClient.js');
    await expect(api.getContact('one')).rejects.toMatchObject({status:429});
    await expect(api.getContact('two')).rejects.toMatchObject({status:429,retryAfterSec:86400});
    expect(await api.getAuthHealth()).toEqual({healthy:true});
    expect(calls).toHaveLength(2);
  });

  it('allows one new read when the provider retry window expires', async () => {
    let calls=0;
    vi.stubGlobal('fetch',async()=>++calls===1
      ? new Response('{}',{status:429,headers:{'retry-after':'120'}})
      : new Response(JSON.stringify({contact:{id:'two',contact_campaign_statuses:[]}})));
    const api=await import('../apolloClient.js');
    await expect(api.getContact('one')).rejects.toMatchObject({status:429});
    vi.advanceTimersByTime(119000);
    await expect(api.getContact('two')).rejects.toMatchObject({status:429,retryAfterSec:1});
    vi.advanceTimersByTime(1000);
    expect(await api.getContact('two')).toMatchObject({id:'two'});
    expect(calls).toBe(2);
  });
});
