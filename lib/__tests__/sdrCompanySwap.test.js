import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportingTestDb } from './reportingTestDb.js';
import { normalizeCompany, nameMatchesAddress, stageDecision, selectSwapCandidates, swapOne, runCompanySwap, HELD_REASON, SWAP_REASON } from '../sdrCompanySwap.js';
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

describe('nameMatchesAddress', () => {
  it('accepts a mailbox that carries the name, a clipped surname, or the initials', () => {
    for (const [name, email] of [['David Strickland', 'dstrickland@ehc.test'], ['Pat Hardy', 'pat.hardy@x.test'], ['Dana Strickland', 'dstrick@x.test'],
      ['Vaughn Prost', 'vxp@prostbuilders.test'], ['J.J. Hickey', 'jjh@x.test'], ['Paul Ulloa-Jarrin', 'pulloa@x.test'], ['Mike Einhauf Sr', 'mike@x.test']]) {
      expect(nameMatchesAddress(name, email), `${name} ${email}`).toBe(true);
    }
  });
  it("rejects another person's mailbox, a shared mailbox and a company name", () => {
    for (const [name, email] of [['Elvira Bolanos', 'david@grigolla.test'], ['Marc Petillon', 'info@towpath.test'], ['Ryan Farmer', 'estimating@pap.test'],
      ['TJ Shea', 'pc@x.test'], ['Kirt Courkamp', 'tcourkamp@jrcc.test'], ['Performance Construction Group, Llc', 'quotes@performance.test'], ['', 'pat@x.test'], ['Pat Hardy', '']]) {
      expect(nameMatchesAddress(name, email), `${name} ${email}`).toBe(false);
    }
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

// A fake Pipedrive holding one lead, its companies and people.
function fakePipedrive(over = {}) {
  const state = {
    lead: { id: 'lead-1', organization_id: OLD_ORG, person_id: OLD_PERSON, owner_id: 7, is_archived: false, [STAGE]: 'PB', [FIELD_KEYS.SEQ]: null, ...over.lead },
    orgs: { [OLD_ORG]: { id: OLD_ORG, name: 'Decker Construction Services, Inc.' }, [NEW_ORG]: { id: NEW_ORG, name: 'Hardy Construction, LLC', ...over.newOrg } },
    persons: over.persons || [],
    created: [], patches: [], notes: [], failPatch: over.failPatch || false,
  };
  const pd = {
    getLead: async () => (over.leadMissing ? null : { ...state.lead }),
    getOrganization: async id => state.orgs[id] || null,
    findPersonsByEmail: async email => state.persons.filter(p => p.email === email).map(p => ({ id: p.id, name: p.name, emails: [p.email], organization: p.org ? { id: p.org } : null })),
    getPerson: async id => { const p = state.persons.find(x => x.id === id); return p ? { id: p.id, name: p.name, last_outgoing_mail_time: p.lastOut || null, last_incoming_mail_time: p.lastIn || null } : null; },
    createPerson: async input => { const p = { id: 900 + state.created.length, name: input.name }; state.created.push(input); return p; },
    swapLeadCompany: async (leadId, fields) => {
      if (state.failPatch) throw Object.assign(new Error('Pipedrive PATCH /leads/lead-1 → 500: boom'), { status: 500 });
      state.patches.push({ leadId, ...fields });
      state.lead.organization_id = fields.organizationId; state.lead.person_id = fields.personId;
      if (fields.stage !== undefined) state.lead[STAGE] = fields.stage;
    },
    addNote: async note => { state.notes.push(note); },
  };
  return { pd, state };
}

describe.skipIf(!db)('company swap against the journal and lead tables', () => {
  const q = (sql, params) => db.pool.query(sql, params);
  let seq = 0;
  // One held proposal row, as the n8n refresh writes it.
  const held = async ({ lead = 'lead-1', newOrg = NEW_ORG, seenOrg = OLD_ORG, seenPerson = OLD_PERSON, company = 'Hardy Construction, LLC',
    stage = 'LBA', email = 'phardy@hardyconstruction.test', name = 'Pat Hardy', hoursAgo = 2 } = {}) =>
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
        start_date date,outreach_status text,last_outgoing_mail_time timestamptz,crm_person_source_updated_at timestamptz,crm_person_source_read_started_at timestamptz);
      CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,status text,contact_email_snapshot text);
      CREATE TABLE sdr_sends(id text,draft_id uuid,pipedrive_lead_id text);
      CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz);
      CREATE TABLE sdr_outreach_controls(company_id text,status text,scope_kind text,scope_id text);
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
      cmd_company: 'Hardy Construction, LLC', cand_email: 'phardy@hardyconstruction.test', cand_name: 'Pat Hardy' });
  });

  const excluded = {
    'a .co send on the lead': () => q("INSERT INTO sdr_sends(id,pipedrive_lead_id) VALUES('s','lead-1')"),
    'any draft on the lead, a rejected one included': () => q("INSERT INTO sdr_drafts(pipedrive_lead_id,status) VALUES('lead-1','rejected')"),
    'a hand email on the lead in the last 60 days': () => q("INSERT INTO sdr_outreach_log VALUES('lead-1','pipedrive',NOW()-INTERVAL '20 days')"),
    'an active hold on the lead': () => q("INSERT INTO sdr_outreach_controls VALUES($1,'active','lead','lead-1')", [COMPANY]),
    'a new contact .co has already emailed': () => q("INSERT INTO sdr_message_facts VALUES(' PHARDY@hardyconstruction.test')"),
    'a new contact staff emailed on another lead in 60 days': () => q(`INSERT INTO sdr_lead_state(pipedrive_lead_id,person_email,last_outgoing_mail_time) VALUES('lead-2','phardy@hardyconstruction.test',NOW()-INTERVAL '5 days')`),
    'a new contact with a send on another lead': async () => {
      const id = (await q("INSERT INTO sdr_drafts(pipedrive_lead_id,status,contact_email_snapshot) VALUES('lead-2','sent','phardy@hardyconstruction.test') RETURNING id")).rows[0].id;
      await q("INSERT INTO sdr_sends(id,draft_id,pipedrive_lead_id) VALUES('s2',$1,'lead-2')", [id]);
    },
    'CMD naming a second company inside 14 days': () => held({ company: 'Other Builders Inc', newOrg: 99, hoursAgo: 200 }),
  };
  for (const [name, arrange] of Object.entries(excluded)) {
    it(`leaves out a lead with ${name}`, async () => { await clean(); await arrange(); expect(await candidates()).toHaveLength(0); });
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

  it('applies the swap: one PATCH, a new contact, a note, a journal entry and fresh local state', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const [row] = await candidates();
    const result = await swapOne(db.pool, row, { pd, companyId: COMPANY });
    expect(result).toMatchObject({ action: 'applied', toCompany: 'Hardy Construction, LLC', stageFrom: 'PB', stageTo: 'LBA', personCreated: true });
    expect(state.created).toEqual([{ name: 'Pat Hardy', email: 'phardy@hardyconstruction.test', phone: '555-0100', orgId: NEW_ORG, ownerId: 7 }]);
    expect(state.patches).toEqual([{ leadId: 'lead-1', organizationId: NEW_ORG, personId: 900, stage: 'LBA' }]);
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].content).toBe("[Auto] Company updated from CMD: Decker Construction Services, Inc. to Hardy Construction, LLC. Project Stage: PB to LBA. Contact set to Pat Hardy (phardy@hardyconstruction.test), the contact CMD lists for this company. Role not confirmed.");
    const local = (await q("SELECT * FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0];
    expect(local).toMatchObject({ pipedrive_org_id: String(NEW_ORG), pipedrive_person_id: '900', person_email: 'phardy@hardyconstruction.test', project_stage: 'LBA', trigger_type: 'LBA', outreach_status: 'clear' });
    const journal = (await q(`SELECT i.action_id, r.status, r.observed_fields FROM sdr_change_intents i JOIN sdr_change_receipts r USING(action_id) WHERE i.reason=$1`, [SWAP_REASON])).rows;
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ status: 'confirmed', observed_fields: { organization_id: NEW_ORG, person_id: '900', [STAGE]: 'LBA' } });
    // Applied once: the same held proposal is never picked up again.
    await held({ hoursAgo: 0 });
    expect(await candidates()).toHaveLength(0);
  });

  it('reuses the one person already holding the address at the new company', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ id: 31, name: 'Pat Hardy', email: 'phardy@hardyconstruction.test', org: NEW_ORG, lastOut: '2026-01-05 10:00:00' }] });
    const result = await swapOne(db.pool, (await candidates())[0], { pd, companyId: COMPANY });
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
    company_name_mismatch: { newOrg: { name: 'R.E. Hardy Construction' } },
    customer_company: { newOrg: { closed_deals_count: 2 } },
    open_deal_company: { newOrg: { open_deals_count: 1 } },
    contact_in_conversation: { persons: [{ id: 31, name: 'Pat', email: 'phardy@hardyconstruction.test', org: NEW_ORG, lastOut: recently }] },
    contact_on_other_record: { persons: [{ id: 31, name: 'Pat', email: 'phardy@hardyconstruction.test', org: 444 }] },
  };
  for (const [reason, over] of Object.entries(liveSkips)) {
    it(`skips without writing when Pipedrive shows ${reason}`, async () => {
      await clean();
      const { pd, state } = fakePipedrive(over);
      expect(await swapOne(db.pool, (await candidates())[0], { pd, companyId: COMPANY })).toEqual({ action: 'skip', reason });
      expect(state.patches).toHaveLength(0);
      expect(state.created).toHaveLength(0);
      expect((await q('SELECT 1 FROM sdr_change_intents WHERE reason=$1', [SWAP_REASON])).rowCount).toBe(0);
    });
  }
  it('skips a change that is the same company under another record or a free-mail contact', async () => {
    await clean({ held: { company: 'Decker Construction Services' } });
    const twin = fakePipedrive({ newOrg: { name: 'Decker Construction Services LLC' } });
    expect(await swapOne(db.pool, (await candidates())[0], { pd: twin.pd, companyId: COMPANY })).toEqual({ action: 'skip', reason: 'same_company' });
    const { pd } = fakePipedrive();
    expect(await swapOne(db.pool, { ...(await candidates())[0], cmd_company: 'Hardy Construction', cand_email: 'hardy@gmail.com' }, { pd, companyId: COMPANY })).toEqual({ action: 'skip', reason: 'free_mail_contact' });
  });

  const strangers = { "another person's mailbox": { name: 'Elvira Bolanos', email: 'david@hardyconstruction.test' },
    'a shared mailbox': { name: 'Pat Hardy', email: 'info@hardyconstruction.test' },
    'the company name as the contact': { name: 'Hardy Construction, LLC', email: 'quotes@hardyconstruction.test' } };
  for (const [what, contact] of Object.entries(strangers)) {
    it(`skips a contact whose name does not fit the mailbox: ${what}`, async () => {
      await clean({ held: contact });
      const { pd, state } = fakePipedrive();
      expect(await swapOne(db.pool, (await candidates())[0], { pd, companyId: COMPANY })).toEqual({ action: 'skip', reason: 'contact_name_mismatch' });
      expect(state.patches).toHaveLength(0);
      expect(state.created).toHaveLength(0);
    });
  }
  it('skips an existing Pipedrive contact whose name does not fit the mailbox', async () => {
    await clean();
    const { pd, state } = fakePipedrive({ persons: [{ id: 31, name: 'Hardy Construction, LLC - Estimator', email: 'phardy@hardyconstruction.test', org: NEW_ORG }] });
    // "hardy" is in the mailbox name, so this one fits; a different person's name does not.
    expect(await swapOne(db.pool, (await candidates())[0], { pd, companyId: COMPANY, dryRun: true })).toMatchObject({ action: 'would_apply' });
    const other = fakePipedrive({ persons: [{ id: 31, name: 'Lynnette Moss', email: 'phardy@hardyconstruction.test', org: NEW_ORG }] });
    expect(await swapOne(db.pool, (await candidates())[0], { pd: other.pd, companyId: COMPANY })).toEqual({ action: 'skip', reason: 'contact_name_mismatch' });
    expect(state.patches).toHaveLength(0);
  });

  it('a dry run reads only', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const stats = await runCompanySwap(db.pool, { pd, companyId: COMPANY, dryRun: true });
    expect(stats).toMatchObject({ candidates: 1, wouldApply: 1, applied: 0 });
    expect(state.patches).toHaveLength(0);
    expect(state.created).toHaveLength(0);
    expect((await q('SELECT 1 FROM sdr_change_intents WHERE reason=$1', [SWAP_REASON])).rowCount).toBe(0);
  });

  it('stands down when a draft appears between selection and the write', async () => {
    await clean();
    const { pd, state } = fakePipedrive();
    const [row] = await candidates();
    await q("INSERT INTO sdr_drafts(pipedrive_lead_id,status) VALUES('lead-1','pending')");
    expect(await swapOne(db.pool, row, { pd, companyId: COMPANY })).toEqual({ action: 'skip', reason: 'draft_or_send_appeared' });
    expect(state.patches).toHaveLength(0);
    expect((await q('SELECT status FROM sdr_change_receipts')).rows).toEqual([{ status: 'superseded' }]);
  });

  it('records a failed write and retries it on a later proposal, up to the attempt limit', async () => {
    await clean();
    const failing = fakePipedrive({ failPatch: true });
    const stats = await runCompanySwap(db.pool, { pd: failing.pd, companyId: COMPANY });
    expect(stats).toMatchObject({ applied: 0, failed: 1 });
    expect((await q('SELECT status FROM sdr_change_receipts')).rows).toEqual([{ status: 'failed' }]);
    expect((await q("SELECT pipedrive_org_id FROM sdr_lead_state WHERE pipedrive_lead_id='lead-1'")).rows[0].pipedrive_org_id).toBe(String(OLD_ORG));
    // Same proposal row: the action id repeats, so nothing is attempted twice for it.
    expect(await runCompanySwap(db.pool, { pd: failing.pd, companyId: COMPANY })).toMatchObject({ applied: 0, failed: 0, skipped: { already_attempted: 1 } });
    // The next refresh repeats the proposal: one more try, reusing the contact created earlier.
    await held({ hoursAgo: 0 });
    const working = fakePipedrive({ persons: [{ id: 900, name: 'Pat Hardy', email: 'phardy@hardyconstruction.test', org: NEW_ORG }] });
    expect(await runCompanySwap(db.pool, { pd: working.pd, companyId: COMPANY })).toMatchObject({ applied: 1 });
    expect(working.state.created).toHaveLength(0);
  });

  it('stops at the per-run limit', async () => {
    await clean();
    await leadState({ pipedrive_lead_id: 'lead-2' });
    await held({ lead: 'lead-2', hoursAgo: 72, email: 'pat.hardy@hardyconstruction.test' }); await held({ lead: 'lead-2', email: 'pat.hardy@hardyconstruction.test' });
    const { pd } = fakePipedrive();
    pd.getLead = async id => ({ id, organization_id: OLD_ORG, person_id: OLD_PERSON, owner_id: 7, is_archived: false, [STAGE]: 'PB' });
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY, limit: 1, dryRun: true })).toMatchObject({ candidates: 2, wouldApply: 1 });
    expect(await runCompanySwap(db.pool, { pd, companyId: COMPANY, limit: 0, dryRun: true })).toMatchObject({ candidates: 2, wouldApply: 0 });
  });
});
