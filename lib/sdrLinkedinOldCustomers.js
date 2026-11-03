// Derek's old customer list (CSV: name, company, email, LinkedIn if he has it) and the job
// change check that feeds lanes B (the contact moved) and C (whoever replaced them).
import { randomUUID } from 'node:crypto';
import { parseCsv } from './leadCsvNormalize.js';
import { companyKey } from './permitMatch.js';
import { companyKeyVariants } from './customerSuppression.js';
import { canonicalProfile } from './sdrLinkedinStore.js';
import { APIFY_ACTORS } from './apifyClient.js';
import { normalizeApifyProfile, US_STATES } from './sdrLinkedinSearch.js';

const fail = code => Object.assign(new Error(code), { code });
const HEADERS = {
  fullName: ['name', 'full name', 'contact name', 'contact'],
  firstName: ['first name'],
  lastName: ['last name'],
  company: ['company', 'company name', 'customer'],
  email: ['email', 'primary email'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile'],
};
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function parseOldCustomerCsv(csvText) {
  const rows = parseCsv(String(csvText || '').replace(/^﻿/, ''));
  if (!rows.length) return { rows: [], errors: [{ row: 0, reason: 'empty_file' }] };
  const header = rows[0].map(h => clean(h).toLowerCase());
  const column = Object.fromEntries(Object.entries(HEADERS).map(([key, names]) => [key, header.findIndex(h => names.includes(h))]));
  if (column.company < 0 || (column.fullName < 0 && column.firstName < 0)) return { rows: [], errors: [{ row: 1, reason: 'headers_unrecognized' }] };
  const out = [], errors = [];
  rows.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const pick = key => (column[key] >= 0 ? clean(cells[column[key]]) : '');
    const firstName = pick('firstName'), lastName = pick('lastName');
    const fullName = pick('fullName') || clean(`${firstName} ${lastName}`);
    const company = pick('company');
    if (!fullName || !company) { errors.push({ row, reason: 'name_and_company_required' }); return; }
    const key = companyKey(company);
    if (!key) { errors.push({ row, reason: 'company_unreadable' }); return; }
    let linkedinUrl = null;
    const rawUrl = pick('linkedin');
    if (rawUrl) {
      try { linkedinUrl = canonicalProfile(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); }
      catch { errors.push({ row, reason: 'linkedin_url_not_profile' }); return; }
    }
    const email = pick('email').toLowerCase();
    const parts = fullName.split(' ');
    out.push({ row, fullName, firstName: firstName || parts[0] || null, lastName: lastName || parts.slice(1).join(' ') || null, company, companyKey: key, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null, linkedinUrl });
  });
  // Duplicates inside one file collapse on name + company, the same key as the table.
  const unique = new Map();
  for (const item of out) unique.set(`${item.fullName.toLowerCase()}|${item.companyKey}`, item);
  return { rows: [...unique.values()], errors };
}

export async function importOldCustomers(pool, { companyId, csvText, actor, dryRun = false }) {
  if (!pool || !companyId || !actor) throw fail('import_scope_required');
  const { rows, errors } = parseOldCustomerCsv(csvText);
  if (dryRun) return { dryRun: true, rows: rows.length, inserted: 0, updated: 0, errors, preview: rows.slice(0, 20) };
  const importId = randomUUID();
  let inserted = 0, updated = 0;
  for (const row of rows) {
    const result = await pool.query(`INSERT INTO sdr_linkedin_old_customers(company_id,import_id,full_name,first_name,last_name,company,company_key,email,linkedin_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(company_id,lower(full_name),company_key) DO UPDATE SET import_id=EXCLUDED.import_id,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,company=EXCLUDED.company,
        email=COALESCE(EXCLUDED.email,sdr_linkedin_old_customers.email),linkedin_url=COALESCE(EXCLUDED.linkedin_url,sdr_linkedin_old_customers.linkedin_url)
      RETURNING (xmax=0) AS inserted`, [companyId, importId, row.fullName, row.firstName, row.lastName, row.company, row.companyKey, row.email, row.linkedinUrl]);
    if (result.rows[0]?.inserted) inserted++; else updated++;
  }
  return { importId, rows: rows.length, inserted, updated, errors };
}

