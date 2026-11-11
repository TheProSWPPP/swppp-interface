import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import { normalizeCompany, sameCompany, nameMatchesAddress, stageDecision, selectSwapCandidates, swapOne, runCompanySwap, HELD_REASON, SWAP_REASON } from '../sdrCompanySwap.js';
import { swapLeadCompany, updateLead } from '../pipedriveClient.js';
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

const db = reportingTestDb('company_swap');
const COMPANY = '13105180';
const OLD_ORG = 10, NEW_ORG = 20, OLD_PERSON = 11;
const EMAIL = 'phardy@hardyconstruction.test';

// A fake Pipedrive holding one lead, its companies and people.
//   failPatch: an HTTP status the lead PATCH fails with; hangPatch: the PATCH never answers;
//   onLeadRead(state): runs before each lead read (state.leadReads counts them), to play a staff
//   edit landing between two reads.
function fakePipedrive(over = {}) {
  const state = {
    lead: { id: 'lead-1', organization_id: OLD_ORG, person_id: OLD_PERSON, owner_id: 7, is_archived: false, update_time: '2026-11-10T08:00:00.000Z',
      [STAGE]: 'PB', [FIELD_KEYS.SEQ]: null, ...over.lead },
    orgs: { [OLD_ORG]: { id: OLD_ORG, name: 'Decker Construction Services, Inc.' }, [NEW_ORG]: { id: NEW_ORG, name: 'Hardy Construction, LLC', ...over.newOrg } },
    persons: over.persons || [],
    created: [], patches: [], notes: [], leadReads: 0, calls: 0,
  };
  const pd = {
    getLead: async () => { state.calls++; state.leadReads++; over.onLeadRead?.(state); return over.leadMissing ? null : { ...state.lead }; },
    getOrganization: async id => { state.calls++; return state.orgs[id] || null; },
    findPersonsByEmail: async email => { state.calls++; return state.persons.filter(p => p.email === email).map(p => ({ id: p.id, name: p.name, emails: [p.email], organization: p.org ? { id: p.org } : null })); },
    // The person record itself: its company now (liveOrg) and its primary address (primary) can
    // differ from what the search matched.
    getPerson: async id => {
      state.calls++;
      const p = state.persons.find(x => x.id === id);
      if (!p) return null;
      const org = p.liveOrg ?? p.org;
      return { id: p.id, name: p.name, active_flag: p.inactive ? false : true, org_id: org ? { value: org, name: 'x' } : null,
        email: p.primary ? [{ value: p.email, primary: false }, { value: p.primary, primary: true }] : [{ value: p.email, primary: true }],
        last_outgoing_mail_time: p.lastOut || null, last_incoming_mail_time: p.lastIn || null };
    },
    createPerson: async input => { state.calls++; const p = { id: 900 + state.created.length, name: input.name }; state.created.push(input); return p; },
    swapLeadCompany: async (leadId, fields) => {
      state.calls++;
      if (over.hangPatch) return new Promise(() => {});
      if (over.failPatch) throw Object.assign(new Error(`Pipedrive PATCH /leads/lead-1 → ${over.failPatch}: boom`), { status: over.failPatch });
      state.patches.push({ leadId, ...fields });
      state.lead.organization_id = fields.organizationId; state.lead.person_id = fields.personId; state.lead.update_time = '2026-11-11T12:00:00.000Z';
      if (fields.stage !== undefined) state.lead[STAGE] = fields.stage;
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
  const swap = (row, pd, extra = {}) => swapOne(db.pool, row, { pd, companyId: COMPANY, graceDays: 30, ...extra });
  const hold = (kind, scopeId, { lead = null, channel = 'email', status = 'active' } = {}) =>
    q('INSERT INTO sdr_outreach_controls(company_id,status,scope_kind,scope_id,lead_id,channel) VALUES($1,$2,$3,$4,$5,$6)', [COMPANY, status, kind, scopeId, lead, channel]);
  // An earlier swap attempt on the lead, with the receipts it left.
  const attempt = async (receipts, lead = 'lead-1') => {
    const id = `swap:${lead}:${++seq}`;
    await q(`INSERT INTO sdr_change_intents(action_id,company_id,entity,entity_id,expected_fields,proposed_fields,actor,reason,context_hash) VALUES($1,$2,'lead',$3,'{}','{}','{}',$4,'h')`, [id, COMPANY, lead, SWAP_REASON]);
    for (const status of receipts) await q('INSERT INTO sdr_change_receipts(action_id,status) VALUES($1,$2)', [id, status]);
  };
  const swapIntents = async () => (await q('SELECT 1 FROM sdr_change_intents WHERE reason=$1', [SWAP_REASON])).rowCount;
  const receipts = async () => (await q('SELECT status FROM sdr_change_receipts ORDER BY id')).rows.map(r => r.status);

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
        start_date date,outreach_status text,last_outgoing_mail_time timestamptz,crm_source_updated_at timestamptz,crm_source_read_started_at timestamptz,
        crm_person_source_updated_at timestamptz,crm_person_source_read_started_at timestamptz);
      CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,status text,contact_email_snapshot text);
      CREATE TABLE sdr_sends(id text,draft_id uuid,pipedrive_lead_id text);
      CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz);
      CREATE TABLE sdr_outreach_controls(company_id text,status text,scope_kind text,scope_id text,lead_id text,channel text);
      CREATE TABLE sdr_message_facts(prospect_email text);
      CREATE TABLE sdr_settings(id int,start_date_grace_days int);INSERT INTO sdr_settings VALUES(1,30)`);
  });
  afterAll(async () => await db.close());
  beforeEach(async () => {
    await q('TRUNCATE sdr_change_receipts,sdr_change_intents,sdr_lead_state,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_outreach_controls,sdr_message_facts');
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
    'a new contact staff emailed on another lead in 60 days': () => q(`INSERT INTO sdr_lead_state(pipedrive_lead_id,person_email,last_outgoing_mail_time) VALUES('lead-2',$1,NOW()-INTERVAL '5 days')`, [EMAIL]),
    'a new contact with a send on another lead': async () => {
      const id = (await q("INSERT INTO sdr_drafts(pipedrive_lead_id,status,contact_email_snapshot) VALUES('lead-2','sent',$1) RETURNING id", [EMAIL])).rows[0].id;
      await q("INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id) VALUES('s2',$1,'lead-2')", [id]);
    },
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
  const stillIn = {
    'a hold on another channel': () => hold('channel', 'linkedin', { channel: 'linkedin' }),
    'a released hold': () => hold('lead', 'lead-1', { lead: 'lead-1', status: 'released' }),
    "a hold on someone else's address": () => hold('recipient', 'someone@else.test'),
    'a hold tied to another lead': () => hold('recipient', EMAIL, { lead: 'lead-9' }),
    'one or two refused swaps': async () => { await attempt(['failed']); await attempt(['failed']); },
  };
  for (const [name, arrange] of Object.entries(stillIn)) {
    it(`keeps a lead with ${name}`, async () => { await clean(); await arrange(); expect(await candidates()).toHaveLength(1); });
  }
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
  const liveSkips = {
    company_edited_since: { lead: { organization_id: 77 } },
    contact_edited_since: { lead: { person_id: 78 } },
    sequence_started: { lead: { [FIELD_KEYS.SEQ]: 'Apollo:PB 2026-11-10' } },
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
  };
  for (const [reason, over] of Object.entries(liveSkips)) {
    it(`skips without writing when Pipedrive shows ${reason}`, async () => {
      await clean();
      const { pd, state } = fakePipedrive(over);
      expect(await swap((await candidates())[0], pd)).toEqual({ action: 'skip', reason });
      expect(await swap((await candidates())[0], pd, { dryRun: true })).toEqual({ action: 'skip', reason });
      expect(state.patches).toHaveLength(0);
      expect(state.created).toHaveLength(0);
      expect(await swapIntents()).toBe(0);
    });
  }
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
    const stats = await runCompanySwap(db.pool, { pd, companyId: COMPANY, dryRun: true });
    expect(stats).toMatchObject({ candidates: 1, wouldApply: 1, applied: 0 });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect(await swapIntents()).toBe(0);
  });

  // Pipedrive has no conditional write. A staff edit that lands after the checks is caught by
  // the read made right before the PATCH.
  const staffEdits = {
    'moves the lead to another company': lead => { lead.organization_id = 77; },
    'picks another contact': lead => { lead.person_id = 78; },
    'moves the stage on to GC': lead => { lead[STAGE] = 'GC'; },
    'starts a sequence': lead => { lead[FIELD_KEYS.SEQ] = 'Apollo:PB 2026-11-11'; },
    'archives the lead': lead => { lead.is_archived = true; },
  };
  for (const [what, edit] of Object.entries(staffEdits)) {
    it(`stands down when staff ${what} between the checks and the write`, async () => {
      await clean();
      const { pd, state } = fakePipedrive({ onLeadRead: s => { if (s.leadReads === 2) edit(s.lead); } });
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

  it('two attempts at once create one contact and write once', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const [row] = await candidates();
    const results = await Promise.all([swap(row, pd), swap(row, pd)]);
    expect(results.map(r => r.action).sort()).toEqual(['applied', 'skip']);
    expect(results.find(r => r.action === 'skip').reason).toBe('no_longer_eligible');
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
    const results = await Promise.all([swap(older, pd), swap(newer, pd)]);
    expect(results.map(r => r.action).sort()).toEqual(['applied', 'skip']);
    expect(state.created).toHaveLength(1);
    expect(state.patches).toHaveLength(1);
    expect(await swapIntents()).toBe(1);
  });

  it('a write Pipedrive refused is recorded as failed and tried again on a later proposal', async () => {
    await clean();
    const failing = fakePipedrive({ failPatch: 400 });
    const stats = await runCompanySwap(db.pool, { pd: failing.pd, companyId: COMPANY });
    expect(stats).toMatchObject({ applied: 0, failed: 1 });
    expect(await receipts()).toEqual(['failed']);
    expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
    // Same proposal row: the action id repeats, so nothing is attempted twice for it.
    expect(await runCompanySwap(db.pool, { pd: failing.pd, companyId: COMPANY })).toMatchObject({ applied: 0, failed: 0, skipped: { already_attempted: 1 } });
    expect(failing.state.created).toHaveLength(1);
    // The next refresh repeats the proposal: one more try, reusing the contact created earlier.
    await held({ hoursAgo: 0 });
    const working = fakePipedrive({ persons: [{ id: 900, name: 'Pat Hardy', email: EMAIL, org: NEW_ORG }] });
    expect(await runCompanySwap(db.pool, { pd: working.pd, companyId: COMPANY })).toMatchObject({ applied: 1 });
    expect(working.state.created).toHaveLength(0);
  });
  it('a contact that cannot be created is a failed attempt and the lead is left alone', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    pd.createPerson = async () => { throw Object.assign(new Error('person refused'), { status: 400 }); };
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY })).toMatchObject({ applied: 0, failed: 1 });
    expect(state.patches).toHaveLength(0);
    expect(await receipts()).toEqual(['failed']);
  });
  const unknownOutcomes = { 'answers with a server error': { failPatch: 500 }, 'never answers': { hangPatch: true } };
  for (const [what, over] of Object.entries(unknownOutcomes)) {
    it(`a write that ${what} may have gone through: recorded as unresolved and never repeated`, async () => {
      await clean();
      const { pd, state } = fakePipedrive(over);
      const stats = await runCompanySwap(db.pool, { pd, companyId: COMPANY, callDeadlineMs: 80 });
      expect(stats).toMatchObject({ applied: 0, failed: 0, unresolved: 1 });
      expect(await receipts()).toEqual(['unresolved']);
      expect(state.notes).toHaveLength(0);
      // Local state is left for the next sync, which reads what the lead really holds.
      expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
      await held({ hoursAgo: 0 });
      expect(await candidates()).toHaveLength(0);
      const again = fakePipedrive();
      expect(await runCompanySwap(db.pool, { pd: again.pd, companyId: COMPANY })).toMatchObject({ candidates: 0, applied: 0 });
      expect(again.state.patches).toHaveLength(0);
    });
  }
  it('a write that cannot be confirmed afterwards is unresolved, with no note and no local change', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ onLeadRead: s => { if (s.leadReads === 3) s.lead.organization_id = 77; } });
    expect(await swap((await candidates())[0], pd)).toMatchObject({ action: 'unresolved' });
    expect(state.patches).toHaveLength(1);
    expect(state.notes).toHaveLength(0);
    expect(await receipts()).toEqual(['unresolved']);
    expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
  });

  // Two leads with a clean held change each.
  const two = async () => {
    await clean();
    await leadState({ pipedrive_lead_id: 'lead-2' });
    await held({ lead: 'lead-2', hoursAgo: 72, email: 'pat.hardy@hardyconstruction.test' }); await held({ lead: 'lead-2', email: 'pat.hardy@hardyconstruction.test' });
    const fake = fakePipedrive();
    const leads = {};
    const of = id => (leads[id] ||= { id, organization_id: OLD_ORG, person_id: OLD_PERSON, owner_id: 7, is_archived: false, [STAGE]: 'PB' });
    fake.pd.getLead = async id => { fake.state.calls++; return { ...of(id) }; };
    fake.pd.swapLeadCompany = async (id, fields) => { fake.state.patches.push({ leadId: id, ...fields }); Object.assign(of(id), { organization_id: fields.organizationId, person_id: fields.personId, [STAGE]: fields.stage }); };
    return fake;
  };
  it('stops at the per-run limit', async () => {
    const { pd, state } = await two();
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY, limit: 1, dryRun: true })).toMatchObject({ candidates: 2, wouldApply: 1 });
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY, limit: 0, dryRun: true })).toMatchObject({ candidates: 2, wouldApply: 0 });
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY, limit: 1 })).toMatchObject({ candidates: 2, applied: 1 });
    expect(state.patches).toHaveLength(1);
  });
  it('stops when the time budget is spent', async () => {
    const { pd, state } = await two();
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY, budgetMs: 0 })).toMatchObject({ candidates: 2, applied: 0, outOfTime: true });
    expect(state.calls).toBe(0);
  });
  it('stops at a Pipedrive rate limit on a read', async () => {
    const { pd, state } = await two();
    pd.getLead = async () => { state.calls++; throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY })).toMatchObject({ applied: 0, failed: 0, rateLimited: true });
    expect(state.calls).toBe(1);
  });
  it('stops at a Pipedrive rate limit on the write, which is a refusal', async () => {
    const { pd, state } = await two();
    pd.swapLeadCompany = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY })).toMatchObject({ applied: 0, rateLimited: true });
    expect(await receipts()).toEqual(['failed']);
    expect(state.created).toHaveLength(1);
  });
  it('stops at a Pipedrive rate limit on the note, after the one swap it already made', async () => {
    const { pd, state } = await two();
    pd.addNote = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY })).toMatchObject({ applied: 1, rateLimited: true });
    expect(state.patches).toHaveLength(1);
    expect(await receipts()).toEqual(['confirmed']);
  });
  it('a hung read costs one deadline and the run moves on', async () => {
    const { pd } = await two();
    const getLead = pd.getLead;
    pd.getLead = id => (id === 'lead-1' ? new Promise(() => {}) : getLead(id));
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY, callDeadlineMs: 80 })).toMatchObject({ applied: 1, failed: 1 });
    expect(await swapIntents()).toBe(1);
  });
  it('does not read Pipedrive again for a proposal row it already checked and skipped', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ newOrg: { closed_deals_count: 2 } });
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY })).toMatchObject({ skipped: { customer_company: 1 } });
    const calls = state.calls;
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY })).toMatchObject({ skipped: { checked_earlier: 1 } });
    expect(state.calls).toBe(calls);
    // The next refresh writes a new proposal row, and that one is checked.
    await held({ hoursAgo: 0 });
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY })).toMatchObject({ skipped: { customer_company: 1 } });
    expect(state.calls).toBeGreaterThan(calls);
  });
});
