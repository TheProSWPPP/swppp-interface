import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import { normalizeCompany, sameCompany, nameMatchesAddress, stageDecision, selectSwapCandidates, swapOne, runCompanySwap, swapReady, releaseSettledSwapHolds,
  HELD_REASON, SWAP_REASON, UNKNOWN_OUTCOME_HOLD } from '../sdrCompanySwap.js';
import { swapLeadCompany, updateLead, getLead, getOrganization, listActivitiesPage, findPersonsByEmail } from '../pipedriveClient.js';
import { companyKeyVariants, CUSTOMER_LEAD_LABEL_ID } from '../customerSuppression.js';
import { FIELD_KEYS } from '../pipedriveSync.js';

// 2026-11-11: 634 active leads carried a held "CMD names a different company" proposal. Derek
// had hand-emailed 181 of them, 59 to the very company CMD names, so the change is applied only
// where nobody has touched the lead.
const STAGE = FIELD_KEYS.STAGE;

describe('stageDecision', () => {
  it('moves forward onto an award stage', () => {
    expect(stageDecision('PB', 'LBA')).toEqual({ ok: true, write: true, final: 'LBA' });
    expect(stageDecision('OB', 'AGC')).toEqual({ ok: true, write: true, final: 'AGC' });
    expect(stageDecision('LBA', 'AGC')).toEqual({ ok: true, write: true, final: 'AGC' });
    expect(stageDecision('', 'LBA')).toEqual({ ok: true, write: true, final: 'LBA' });
  });
  it('keeps an award stage when CMD proposes no stage change', () => {
    expect(stageDecision('LBA', undefined)).toEqual({ ok: true, write: false, final: 'LBA' });
    expect(stageDecision('AGC', 'AGC')).toEqual({ ok: true, write: false, final: 'AGC' });
  });
  it('never moves a stage backward', () => {
    expect(stageDecision('CM', 'LBA')).toEqual({ ok: false, reason: 'stage_not_forward' });
    expect(stageDecision('AGC', 'LBA')).toEqual({ ok: false, reason: 'stage_not_forward' });
    expect(stageDecision('PB', 'CD')).toEqual({ ok: false, reason: 'stage_not_forward' });
    expect(stageDecision('Miscellaneous - Cancelled', 'LBA')).toEqual({ ok: false, reason: 'stage_not_forward' });
    expect(stageDecision('Staff note', 'LBA')).toEqual({ ok: false, reason: 'stage_not_forward' });
  });
  it('needs an award stage at the end: a company change before the award names no winner', () => {
    expect(stageDecision('PB', undefined)).toEqual({ ok: false, reason: 'not_award_stage' });
    expect(stageDecision('OB', 'PB')).toEqual({ ok: false, reason: 'not_award_stage' });
    expect(stageDecision('PB', 'Miscellaneous - Cancelled')).toEqual({ ok: false, reason: 'stage_not_forward' });
  });
});

describe('normalizeCompany', () => {
  it('treats names as one company only when they match without case, punctuation and legal suffixes', () => {
    expect(normalizeCompany('Hardy Construction, LLC')).toBe(normalizeCompany('HARDY CONSTRUCTION'));
    expect(normalizeCompany('Smith & Sons Inc.')).toBe(normalizeCompany('Smith and Sons'));
    expect(normalizeCompany('Smith Construction Company')).not.toBe(normalizeCompany('R.E. Smith Construction Company'));
    expect(normalizeCompany('')).toBe('');
  });
});

describe('sameCompany', () => {
  it('reads a branch or division record as the company the lead already has', () => {
    expect(sameCompany('J Raymond Construction', 'J Raymond Construction - Longwood (HQ)')).toBe(true);
    expect(sameCompany('J A Tiberti Construction CO (Fence and Property Management)', 'J A Tiberti Construction Co')).toBe(true);
    expect(sameCompany('Decker Construction Services', 'Decker Construction Services LLC')).toBe(true);
  });
  it('keeps two different companies apart', () => {
    expect(sameCompany('Decker Construction Services, Inc.', 'Hardy Construction, LLC')).toBe(false);
    expect(sameCompany('Miles Resources', 'Puget Paving & Construction Inc.')).toBe(false);
    // One shared word is not a company.
    expect(sameCompany('Construction', 'Hardy Construction')).toBe(false);
    expect(sameCompany('', 'Hardy Construction')).toBe(false);
  });
});

describe('nameMatchesAddress', () => {
  it("accepts the usual formats of a person's own mailbox", () => {
    for (const [name, email] of [['David Strickland', 'dstrickland@ehc.test'], ['Pat Hardy', 'pat.hardy@x.test'], ['Pat Hardy', 'hardy_pat@x.test'],
      ['Pat Hardy', 'phardy2@x.test'], ['Dana Strickland', 'dstrick@x.test'], ['Dana Strickland', 'stricklandd@x.test'], ['J.J. Hickey', 'jjh@x.test'],
      ['Paul Ulloa-Jarrin', 'pulloa@x.test'], ['Paul Ulloa-Jarrin', 'pulloajarrin@x.test'], ['Mike Einhauf Sr', 'mike@x.test'], ['Jeff Liming', 'liming@x.test'],
      ['Rod Jones', 'rodj@x.test'], ['Anthony Carino', 'amcarino@x.test']]) {
      expect(nameMatchesAddress(name, email), `${name} ${email}`).toBe(true);
    }
  });
  it("rejects another person's mailbox and a shared mailbox, even when a piece of the name is inside it", () => {
    for (const [name, email] of [['Elvira Bolanos', 'david@grigolla.test'], ['Marc Petillon', 'info@towpath.test'], ['Ryan Farmer', 'estimating@pap.test'],
      ['Tim Jones', 'estimating@x.test'], ['Pat Hardy', 'dispatch@x.test'], ['Anne Smith', 'joanne@x.test'], ['TJ Shea', 'pc@x.test'],
      ['Kirt Courkamp', 'tcourkamp@jrcc.test'], ['Vaughn Prost', 'vxp@prostbuilders.test'], ['', 'pat@x.test'], ['Pat Hardy', '']]) {
      expect(nameMatchesAddress(name, email), `${name} ${email}`).toBe(false);
    }
  });
  it('rejects a company, a role or a team written as the name', () => {
    for (const [name, email] of [['Performance Construction Group, Llc', 'performance@performance.test'], ['Estimating', 'estimating@x.test'],
      ['Office Manager', 'office@x.test'], ['Hardy Inc', 'hardy@x.test'], ['Bids Team', 'bids@x.test']]) {
      expect(nameMatchesAddress(name, email), `${name} ${email}`).toBe(false);
    }
    // The mailbox's own label typed as the name would read as a first name ("Hi Service,").
    for (const [name, email] of [['Service', 'service@x.test'], ['Accounting', 'accounting@x.test'], ['Marketing', 'marketing@x.test'],
      ['Pre-Con', 'precon@x.test'], ['Pre Con', 'pre.con@x.test'], ['Customer Service', 'service@x.test'], ['Front Desk', 'frontdesk@x.test'],
      ['A P', 'ap@x.test'], ['Pat Hardy', 'ap@x.test'], ['Dispatch', 'dispatch@x.test'], ['Billing', 'billing@x.test']]) {
      expect(nameMatchesAddress(name, email), `${name} ${email}`).toBe(false);
    }
    // The company's own name, whole or in part, is not a person.
    expect(nameMatchesAddress('Hardy Brothers', 'hardy@x.test')).toBe(true);
    expect(nameMatchesAddress('Hardy Brothers', 'hardy@x.test', 'Hardy Brothers Paving, Inc.')).toBe(false);
    expect(nameMatchesAddress('Hardy Brothers Paving Estimator', 'hardy@x.test', 'Hardy Brothers Paving, Inc.')).toBe(false);
    expect(nameMatchesAddress('Pat Hardy', 'phardy@x.test', 'Hardy Construction, LLC')).toBe(true);
  });
});

describe('swapLeadCompany (Pipedrive client)', () => {
  const originalToken = process.env.PIPEDRIVE_API_TOKEN;
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.PIPEDRIVE_API_TOKEN; else process.env.PIPEDRIVE_API_TOKEN = originalToken;
  });
  const capture = () => {
    const calls = [];
    process.env.PIPEDRIVE_API_TOKEN = 'fixture';
    globalThis.fetch = vi.fn(async (url, options) => {
      calls.push({ path: new URL(url).pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { id: 'lead-1' } }) };
    });
    return calls;
  };

  it('sends company, contact and stage in one lead PATCH', async () => {
    const calls = capture();
    await swapLeadCompany('lead-1', { organizationId: 20, personId: 30, stage: 'LBA' });
    expect(calls).toEqual([{ path: '/v1/leads/lead-1', method: 'PATCH', body: { organization_id: 20, person_id: 30, [STAGE]: 'LBA' } }]);
  });
  it('leaves the stage out when none is given', async () => {
    const calls = capture();
    await swapLeadCompany('lead-1', { organizationId: 20, personId: 30 });
    expect(calls[0].body).toEqual({ organization_id: 20, person_id: 30 });
  });
  it('hands the caller\'s abort signal to the request, and a dropped request rejects', async () => {
    process.env.PIPEDRIVE_API_TOKEN = 'fixture';
    const controller = new AbortController();
    let seen;
    globalThis.fetch = vi.fn((url, options) => {
      seen = options.signal;
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))));
    });
    const write = swapLeadCompany('lead-1', { organizationId: 20, personId: 30 }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(write).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toBe(controller.signal);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses anything that is not a whole company and contact', async () => {
    const calls = capture();
    await expect(swapLeadCompany('lead-1', { organizationId: 20 })).rejects.toThrow('lead, company and person required');
    await expect(swapLeadCompany('lead-1', { organizationId: '20', personId: 30 })).rejects.toThrow('lead, company and person required');
    await expect(swapLeadCompany('lead-1', { organizationId: 20, personId: 30, stage: ' ' })).rejects.toThrow('stage must be a non-empty string');
    expect(calls).toHaveLength(0);
  });
  it('keeps every other identity write held for review', async () => {
    const calls = capture();
    await expect(updateLead('lead-1', { organization_id: 20, person_id: 30 })).rejects.toMatchObject({ code: 'crm_change_requires_review' });
    await expect(updateLead('lead-1', { organization_id: 20, person_id: 30, [STAGE]: 'LBA' })).rejects.toMatchObject({ code: 'crm_change_requires_review' });
    await expect(updateLead('lead-1', { title: 'x' })).rejects.toMatchObject({ code: 'crm_change_requires_review' });
    expect(calls).toHaveLength(0);
  });
});

describe('swapReady', () => {
  const sync = { scanned: 10, coverage: 'complete' };
  const sweep = { scanned: 3, leadsUpserted: 1, complete: true, backfilled: true };
  it('lets the swap run after a complete CRM sync and a finished sent-folder sweep', () => {
    expect(swapReady({ sync, sweep })).toEqual({ ok: true });
  });
  it('defers when the CRM sync was partial, skipped or missing', () => {
    for (const bad of [{ ...sync, coverage: 'partial' }, { skipped: 'already_running' }, { skipped: 'concurrent_run' }, null, undefined, {}]) {
      expect(swapReady({ sync: bad, sweep }), JSON.stringify(bad)).toEqual({ ok: false, reason: 'crm_sync_incomplete' });
    }
  });
  it('defers when the sent-folder sweep failed, was already running or stopped at its page cap', () => {
    for (const bad of [null, { skipped: 'already_running' }, { ...sweep, complete: false }, { scanned: 3 }]) {
      expect(swapReady({ sync, sweep: bad }), JSON.stringify(bad)).toEqual({ ok: false, reason: 'sent_sweep_incomplete' });
    }
    expect(swapReady()).toMatchObject({ ok: false });
  });
  it('defers until a sweep has read the whole sent folder and none since stopped at its cap', () => {
    for (const bad of [{ ...sweep, backfilled: false }, { scanned: 3, leadsUpserted: 1, complete: true }]) {
      expect(swapReady({ sync, sweep: bad }), JSON.stringify(bad)).toEqual({ ok: false, reason: 'sent_backfill_unverified' });
    }
  });
});