// One person's current job. A URL is read directly; otherwise a name + past company search.
// Zero hits is not_found and more than one is ambiguous: a same-name person is never guessed.
export async function lookupOldCustomer({ apify, row, now = new Date() }) {
  const observedAt = new Date(now).toISOString();
  let items;
  if (row.linkedin_url) {
    items = await apify.runActor({ actor: APIFY_ACTORS.profileScraper, input: { urls: [row.linkedin_url] }, allowEmpty: true });
    const people = items.map(item => normalizeApifyProfile(item, { observedAt, states: Object.keys(US_STATES) })).filter(p => p && p.profileUrl === row.linkedin_url);
    return people.length === 1 ? { status: 'found', person: people[0], matchedOn: 'url' } : { status: people.length ? 'ambiguous' : 'not_found' };
  }
  const first = row.first_name || String(row.full_name).split(' ')[0];
  const last = row.last_name || String(row.full_name).split(' ').slice(1).join(' ');
  if (!first || !last) return { status: 'not_found' };
  items = await apify.runActor({ actor: APIFY_ACTORS.profileSearch, input: { firstNames: [first], lastNames: [last], pastCompanies: [row.company], profileScraperMode: 'Full', maxItems: 5, takePages: 1 }, allowEmpty: true });
  const people = items.map(item => normalizeApifyProfile(item, { observedAt, states: Object.keys(US_STATES) })).filter(Boolean);
  if (people.length === 0) return { status: 'not_found' };
  if (people.length > 1) return { status: 'ambiguous', candidates: people.slice(0, 5).map(p => ({ profileUrl: p.profileUrl, title: p.title, company: p.company })) };
  return { status: 'found', person: people[0], matchedOn: 'name_past_company' };
}

export function classifyOldCustomer(row, lookup) {
  if (lookup.status !== 'found') return { status: lookup.status };
  const currentKey = lookup.person.company ? companyKey(lookup.person.company) : null;
  if (!currentKey) return { status: 'ambiguous' };
  const oldVariants = companyKeyVariants(row.company), newVariants = companyKeyVariants(lookup.person.company);
  const sameAsOld = name => { const keys = companyKeyVariants(name); return companyKey(name) === row.company_key || [...keys].some(key => oldVariants.has(key) || key === row.company_key); };
  if (currentKey === row.company_key || [...newVariants].some(key => oldVariants.has(key) || key === row.company_key)) return { status: 'same_company', currentKey };
  // "Moved" needs the old company as a finished job on their profile, not just a name match:
  // a same-name stranger at another company must never get "we miss doing your SWPPPs".
  if (!(lookup.person.pastCompanies || []).some(sameAsOld)) return { status: 'ambiguous', currentKey, reason: 'old_company_not_in_experience' };
  // "Manhattan" vs "Manhattan Construction" may be the same company: a wrong "you moved" message
  // is worse than none, so a name that extends the other is left for a manual pick.
  const a = row.company_key.split(' '), b = currentKey.split(' ');
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.every((token, i) => long[i] === token)) return { status: 'ambiguous', currentKey };
  return { status: 'moved', currentKey };
}

