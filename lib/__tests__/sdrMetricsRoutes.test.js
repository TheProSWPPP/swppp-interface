import { expect, it } from 'vitest';
import { registerSdrMetricsRoutes } from '../sdrMetricsRoutes.js';
async function request({ user = { role:'rep',sub:'rep-1' }, query = {}, allowed = ['rep-a@example.test'], fail = false } = {}) {
  let handler; let observed; let status=200; let body;
  registerSdrMetricsRoutes({ get(path, fn) { expect(path).toBe('/api/sdr/metrics'); handler=fn; } },{
    pool:{},resolveVisibleMailboxes:async () => allowed,
    metrics:async (_pool, options) => { observed=options; if (fail) throw new Error('secret token'); return { total:options.visibleMailboxes.length,attention:options.visibleMailboxes.map(mailbox => ({mailbox})) }; },
  });
  const res={ status(code) { status=code; return this; },json(value) {body=value; return this;} };
  await handler({ sdrUser:user,query },res);
  return { status,body,observed };
}
it('denies missing identity independently of host middleware',async () => {
  expect((await request({ user:null })).status).toBe(401);
});
it('scopes a rep and disables company-wide sales',async () => {
  const result=await request();
  expect(result.observed.visibleMailboxes).toEqual(['rep-a@example.test']);
  expect(result.observed.includeCompanySales).toBe(false);
  expect(result.body.total).toBe(1);
});
it('rejects a forged mailbox before aggregation',async () => {
  const result=await request({query:{mailbox:'other@example.test'}});
  expect(result.status).toBe(403); expect(result.observed).toBeUndefined();
});
it('keeps clearly separated company totals for an admin on sender-filtered views',async () => {
  const options={user:{role:'admin',sub:'admin'},allowed:['rep-a@example.test','rep-c@example.test']};
  expect((await request(options)).observed.includeCompanySales).toBe(true);
  const result=await request({...options,query:{mailbox:'REP-A@example.test'}});
  expect(result.observed.visibleMailboxes).toEqual(['rep-a@example.test']);
  expect(result.observed.includeCompanySales).toBe(true);
});
it('passes an explicit empty scope without defaulting to everyone',async () => {
  expect((await request({allowed:[]})).observed.visibleMailboxes).toEqual([]);
});
it.each([{from:'2026-02-30'},{mailbox:['a','b']},{source:{x:'y'}},{source:'x'.repeat(129)},{sequence:['forged']},{sequence:'x'.repeat(129)}])('rejects invalid scalar query filters',async query => {
  const result=await request({query}); expect(result.status).toBe(400); expect(result.observed).toBeUndefined();
});
it('exposes a safe retryable error category',async () => {
  const result=await request({fail:true}); expect(result.status).toBe(503); expect(result.body).toEqual({error:'metrics_unavailable'});
});