describe('Pipedrive reads the swap makes', () => {
  const originalToken = process.env.PIPEDRIVE_API_TOKEN;
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.PIPEDRIVE_API_TOKEN; else process.env.PIPEDRIVE_API_TOKEN = originalToken;
  });
  it('fail at once on a rate limit instead of waiting it out inside the client', async () => {
    process.env.PIPEDRIVE_API_TOKEN = 'fixture';
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, headers: { get: () => '1' }, text: async () => JSON.stringify({ success: false, error: 'rate limit' }) }));
    await expect(getLead('lead-1', { failFast: true })).rejects.toMatchObject({ status: 429 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await expect(getOrganization(20, { failFast: true })).rejects.toMatchObject({ status: 429 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
  // Review 2026-11-11 (round 13): a search answer that is not a whole list used to read as
  // "nobody holds this address".
  const searchAnswer = body => {
    process.env.PIPEDRIVE_API_TOKEN = 'fixture';
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
  };
  const lastPage = { pagination: { start: 0, limit: 50, more_items_in_collection: false } };
  const hit = (id, emails, organization = { id: 20 }) => ({ result_score: 1, item: { id, name: 'Pat Hardy', emails, organization } });
  it('the person search gives back the records holding exactly that address', async () => {
    searchAnswer({ success: true, data: { items: [hit(31, ['PHardy@x.test']), hit(32, ['phardy@x.test.au'], null)] }, additional_data: lastPage });
    expect((await findPersonsByEmail('phardy@x.test', { failFast: true })).map(p => p.id)).toEqual([31]);
    searchAnswer({ success: true, data: { items: [] }, additional_data: lastPage });
    expect(await findPersonsByEmail('phardy@x.test')).toEqual([]);
  });
  it.each([
    ['no list', { success: true, data: {}, additional_data: lastPage }],
    ['no data', { success: true, data: null, additional_data: lastPage }],
    ['a list that is not one', { success: true, data: { items: 'x' }, additional_data: lastPage }],
    ['an entry with no record', { success: true, data: { items: [hit(31, ['phardy@x.test']), { result_score: 1 }] }, additional_data: lastPage }],
    ['a record with no id', { success: true, data: { items: [{ item: { name: 'Pat Hardy', emails: ['phardy@x.test'] } }] }, additional_data: lastPage }],
    ['a record with no address list', { success: true, data: { items: [{ item: { id: 31, name: 'Pat Hardy' } }] }, additional_data: lastPage }],
    // Review 2026-11-11 (round 14): the filter dropped a record whose address it could not read.
    ['an address that is not text', { success: true, data: { items: [hit(31, ['phardy@x.test']), hit(55, [{}], { id: 77 })] }, additional_data: lastPage }],
    ['an empty address', { success: true, data: { items: [hit(55, [''])] }, additional_data: lastPage }],
    // Round 15: an empty list passed, and the record dropped out of the answer.
    ['a record with an empty address list', { success: true, data: { items: [hit(31, ['phardy@x.test']), hit(32, [], { id: 77 })] }, additional_data: lastPage }],
    ['a company that is not a record', { success: true, data: { items: [hit(31, ['phardy@x.test'], {})] }, additional_data: lastPage }],
    ['no word on further pages', { success: true, data: { items: [] } }],
    ['more pages to come', { success: true, data: { items: [hit(31, ['phardy@x.test'])] }, additional_data: { pagination: { start: 0, limit: 50, more_items_in_collection: true } } }],
  ])('the person search refuses an answer with %s', async (_, body) => {
    searchAnswer(body);
    await expect(findPersonsByEmail('phardy@x.test')).rejects.toMatchObject({ code: 'person_search_incomplete' });
  });
});

describe('listActivitiesPage for one person', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const answer = body => { const urls = []; vi.stubEnv('PIPEDRIVE_API_TOKEN', 'synthetic');
    vi.stubGlobal('fetch', vi.fn(async url => { urls.push(new URL(url)); return { ok: true, status: 200, text: async () => JSON.stringify(body) }; })); return urls; };
  // The /activities list ignores a person filter (checked against live Pipedrive 2026-11-11):
  // it answers with other people's activities. The person's own endpoint does not.
  it("reads the person's own endpoint, with no lead or user filter", async () => {
    const urls = answer({ success: true, data: [{ id: 5, done: true }], additional_data: { pagination: { start: 0, limit: 100, more_items_in_collection: false } } });
    expect(await listActivitiesPage({ personId: 31, limit: 100 }, { failFast: true })).toEqual({ data: [{ id: 5, done: true }], pagination: { start: 0, limit: 100, more_items_in_collection: false } });
    expect(urls).toHaveLength(1);
    expect(urls[0].pathname).toBe('/v1/persons/31/activities');
    expect(urls[0].searchParams.get('limit')).toBe('100');
    expect(urls[0].searchParams.has('lead_id')).toBe(false);
    expect(urls[0].searchParams.has('person_id')).toBe(false);
  });
  it('gives an answer with no pagination no "last page" of its own making', async () => {
    answer({ success: true, data: null });
    expect(await listActivitiesPage({ personId: 31 })).toEqual({ data: [], pagination: {} });
  });
  it('still reads a lead from the all-users list', async () => {
    const urls = answer({ success: true, data: null, additional_data: { pagination: { start: 0, limit: 100, more_items_in_collection: false } } });
    await listActivitiesPage({ leadId: 'lead-1', limit: 100 });
    expect(urls[0].pathname).toBe('/v1/activities');
    expect(urls[0].searchParams.get('lead_id')).toBe('lead-1');
    expect(urls[0].searchParams.get('user_id')).toBe('0');
  });
});

const db = reportingTestDb('company_swap');
const NO_CUSTOMERS = { orgIds: new Set(), keys: new Set(), dealKeys: new Set(), openDealKeys: new Set() };
const COMPANY = '13105180';
const OLD_ORG = 10, NEW_ORG = 20, OLD_PERSON = 11;
const EMAIL = 'phardy@hardyconstruction.test';
const START = FIELD_KEYS.START, ORIGIN = FIELD_KEYS.LEAD_ORIGIN;
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
// A first-round skip for a record or a list that came back empty or cut short is marked
// transient: the runner does not remember it, and reads the same proposal again next pass.
const ALWAYS_UNREAD = new Set(['lead_activity_unavailable', 'contact_activity_unavailable', 'current_contact_activity_unavailable', 'current_contact_unavailable']);
const skipOf = reason => ({ action: 'skip', reason, ...(ALWAYS_UNREAD.has(reason) ? { transient: true } : {}) });

// A fake Pipedrive holding one lead, its companies and people.
//   failPatch: an HTTP status the lead PATCH fails with; hangPatch: the PATCH never answers,
//   and ends when its request is dropped ('deaf': not even then);
//   onLeadRead(state): runs before each lead read (state.leadReads counts them), to play a staff
//   edit landing between two reads; onPatch(state): runs as the PATCH arrives.
function fakePipedrive(over = {}) {
  const state = {
    lead: { id: 'lead-1', title: 'Hardy Road Widening', organization_id: OLD_ORG, person_id: OLD_PERSON, owner_id: 7, is_archived: false, label_ids: [],
      add_time: '2026-11-01T08:00:00.000Z', update_time: '2026-11-10T08:00:00.000Z',
      [STAGE]: 'PB', [FIELD_KEYS.SEQ]: null, [START]: day(1), [ORIGIN]: 'CMD', ...over.lead },
    orgs: { [OLD_ORG]: { id: OLD_ORG, name: 'Decker Construction Services, Inc.' }, [NEW_ORG]: { id: NEW_ORG, name: 'Hardy Construction, LLC', active_flag: true, closed_deals_count: 0, won_deals_count: 0, open_deals_count: 0, label_ids: [], ...over.newOrg } },
    // The contact the lead has now is always on file, unless a test takes it away (null).
    persons: [...(over.currentPerson === null ? [] : [{ id: OLD_PERSON, name: 'Dale Decker', email: 'old@decker.test', org: OLD_ORG, ...over.currentPerson }]),
      ...(over.persons || [])],
    created: [], patches: [], notes: [], leadReads: 0, calls: 0, readOptions: [], patchSignals: [], aborted: 0, activityReads: [],
  };
  // Pipedrive moves a lead's update time on every edit. A test edits state.lead directly, so
  // the fake moves the time itself when the lead no longer reads as it did.
  const content = () => { const { update_time, ...rest } = state.lead; return JSON.stringify(rest); };
  let served = content();
  let edits = 0;
  const touch = () => {
    if (content() !== served) state.lead.update_time = new Date(Date.parse('2026-11-11T09:00:00.000Z') + ++edits * 1000).toISOString();
    served = content();
  };
  const pd = {
    getLead: async (id, options) => { state.calls++; state.leadReads++; state.readOptions.push(options); await over.onLeadRead?.(state); touch(); return over.leadMissing ? null : { ...state.lead }; },
    getOrganization: async (id, options) => { state.calls++; state.readOptions.push(options); return state.orgs[id] || null; },
    findPersonsByEmail: async (email, options) => { state.calls++; state.readOptions.push(options); return state.persons.filter(p => p.email === email && !p.unindexed).map(p => ({ id: p.id, name: p.name, emails: [p.email], organization: p.org ? { id: p.org } : null })); },
    // The person record itself: its company now (liveOrg) and its primary address (primary) can
    // differ from what the search matched.
    getPerson: async (id, options) => {
      state.calls++; state.readOptions.push(options);
      const p = state.persons.find(x => x.id === id);
      if (!p) return null;
      const org = p.liveOrg ?? p.org;
      return { id: p.id, name: p.name, active_flag: p.inactive ? false : true, org_id: org ? { value: org, name: 'x' } : null,
        email: p.primary ? [{ value: p.email, primary: false }, { value: p.primary, primary: true }] : [{ value: p.email, primary: true }],
        last_outgoing_mail_time: p.lastOut || null, last_incoming_mail_time: p.lastIn || null,
        last_activity_date: p.lastActivity || null, next_activity_date: p.nextActivity || null, next_activity_id: p.nextActivityId ?? null,
        // Open and closed activities on the person, as Pipedrive counts them (`activities`: the closed ones).
        undone_activities_count: 'undone' in p ? p.undone : 0, done_activities_count: 'done' in p ? p.done : (p.activities || []).length };
    },
    // Calls, meetings and tasks on the lead, or on one person's own record: none unless a test logs some.
    listActivitiesPage: async (args, options) => {
      state.calls++; state.readOptions.push(options); state.activityReads.push(args);
      if (args.personId != null) {
        const p = state.persons.find(x => x.id === args.personId);
        return p && 'activityPage' in p ? p.activityPage
          : { data: p?.activities || [], pagination: { start: 0, limit: args.limit, more_items_in_collection: false } };
      }
      return 'activityPage' in over ? over.activityPage
        : { data: over.activities || [], pagination: { start: 0, limit: args.limit, more_items_in_collection: false, ...over.activityPagination } };
    },
    // A created contact can be read by its id at once. The search shows it too, unless a test
    // makes the search lag behind (over.searchLag), as Pipedrive's can.
    createPerson: async input => {
      state.calls++;
      const p = { id: 900 + state.created.length, name: input.name };
      state.created.push(input);
      state.persons.push({ ...p, email: input.email, org: input.orgId, unindexed: !!over.searchLag });
      return p;
    },
    swapLeadCompany: async (leadId, fields, options) => {
      state.calls++;
      state.patchSignals.push(options?.signal);
      await over.onPatch?.(state);
      if (over.hangPatch) {
        return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => {
          state.aborted++;
          if (over.hangPatch !== 'deaf') reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        }));
      }
      if (over.failPatch) throw Object.assign(new Error(`Pipedrive PATCH /leads/lead-1 → ${over.failPatch}: boom`), { status: over.failPatch });
      state.patches.push({ leadId, ...fields });
      state.lead.organization_id = fields.organizationId; state.lead.person_id = fields.personId; state.lead.update_time = '2026-11-11T12:00:00.000Z';
      if (fields.stage !== undefined) state.lead[STAGE] = fields.stage;
      served = content();
    },
    addNote: async note => { state.calls++; if (over.failNote) throw Object.assign(new Error('note refused'), { status: over.failNote }); state.notes.push(note); },
  };
  return { pd, state };
}