// Check up to `limit` imported rows. Moved -> staged in lane B (skip rules apply). Each old
// company with a moved or same-company row then queues one lane C search for its new precon lead.
const PERMANENT_STAGE_CODES = new Set(['already_candidate', 'provider_rejected', 'profile_conflict', 'identity_conflict', 'invalid_profile', 'invalid_candidate', 'source_conflict', 'classic_recipient_required', 'linkedin_identity_unverified']);
export async function checkOldCustomers(pool, { companyId, accountId = null, limit = 25, apify, actor, now = new Date(), stageMoved, stageReplacement }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('invalid_limit');
  if (!apify?.runActor) throw fail('apify_unconfigured');
  const rows = (await pool.query(`SELECT * FROM sdr_linkedin_old_customers WHERE company_id=$1 AND status IN ('imported','error') ORDER BY created_at LIMIT $2`, [companyId, limit])).rows;
  const counts = { checked: 0, moved: 0, same_company: 0, not_found: 0, ambiguous: 0, error: 0, stagedB: 0 };
  const staged = [], companies = new Map();let stopped = null;
  const record = (row, status, person, verdict, lookup, extra = {}) => pool.query(`UPDATE sdr_linkedin_old_customers SET status=$2,current_company=$3,current_company_key=$4,current_title=$5,provider_hint=$6,checked_at=$7,evidence=$8,linkedin_url=COALESCE(linkedin_url,$9) WHERE id=$1`,
    [row.id, status, person?.company || null, verdict?.currentKey || null, person?.title || null, person?.providerHint || null, now, JSON.stringify({ matchedOn: lookup?.matchedOn || null, candidates: lookup?.candidates || null, source: person?.evidence || null, ...(verdict?.reason ? { reason: verdict.reason } : {}), ...extra }), status === 'moved' || status === 'same_company' ? person?.profileUrl || null : null]);
  for (const row of rows) {
    counts.checked++;
    let lookup, verdict;
    try { lookup = await lookupOldCustomer({ apify, row, now }); verdict = classifyOldCustomer(row, lookup); }
    catch (error) {
      await pool.query(`UPDATE sdr_linkedin_old_customers SET status='error',checked_at=$2,evidence=$3 WHERE id=$1`, [row.id, now, JSON.stringify({ error: error?.code || 'lookup_failed' })]);
      counts.error++; continue;
    }
    const person = lookup.person || null;
    // A moved row is recorded as moved only once its staging decision is made (staged, or skipped
    // by a rule). A staging error leaves it 'error' so the next check retries it.
    if (verdict.status === 'moved' && stageMoved) {
      let result;
      try { result = await stageMoved({ row, person }); }
      catch (error) {
        // A refusal that will not change on retry (already a candidate, provider refused the profile,
        // identity conflict) is final: recorded as moved with the reason, never re-scraped.
        if (PERMANENT_STAGE_CODES.has(error?.code)) { await record(row, 'moved', person, verdict, lookup, { stageRefused: error.code }); counts.moved++; counts.stageRefused = (counts.stageRefused || 0) + 1; continue; }
        await record(row, 'error', person, verdict, lookup, { error: error?.code || 'stage_unavailable' }); counts.error++;
        if (error?.code === 'authentication') {
          // A 401 or 403 on the seat: restrict the account and stop, no further seat read.
          if (accountId) await pool.query("UPDATE sdr_linkedin_accounts SET status='restricted',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2", [companyId, accountId, now]);
          stopped = 'authentication'; break;
        }
        if (error?.code === 'read_budget_exhausted') { stopped = 'read_budget_exhausted'; break; }
        continue;
      }
      await record(row, 'moved', person, verdict, lookup, result?.skipped ? { stageSkipped: result.skipped } : {});
      counts.moved++;
      if (result?.staged) { counts.stagedB++; staged.push(result.staged); }
      companies.set(row.company_key, row.company);
      continue;
    }
    await record(row, verdict.status, person, verdict, lookup);
    counts[verdict.status] = (counts[verdict.status] || 0) + 1;
    // Lane C looks for whoever replaced a contact who left. A contact still at the company has no replacement.
    if (verdict.status === 'moved') companies.set(row.company_key, row.company);
  }
  const replacements = [];
  if (stageReplacement && !stopped) for (const company of companies.values()) {
    try { replacements.push({ company, result: await stageReplacement({ company }) }); }
    catch (error) { replacements.push({ company, error: error?.code || 'stage_unavailable' }); }
  }
  return { counts, staged, stopped, replacements: replacements.map(r => ({ company: r.company, staged: r.result?.staged?.length || 0, error: r.error || null })) };
}

export async function listOldCustomers(pool, { companyId, limit = 200 }) {
  const rows = (await pool.query(`SELECT id,full_name,company,email,linkedin_url,status,current_company,current_title,checked_at,evidence FROM sdr_linkedin_old_customers WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2`, [companyId, Math.min(500, limit)])).rows;
  const counts = (await pool.query(`SELECT status,COUNT(*)::int AS n FROM sdr_linkedin_old_customers WHERE company_id=$1 GROUP BY status`, [companyId])).rows;
  return { rows, counts: Object.fromEntries(counts.map(r => [r.status, r.n])) };
}
