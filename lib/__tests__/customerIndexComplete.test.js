import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../pipedriveClient.js', async orig => ({ ...(await orig()), listOrganizations: vi.fn(), getLead: vi.fn(), getOrganization: vi.fn(),
  getPerson: vi.fn(), updateLead: vi.fn(), swapLeadCompany: vi.fn() }));

// The existing-customer index says "not a customer" for every company it does not list. A scan
// that stopped early lists fewer customers than there are, so it is no index at all: it must
// never be cached, and a send or company swap that needs it waits.
// (Review 2026-11-11: a scan cut short by missing pagination, a repeated cursor or the page cap
// was cached for six hours and let a swap onto a customer's company through.)
const fresh = async () => {
  vi.resetModules();
  const pd = await import('../pipedriveClient.js');
  const index = await import('../customerSuppression.js');
  const swap = await import('../sdrCompanySwap.js');
  return { pd, ...index, ...swap };
};
const org = (id, name, customer = false) => ({ id, name, label: customer ? 1 : null });
const page = (data, pagination) => ({ data, pagination });
const more = next => ({ more_items_in_collection: true, next_start: next });
const END = { more_items_in_collection: false };
// The customer sits on the second page: a scan that stops after the first never sees it.
const FIRST = [org(1, 'Unrelated Paving')];
const SECOND = [org(2, 'Crossland Construction', true)];