describe.skipIf(!db)('company swap against the journal and lead tables', () => {
  const q = (sql, params) => db.pool.query(sql, params);
  let seq = 0;
  // One held proposal row, as the n8n refresh writes it.
  const held = async ({ lead = 'lead-1', newOrg = NEW_ORG, seenOrg = OLD_ORG, seenPerson = OLD_PERSON, company = 'Hardy Construction, LLC',
    stage = 'LBA', email = EMAIL, name = 'Pat Hardy', hoursAgo = 2 } = {}) =>
    q(`INSERT INTO sdr_change_intents(action_id,company_id,entity,entity_id,expected_fields,proposed_fields,actor,reason,context_hash,created_at)
       VALUES($1,$2,'lead',$3,$4,$5,'{}',$6,'h',NOW()-make_interval(hours=>$7::int))`,
      [`n8n:${++seq}`, COMPANY, lead, { organization_id: seenOrg }, {
        proposed_fields: { organization_id: newOrg, ...(stage ? { [STAGE]: stage } : {}) },
        source_evidence: { company, stage },
        contact_candidate: { selected_person_id: seenPerson, candidate: email ? { email, name, phone: '555-0100' } : null },
      }, HELD_REASON, hoursAgo]);
  const leadState = (over = {}) => {
    const row = { pipedrive_lead_id: 'lead-1', pipedrive_org_id: String(OLD_ORG), pipedrive_person_id: String(OLD_PERSON), person_email: 'old@decker.test',
      project_stage: 'PB', trigger_type: 'PB', crm_status: 'active', crm_company_id: COMPANY, start_date: 'tomorrow', outreach_status: 'clear', ...over };
    const keys = Object.keys(row);
    return q(`INSERT INTO sdr_lead_state(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  };
  // The usual clean case: proposed 3 days ago and again 2 hours ago.
  const clean = async (over = {}) => { await leadState(over.state); await held({ hoursAgo: 72, ...over.held }); await held(over.held); };
  const candidates = () => selectSwapCandidates(db.pool, { companyId: COMPANY, graceDays: 30 });
  const swap = (row, pd, extra = {}) => swapOne(db.pool, row, { pd, companyId: COMPANY, graceDays: 30, customers: NO_CUSTOMERS, ...extra });
  const run = (options = {}) => runCompanySwap(db.pool, { companyId: COMPANY, loadCustomers: async () => NO_CUSTOMERS, ...options });
  const hold = (kind, scopeId, { lead = null, channel = 'email', status = 'active' } = {}) =>
    q('INSERT INTO sdr_outreach_controls(company_id,status,scope_kind,scope_id,lead_id,channel) VALUES($1,$2,$3,$4,$5,$6)', [COMPANY, status, kind, scopeId, lead, channel]);
  // An earlier swap attempt on the lead, with the receipts it left.
  const attempt = async (receipts, lead = 'lead-1') => {
    const id = `swap:${lead}:${++seq}`;
    await q(`INSERT INTO sdr_change_intents(action_id,company_id,entity,entity_id,expected_fields,proposed_fields,actor,reason,context_hash) VALUES($1,$2,'lead',$3,'{}','{}','{}',$4,'h')`, [id, COMPANY, lead, SWAP_REASON]);
    for (const status of receipts) await q('INSERT INTO sdr_change_receipts(action_id,status) VALUES($1,$2)', [id, status]);
  };
  const swapIntents = async () => (await q('SELECT 1 FROM sdr_change_intents WHERE reason=$1', [SWAP_REASON])).rowCount;
  // One message in our copy of the mailboxes, addresses as Gmail gives them ("Name <address>").
  const conv = ({ lead = null, person = null, from = 'Pro SWPPP <dc@proswppp.co>', to = [], cc = [], days = 10 } = {}) =>
    q('INSERT INTO sdr_conversation_messages VALUES($1,$2,$3,$4::jsonb,$5::jsonb,NOW()-make_interval(days=>$6::int))', [lead, person, from, JSON.stringify(to), JSON.stringify(cc), days]);
  // A .co send to an address on another lead, `days` ago (null: no send time on record).
  const sentElsewhere = async (address, days) => {
    const id = (await q("INSERT INTO sdr_drafts(pipedrive_lead_id,status,contact_email_snapshot) VALUES('lead-2','sent',$1) RETURNING id", [address])).rows[0].id;
    await q("INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id,sent_at) VALUES('s2',$1,'lead-2',NOW()-make_interval(days=>$2::int))", [id, days]);
  };
  const review = lead => q(`INSERT INTO sdr_change_intents(action_id,company_id,entity,entity_id,expected_fields,proposed_fields,actor,reason,context_hash)
    VALUES('review:1',$1,'outreach_review',$2,'{}','{}','{}','Outreach review','h')`, [COMPANY, lead]);
  const receipts = async () => (await q('SELECT status FROM sdr_change_receipts ORDER BY id')).rows.map(r => r.status);
  // The holds the swap places on a lead whose write it could not confirm.
  const swapHolds = async () => (await q(`SELECT lead_id, scope_kind, scope_id, channel, status, version, owner_id, actor->>'accountId' AS by,
      (SELECT array_agg(d.decision ORDER BY d.version) FROM sdr_outreach_control_decisions d WHERE d.control_id = c.id) AS decisions
    FROM sdr_outreach_controls c WHERE reason = $1 ORDER BY created_at`, [UNKNOWN_OUTCOME_HOLD])).rows;
  const ONE_HOLD = [{ lead_id: 'lead-1', scope_kind: 'lead', scope_id: 'lead-1', channel: null, status: 'active', version: 1, owner_id: 'company-swap',
    by: 'company-swap', decisions: ['hold'] }];

  beforeAll(async () => {
    await db.setup();
    // Same columns as migrations/2026-10-07-sdr-manual-protection.sql, without the append-only
    // triggers so each test can start from empty tables.
    await q(`CREATE TABLE sdr_change_intents(action_id text PRIMARY KEY,company_id text NOT NULL,entity text NOT NULL,entity_id text NOT NULL,
        expected_fields jsonb NOT NULL,proposed_fields jsonb NOT NULL,actor jsonb NOT NULL,reason text NOT NULL,context_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE sdr_change_receipts(id bigserial PRIMARY KEY,action_id text NOT NULL REFERENCES sdr_change_intents(action_id),status text NOT NULL,
        provider_receipt jsonb,observed_fields jsonb,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_org_id text,pipedrive_person_id text,person_name text,person_email text,
        project_stage text,trigger_type text,trigger_override text,sequence_started text,lead_origin text,lead_title text,crm_status text,crm_company_id text,
        start_date date,outreach_status text,last_outgoing_mail_time timestamptz,last_activity_date date,crm_source_updated_at timestamptz,crm_source_read_started_at timestamptz,
        crm_person_source_updated_at timestamptz,crm_person_source_read_started_at timestamptz,safety_context jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,status text,contact_email_snapshot text);
      CREATE TABLE sdr_sends(id text,draft_id uuid,pipedrive_lead_id text,sent_at timestamptz);
      CREATE TABLE sdr_reply_messages(provider_message_id text,pipedrive_lead_id text,from_email text,received_at timestamptz);
      CREATE TABLE sdr_inbox_reply_log(gmail_message_id text,pipedrive_lead_id text,from_addr text,created_at timestamptz);
      CREATE TABLE sdr_conversation_messages(pipedrive_lead_id text,person_id text,from_address text,to_addresses jsonb,cc_addresses jsonb,occurred_at timestamptz);
      CREATE TABLE sdr_followup_drafts(company_id text,lead_id text);
      CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz);
      CREATE TABLE sdr_outreach_controls(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text,status text NOT NULL DEFAULT 'active',scope_kind text,
        scope_id text,lead_id text,channel text,reason text,context_hash text,actor jsonb,owner_id text,version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE sdr_outreach_control_decisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),control_id uuid NOT NULL REFERENCES sdr_outreach_controls(id),
        version integer NOT NULL,decision text NOT NULL,evidence text NOT NULL,context_hash text NOT NULL,actor jsonb NOT NULL,UNIQUE(control_id,version));
      CREATE TABLE sdr_message_facts(prospect_email text,pipedrive_lead_id text,occurred_at timestamptz);
      CREATE TABLE sdr_settings(id int,start_date_grace_days int);INSERT INTO sdr_settings VALUES(1,30)`);
  });
  afterAll(async () => await db.close());
  beforeEach(async () => {
    await q('TRUNCATE sdr_change_receipts,sdr_change_intents,sdr_lead_state,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_message_facts,sdr_reply_messages,sdr_inbox_reply_log,sdr_conversation_messages,sdr_followup_drafts');
  });

  it('selects an untouched lead with a stable held company change', async () => {
    await clean();
    const rows = await candidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lead_id: 'lead-1', new_org: String(NEW_ORG), new_stage: 'LBA', seen_org: String(OLD_ORG), seen_person: String(OLD_PERSON),
      cmd_company: 'Hardy Construction, LLC', cand_email: EMAIL, cand_name: 'Pat Hardy', cur_email: 'old@decker.test' });
  });

  // Everything that takes a lead out of the selection. The same list is replayed further down
  // as "appeared after selection", against the recheck made under the lead lock.
  const excluded = {
    'a .co send on the lead': () => q("INSERT INTO sdr_sends(id,pipedrive_lead_id) VALUES('s','lead-1')"),
    'any draft on the lead, a rejected one included': () => q("INSERT INTO sdr_drafts(pipedrive_lead_id,status) VALUES('lead-1','rejected')"),
    'a hand email on the lead in the last 60 days': () => q("INSERT INTO sdr_outreach_log VALUES('lead-1','pipedrive',NOW()-INTERVAL '20 days')"),
    'an active hold on the lead': () => hold('lead', 'lead-1', { lead: 'lead-1' }),
    'an active hold on the lead with no channel named': () => hold('lead', 'lead-1', { channel: null }),
    'a hold of another kind tied to the lead': () => hold('service', 'svc-1', { lead: 'lead-1' }),
    'a hold on the new address': () => hold('recipient', ' PHardy@hardyconstruction.test'),
    'a hold on the address the lead has now': () => hold('recipient', 'old@decker.test'),
    'a hold on the whole email channel': () => hold('channel', 'email'),
    'a new contact .co has already emailed': () => q("INSERT INTO sdr_message_facts VALUES(' PHARDY@hardyconstruction.test')"),
    'staff mail to the contact the lead has now, as the sync read it on the person': () =>
      q("UPDATE sdr_lead_state SET last_outgoing_mail_time = NOW() - INTERVAL '1 day', outreach_status = 'contacted_recent' WHERE pipedrive_lead_id = 'lead-1'"),
    'staff mail to the contact the lead has now 59 days ago': () =>
      q("UPDATE sdr_lead_state SET last_outgoing_mail_time = NOW() - INTERVAL '59 days' WHERE pipedrive_lead_id = 'lead-1'"),
    'a call closed yesterday with the contact the lead has now, as the sync read it on the person': () =>
      q("UPDATE sdr_lead_state SET last_activity_date = CURRENT_DATE - 1 WHERE pipedrive_lead_id = 'lead-1'"),
    'a call closed 59 days ago with the contact the lead has now': () =>
      q("UPDATE sdr_lead_state SET last_activity_date = CURRENT_DATE - 59 WHERE pipedrive_lead_id = 'lead-1'"),
    'a new contact staff emailed on another lead in 60 days': () => q(`INSERT INTO sdr_lead_state(pipedrive_lead_id,person_email,last_outgoing_mail_time) VALUES('lead-2',$1,NOW()-INTERVAL '5 days')`, [EMAIL]),
    'a new contact with a send on another lead': async () => {
      const id = (await q("INSERT INTO sdr_drafts(pipedrive_lead_id,status,contact_email_snapshot) VALUES('lead-2','sent',$1) RETURNING id", [EMAIL])).rows[0].id;
      await q("INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id) VALUES('s2',$1,'lead-2')", [id]);
    },
    // Mail on record in our own tables (review 2026-11-11, round 9): the selection read them
    // for the new contact only, and not at all for the lead or the contact it has now.
    'a .co message on record for the lead, however old': () => q("INSERT INTO sdr_message_facts VALUES('someone@else.test','lead-1',NOW()-INTERVAL '300 days')"),
    'a .co message to the contact the lead has now in 60 days, on another lead': () => q("INSERT INTO sdr_message_facts VALUES(' OLD@decker.test','lead-2',NOW()-INTERVAL '10 days')"),
    'a .co message to the contact the lead has now with no date': () => q("INSERT INTO sdr_message_facts VALUES('old@decker.test','lead-2',NULL)"),
    'a reply on record for the lead, however old': () => q("INSERT INTO sdr_reply_messages VALUES('r1','lead-1','someone@else.test',NOW()-INTERVAL '300 days')"),
    'a reply from the new contact on another lead, however old': () => q("INSERT INTO sdr_reply_messages VALUES('r1','lead-2',' PHARDY@hardyconstruction.test',NOW()-INTERVAL '300 days')"),
    'a reply from the contact the lead has now in 60 days, on another lead': () => q("INSERT INTO sdr_reply_messages VALUES('r1','lead-2','Old@decker.test',NOW()-INTERVAL '10 days')"),
    'an inbox reply logged on the lead, however old': () => q("INSERT INTO sdr_inbox_reply_log VALUES('g1','lead-1','[auto-reply] someone@else.test',NOW()-INTERVAL '300 days')"),
    'an inbox reply from the new contact, however old': () => q("INSERT INTO sdr_inbox_reply_log VALUES('g1',NULL,'Pat Hardy <PHardy@hardyconstruction.test>',NOW()-INTERVAL '300 days')"),
    'an inbox reply from the contact the lead has now in 60 days': () => q("INSERT INTO sdr_inbox_reply_log VALUES('g1',NULL,'old@decker.test',NOW()-INTERVAL '10 days')"),
    'mail on the lead in our copy of the mailboxes in 60 days': () => conv({ lead: 'lead-1', to: ['Someone Else <someone@else.test>'] }),
    'mail to the contact the lead has now in our copy of the mailboxes, tied to no lead': () => conv({ to: ['Dale Decker <Old@Decker.test>'] }),
    'mail copied to the contact the lead has now': () => conv({ to: ['someone@else.test'], cc: ['old@decker.test'] }),
    'mail from the contact the lead has now': () => conv({ from: 'Dale Decker <old@decker.test>', to: ['dc@proswppp.co'] }),
    'mail to the new contact in our copy of the mailboxes': () => conv({ to: [`Pat Hardy <${EMAIL}>`] }),
    "mail tied to the person record of the contact the lead has now": () => conv({ person: String(OLD_PERSON), to: ['other@decker.test'] }),
    'mail in our copy of the mailboxes with no date': () => q(`INSERT INTO sdr_conversation_messages VALUES('lead-1',NULL,'dc@proswppp.co','[]','[]',NULL)`),
    'a .co send to the contact the lead has now on another lead in 60 days': () => sentElsewhere(' Old@decker.test', 10),
    'a .co send to the contact the lead has now on another lead with no send time': () => sentElsewhere('old@decker.test', null),
    // Staff work that leaves no mail behind.
    'a follow-up draft staff saved on the lead': () => q("INSERT INTO sdr_followup_drafts VALUES($1,'lead-1')", [COMPANY]),
    'an outreach review staff saved on the lead': () => q(`UPDATE sdr_lead_state SET safety_context = '{"projectRole":"gc","cadence":"standard"}' WHERE pipedrive_lead_id = 'lead-1'`),
    'an outreach review of the lead in the journal': () => review('lead-1'),
    'CMD naming a second company inside 14 days': () => held({ company: 'Other Builders Inc', newOrg: 99, hoursAgo: 200 }),
    'a staff trigger override': () => q("UPDATE sdr_lead_state SET trigger_override='PB' WHERE pipedrive_lead_id='lead-1'"),
    'an earlier swap that went through': () => attempt(['confirmed']),
    'an earlier swap whose outcome is not known': () => attempt(['unresolved']),
    'an earlier swap with no receipt at all': () => attempt([]),
    'an earlier swap that stood down for a staff edit': () => attempt(['superseded']),
    'an earlier swap with a failed and an unresolved receipt': () => attempt(['failed', 'unresolved']),
    'three refused swaps already': async () => { await attempt(['failed']); await attempt(['failed']); await attempt(['failed']); },
  };
  for (const [name, arrange] of Object.entries(excluded)) {
    it(`leaves out a lead with ${name}`, async () => { await clean(); await arrange(); expect(await candidates()).toHaveLength(0); });
    it(`stands down under the lock when ${name} appears after selection`, async () => {
      await clean();
      const { pd, state } = fakePipedrive();
      const [row] = await candidates();
      await arrange();
      const before = await swapIntents();
      expect(await swap(row, pd)).toEqual({ action: 'skip', reason: 'no_longer_eligible' });
      expect(state.calls).toBe(0);
      expect(await swapIntents()).toBe(before);
    });
  }
  // Review 2026-11-11 (round 10): an address with a quoted local part. Printed as JSON the
  // recipient list escapes the quotes, and the address was then not found in it.
  const QUOTED = '"dale"@decker.test';
  const QUOTED_NEW = '"pat"@hardyconstruction.test';
  it.each([
    ['sent to the contact the lead has now', { state: { person_email: QUOTED } }, { to: [`Dale <${QUOTED}>`] }],
    ['copied to the contact the lead has now', { state: { person_email: QUOTED } }, { to: ['someone@else.test'], cc: [`Dale <${QUOTED}>`] }],
    ['sent to the new contact', { held: { email: QUOTED_NEW } }, { to: [`Pat Hardy <${QUOTED_NEW}>`] }],
    ['copied to the new contact', { held: { email: QUOTED_NEW } }, { to: ['someone@else.test'], cc: [QUOTED_NEW.toUpperCase()] }],
  ])('leaves out a lead with mail %s at a quoted address', async (_what, setup, message) => {
    await clean(setup);
    const [row] = await candidates();
    expect(row).toBeTruthy();
    await conv(message);
    expect(await candidates()).toHaveLength(0);
    const { pd, state } = fakePipedrive();
    expect(await swap(row, pd)).toEqual({ action: 'skip', reason: 'no_longer_eligible' });
    expect(state.calls).toBe(0);
  });
  it('reads a recipient list stored as one text value, quoted address included', async () => {
    await clean({ state: { person_email: QUOTED } });
    expect(await candidates()).toHaveLength(1);
    await q('INSERT INTO sdr_conversation_messages VALUES(NULL,NULL,$1,$2::jsonb,$3::jsonb,NOW())', ['dc@proswppp.co', JSON.stringify(`Dale <${QUOTED}>`), 'null']);
    expect(await candidates()).toHaveLength(0);
  });
  it('still selects the lead when the mail went to somebody else at a quoted address', async () => {
    await clean({ state: { person_email: QUOTED } });
    await conv({ to: ['Erin <"erin"@decker.test>'], cc: ['"sam"@else.test'] });
    expect(await candidates()).toHaveLength(1);
  });
  const stillIn = {
    'a hold on another channel': () => hold('channel', 'linkedin', { channel: 'linkedin' }),
    'a released hold': () => hold('lead', 'lead-1', { lead: 'lead-1', status: 'released' }),
    "a hold on someone else's address": () => hold('recipient', 'someone@else.test'),
    'a hold tied to another lead': () => hold('recipient', EMAIL, { lead: 'lead-9' }),
    'one or two refused swaps': async () => { await attempt(['failed']); await attempt(['failed']); },
    'staff mail to the contact the lead has now 61 days ago': () =>
      q("UPDATE sdr_lead_state SET last_outgoing_mail_time = NOW() - INTERVAL '61 days', outreach_status = 'contacted_stale' WHERE pipedrive_lead_id = 'lead-1'"),
    'a call closed 61 days ago with the contact the lead has now': () =>
      q("UPDATE sdr_lead_state SET last_activity_date = CURRENT_DATE - 61 WHERE pipedrive_lead_id = 'lead-1'"),
    'a .co message to the contact the lead has now 61 days ago, on another lead': () => q("INSERT INTO sdr_message_facts VALUES('old@decker.test','lead-2',NOW()-INTERVAL '61 days')"),
    'a reply from the contact the lead has now 61 days ago, on another lead': () => q("INSERT INTO sdr_reply_messages VALUES('r1','lead-2','old@decker.test',NOW()-INTERVAL '61 days')"),
    'an inbox reply from the contact the lead has now 61 days ago': () => q("INSERT INTO sdr_inbox_reply_log VALUES('g1',NULL,'old@decker.test',NOW()-INTERVAL '61 days')"),
    'mail on the lead in our copy of the mailboxes 61 days ago': () => conv({ lead: 'lead-1', to: ['someone@else.test'], days: 61 }),
    'mail to both contacts in our copy of the mailboxes 61 days ago': () => conv({ person: String(OLD_PERSON), to: ['old@decker.test', EMAIL], days: 61 }),
    'mail between other people on another lead': () => conv({ lead: 'lead-2', person: '99', from: 'someone@else.test', to: ['dc@proswppp.co'], cc: ['third@else.test'] }),
    'a .co send to the contact the lead has now on another lead 61 days ago': () => sentElsewhere('old@decker.test', 61),
    'a follow-up draft saved on another lead': () => q("INSERT INTO sdr_followup_drafts VALUES($1,'lead-2')", [COMPANY]),
    'a follow-up draft another company saved': () => q("INSERT INTO sdr_followup_drafts VALUES('999','lead-1')"),
    'an outreach review of another lead in the journal': () => review('lead-2'),
  };
  for (const [name, arrange] of Object.entries(stillIn)) {
    it(`keeps a lead with ${name}`, async () => { await clean(); await arrange(); expect(await candidates()).toHaveLength(1); });
  }
  // A lead with no contact address: rows with no address on record are not mail with "nobody".
  it('does not match rows that carry no address to a lead whose contact has no address', async () => {
    await clean({ state: { person_email: null } });
    await q("INSERT INTO sdr_message_facts VALUES('','lead-2',NOW()),(NULL,'lead-2',NOW())");
    await q("INSERT INTO sdr_reply_messages VALUES('r1','lead-2','',NOW()),('r2','lead-2',NULL,NOW())");
    await q("INSERT INTO sdr_inbox_reply_log VALUES('g1',NULL,'',NOW()),('g2',NULL,NULL,NOW())");
    await conv({ from: '', to: [], days: 1 });
    await q(`INSERT INTO sdr_conversation_messages VALUES(NULL,NULL,NULL,NULL,NULL,NOW())`);
    await sentElsewhere('', 1);
    expect(await candidates()).toHaveLength(1);
  });
  const excludedState = {
    'a company staff changed after the proposal': { pipedrive_org_id: '55' },
    'a contact staff changed after the proposal': { pipedrive_person_id: '56' },
    'a staff trigger override': { trigger_override: 'PB' },
    'a Sequence_Started marker': { sequence_started: 'Apollo:PB 2026-11-01' },
    'a Bid Invite origin': { lead_origin: 'Bid Invite - Estimator' },
    'a start date outside the window': { start_date: '2026-01-01' },
    'an archived record': { crm_status: 'archived' },
  };
  for (const [name, state] of Object.entries(excludedState)) {
    it(`leaves out a lead with ${name}`, async () => { await clean({ state }); expect(await candidates()).toHaveLength(0); });
  }
  it('leaves out a change CMD first showed less than a day ago', async () => {
    await leadState(); await held({ hoursAgo: 5 }); await held({ hoursAgo: 1 });
    expect(await candidates()).toHaveLength(0);
  });
  it('leaves out a proposal the refresh no longer repeats', async () => {
    await leadState(); await held({ hoursAgo: 80 }); await held({ hoursAgo: 50 });
    expect(await candidates()).toHaveLength(0);
  });
  it('leaves out a lead with no scraped contact', async () => {
    await clean({ held: { email: null } });
    expect(await candidates()).toHaveLength(0);
  });
  it('narrows to one lead for the recheck under the lock', async () => {
    await clean();
    await leadState({ pipedrive_lead_id: 'lead-2' });
    await held({ lead: 'lead-2', hoursAgo: 72, email: 'pat.hardy@hardyconstruction.test' }); await held({ lead: 'lead-2', email: 'pat.hardy@hardyconstruction.test' });
    expect(await candidates()).toHaveLength(2);
    const one = await selectSwapCandidates(db.pool, { companyId: COMPANY, graceDays: 30, leadId: 'lead-2' });
    expect(one.map(r => r.lead_id)).toEqual(['lead-2']);
  });

  it('applies the swap: one PATCH, a new contact, a note, a journal entry and fresh local state', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const [row] = await candidates();
    const result = await swap(row, pd);
    expect(result).toMatchObject({ action: 'applied', toCompany: 'Hardy Construction, LLC', stageFrom: 'PB', stageTo: 'LBA', personCreated: true });
    expect(result.note).toBeUndefined();
    // Every read asks the client not to wait out a rate limit.
    expect(state.readOptions.length).toBeGreaterThan(4);
    expect(state.readOptions.every(options => options?.failFast === true)).toBe(true);
    expect(state.created).toEqual([{ name: 'Pat Hardy', email: EMAIL, phone: '555-0100', orgId: NEW_ORG, ownerId: 7 }]);
    expect(state.patches).toEqual([{ leadId: 'lead-1', organizationId: NEW_ORG, personId: 900, stage: 'LBA' }]);
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].content).toBe("[Auto] Company updated from CMD: Decker Construction Services, Inc. to Hardy Construction, LLC. Project Stage: PB to LBA. Contact set to Pat Hardy (phardy@hardyconstruction.test), the contact CMD lists for this company. Role not confirmed.");
    const local = (await q("SELECT * FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0];
    expect(local).toMatchObject({ pipedrive_org_id: String(NEW_ORG), pipedrive_person_id: '900', person_email: EMAIL, project_stage: 'LBA', trigger_type: 'LBA', outreach_status: 'clear' });
    const journal = (await q(`SELECT i.action_id, r.status, r.observed_fields, r.provider_receipt FROM sdr_change_intents i JOIN sdr_change_receipts r USING(action_id) WHERE i.reason=$1`, [SWAP_REASON])).rows;
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ status: 'confirmed', observed_fields: { organization_id: NEW_ORG, person_id: '900', [STAGE]: 'LBA' }, provider_receipt: { person_id: 900, person_created: true } });
    // Applied once: the same held proposal is never picked up again.
    await held({ hoursAgo: 0 });
    expect(await candidates()).toHaveLength(0);
  });

  it('moves the local source stamps to the confirming read, so an older sync pass cannot put the old contact back', async () => {
    const syncStarted = new Date(Date.now() - 1000);
    await clean({ state: { crm_source_updated_at: '2026-11-10T08:00:00Z', crm_source_read_started_at: new Date(Date.now() - 3600e3), crm_person_source_updated_at: '2026-11-01T00:00:00Z', crm_person_source_read_started_at: new Date(Date.now() - 3600e3) } });
    const { pd } = fakePipedrive();
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    // The sync applies an observation only when its read started at or after these stamps.
    const local = (await q(`SELECT crm_source_updated_at, crm_person_source_updated_at, crm_source_read_started_at, crm_person_source_read_started_at,
        $1::timestamptz >= crm_source_read_started_at AS old_lead_read_wins, $1::timestamptz >= crm_person_source_read_started_at AS old_person_read_wins,
        NOW() >= crm_source_read_started_at AS next_sync_wins
      FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'`, [syncStarted])).rows[0];
    expect(local).toMatchObject({ old_lead_read_wins: false, old_person_read_wins: false, next_sync_wins: true, crm_person_source_updated_at: null });
    expect(local.crm_source_updated_at.toISOString()).toBe('2026-11-11T12:00:00.000Z');
    expect(+local.crm_person_source_read_started_at).toBe(+local.crm_source_read_started_at);
  });

  it('reuses the one person already holding the address at the new company', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, lastOut: '2026-01-05 10:00:00' }] });
    const result = await swap((await candidates())[0], pd);
    expect(result).toMatchObject({ action: 'applied', personId: 31, personCreated: false });
    expect(state.created).toHaveLength(0);
    expect((await q("SELECT outreach_status FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].outreach_status).toBe('contacted_stale');
  });

  const recently = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  // Pipedrive's UTC time format, `days` ago. A closed call from 300 days back unless told otherwise.
  const stamp = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const call = (over = {}) => ({ type: 'call', done: true, subject: 'Call', add_time: stamp(300), update_time: stamp(300),
    marked_as_done_time: stamp(300), due_date: day(-300), ...over });
  const liveSkips = {
    company_edited_since: { lead: { organization_id: 77 } },
    contact_edited_since: { lead: { person_id: 78 } },
    sequence_started: { lead: { [FIELD_KEYS.SEQ]: 'Apollo:PB 2026-11-10' } },
    // Our copy of the lead can be hours old: staff may have changed these two since the sync.
    bid_invite_lead: { lead: { [ORIGIN]: ' Bid Invite - Estimator' } },
    start_date_out_of_window: { lead: { [START]: day(-45) } },
    stage_not_forward: { lead: { [STAGE]: 'GC' } },
    lead_unavailable: { lead: { is_archived: true } },
    company_unavailable: { newOrg: { active_flag: false } },
    company_name_mismatch: { newOrg: { name: 'R.E. Hardy Construction' } },
    customer_company: { newOrg: { closed_deals_count: 2 } },
    open_deal_company: { newOrg: { open_deals_count: 1 } },
    contact_in_conversation: { persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, lastOut: recently }] },
    contact_on_other_record: { persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: 444 }] },
    contact_unavailable: { persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, inactive: true }] },
    // The search matched a secondary address: the sync and every send would use the primary one.
    contact_address_not_primary: { persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, primary: 'someone.else@hardyconstruction.test' }] },
    contact_name_mismatch: { persons: [{ id: 31, name: 'Lynnette Moss', email: EMAIL, org: NEW_ORG }] },
    // The contact the lead has now, read live: mail either way in 60 days, or no record to read.
    current_contact_in_conversation: { currentPerson: { lastOut: recently } },
    current_contact_unavailable: { currentPerson: null },
    // Calls, meetings and tasks: on the lead, on the contact it has now, on the contact it would get.
    lead_has_activity: { activities: [call({ marked_as_done_time: recently })] },
    current_contact_has_activity: { currentPerson: { lastActivity: day(-5) } },
    contact_has_activity: { persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, lastActivity: day(-5) }] },
    lead_activity_unavailable: { activityPagination: { more_items_in_collection: true, next_start: 100 } },
  };
  // Review 2026-11-11: staff completed a call about the project yesterday from the console, which
  // logs it on the lead alone. No mail, no draft, no hold: nothing else shows the lead was worked.
  it('leaves a lead alone when staff completed a call on it yesterday', async () => {
    await clean();
    const [row] = await candidates();
    const { pd, state } = fakePipedrive({ activities: [call({ add_time: stamp(1), update_time: stamp(1), marked_as_done_time: stamp(1), due_date: day(-1) })] });
    expect(await swap(row, pd)).toEqual({ action: 'skip', reason: 'lead_has_activity' });
    expect(await swap(row, pd, { dryRun: true })).toEqual({ action: 'skip', reason: 'lead_has_activity' });
    expect(await run({ pd })).toMatchObject({ candidates: 1, applied: 0, skipped: { lead_has_activity: 1 } });
    // Every user's activities on this lead, and the read does not wait out a rate limit.
    expect(state.activityReads[0]).toEqual({ leadId: 'lead-1', limit: 100 });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
    expect((await q("SELECT 1 FROM sdr_outreach_controls WHERE lead_id = 'lead-1'")).rowCount).toBe(0);
  });
  it.each([
    ['an open task from two years ago', { type: 'task', done: false, add_time: stamp(700), update_time: stamp(700), due_date: day(-690), marked_as_done_time: '' }],
    ['a call planned for next week', { done: false, add_time: stamp(90), update_time: stamp(90), due_date: day(7), marked_as_done_time: '' }],
    ['an old call somebody edited last week', { update_time: stamp(6) }],
    ['a call logged last week for a date long past', { add_time: stamp(6), update_time: stamp(200) }],
  ])('leaves a lead alone with %s on it', async (_what, over) => {
    await clean();
    const { pd, state } = fakePipedrive({ activities: [call(), call(over)] });
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'lead_has_activity' });
    expect(state.patches).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  // An entry that does not say plainly whether it is done is a list that was not read whole.
  // The lead is left alone either way; it is only not put down as staff work.
  it.each([
    ['an activity that does not say whether it is done', { done: undefined }],
    ['an activity marked done with a number', { done: 1 }],
    ['a closed call with no dates at all', { add_time: '', update_time: null, marked_as_done_time: '', due_date: null }],
    ['a closed call with a date that cannot be read', { marked_as_done_time: 'yesterday' }],
    // Review 2026-11-11 (round 14): closed today, but only the old due date came back.
    ['a closed task with only an old due date left on it', { type: 'task', add_time: undefined, update_time: undefined, marked_as_done_time: undefined, due_date: '2025-01-01' }],
  ])('leaves a lead alone with %s on it, as a list it could not read', async (_what, over) => {
    await clean();
    const { pd, state } = fakePipedrive({ activities: [call(), call(over)] });
    expect(await swap((await candidates())[0], pd)).toEqual(skipOf('lead_activity_unavailable'));
    expect(state.patches).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  it('swaps when every call and task on the lead was closed more than 60 days ago', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ activities: [call(), call({ type: 'task', due_date: null })],
      currentPerson: { lastActivity: day(-61) }, persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, lastActivity: day(-200) }] });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    expect(state.patches).toHaveLength(1);
  });
  it.each([
    ['the contact the lead has now', { currentPerson: { nextActivity: day(3) } }, 'current_contact_has_activity'],
    ['the contact the lead has now, long overdue', { currentPerson: { nextActivity: day(-400) } }, 'current_contact_has_activity'],
    ['the contact the lead would get', { persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, nextActivity: day(3) }] }, 'contact_has_activity'],
    ['the contact the lead has now, with a last activity date that cannot be read', { currentPerson: { lastActivity: 'soon' } }, 'current_contact_unavailable'],
  ])('leaves a lead alone when an activity is planned with %s', async (_who, over, reason) => {
    await clean();
    const { pd, state } = fakePipedrive(over);
    expect(await swap((await candidates())[0], pd)).toEqual(skipOf(reason));
    expect(state.patches).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  // Review 2026-11-11 (round 9): a task on the contact alone, with no due date, shows on the
  // person only as a count: no next date, no last date. A call closed yesterday with no due date
  // leaves the last date empty too, so closed activities are read from the person's own list.
  const NEW_PERSON = { id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG };
  const closedYesterday = call({ due_date: null, add_time: stamp(1), update_time: stamp(1), marked_as_done_time: stamp(1) });
  it.each([
    ['an open task with no due date on the contact the lead has now', { currentPerson: { undone: 1 } }, 'current_contact_has_activity'],
    ['an open task with no due date on the contact the lead would get', { persons: [{ ...NEW_PERSON, undone: 1 }] }, 'contact_has_activity'],
    ['a next activity with no date on the contact the lead has now', { currentPerson: { nextActivityId: 4218 } }, 'current_contact_has_activity'],
    ['a call with no due date closed yesterday with the contact the lead has now', { currentPerson: { activities: [call(), closedYesterday] } }, 'current_contact_has_activity'],
    ['a call with no due date closed yesterday with the contact the lead would get', { persons: [{ ...NEW_PERSON, activities: [closedYesterday] }] }, 'contact_has_activity'],
    ['a call due long ago and closed yesterday with the contact the lead has now',
      { currentPerson: { lastActivity: day(-200), activities: [call({ update_time: stamp(1), marked_as_done_time: stamp(1) })] } }, 'current_contact_has_activity'],
    ['no activity counts on the contact the lead has now', { currentPerson: { undone: undefined, done: undefined } }, 'current_contact_activity_unavailable'],
    ['activity counts that are not numbers on the contact the lead has now', { currentPerson: { undone: '0', done: null } }, 'current_contact_activity_unavailable'],
    ['no activity counts on the contact the lead would get', { persons: [{ ...NEW_PERSON, undone: undefined }] }, 'contact_activity_unavailable'],
    ['more closed activities on the contact than one page holds',
      { currentPerson: { done: 150, activityPage: { data: [call()], pagination: { more_items_in_collection: true, next_start: 100 } } } }, 'current_contact_activity_unavailable'],
    ['closed activities on the contact that do not come back as a list',
      { currentPerson: { done: 2, activityPage: { data: null, pagination: { more_items_in_collection: false } } } }, 'current_contact_activity_unavailable'],
    ['fewer activities in the list than the contact counts', { currentPerson: { done: 2, activities: [call()] } }, 'current_contact_activity_unavailable'],
    ['a list for the new contact with no word on more pages', { persons: [{ ...NEW_PERSON, done: 1, activityPage: { data: [call()], pagination: {} } }] }, 'contact_activity_unavailable'],
  ])('leaves a lead alone with %s', async (_what, over, reason) => {
    await clean();
    const [row] = await candidates();
    const { pd, state } = fakePipedrive(over);
    expect(await swap(row, pd)).toEqual(skipOf(reason));
    expect(await swap(row, pd, { dryRun: true })).toEqual({ action: 'skip', reason });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  it("swaps when everything closed with either contact is older than 60 days, read from each contact's own list", async () => {
    await clean();
    const { pd, state } = fakePipedrive({ currentPerson: { lastActivity: day(-200), activities: [call()] },
      persons: [{ ...NEW_PERSON, activities: [call(), call({ type: 'task', due_date: null })] }] });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 31 });
    // Once in each round of checks.
    const round = [{ personId: 31, limit: 100 }, { personId: OLD_PERSON, limit: 100 }, { leadId: 'lead-1', limit: 100 }];
    expect(state.activityReads).toEqual([...round, ...round]);
  });
  it('reads no activity list for a contact with no activities at all', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [NEW_PERSON] });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    expect(state.activityReads).toEqual([{ leadId: 'lead-1', limit: 100 }, { leadId: 'lead-1', limit: 100 }]);
  });
  it("stops the pass at a rate limit on a contact's activity read", async () => {
    await clean();
    const { pd, state } = fakePipedrive({ currentPerson: { activities: [call()] } });
    pd.listActivitiesPage = async () => { state.calls++; throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await run({ pd })).toMatchObject({ applied: 0, failed: 0, rateLimited: true });
    expect(state.patches).toHaveLength(0);
  });
  it.each([
    ['no page at all', undefined],
    ['a page that is not a list', { data: null, pagination: { more_items_in_collection: false } }],
    ['a list with no word on more pages', { data: [], pagination: {} }],
    ['a list with no pagination', { data: [] }],
    ['"no more pages" as text', { data: [], pagination: { more_items_in_collection: 'false' } }],
  ])('leaves a lead alone when the activity list comes back as %s', async (_what, activityPage) => {
    await clean();
    const { pd, state } = fakePipedrive({ activityPage });
    expect(await swap((await candidates())[0], pd)).toEqual(skipOf('lead_activity_unavailable'));
    expect(state.patches).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  it('writes nothing when the activities on the lead cannot be read', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    pd.listActivitiesPage = async () => { state.calls++; throw Object.assign(new Error('Pipedrive GET /activities → 500'), { status: 500 }); };
    await expect(swap((await candidates())[0], pd)).rejects.toThrow('/activities');
    expect(await run({ pd })).toMatchObject({ candidates: 1, applied: 0, failed: 1 });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  it('stops the pass at a rate limit on the activity read', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    pd.listActivitiesPage = async () => { state.calls++; throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await run({ pd })).toMatchObject({ applied: 0, failed: 0, rateLimited: true });
    expect(state.patches).toHaveLength(0);
  });
  it('skips without writing when the contact the lead has now wrote to us lately', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ currentPerson: { lastIn: recently } });
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'current_contact_in_conversation' });
    expect(state.patches).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  it('swaps when the last mail with the contact the lead has now is older than 60 days', async () => {
    await clean();
    const old = new Date(Date.now() - 61 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const { pd, state } = fakePipedrive({ currentPerson: { lastOut: old, lastIn: old } });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    expect(state.patches).toHaveLength(1);
  });
  // Review 2026-11-11: staff emailed the lead's contact about the project yesterday and Pipedrive
  // did not tie the thread to the lead. The sweep skips such a thread and the ledger is still
  // whole, so only the person's own mail times show it.
  it('leaves a lead alone when staff emailed its contact on a thread Pipedrive did not tie to the lead', async () => {
    await clean();
    const [row] = await candidates();
    expect(await q("SELECT 1 FROM sdr_outreach_log WHERE pipedrive_lead_id = 'lead-1'")).toMatchObject({ rowCount: 0 });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');
    // Our copy has not caught up: only Pipedrive's person record shows the mail.
    const live = fakePipedrive({ currentPerson: { lastOut: yesterday } });
    expect(await swap(row, live.pd)).toEqual({ action: 'skip', reason: 'current_contact_in_conversation' });
    expect(await swap(row, live.pd, { dryRun: true })).toEqual({ action: 'skip', reason: 'current_contact_in_conversation' });
    // Once the sync has read the person, the lead is not a candidate at all.
    await q("UPDATE sdr_lead_state SET last_outgoing_mail_time = $1::timestamp, outreach_status = 'contacted_recent' WHERE pipedrive_lead_id = 'lead-1'", [yesterday]);
    expect(await candidates()).toHaveLength(0);
    const stale = fakePipedrive();
    expect(await swap(row, stale.pd)).toEqual({ action: 'skip', reason: 'no_longer_eligible' });
    for (const { state } of [live, stale]) { expect(state.patches).toHaveLength(0); expect(state.created).toHaveLength(0); }
    expect(await swapIntents()).toBe(0);
    expect((await q("SELECT pipedrive_org_id, outreach_status FROM sdr_lead_state WHERE pipedrive_lead_id = 'lead-1'")).rows[0])
      .toEqual({ pipedrive_org_id: String(OLD_ORG), outreach_status: 'contacted_recent' });
  });
  it('writes nothing when the contact the lead has now cannot be read', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const getPerson = pd.getPerson;
    pd.getPerson = async (id, options) => { if (id === OLD_PERSON) { state.calls++; throw Object.assign(new Error('Pipedrive GET /persons/11 → 500'), { status: 500 }); } return getPerson(id, options); };
    await expect(swap((await candidates())[0], pd)).rejects.toThrow('/persons/11');
    expect(await run({ pd })).toMatchObject({ candidates: 1, applied: 0, failed: 1 });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  for (const [reason, over] of Object.entries(liveSkips)) {
    it(`skips without writing when Pipedrive shows ${reason}`, async () => {
      await clean();
      const { pd, state } = fakePipedrive(over);
      expect(await swap((await candidates())[0], pd)).toEqual(skipOf(reason));
      expect(await swap((await candidates())[0], pd, { dryRun: true })).toEqual({ action: 'skip', reason });
      expect(state.patches).toHaveLength(0);
      expect(state.created).toHaveLength(0);
      expect(await swapIntents()).toBe(0);
    });
  }
  it('reads the start date window from the live lead: none or unreadable is out, inside the grace days is in', async () => {
    await clean();
    const [row] = await candidates();
    for (const start of [null, '', 'soon', undefined]) {
      const { pd } = fakePipedrive({ lead: { [START]: start } });
      expect(await swap(row, pd, { dryRun: true }), String(start)).toEqual({ action: 'skip', reason: 'start_date_out_of_window' });
    }
    for (const start of [day(-29), day(0), `${day(40)} 00:00:00`]) {
      const { pd } = fakePipedrive({ lead: { [START]: start } });
      expect(await swap(row, pd, { dryRun: true }), start).toMatchObject({ action: 'would_apply' });
    }
    // No grace configured: a start date in the past is out.
    expect(await swap(row, fakePipedrive({ lead: { [START]: day(-2) } }).pd, { dryRun: true, graceDays: 0 })).toEqual({ action: 'skip', reason: 'start_date_out_of_window' });
  });
  it('skips a person the search still lists at the new company after the record moved elsewhere', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ id: 31, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG, liveOrg: 444 }] });
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'contact_on_other_record' });
    expect(state.patches).toHaveLength(0);
  });
  it('skips a change that is the same company under another record, a free-mail contact, a nameless company or a broken address', async () => {
    await clean({ held: { company: 'Decker Construction Services' } });
    const twin = fakePipedrive({ newOrg: { name: 'Decker Construction Services LLC' } });
    expect(await swap((await candidates())[0], twin.pd)).toEqual({ action: 'skip', reason: 'same_company' });
    const { pd, state } = fakePipedrive();
    const [row] = await candidates();
    const dry = over => swap({ ...row, cmd_company: 'Hardy Construction', ...over }, pd, { dryRun: true });
    expect(await dry({ cand_email: 'hardy@gmail.com' })).toEqual({ action: 'skip', reason: 'free_mail_contact' });
    for (const address of ['edwin.robles@delaware.gov', 'mmoreno@ci.pleasant-hill.ca.us', 'pat@usace.army.mil']) {
      expect(await dry({ cand_email: address }), address).toEqual({ action: 'skip', reason: 'public_agency_contact' });
    }
    expect(await dry({ cmd_company: 'LLC' })).toEqual({ action: 'skip', reason: 'company_unresolved' });
    expect(await dry({ new_org: 'abc' })).toEqual({ action: 'skip', reason: 'company_unresolved' });
    expect(await dry({ cand_email: 'pat@@hardyconstruction.test' })).toEqual({ action: 'skip', reason: 'no_contact' });
    expect(state.calls).toBe(0);
  });

  const strangers = { "another person's mailbox": { name: 'Elvira Bolanos', email: 'david@hardyconstruction.test' },
    'a shared mailbox': { name: 'Pat Hardy', email: 'info@hardyconstruction.test' },
    'a shared mailbox with a piece of the name inside it': { name: 'Tim Jones', email: 'estimating@hardyconstruction.test' },
    'the company name as the contact': { name: 'Hardy Construction, LLC', email: 'hardy@hardyconstruction.test' },
    'part of the company name as the contact': { name: 'Hardy', email: 'hardy@hardyconstruction.test' } };
  for (const [what, contact] of Object.entries(strangers)) {
    it(`skips a contact whose name does not fit the mailbox: ${what}`, async () => {
      await clean({ held: contact });
      const { pd, state } = fakePipedrive();
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'contact_name_mismatch' });
      expect(state.patches).toHaveLength(0);
      expect(state.created).toHaveLength(0);
    });
  }
  it('skips an existing Pipedrive contact that is the company, whatever CMD called the person', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ id: 31, name: 'Hardy Construction, LLC - Estimator', email: EMAIL, org: NEW_ORG }] });
    expect(await swap((await candidates())[0], pd, { dryRun: true })).toEqual({ action: 'skip', reason: 'contact_name_mismatch' });
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'contact_name_mismatch' });
    expect(state.patches).toHaveLength(0);
  });

  it('a dry run reads only', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const stats = await run({ pd, dryRun: true });
    expect(stats).toMatchObject({ candidates: 1, wouldApply: 1, applied: 0 });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });

  // Pipedrive has no conditional write. A staff edit that lands after the checks is caught by
  // the second round of checks (lead read 2) or by the read made right before the PATCH (3).
  const staffEdits = {
    'moves the lead to another company': lead => { lead.organization_id = 77; },
    'picks another contact': lead => { lead.person_id = 78; },
    'moves the stage on to GC': lead => { lead[STAGE] = 'GC'; },
    'starts a sequence': lead => { lead[FIELD_KEYS.SEQ] = 'Apollo:PB 2026-11-11'; },
    'archives the lead': lead => { lead.is_archived = true; },
    'marks it a Bid Invite lead': lead => { lead[ORIGIN] = 'Bid Invite - Estimator'; },
    'moves the start date': lead => { lead[START] = day(20); },
    'clears the start date': lead => { lead[START] = null; },
    'clears the stage, which takes the field off the lead': lead => { delete lead[STAGE]; },
    // Review 2026-11-11 (round 15): the owner was not compared. Any edit moves the update time.
    'hands the lead to another owner': lead => { lead.owner_id = 8; },
    'renames the lead': lead => { lead.title = 'Hardy Road Widening, Phase 2'; },
    'changes a field the checks do not read': lead => { lead.value = { amount: 5000, currency: 'USD' }; },
  };
  for (const [what, edit] of Object.entries(staffEdits)) for (const read of [2, 3]) {
    it(`stands down when staff ${what} between the checks and the write (lead read ${read})`, async () => {
      await clean();
      const { pd, state } = fakePipedrive({ onLeadRead: s => { if (s.leadReads === read) edit(s.lead); } });
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
      expect(state.patches).toHaveLength(0);
      expect(state.notes).toHaveLength(0);
      expect(await receipts()).toEqual(['superseded']);
      expect((await q("SELECT pipedrive_org_id, project_stage FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0]).toEqual({ pipedrive_org_id: String(OLD_ORG), project_stage: 'PB' });
      // A person is working the lead: it is not tried again on the next proposal.
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(0);
    });
  }

  // Review 2026-11-11 (round 10): the contacts, the company and the activity lists were read
  // once, before the new contact is created, and not again. Every live check now runs a second
  // time right before the write. Each change here lands after the first round has passed.
  const currentContact = s => s.persons.find(p => p.id === OLD_PERSON);
  const newContact = s => s.persons.find(p => p.id === 31);
  const lateChanges = {
    'add an open task with no due date on the contact the lead has now': [s => { currentContact(s).undone = 1; }, 'current_contact_has_activity'],
    'close a call with the contact the lead has now': [s => { currentContact(s).activities = [closedYesterday]; }, 'current_contact_has_activity'],
    'email the contact the lead has now': [s => { currentContact(s).lastOut = recently; }, 'current_contact_in_conversation'],
    'add an open task on the contact the lead would get': [s => { newContact(s).undone = 1; }, 'contact_has_activity'],
    'email the contact the lead would get': [s => { newContact(s).lastIn = recently; }, 'contact_in_conversation'],
    'move the contact the lead would get to another company': [s => { newContact(s).org = 77; }, 'contact_on_other_record'],
    'put the Customer label on the new company': [s => { s.orgs[NEW_ORG].label = 1; }, 'customer_company'],
    'close a deal with the new company': [s => { s.orgs[NEW_ORG].closed_deals_count = 1; }, 'customer_company'],
    'open a deal with the new company': [s => { s.orgs[NEW_ORG].open_deals_count = 1; }, 'open_deal_company'],
    'rename the new company': [s => { s.orgs[NEW_ORG].name = 'R.E. Hardy Construction'; }, 'company_name_mismatch'],
    'deactivate the new company': [s => { s.orgs[NEW_ORG].active_flag = false; }, 'company_unavailable'],
    'deactivate the contact the lead would get': [s => { newContact(s).inactive = true; }, 'contact_unavailable'],
    'log a call on the lead': [(s, over) => { over.activities = [closedYesterday]; }, 'lead_has_activity'],
  };
  for (const [what, [change, seen]] of Object.entries(lateChanges)) {
    it(`stands down when staff ${what} after the first checks`, async () => {
      await clean();
      const over = { persons: [{ ...NEW_PERSON }], onLeadRead: s => { if (s.leadReads === 2) change(s, over); } };
      const { pd, state } = fakePipedrive(over);
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
      expect(state.patches).toHaveLength(0);
      expect(state.notes).toHaveLength(0);
      expect((await q('SELECT status, provider_receipt FROM sdr_change_receipts')).rows).toMatchObject([{ status: 'superseded', provider_receipt: { changed: seen } }]);
      expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
      expect((await q("SELECT pipedrive_org_id, project_stage FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0]).toEqual({ pipedrive_org_id: String(OLD_ORG), project_stage: 'PB' });
      // A person is working the lead: it is not tried again on the next proposal.
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(0);
    });
  }
  it('stands down when staff add a task on the current contact while the new contact is being created', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const createPerson = pd.createPerson;
    pd.createPerson = async input => { currentContact(state).undone = 1; return createPerson(input); };
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
    expect(state.created).toHaveLength(1);
    expect(state.patches).toHaveLength(0);
    expect((await q('SELECT status, provider_receipt FROM sdr_change_receipts')).rows)
      .toMatchObject([{ status: 'superseded', provider_receipt: { person_id: 900, person_created: true, changed: 'current_contact_has_activity' } }]);
  });
  it('stands down when another record turns up holding the address after the contact was created', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const createPerson = pd.createPerson;
    // Somebody added the same person by hand: the search now shows that record, not ours.
    pd.createPerson = async input => { state.persons.push({ ...NEW_PERSON }); return createPerson(input); };
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
    expect(state.patches).toHaveLength(0);
    expect((await q('SELECT status, provider_receipt FROM sdr_change_receipts')).rows).toMatchObject([{ status: 'superseded', provider_receipt: { changed: 'contact_on_other_record' } }]);
  });
  // Review 2026-11-11 (round 11): the second round reads the contact by its id. The search can
  // lag behind a contact created a moment ago, and a contact the search does not show was
  // then never checked at all.
  const personReads = pd => {
    const ids = [];
    const { getPerson } = pd;
    pd.getPerson = async (id, options) => { ids.push(id); return getPerson(id, options); };
    return ids;
  };
  it.each([[false], [true]])('reads the contact it just created by its id before the write (search lagging: %s)', async searchLag => {
    await clean();
    const { pd, state } = fakePipedrive({ searchLag });
    const ids = personReads(pd);
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 900, personCreated: true });
    expect(ids).toEqual([OLD_PERSON, 900, OLD_PERSON]);
    expect(state.created).toHaveLength(1);
    expect(state.patches).toEqual([{ leadId: 'lead-1', organizationId: NEW_ORG, personId: 900, stage: 'LBA' }]);
  });
  const onCreated = {
    'an open task': [p => { p.undone = 1; }, 'contact_has_activity'],
    'a call closed yesterday': [p => { p.activities = [closedYesterday]; }, 'contact_has_activity'],
    'mail': [p => { p.lastOut = recently; }, 'contact_in_conversation'],
    'another company': [p => { p.org = 77; }, 'contact_on_other_record'],
    'another primary address': [p => { p.primary = 'pat@elsewhere.test'; }, 'contact_address_not_primary'],
  };
  for (const [what, [change, seen]] of Object.entries(onCreated)) {
    it(`stands down when the contact it just created has ${what}, though the search does not show the contact yet`, async () => {
      await clean();
      const { pd, state } = fakePipedrive({ searchLag: true });
      const createPerson = pd.createPerson;
      pd.createPerson = async input => { const made = await createPerson(input); change(state.persons.find(p => p.id === made.id)); return made; };
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
      expect(state.created).toHaveLength(1);
      expect(state.patches).toHaveLength(0);
      expect((await q('SELECT status, provider_receipt FROM sdr_change_receipts')).rows)
        .toMatchObject([{ status: 'superseded', provider_receipt: { person_id: 900, person_created: true, changed: seen } }]);
    });
  }
  it('goes ahead when the second search no longer shows the contact it found but the record is unchanged', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ ...NEW_PERSON }], onLeadRead: s => { if (s.leadReads === 2) newContact(s).unindexed = true; } });
    const ids = personReads(pd);
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 31, personCreated: false });
    expect(ids).toEqual([31, OLD_PERSON, 31, OLD_PERSON]);
    expect(state.created).toHaveLength(0);
  });
  // A record that comes back empty or cut short in the second round says nothing about staff
  // work. It is a failed attempt, tried again on the next proposal; nothing is written.
  const unreadLate = {
    'the lead comes back empty': [(s, over) => { over.leadMissing = true; }, 'lead_unavailable'],
    'the new company comes back empty': [s => { delete s.orgs[NEW_ORG]; }, 'company_unavailable'],
    'the contact it found comes back empty': [s => { s.persons.splice(s.persons.indexOf(newContact(s)), 1); }, 'contact_unavailable'],
    'the contact the lead has now comes back empty': [s => { s.persons.splice(s.persons.indexOf(currentContact(s)), 1); }, 'current_contact_unavailable'],
    'the activity counts of the contact it found are missing': [s => { newContact(s).undone = undefined; }, 'contact_activity_unavailable'],
    'the activity counts of the contact the lead has now are missing': [s => { currentContact(s).undone = undefined; }, 'current_contact_activity_unavailable'],
    'the lead activity list is not whole': [(s, over) => { over.activityPagination = { more_items_in_collection: true, next_start: 100 }; }, 'lead_activity_unavailable'],
  };
  for (const [what, [change, reason]] of Object.entries(unreadLate)) {
    it(`a second round where ${what} is a failed attempt, tried again on the next proposal`, async () => {
      await clean();
      const over = { persons: [{ ...NEW_PERSON }], onLeadRead: s => { if (s.leadReads === 2) change(s, over); } };
      const { pd, state } = fakePipedrive(over);
      await expect(swap((await candidates())[0], pd)).rejects.toThrow(`recheck_${reason}`);
      expect(state.patches).toHaveLength(0);
      expect(state.notes).toHaveLength(0);
      expect(await receipts()).toEqual(['failed']);
      expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(1);
    });
  }
  // Review 2026-11-11 (round 12): the same for the last lead read before the write.
  it.each([[null], [undefined], [{}], [{ id: 'lead-2' }]])('a last lead read that comes back as %j is a failed attempt, tried again on the next proposal', async answer => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ ...NEW_PERSON }] });
    const { getLead } = pd;
    pd.getLead = async (id, options) => { const lead = await getLead(id, options); return state.leadReads === 3 ? answer : lead; };
    await expect(swap((await candidates())[0], pd)).rejects.toThrow('recheck_lead_unavailable');
    expect(state.leadReads).toBe(3);
    expect(state.patches).toHaveLength(0);
    expect(await receipts()).toEqual(['failed']);
    expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
    await held({ hoursAgo: 0 });
    expect(await candidates()).toHaveLength(1);
    pd.getLead = getLead;
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 31 });
  });
  // Review 2026-11-11 (round 13): a record with the right id but cut short read as staff work
  // (a missing field looked like a changed one) and ended the lead for good. A record now has
  // to be whole before anything is read off it. [call, what comes back, reason, reason in the
  // first round when it differs]
  const without = (record, ...keys) => { const copy = { ...record }; for (const key of keys) delete copy[key]; return copy; };
  const cutShort = {
    'the lead comes back with only its id': ['getLead', () => ({ id: 'lead-1' }), 'lead_unavailable'],
    'the lead comes back without its labels': ['getLead', lead => without(lead, 'label_ids'), 'lead_unavailable'],
    'the lead comes back without its archive flag': ['getLead', lead => without(lead, 'is_archived'), 'lead_unavailable'],
    'the lead comes back without its company and contact': ['getLead', lead => without(lead, 'organization_id', 'person_id'), 'lead_unavailable'],
    // Pipedrive leaves an empty custom field off a lead, so in the first round this reads as a lead with no start date.
    'the lead comes back without its custom fields, its update time unmoved': ['getLead', lead => without(lead, STAGE, START, ORIGIN), 'lead_unavailable', 'start_date_out_of_window'],
    'the new company comes back with only its id': ['getOrganization', org => (org?.id === NEW_ORG ? { id: NEW_ORG } : org), 'company_unavailable'],
    'the new company comes back without its deal counts': ['getOrganization',
      org => (org?.id === NEW_ORG ? without(org, 'closed_deals_count', 'won_deals_count', 'open_deals_count') : org), 'company_unavailable'],
    'the new company comes back without its labels': ['getOrganization', org => (org?.id === NEW_ORG ? without(org, 'label_ids') : org), 'company_unavailable'],
    'the company the lead has now comes back with only its id': ['getOrganization', org => (org?.id === OLD_ORG ? { id: OLD_ORG } : org), 'current_company_unavailable'],
    'the contact it found comes back with only its id': ['getPerson', p => (p?.id === 31 ? { id: 31 } : p), 'contact_unavailable'],
    'the contact it found comes back without its mail times': ['getPerson',
      p => (p?.id === 31 ? without(p, 'last_outgoing_mail_time', 'last_incoming_mail_time') : p), 'contact_unavailable'],
    'the contact it found comes back without its company': ['getPerson', p => (p?.id === 31 ? without(p, 'org_id') : p), 'contact_unavailable'],
    'the contact the lead has now comes back with only its id': ['getPerson', p => (p?.id === OLD_PERSON ? { id: OLD_PERSON } : p), 'current_contact_unavailable'],
    'the contact the lead has now comes back with a mail time that is not a time': ['getPerson',
      p => (p?.id === OLD_PERSON ? { ...p, last_outgoing_mail_time: 'soon' } : p), 'current_contact_unavailable'],
    'the search answers with something that is not a list': ['findPersonsByEmail', () => null, 'contact_search_unavailable'],
    'the search lists a record with no id': ['findPersonsByEmail', found => [...found, { name: 'Somebody', emails: [EMAIL], organization: { id: 77 } }], 'contact_search_unavailable'],
    'the lead activity list holds an entry that is not an activity': ['listActivitiesPage',
      (page, args) => (args.personId == null ? { ...page, data: [{}] } : page), 'lead_activity_unavailable'],
    // Review 2026-11-11 (round 14): a field that is there but is not what Pipedrive sends.
    'the lead comes back with a company that is not an id': ['getLead', lead => ({ ...lead, organization_id: {} }), 'lead_unavailable'],
    'the lead comes back with an update time that is not a time': ['getLead', lead => ({ ...lead, update_time: 'bad' }), 'lead_unavailable'],
    'the lead comes back with a label that is not a label': ['getLead', lead => ({ ...lead, label_ids: [{}] }), 'lead_unavailable'],
    'the new company comes back with an empty name': ['getOrganization', org => (org?.id === NEW_ORG ? { ...org, name: '' } : org), 'company_unavailable'],
    'the new company comes back with a label that is not a label': ['getOrganization', org => (org?.id === NEW_ORG ? { ...org, label_ids: [{}] } : org), 'company_unavailable'],
    'the company the lead has now comes back with an empty name': ['getOrganization', org => (org?.id === OLD_ORG ? { ...org, name: '' } : org), 'current_company_unavailable'],
    'the contact it found comes back with a company that is not one': ['getPerson', p => (p?.id === 31 ? { ...p, org_id: {} } : p), 'contact_unavailable'],
    'the contact it found comes back with an address that has no value': ['getPerson', p => (p?.id === 31 ? { ...p, email: [{ primary: true }] } : p), 'contact_unavailable'],
    'the contact it found comes back with a next activity that is not an id': ['getPerson', p => (p?.id === 31 ? { ...p, next_activity_id: {} } : p), 'contact_unavailable'],
    'the contact the lead has now comes back with a next activity date that is not a date': ['getPerson',
      p => (p?.id === OLD_PERSON ? { ...p, next_activity_date: {} } : p), 'current_contact_unavailable'],
    'the search lists a record whose company is not a record': ['findPersonsByEmail', found => found.map(p => ({ ...p, organization: 'x' })), 'contact_search_unavailable'],
    'the lead activity list holds a closed task with only an old due date': ['listActivitiesPage',
      (page, args) => (args.personId == null ? { ...page, data: [{ done: true, due_date: '2025-01-01' }] } : page), 'lead_activity_unavailable'],
  };
  for (const [who, id, setup, reason] of [
    ['the contact it found', 31, { persons: [{ ...NEW_PERSON, activities: [call()] }] }, 'contact_activity_unavailable'],
    ['the contact the lead has now', OLD_PERSON, { persons: [{ ...NEW_PERSON }], currentPerson: { activities: [call()] } }, 'current_contact_activity_unavailable'],
  ]) {
    it(`a second round where the activity list of ${who} holds a closed task with only an old due date is a failed attempt`, async () => {
      await clean();
      const { pd, state } = fakePipedrive(setup);
      const real = pd.listActivitiesPage;
      pd.listActivitiesPage = async (args, options) => {
        const page = await real(args, options);
        return state.leadReads >= 2 && args.personId === id ? { ...page, data: [{ done: true, due_date: '2025-01-01' }] } : page;
      };
      await expect(swap((await candidates())[0], pd)).rejects.toThrow(`recheck_${reason}`);
      expect(state.patches).toHaveLength(0);
      expect(await receipts()).toEqual(['failed']);
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(1);
    });
  }
  // Review 2026-11-11 (round 14): a value staff set can come back under an update time that
  // has not moved. A value that is there is staff work, whatever the time says.
  // Round 15: the same when a custom field is gone from that read as well. The value that is
  // there decides, before the missing one is taken for a faulty read.
  for (const [what, edit] of [
    ['the stage reads GC', lead => ({ ...lead, [STAGE]: 'GC' })],
    ['the stage reads LBA and the origin is gone', ({ [ORIGIN]: _gone, ...lead }) => ({ ...lead, [STAGE]: 'LBA' })],
    ['the owner reads another', lead => ({ ...lead, owner_id: 8 })],
  ]) for (const read of [2, 3]) {
    it(`stands down when ${what} at lead read ${read} though the update time has not moved`, async () => {
      await clean();
      const { pd, state } = fakePipedrive();
      const { getLead } = pd;
      pd.getLead = async (id, options) => { const lead = await getLead(id, options); return state.leadReads >= read ? edit(lead) : lead; };
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
      expect(state.patches).toHaveLength(0);
      expect(await receipts()).toEqual(['superseded']);
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(0);
    });
  }
  // Round 15: staff moved the stage, and the next read of that round failed. The attempt went
  // down as a failed one and the next proposal swapped the lead staff had just edited.
  it('puts a staff edit on record even when the read after it fails', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ onLeadRead: s => { if (s.leadReads === 2) s.lead[STAGE] = 'LBA'; } });
    const { getOrganization } = pd;
    pd.getOrganization = async (id, options) => (state.leadReads >= 2 ? null : getOrganization(id, options));
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
    expect(state.patches).toHaveLength(0);
    expect(await receipts()).toEqual(['superseded']);
    await held({ hoursAgo: 0 });
    expect(await candidates()).toHaveLength(0);
  });
  for (const [what, [call, cut, reason, firstReason = reason]] of Object.entries(cutShort)) {
    it(`a second round where ${what} is a failed attempt, tried again on the next proposal`, async () => {
      await clean();
      const { pd, state } = fakePipedrive({ persons: [{ ...NEW_PERSON }] });
      const real = pd[call];
      pd[call] = async (...args) => { const answer = await real(...args); return state.leadReads >= 2 ? cut(answer, ...args) : answer; };
      await expect(swap((await candidates())[0], pd)).rejects.toThrow(`recheck_${reason}`);
      expect(state.patches).toHaveLength(0);
      expect(state.notes).toHaveLength(0);
      expect(await receipts()).toEqual(['failed']);
      expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(1);
      pd[call] = real;
      expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 31 });
    });
    it(`a first round where ${what} is a skip with nothing on record, and the lead is taken again on a later proposal`, async () => {
      await clean();
      const { pd, state } = fakePipedrive({ persons: [{ ...NEW_PERSON }] });
      const real = pd[call];
      pd[call] = async (...args) => cut(await real(...args), ...args);
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: firstReason, ...(firstReason === reason ? { transient: true } : {}) });
      expect(state.patches).toHaveLength(0);
      expect(await swapIntents()).toBe(0);
      pd[call] = real;
      expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 31 });
    });
  }
  const lastReadCut = {
    'with only its id': () => ({ id: 'lead-1' }),
    'without its labels': lead => without(lead, 'label_ids'),
    'without its custom fields, its update time unmoved': lead => without(lead, STAGE, START, ORIGIN),
    'with a company that is not an id': lead => ({ ...lead, organization_id: {} }),
    'with an update time that is not a time': lead => ({ ...lead, update_time: 'bad' }),
  };
  for (const [what, cut] of Object.entries(lastReadCut)) {
    it(`a last lead read that comes back ${what} is a failed attempt, tried again on the next proposal`, async () => {
      await clean();
      const { pd, state } = fakePipedrive({ persons: [{ ...NEW_PERSON }] });
      const { getLead } = pd;
      pd.getLead = async (id, options) => { const lead = await getLead(id, options); return state.leadReads === 3 ? cut(lead) : lead; };
      await expect(swap((await candidates())[0], pd)).rejects.toThrow('recheck_lead_unavailable');
      expect(state.leadReads).toBe(3);
      expect(state.patches).toHaveLength(0);
      expect(await receipts()).toEqual(['failed']);
      expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(1);
      pd.getLead = getLead;
      expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 31 });
    });
  }
  it('writes nothing when another record takes the address while the contact is created and the second search cannot be read', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const { createPerson, findPersonsByEmail: search } = pd;
    pd.createPerson = async input => { state.persons.push({ id: 55, name: 'Pat Hardy', email: EMAIL, org: 77 }); return createPerson(input); };
    // The client refuses a search answer that is not a whole list (see the client tests above).
    let searches = 0;
    pd.findPersonsByEmail = async (...args) => {
      if (++searches === 2) throw Object.assign(new Error('person search answer incomplete'), { code: 'person_search_incomplete' });
      return search(...args);
    };
    await expect(swap((await candidates())[0], pd)).rejects.toThrow('person search answer incomplete');
    expect(state.patches).toHaveLength(0);
    expect(await receipts()).toEqual(['failed']);
    expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
    // Read whole on the next pass, the other record is seen.
    await held({ hoursAgo: 0 });
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'contact_on_other_record' });
    expect(state.patches).toHaveLength(0);
  });
  it('a contact it just created that cannot be read back yet is a failed attempt, tried again with that contact', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const { getPerson } = pd;
    pd.getPerson = async (id, options) => (id === 900 ? null : getPerson(id, options));
    await expect(swap((await candidates())[0], pd)).rejects.toThrow('recheck_contact_unavailable');
    expect(state.patches).toHaveLength(0);
    expect(await receipts()).toEqual(['failed']);
    await held({ hoursAgo: 0 });
    pd.getPerson = getPerson;
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied', personId: 900, personCreated: false });
    expect(state.created).toHaveLength(1);
  });
  it('runs every live check twice before a write, the lead a third time, and once more to confirm', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ ...NEW_PERSON }] });
    const order = [];
    for (const name of ['getLead', 'getOrganization', 'findPersonsByEmail', 'getPerson', 'listActivitiesPage', 'swapLeadCompany']) {
      const real = pd[name];
      pd[name] = async (...args) => { order.push(name); return real(...args); };
    }
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    const round = ['getLead', 'getOrganization', 'getOrganization', 'findPersonsByEmail', 'getPerson', 'getPerson', 'listActivitiesPage'];
    expect(order).toEqual([...round, ...round, 'getLead', 'swapLeadCompany', 'getLead']);
    expect(state.readOptions.every(options => options?.failFast === true)).toBe(true);
  });
  it('a second round of checks that runs out of time writes nothing and is tried again', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ ...NEW_PERSON }] });
    // Every read of the second round is slow: it starts with the second lead read.
    for (const name of ['getLead', 'getOrganization', 'findPersonsByEmail', 'getPerson', 'listActivitiesPage']) {
      const real = pd[name];
      pd[name] = async (...args) => { if (state.leadReads >= (name === 'getLead' ? 1 : 2)) await new Promise(resolve => setTimeout(resolve, 350)); return real(...args); };
    }
    // Seven calls of 400 ms are reserved, four of them for the calls after the second round: in
    // a 3.4 s pass the second round has to be over at 1.8 s, and five slow reads are not.
    expect(await run({ pd, budgetMs: 3400, callDeadlineMs: 400 })).toMatchObject({ applied: 0, outOfTime: true });
    expect(state.patches).toHaveLength(0);
    expect(await receipts()).toEqual(['failed']);
    expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
    await held({ hoursAgo: 0 });
    expect(await run({ pd: fakePipedrive({ persons: [{ ...NEW_PERSON }] }).pd })).toMatchObject({ applied: 1 });
  });

  // A staff override and recipient or channel holds do not take the lead lock, so they can land
  // while the swap is talking to Pipedrive. The eligibility query runs again right before the
  // PATCH. Everything that excludes a lead is replayed here, landing during the first lead read.
  for (const [name, arrange] of Object.entries(excluded)) {
    it(`stands down before the write when ${name} lands during the Pipedrive checks`, async () => {
      await clean();
      const { pd, state } = fakePipedrive({ onLeadRead: async s => { if (s.leadReads === 1) await arrange(); } });
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
      expect(state.patches).toHaveLength(0);
      expect(state.notes).toHaveLength(0);
      expect((await receipts()).at(-1)).toBe('superseded');
      expect((await q("SELECT pipedrive_org_id, project_stage FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0]).toEqual({ pipedrive_org_id: String(OLD_ORG), project_stage: 'PB' });
    });
  }
  it('a newer proposal for another company landing during the checks stands the swap down', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ onLeadRead: async s => { if (s.leadReads === 1) await held({ company: 'Other Builders Inc', newOrg: 99, hoursAgo: 0 }); } });
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
    expect(state.patches).toHaveLength(0);
  });
  it('keeps a staff trigger override set in the last moment before the write', async () => {
    await clean();
    const { pd } = fakePipedrive({ onPatch: () => q("UPDATE sdr_lead_state SET trigger_override='PB', trigger_type='PB' WHERE pipedrive_lead_id='lead-1'") });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    expect((await q("SELECT trigger_override, trigger_type, project_stage FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0])
      .toEqual({ trigger_override: 'PB', trigger_type: 'PB', project_stage: 'LBA' });
  });

  // The existing-customer index (lib/customerSuppression.js): a customer is often tagged on one
  // Pipedrive record while CMD's name resolves to an untagged duplicate or branch record.
  it('skips a company whose other Pipedrive record carries the customer label', async () => {
    await clean({ held: { company: 'Hardy Construction - Tulsa' } });
    const customers = { ...NO_CUSTOMERS, orgIds: new Set(['4711']), keys: new Set(companyKeyVariants('Hardy Construction, LLC')) };
    const { pd, state } = fakePipedrive({ newOrg: { name: 'Hardy Construction - Tulsa' } });
    const [row] = await candidates();
    expect(await swap(row, pd, { customers, dryRun: true })).toEqual({ action: 'skip', reason: 'customer_company' });
    expect(await swap(row, pd, { customers })).toEqual({ action: 'skip', reason: 'customer_company' });
    expect(await run({ pd, loadCustomers: async () => customers })).toMatchObject({ applied: 0, skipped: { customer_company: 1 } });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    // The same lead with no customer of that name goes through.
    const other = fakePipedrive({ newOrg: { name: 'Hardy Construction - Tulsa' } });
    expect(await swap(row, other.pd, { customers: { ...NO_CUSTOMERS, orgIds: new Set(['4711']), keys: new Set(companyKeyVariants('Crossland Construction')) } })).toMatchObject({ action: 'applied' });
  });
  // Review 2026-11-11 (round 9): Pipedrive gives a company's labels as a number, as text, or as
  // several ids in one text ("1,2"). Only the bare number 1 was read as Customer.
  it.each([
    ['as a number', { label: 1 }],
    ['as text', { label: '1' }],
    ['next to another label, in one text', { label: '1,2' }],
    ['second in one text, with spaces', { label: '15, 1' }],
    ['in the id list', { label: 15, label_ids: [15, 1] }],
    ['in the id list as text', { label_ids: ['3', '1'] }],
  ])('skips a company that carries the Customer label %s', async (_how, newOrg) => {
    await clean();
    const [row] = await candidates();
    const { pd, state } = fakePipedrive({ newOrg });
    expect(await swap(row, pd, { dryRun: true })).toEqual({ action: 'skip', reason: 'customer_company' });
    expect(await swap(row, pd)).toEqual({ action: 'skip', reason: 'customer_company' });
    expect(state.patches).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });
  it('does not read another label as the Customer label', async () => {
    await clean();
    const { pd } = fakePipedrive({ newOrg: { label: '11,21', label_ids: [11, 21, 15] } });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
  });
  // Review 2026-11-11 (round 9): the deals sit on another Pipedrive record of the same company,
  // which carries no Customer label. CMD's name resolves to a record with no deals of its own.
  it.each([
    ['a won or closed deal', 'dealKeys', 'company_deal_on_other_record'],
    ['an open deal', 'openDealKeys', 'open_deal_on_other_record'],
  ])('skips a company whose other Pipedrive record has %s', async (_what, set, reason) => {
    await clean({ held: { company: 'Hardy Construction - Tulsa' } });
    const customers = { ...NO_CUSTOMERS, [set]: new Set(companyKeyVariants('Hardy Construction, LLC')) };
    const { pd, state } = fakePipedrive({ newOrg: { name: 'Hardy Construction - Tulsa' } });
    const [row] = await candidates();
    expect(await swap(row, pd, { customers, dryRun: true })).toEqual({ action: 'skip', reason });
    expect(await swap(row, pd, { customers })).toEqual({ action: 'skip', reason });
    expect(await run({ pd, loadCustomers: async () => customers })).toMatchObject({ applied: 0, skipped: { [reason]: 1 } });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
    // Deals at a company of another name are no obstacle.
    const other = fakePipedrive({ newOrg: { name: 'Hardy Construction - Tulsa' } });
    expect(await swap(row, other.pd, { customers: { ...NO_CUSTOMERS, [set]: new Set(companyKeyVariants('Crossland Construction')) } })).toMatchObject({ action: 'applied' });
  });
  it('swaps nothing with an index that does not say which companies have deals', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const noDeals = { orgIds: new Set(), keys: new Set() };
    expect(await run({ pd, loadCustomers: async () => noDeals })).toMatchObject({ candidates: 1, applied: 0, error: 'customer_index_unavailable' });
    expect(await run({ pd, loadCustomers: async () => ({ ...NO_CUSTOMERS, dealKeys: null }) })).toMatchObject({ applied: 0, error: 'customer_index_unavailable' });
    expect(await run({ pd, loadCustomers: async () => ({ ...NO_CUSTOMERS, openDealKeys: null }) })).toMatchObject({ applied: 0, error: 'customer_index_unavailable' });
    await expect(swap((await candidates())[0], pd, { customers: noDeals })).rejects.toThrow('customer_index_unavailable');
    expect(state.calls).toBe(0);
    expect(await swapIntents()).toBe(0);
  });
  it('never swaps a lead staff labelled Customer', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ lead: { label_ids: ['other-label', CUSTOMER_LEAD_LABEL_ID] } });
    const [row] = await candidates();
    expect(await swap(row, pd, { dryRun: true })).toEqual({ action: 'skip', reason: 'customer_lead' });
    expect(await swap(row, pd)).toEqual({ action: 'skip', reason: 'customer_lead' });
    expect(state.patches).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
    // Any other label is no obstacle.
    const other = fakePipedrive({ lead: { label_ids: ['other-label'] } });
    expect(await swap(row, other.pd)).toMatchObject({ action: 'applied' });
  });
  it('stands down when the Customer label is put on the lead between the checks and the write', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ onLeadRead: s => { if (s.leadReads === 2) s.lead.label_ids = [CUSTOMER_LEAD_LABEL_ID]; } });
    expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
    expect(state.patches).toHaveLength(0);
    expect((await receipts()).at(-1)).toBe('superseded');
  });
  it('gives the customer index no more than the time the pass has', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const started = Date.now();
    expect(await run({ pd, budgetMs: 150, loadCustomers: () => new Promise(() => {}) })).toMatchObject({ candidates: 1, applied: 0, error: 'customer_index_unavailable' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(state.calls).toBe(0);
  });
  it('skips a company the customer index lists by its record id', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    expect(await swap((await candidates())[0], pd, { customers: { ...NO_CUSTOMERS, orgIds: new Set([String(NEW_ORG)]) } })).toEqual({ action: 'skip', reason: 'customer_company' });
    expect(state.patches).toHaveLength(0);
  });
  it('swaps nothing when the customer index cannot be built', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    expect(await run({ pd, loadCustomers: async () => { throw new Error('Pipedrive unreachable'); } })).toMatchObject({ candidates: 1, applied: 0, error: 'customer_index_unavailable' });
    expect(await run({ pd, loadCustomers: async () => null })).toMatchObject({ applied: 0, error: 'customer_index_unavailable' });
    await expect(swap((await candidates())[0], pd, { customers: {} })).rejects.toThrow('customer_index_unavailable');
    expect(state.calls).toBe(0);
    expect(await swapIntents()).toBe(0);
  });

  // "Named for at least a day" counts from the first proposal after the last different one.
  it('starts the day over when CMD names a company, drops it for another, and names it again', async () => {
    await leadState();
    await held({ hoursAgo: 720 });
    await held({ company: 'Other Builders Inc', newOrg: 99, hoursAgo: 360 });
    await held({ hoursAgo: 2 });
    expect(await candidates()).toHaveLength(0);
  });
  it('accepts the company again once it has stood a day since the other one', async () => {
    await leadState();
    await held({ hoursAgo: 720 });
    await held({ company: 'Other Builders Inc', newOrg: 99, hoursAgo: 360 });
    await held({ hoursAgo: 30 });
    await held({ hoursAgo: 2 });
    expect(await candidates()).toHaveLength(1);
  });
  it('starts the day over after a refresh that proposed no company change', async () => {
    await leadState();
    await held({ hoursAgo: 72 });
    await held({ newOrg: null, hoursAgo: 10 });
    await held({ hoursAgo: 2 });
    expect(await candidates()).toHaveLength(0);
  });

  // The lead lock is the one every draft, send and enrollment path takes, held on the session:
  // no transaction is open while the swap talks to Pipedrive.
  it('holds the lead lock during the write without holding any table lock', async () => {
    await clean();
    const seen = {};
    const { pd } = fakePipedrive({ onPatch: async () => {
      const other = await db.pool.connect();
      try {
        seen.leadLockFree = (await other.query("SELECT pg_try_advisory_lock(hashtextextended('lead-1', 0)) AS got")).rows[0].got;
        // What deploy DDL needs: fails at once if any open transaction has touched these tables.
        await other.query('BEGIN');
        await other.query('LOCK TABLE sdr_lead_state, sdr_change_intents, sdr_change_receipts, sdr_drafts, sdr_sends IN ACCESS EXCLUSIVE MODE NOWAIT');
        await other.query('ROLLBACK');
        seen.tablesFree = true;
      } catch (error) { await other.query('ROLLBACK').catch(() => {}); seen.error = error.message; }
      finally { other.release(); }
    } });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    expect(seen).toEqual({ leadLockFree: false, tablesFree: true });
    // Released afterwards.
    const after = await db.pool.connect();
    try {
      expect((await after.query("SELECT pg_try_advisory_lock(hashtextextended('lead-1', 0)) AS got")).rows[0].got).toBe(true);
      await after.query("SELECT pg_advisory_unlock(hashtextextended('lead-1', 0))");
    } finally { after.release(); }
  });
  it('leaves a lead another path is working on for the next pass', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const other = await db.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query("SELECT pg_advisory_xact_lock(hashtextextended('lead-1', 0))");
      expect(await run({ pd })).toMatchObject({ applied: 0, skipped: { lead_busy: 1 } });
      expect(state.calls).toBe(0);
      await other.query('COMMIT');
    } finally { other.release(); }
    // Not remembered as checked: the next pass takes it.
    expect(await run({ pd })).toMatchObject({ applied: 1 });
  });
  it('releases the lead lock when the attempt fails', async () => {
    await clean();
    const { pd } = fakePipedrive({ failPatch: 400 });
    await expect(swap((await candidates())[0], pd)).rejects.toMatchObject({ status: 400 });
    const after = await db.pool.connect();
    try {
      expect((await after.query("SELECT pg_try_advisory_lock(hashtextextended('lead-1', 0)) AS got")).rows[0].got).toBe(true);
      await after.query("SELECT pg_advisory_unlock(hashtextextended('lead-1', 0))");
    } finally { after.release(); }
  });

  it('two attempts at once create one contact and write once', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const [row] = await candidates();
    const results = await Promise.all([swap(row, pd), swap(row, pd)]);
    expect(results.map(r => r.action).sort()).toEqual(['applied', 'skip']);
    expect(results.find(r => r.action === 'skip').reason).toBe('lead_busy');
    expect(state.created).toHaveLength(1);
    expect(state.patches).toHaveLength(1);
    expect(state.notes).toHaveLength(1);
    expect(await swapIntents()).toBe(1);
  });
  it('two attempts at once from two different proposal rows still create one contact and write once', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const [older] = await candidates();
    await held({ hoursAgo: 0 });
    const [newer] = await candidates();
    expect(newer.source_action_id).not.toBe(older.source_action_id);
    // Whoever takes the lead lock first wins it. The stale row is no longer the proposal, and
    // the current one finds the lead busy, so this round may swap nothing.
    const results = await Promise.all([swap(older, pd), swap(newer, pd)]);
    expect(results.filter(r => r.action === 'applied').length).toBeLessThanOrEqual(1);
    expect(results.filter(r => r.action === 'skip').every(r => ['lead_busy', 'no_longer_eligible'].includes(r.reason))).toBe(true);
    // The next pass, with the row as it now stands, finishes the job exactly once.
    const [current] = await candidates();
    if (current) expect(await swap(current, pd)).toMatchObject({ action: 'applied' });
    expect(await candidates()).toHaveLength(0);
    expect(state.created).toHaveLength(1);
    expect(state.patches).toHaveLength(1);
    expect(await swapIntents()).toBe(1);
  });

  it('a write Pipedrive refused is recorded as failed and tried again on a later proposal', async () => {
    await clean();
    const failing = fakePipedrive({ failPatch: 400 });
    const stats = await run({ pd: failing.pd });
    expect(stats).toMatchObject({ applied: 0, failed: 1 });
    expect(await receipts()).toEqual(['failed']);
    expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
    // Same proposal row: the action id repeats, so nothing is attempted twice for it.
    expect(await run({ pd: failing.pd })).toMatchObject({ applied: 0, failed: 0, skipped: { already_attempted: 1 } });
    expect(failing.state.created).toHaveLength(1);
    // The next refresh repeats the proposal: one more try, reusing the contact created earlier.
    await held({ hoursAgo: 0 });
    const working = fakePipedrive({ persons: [{ id: 900, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG }] });
    expect(await run({ pd: working.pd })).toMatchObject({ applied: 1 });
    expect(working.state.created).toHaveLength(0);
  });
  it('a contact that cannot be created is a failed attempt and the lead is left alone', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    pd.createPerson = async () => { throw Object.assign(new Error('person refused'), { status: 400 }); };
    expect(await run({ pd })).toMatchObject({ applied: 0, failed: 1 });
    expect(state.patches).toHaveLength(0);
    expect(await receipts()).toEqual(['failed']);
  });
  const unknownOutcomes = { 'answers with a server error': { failPatch: 500 }, 'answers with a timeout status': { failPatch: 408 },
    'never answers': { hangPatch: true }, 'never answers and ignores being dropped': { hangPatch: 'deaf' } };
  for (const [what, over] of Object.entries(unknownOutcomes)) {
    it(`a write that ${what} may have gone through: recorded as unresolved and never repeated`, async () => {
      await clean();
      const { pd, state } = fakePipedrive(over);
      const stats = await run({ pd, callDeadlineMs: 80 });
      expect(stats).toMatchObject({ applied: 0, failed: 0, unresolved: 1 });
      expect(await receipts()).toEqual(['unresolved']);
      expect(state.notes).toHaveLength(0);
      // The request is dropped at its deadline, not left on its way to Pipedrive.
      expect(state.patchSignals).toHaveLength(1);
      expect(state.patchSignals[0]).toBeInstanceOf(AbortSignal);
      expect(state.patchSignals[0].aborted).toBe(Boolean(over.hangPatch));
      expect(state.aborted).toBe(over.hangPatch ? 1 : 0);
      // Our copy still shows the old company, so the lead is held on every channel.
      expect(await swapHolds()).toEqual(ONE_HOLD);
      // Local state is left for the next sync, which reads what the lead really holds.
      expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(0);
      const again = fakePipedrive();
      expect(await run({ pd: again.pd })).toMatchObject({ candidates: 0, applied: 0 });
      expect(again.state.patches).toHaveLength(0);
    });
  }
  it('a write that cannot be confirmed afterwards is unresolved, with no note and no local change', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ onLeadRead: s => { if (s.leadReads === 4) s.lead.organization_id = 77; } });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'unresolved' });
    expect(state.patches).toHaveLength(1);
    expect(state.notes).toHaveLength(0);
    expect(await receipts()).toEqual(['unresolved']);
    expect(await swapHolds()).toEqual(ONE_HOLD);
    expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
  });
  it('a write whose confirming read fails holds the lead', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ onLeadRead: s => { if (s.leadReads === 4) throw Object.assign(new Error('bad gateway'), { status: 502 }); } });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'unresolved', rateLimited: false });
    expect(state.patches).toHaveLength(1);
    expect(await receipts()).toEqual(['unresolved']);
    expect(await swapHolds()).toEqual(ONE_HOLD);
  });
  // The hold goes on before the request leaves, so a crash or a lost connection during the
  // write cannot leave the lead without one. It comes off only on a known result.
  const LIFTED = [{ ...ONE_HOLD[0], status: 'released', version: 2, decisions: ['hold', 'release'] }];
  it('the lead is held on every channel while the write is out, and released once it is confirmed and copied', async () => {
    await clean();
    let during;
    const { pd } = fakePipedrive({ onPatch: async () => { during = await swapHolds(); } });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'applied' });
    expect(during).toEqual(ONE_HOLD);
    expect(await swapHolds()).toEqual(LIFTED);
    expect((await q("SELECT 1 FROM sdr_outreach_controls WHERE status = 'active'")).rowCount).toBe(0);
  });
  it('a write Pipedrive refuses leaves the lead as it was: the hold comes off', async () => {
    await clean();
    await expect(swap((await candidates())[0], fakePipedrive({ failPatch: 422 }).pd)).rejects.toMatchObject({ status: 422 });
    expect(await receipts()).toEqual(['failed']);
    expect(await swapHolds()).toEqual(LIFTED);
    // A refused write may be tried again.
    expect(await candidates()).toHaveLength(1);
  });
  it('a stand-down before the write places no hold', async () => {
    await clean();
    expect(await swap((await candidates())[0], fakePipedrive({ lead: { [STAGE]: 'GC' } }).pd)).toEqual({ action: 'skip', reason: 'stage_not_forward' });
    expect(await swap((await candidates())[0], fakePipedrive({ onLeadRead: s => { if (s.leadReads === 2) s.lead.person_id = 78; } }).pd)).toEqual({ action: 'skip', reason: 'changed_before_write' });
    expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
  });
  it('writes nothing to Pipedrive when the hold cannot be placed', async () => {
    await clean();
    // The hold's decision row has nowhere to go: the hold itself must not stay behind either.
    const { pd, state } = fakePipedrive({ onLeadRead: async s => { if (s.leadReads === 2) await q('ALTER TABLE sdr_outreach_control_decisions RENAME TO decisions_away'); } });
    try {
      await expect(swap((await candidates())[0], pd)).rejects.toThrow(/sdr_outreach_control_decisions/);
    } finally {
      await q('ALTER TABLE decisions_away RENAME TO sdr_outreach_control_decisions');
    }
    expect(state.patches).toHaveLength(0);
    expect(state.patchSignals).toHaveLength(0);
    expect(await receipts()).toEqual(['failed']);
    expect((await q('SELECT 1 FROM sdr_outreach_controls')).rowCount).toBe(0);
  });
  it('a confirmed write that could not be copied to the lead keeps the hold until the sync', async () => {
    await clean();
    // Our copy cannot be updated at the moment of the confirming read.
    const { pd, state } = fakePipedrive({ onLeadRead: async s => { if (s.leadReads === 4) await q('ALTER TABLE sdr_lead_state RENAME COLUMN outreach_status TO outreach_status_away'); } });
    let result;
    try { result = await swap((await candidates())[0], pd); }
    finally { await q('ALTER TABLE sdr_lead_state RENAME COLUMN outreach_status_away TO outreach_status'); }
    expect(result).toMatchObject({ action: 'applied' });
    expect(state.patches).toHaveLength(1);
    expect(await receipts()).toEqual(['confirmed']);
    // The copy still shows the old company and contact, so nothing may go out on it.
    expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
    expect(await swapHolds()).toEqual(ONE_HOLD);
  });

  // The hold lifts by itself once the sync has read the lead again: our copy then shows what the
  // lead really holds, whichever way the write went.
  describe('holds left by an unconfirmed write', () => {
    const unconfirmed = async () => {
      await clean();
      expect(await swap((await candidates())[0], fakePipedrive({ failPatch: 500 }).pd)).toMatchObject({ action: 'unresolved' });
      expect(await swapHolds()).toEqual(ONE_HOLD);
    };
    const syncedAfter = minutes => q(`UPDATE sdr_lead_state SET crm_source_read_started_at = (SELECT created_at FROM sdr_outreach_controls LIMIT 1) + make_interval(secs => $1::int)
      WHERE pipedrive_lead_id = 'lead-1'`, [Math.round(minutes * 60)]);
    const release = () => releaseSettledSwapHolds(db.pool, { companyId: COMPANY });

    it('stay while the lead has not been read again, or was read too soon after', async () => {
      await unconfirmed();
      expect(await release()).toEqual({ released: 0 });
      await syncedAfter(-30);
      expect(await release()).toEqual({ released: 0 });
      await syncedAfter(4);
      expect(await release()).toEqual({ released: 0 });
      expect(await swapHolds()).toEqual(ONE_HOLD);
    });
    it('lift once the sync has read the lead well after the attempt, with the decision on record', async () => {
      await unconfirmed();
      await syncedAfter(6);
      expect(await release()).toEqual({ released: 1 });
      expect(await swapHolds()).toEqual([{ ...ONE_HOLD[0], status: 'released', version: 2, decisions: ['hold', 'release'] }]);
      expect(await release()).toEqual({ released: 0 });
      // The swap itself stays off: the unresolved attempt is still on record.
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(0);
    });
    it('leave a hold staff have decided on, and every hold that is not this job\'s', async () => {
      await unconfirmed();
      // Staff looked at it and kept it held: version 2, still active.
      await q("UPDATE sdr_outreach_controls SET version = 2");
      // Same wording from a person, and another automatic hold on the same lead.
      await q(`INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,reason,context_hash,actor,owner_id)
        VALUES($1,'lead-1','lead','lead-1',$2,'h','{"accountId":"derek"}','derek'),($1,'lead-1','lead','lead-1','Bounced','h','{"accountId":"company-swap"}','company-swap')`, [COMPANY, UNKNOWN_OUTCOME_HOLD]);
      await q("UPDATE sdr_lead_state SET crm_source_read_started_at = NOW() + INTERVAL '1 hour'");
      expect(await release()).toEqual({ released: 0 });
      expect((await q("SELECT 1 FROM sdr_outreach_controls WHERE status = 'active'")).rowCount).toBe(3);
    });
    it('touch no other company and do nothing with no company configured', async () => {
      await unconfirmed();
      await syncedAfter(6);
      expect(await releaseSettledSwapHolds(db.pool, { companyId: '999' })).toEqual({ released: 0 });
      expect(await releaseSettledSwapHolds(db.pool, { companyId: '' })).toEqual({ released: 0 });
      expect(await swapHolds()).toEqual(ONE_HOLD);
    });
  });

  // Two leads with a clean held change each.
  const two = async () => {
    await clean();
    await leadState({ pipedrive_lead_id: 'lead-2' });
    await held({ lead: 'lead-2', hoursAgo: 72, email: 'pat.hardy@hardyconstruction.test' }); await held({ lead: 'lead-2', email: 'pat.hardy@hardyconstruction.test' });
    const fake = fakePipedrive();
    const leads = {};
    const of = id => (leads[id] ||= { id, title: 'Hardy Road Widening', organization_id: OLD_ORG, person_id: OLD_PERSON, owner_id: 7, is_archived: false, label_ids: [],
      update_time: '2026-11-10T08:00:00.000Z', [STAGE]: 'PB', [START]: day(1) });
    fake.pd.getLead = async id => { fake.state.calls++; return { ...of(id) }; };
    fake.pd.swapLeadCompany = async (id, fields) => {
      fake.state.patches.push({ leadId: id, ...fields });
      Object.assign(of(id), { organization_id: fields.organizationId, person_id: fields.personId, [STAGE]: fields.stage, update_time: '2026-11-11T12:00:00.000Z' });
    };
    return fake;
  };
  it('stops at the per-run limit', async () => {
    const { pd, state } = await two();
    expect(await run({ pd, limit: 1, dryRun: true })).toMatchObject({ candidates: 2, wouldApply: 1 });
    expect(await run({ pd, limit: 0, dryRun: true })).toMatchObject({ candidates: 2, wouldApply: 0 });
    expect(await run({ pd, limit: 1 })).toMatchObject({ candidates: 2, applied: 1 });
    expect(state.patches).toHaveLength(1);
  });
  it('stops when the time budget is spent', async () => {
    const { pd, state } = await two();
    expect(await run({ pd, budgetMs: 0 })).toMatchObject({ candidates: 2, applied: 0, outOfTime: true });
    expect(state.calls).toBe(0);
  });
  it('stops at a Pipedrive rate limit on a read', async () => {
    const { pd, state } = await two();
    pd.getLead = async () => { state.calls++; throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await run({ pd })).toMatchObject({ applied: 0, failed: 0, rateLimited: true });
    expect(state.calls).toBe(1);
  });
  it('stops at a Pipedrive rate limit on the write, which is a refusal', async () => {
    const { pd, state } = await two();
    pd.swapLeadCompany = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await run({ pd })).toMatchObject({ applied: 0, rateLimited: true });
    expect(await receipts()).toEqual(['failed']);
    expect(state.created).toHaveLength(1);
  });
  it('stops at a Pipedrive rate limit on the note, after the one swap it already made', async () => {
    const { pd, state } = await two();
    pd.addNote = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await run({ pd })).toMatchObject({ applied: 1, rateLimited: true });
    expect(state.patches).toHaveLength(1);
    expect(await receipts()).toEqual(['confirmed']);
  });
  it('stops at a Pipedrive rate limit on the confirming read, with that one lead left unresolved', async () => {
    const { pd, state } = await two();
    const getLead = pd.getLead;
    let reads = 0;
    pd.getLead = async id => { if (++reads === 4) throw Object.assign(new Error('rate limited'), { status: 429 }); return getLead(id); };
    expect(await run({ pd })).toMatchObject({ applied: 0, unresolved: 1, failed: 0, rateLimited: true });
    expect(state.patches).toHaveLength(1);
    expect(await receipts()).toEqual(['unresolved']);
    expect((await swapHolds()).map(h => h.status)).toEqual(['active']);
  });
  it('never starts a write it may not have time to finish', async () => {
    const { pd, state } = await two();
    // Seven calls of 80 ms are reserved for a write: a 300 ms pass has no room for one.
    expect(await run({ pd, budgetMs: 300, callDeadlineMs: 80 })).toMatchObject({ applied: 0, failed: 0, outOfTime: true, checked: 1 });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
    // Not remembered as checked: the next pass takes both.
    expect(await run({ pd })).toMatchObject({ applied: 2 });
  });
  it('cuts a hung read at the end of the pass, not at the call deadline', async () => {
    const { pd } = await two();
    pd.getLead = () => new Promise(() => {});
    const started = Date.now();
    expect(await run({ pd, budgetMs: 120, callDeadlineMs: 60000 })).toMatchObject({ applied: 0, failed: 0, outOfTime: true, checked: 1 });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it('stops at the cap on leads looked up in one pass', async () => {
    const { pd } = await two();
    pd.getOrganization = async id => ({ id, name: id === NEW_ORG ? 'Hardy Construction, LLC' : 'Decker Construction Services, Inc.', active_flag: true,
      closed_deals_count: 0, won_deals_count: 0, open_deals_count: id === NEW_ORG ? 1 : 0, label_ids: [] });
    expect(await run({ pd, maxChecks: 1 })).toMatchObject({ candidates: 2, checked: 1, capped: true, skipped: { open_deal_company: 1 } });
    // The lead checked earlier costs no lookup, so the next pass reaches the second one.
    expect(await run({ pd, maxChecks: 1 })).toMatchObject({ checked: 1, capped: false, skipped: { checked_earlier: 1, open_deal_company: 1 } });
  });
  it('a hung read costs one deadline and the run moves on', async () => {
    const { pd } = await two();
    const getLead = pd.getLead;
    pd.getLead = id => (id === 'lead-1' ? new Promise(() => {}) : getLead(id));
    expect(await run({ pd, callDeadlineMs: 80 })).toMatchObject({ applied: 1, failed: 1 });
    expect(await swapIntents()).toBe(1);
  });
  it('does not read Pipedrive again for a proposal row it already checked and skipped', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ newOrg: { closed_deals_count: 2 } });
    expect(await run({ pd })).toMatchObject({ skipped: { customer_company: 1 } });
    const calls = state.calls;
    expect(await run({ pd })).toMatchObject({ skipped: { checked_earlier: 1 } });
    expect(state.calls).toBe(calls);
    // The next refresh writes a new proposal row, and that one is checked.
    await held({ hoursAgo: 0 });
    expect(await run({ pd })).toMatchObject({ skipped: { customer_company: 1 } });
    expect(state.calls).toBeGreaterThan(calls);
  });
  // Review 2026-11-11 (round 15): a first read that came back cut short was remembered as a
  // settled skip, so the same proposal was not read again until a restart.
  it('reads Pipedrive again for a proposal row whose lead came back cut short', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const { getLead } = pd;
    let cut = true;
    pd.getLead = async (id, options) => { const lead = await getLead(id, options); return cut ? { id: lead.id } : lead; };
    expect(await run({ pd })).toMatchObject({ applied: 0, skipped: { lead_unavailable: 1 } });
    cut = false;
    expect(await run({ pd })).toMatchObject({ applied: 1 });
    expect(state.patches).toHaveLength(1);
  });
});
