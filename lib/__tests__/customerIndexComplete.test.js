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
const org = (id, name, customer = false, deals = {}) => ({ id, name, label: customer ? 1 : null, open_deals_count: 0, won_deals_count: 0, closed_deals_count: 0, ...deals });
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

  // Review 2026-11-11 (round 9): only a `label` equal to the bare number 1 was read as Customer.
  it.each([
    ['a number', { label: 1 }, true],
    ['text', { label: '1' }, true],
    ['one text with another label', { label: '1,2' }, true],
    ['one text, second, with spaces', { label: '15, 1' }, true],
    ['the id list only', { label: null, label_ids: [15, 1] }, true],
    ['the id list as text', { label_ids: ['1'] }, true],
    ['another label that starts with 1', { label: '11,21', label_ids: [11, 21] }, false],
    ['no label', { label: null, label_ids: [] }, false],
  ])('reads the Customer label given as %s', async (_how, labels, customer) => {
    const { pd, refreshCustomerIndex, orgIsCustomer } = await fresh();
    const record = { ...org(2, 'Crossland Construction'), ...labels };
    pd.listOrganizations.mockResolvedValueOnce(page([record], END));
    const index = await refreshCustomerIndex();
    expect(index.orgIds.has('2')).toBe(customer);
    expect(index.keys.has('crossland construction')).toBe(customer);
    expect(orgIsCustomer(record)).toBe(customer);
  });

  // Review 2026-11-11 (round 9): deals on another record of the same company, no Customer label.
  it('lists companies with deals by name, apart from the customers the send checks use', async () => {
    const { pd, refreshCustomerIndex, customerMatch, isCustomerCompany } = await fresh();
    pd.listOrganizations.mockResolvedValue(page([org(1, 'Unrelated Paving'), org(2, 'Hardy Construction - Tulsa', false, { won_deals_count: 1 }),
      org(3, 'Decker Builders, Inc.', false, { closed_deals_count: 2 }), org(4, 'Open Road Contractors', false, { open_deals_count: 1 })], END));
    const index = await refreshCustomerIndex();
    expect([...index.dealKeys].sort()).toEqual(['decker builders', 'hardy construction', 'hardy construction tulsa']);
    expect([...index.openDealKeys]).toEqual(['open road contractors']);
    // The send checks go by the Customer label alone, as before.
    expect(index.orgIds.size).toBe(0);
    expect(index.keys.size).toBe(0);
    expect(customerMatch({ label_ids: [], org_id: 2, org_name: 'Hardy Construction' }, index)).toBeNull();
    expect(await isCustomerCompany('Hardy Construction')).toBeNull();
  });
  it('an organization list without deal counts is an index for the send checks and none for the swap', async () => {
    const { pd, refreshCustomerIndex, isCustomerCompany, runCompanySwap } = await fresh();
    pd.listOrganizations.mockResolvedValue(page([{ id: 2, name: 'Crossland Construction', label: 1 }, org(3, 'Hardy Construction', false, { won_deals_count: '1' })], END));
    const index = await refreshCustomerIndex();
    expect(index.dealKeys).toBeNull();
    expect(index.openDealKeys).toBeNull();
    expect(await isCustomerCompany('Crossland Construction')).toMatchObject({ matchedOn: 'company_name' });
    const row = { lead_id: 'lead-1', source_action_id: 'a1', new_org: '2', cand_email: 'est@crossland.example' };
    const pool = { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })), connect: vi.fn() };
    expect(await runCompanySwap(pool, { companyId: '42', limit: 5 })).toMatchObject({ candidates: 1, checked: 0, applied: 0, error: 'customer_index_unavailable' });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pd.getLead).not.toHaveBeenCalled();
  });

  // Review 2026-11-11 (round 15): a customer record that comes back without its name is on the
  // id list and not on the name list, so a sibling record of that company read as no customer.
  it.each([
    ['a Customer record with no name', { id: 77, label: 1, won_deals_count: 0, closed_deals_count: 0, open_deals_count: 0 }],
    ['a record with a won deal and an empty name', { id: 77, name: ' ', won_deals_count: 1, closed_deals_count: 0, open_deals_count: 0 }],
    ['a record with no id', { name: 'Hardy Construction - Tulsa', won_deals_count: 0, closed_deals_count: 0, open_deals_count: 0 }],
  ])('an organization list holding %s is an index for the send checks and none for the swap', async (_what, record) => {
    const { pd, refreshCustomerIndex, isCustomerCompany } = await fresh();
    pd.listOrganizations.mockResolvedValue(page([org(1, 'Unrelated Paving'), { id: 2, name: 'Crossland Construction', label: 1, won_deals_count: 0, closed_deals_count: 0, open_deals_count: 0 }, record], END));
    const index = await refreshCustomerIndex();
    expect(index.dealKeys).toBeNull();
    expect(index.openDealKeys).toBeNull();
    expect(await isCustomerCompany('Crossland Construction')).toMatchObject({ matchedOn: 'company_name' });
  });

  // Review 2026-11-11 (round 9): the swap took the six-hour copy, so a Customer label staff put
  // on a sibling record hours before the pass was not in it.
  it('the swap reads the organizations again on every pass, the send checks keep the six-hour copy', async () => {
    const { pd, refreshCustomerIndex, isCustomerCompany, runCompanySwap } = await fresh();
    pd.listOrganizations.mockResolvedValue(page(FIRST, END));
    await refreshCustomerIndex();
    expect(pd.listOrganizations).toHaveBeenCalledTimes(1);
    // Staff tag the customer. A send check still answers from the copy; the swap does not.
    pd.listOrganizations.mockResolvedValue(page([...FIRST, ...SECOND], END));
    expect(await isCustomerCompany('Crossland Construction')).toBeNull();
    expect(pd.listOrganizations).toHaveBeenCalledTimes(1);
    const row = { lead_id: 'lead-1', source_action_id: 'a1', new_org: '2', cand_email: 'est@crossland.example' };
    const pool = { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })), connect: vi.fn() };
    expect(await runCompanySwap(pool, { companyId: '42', limit: 5, dryRun: true })).toMatchObject({ candidates: 1, checked: 1 });
    expect(pd.listOrganizations).toHaveBeenCalledTimes(2);
    await runCompanySwap(pool, { companyId: '42', limit: 5, dryRun: true });
    expect(pd.listOrganizations).toHaveBeenCalledTimes(3);
    // The fresh read is the copy the send checks answer from next.
    expect(await isCustomerCompany('Crossland Construction')).toMatchObject({ matchedOn: 'company_name' });
    expect(pd.listOrganizations).toHaveBeenCalledTimes(3);
  });
  it('a forced read waits out a scan already under way and takes one that began after it asked', async () => {
    const { pd, refreshCustomerIndex } = await fresh();
    let release;
    pd.listOrganizations.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(page(FIRST, END)); }))
      .mockResolvedValue(page(SECOND, END));
    const send = refreshCustomerIndex();              // under way: it has read the page already
    const one = refreshCustomerIndex({ force: true });   // staff tag the customer, then the swap asks
    const two = refreshCustomerIndex({ force: true });
    const joined = refreshCustomerIndex();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(pd.listOrganizations).toHaveBeenCalledTimes(1);
    release();
    expect([...(await send).orgIds]).toEqual([]);
    expect([...(await joined).orgIds]).toEqual([]);
    expect([...(await one).orgIds]).toEqual(['2']);
    expect([...(await two).orgIds]).toEqual(['2']);
    // The two forced callers share one new scan.
    expect(pd.listOrganizations).toHaveBeenCalledTimes(2);
    expect([...(await refreshCustomerIndex()).orgIds]).toEqual(['2']);
    expect(pd.listOrganizations).toHaveBeenCalledTimes(2);
  });
  it('a forced read still makes its own scan when the one under way fails', async () => {
    const { pd, refreshCustomerIndex } = await fresh();
    let fail;
    pd.listOrganizations.mockImplementationOnce(() => new Promise((_, reject) => { fail = () => reject(new Error('Pipedrive unreachable')); }))
      .mockResolvedValue(page(SECOND, END));
    const send = refreshCustomerIndex();
    const forced = refreshCustomerIndex({ force: true });
    fail();
    await expect(send).rejects.toThrow('Pipedrive unreachable');
    expect([...(await forced).orgIds]).toEqual(['2']);
    expect(pd.listOrganizations).toHaveBeenCalledTimes(2);
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