describe('existing-customer index is whole or nothing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('PIPEDRIVE_API_TOKEN', 'synthetic');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('reads every page up to the one that says no more are left', async () => {
    const { pd, refreshCustomerIndex, customerIndexStats } = await fresh();
    pd.listOrganizations.mockResolvedValueOnce(page(FIRST, more(500))).mockResolvedValueOnce(page(SECOND, more(1000))).mockResolvedValueOnce(page([], END));
    const index = await refreshCustomerIndex();
    expect([...index.orgIds]).toEqual(['2']);
    expect(index.orgRecords).toBe(2);
    expect(pd.listOrganizations.mock.calls.map(([args]) => args.start)).toEqual([0, 500, 1000]);
    expect(customerIndexStats()).toMatchObject({ loaded: true, tagged_org_records: 1, orgs_scanned: 2 });
  });

  it.each([
    ['no pagination at all', undefined],
    ['empty pagination', {}],
    ['no answer on whether more pages are left', { next_start: 500 }],
    ['"more" as text', { more_items_in_collection: 'true', next_start: 500 }],
    ['"no more" as text', { more_items_in_collection: 'false' }],
    ['more pages promised and no cursor', { more_items_in_collection: true }],
    ['more pages promised and an empty cursor', { more_items_in_collection: true, next_start: null }],
    ['a cursor that is not a number', { more_items_in_collection: true, next_start: '500' }],
    ['a cursor that stays where it is', { more_items_in_collection: true, next_start: 0 }],
    ['a cursor that goes backward', { more_items_in_collection: true, next_start: -500 }],
  ])('a first page with %s is not a whole index', async (_what, pagination) => {
    const { pd, refreshCustomerIndex, customerIndexStats } = await fresh();
    pd.listOrganizations.mockResolvedValueOnce(page(FIRST, pagination)).mockResolvedValue(page(SECOND, END));
    await expect(refreshCustomerIndex()).rejects.toThrow('customer index incomplete after 1 organizations');
    expect(customerIndexStats()).toEqual({ loaded: false });
  });

  it('a cursor that loops back on a later page is not a whole index', async () => {
    const { pd, refreshCustomerIndex, customerIndexStats } = await fresh();
    pd.listOrganizations.mockResolvedValueOnce(page(FIRST, more(500))).mockResolvedValueOnce(page(FIRST, more(500))).mockResolvedValue(page(SECOND, END));
    await expect(refreshCustomerIndex()).rejects.toThrow('customer index incomplete');
    expect(pd.listOrganizations).toHaveBeenCalledTimes(2);
    expect(customerIndexStats()).toEqual({ loaded: false });
  });

  it('a page that is not a list is not a whole index', async () => {
    const { pd, refreshCustomerIndex } = await fresh();
    pd.listOrganizations.mockResolvedValue(page(null, END));
    await expect(refreshCustomerIndex()).rejects.toThrow('customer index incomplete');
  });

  it('a scan stopped at the page cap is not a whole index', async () => {
    const { pd, refreshCustomerIndex, customerIndexStats } = await fresh();
    pd.listOrganizations.mockImplementation(async ({ start }) => page([org(start + 1, `Company ${start}`)], more(start + 500)));
    await expect(refreshCustomerIndex()).rejects.toThrow('customer index incomplete after 200 organizations');
    expect(pd.listOrganizations).toHaveBeenCalledTimes(200);
    expect(customerIndexStats()).toEqual({ loaded: false });
  });

  it('caches nothing from a scan cut short: the next call reads Pipedrive again', async () => {
    const { pd, refreshCustomerIndex } = await fresh();
    pd.listOrganizations.mockResolvedValueOnce(page(FIRST, {}));
    await expect(refreshCustomerIndex()).rejects.toThrow('customer index incomplete');
    pd.listOrganizations.mockResolvedValueOnce(page(FIRST, more(500))).mockResolvedValueOnce(page(SECOND, END));
    expect([...(await refreshCustomerIndex()).orgIds]).toEqual(['2']);
    expect(pd.listOrganizations).toHaveBeenCalledTimes(3);
  });

  it('a scan cut short never replaces a whole index, and an index past its age is not served in its place', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { pd, refreshCustomerIndex, customerIndexStats } = await fresh();
    pd.listOrganizations.mockResolvedValueOnce(page(SECOND, END));
    await refreshCustomerIndex();
    // A forced refresh that comes back short fails, and the whole index stays for its six hours.
    pd.listOrganizations.mockResolvedValue(page(FIRST, {}));
    await expect(refreshCustomerIndex({ force: true })).rejects.toThrow('customer index incomplete');
    expect(customerIndexStats()).toMatchObject({ loaded: true, tagged_org_records: 1 });
    expect([...(await refreshCustomerIndex()).orgIds]).toEqual(['2']);
    // Past six hours a short scan is an error, not a fallback to the old index.
    vi.setSystemTime(Date.now() + 7 * 3600 * 1000);
    await expect(refreshCustomerIndex()).rejects.toThrow('customer index incomplete');
  });

  it('the send checks hold the send when the scan is cut short', async () => {
    const { pd, isCustomerLead, isCustomerCompany } = await fresh();
    pd.listOrganizations.mockResolvedValue(page(FIRST, more(0)));
    pd.getLead.mockResolvedValue({ id: 'lead-1', organization_id: 77, label_ids: [] });
    pd.getOrganization.mockResolvedValue({ id: 77, name: 'Crossland Construction - Tulsa' });
    await expect(isCustomerLead('lead-1')).rejects.toMatchObject({ code: 'crm_unverified', status: 503, preserveDraft: true });
    await expect(isCustomerCompany('Crossland Construction')).rejects.toMatchObject({ code: 'crm_unverified' });
  });

  it('the company swap writes nothing when the scan is cut short', async () => {
    const { pd, swapOne, runCompanySwap } = await fresh();
    pd.listOrganizations.mockResolvedValue(page(FIRST, {}));
    const row = { lead_id: 'lead-1', source_action_id: 'a1', new_org: '2', cand_email: 'est@crossland.example' };
    // Every query answers with the candidate row: settings, then the candidate list.
    const pool = { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })), connect: vi.fn() };
    await expect(swapOne(pool, row, { companyId: '42' })).rejects.toThrow('customer index incomplete');
    expect(pool.query).not.toHaveBeenCalled();
    expect(await runCompanySwap(pool, { companyId: '42', limit: 5 })).toMatchObject({ candidates: 1, checked: 0, applied: 0, error: 'customer_index_unavailable' });
    expect(pool.connect).not.toHaveBeenCalled();
    for (const call of [pd.getLead, pd.getOrganization, pd.getPerson, pd.updateLead, pd.swapLeadCompany]) expect(call).not.toHaveBeenCalled();
  });
});
