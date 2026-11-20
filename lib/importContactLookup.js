// The CRM lead already exists. A lookup receipt never authorizes another CRM create.
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import * as pd from './pipedriveClient.js';
import { isCustomerLead } from './customerSuppression.js';
import { getOutreachControls } from './sdrOutreachControls.js';
import { canonicalVerdict, looksLikeEmail } from './emailVerify.js';
import { checkSdrAddressInTransaction } from './sdrAddressVerification.js';

const COMPANY = '13105180';
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const STAGE = '7c1852c27664d1118f75660223a6af9e99d10f2c';
const SEQUENCE = '48c4bb758e8642d6372c7fff9df3c0ea716170f1';
export const lookupMessages = Object.freeze({
  verified_address: 'The current email has a valid verification result.',
  uncertain_address: 'The current email has an uncertain verification result.',
  verification_pending: 'The current email is awaiting a deliverability check.',
  customer_review: 'Existing customer. Review the contact in Pipedrive.',
  sequence_active: 'An existing sequence is recorded on the lead.',
  outreach_held: 'Contact lookup is on hold for this lead.',
  candidate_review: 'A possible contact is ready for staff review.',
  no_match: 'The lookup completed without a suitable contact.',
  missing_domain: 'Add a confirmed website to the linked Pipedrive company, then retry the lookup.',
  waiting_for_credits: 'Waiting for Apollo lead credits.',
  lookup_unavailable: 'The lookup could not be completed. Retry it on the existing lead.',
  lookup_uncertain: 'A lookup may already have run. Review the existing attempt before retrying.',
  not_applicable: 'Contact lookup does not apply to this project stage.',
  recently_checked: 'A recent lookup was already recorded.',
  skipped_recent: 'A recent lookup was already recorded.',
  ready_for_lookup: 'Company and credit checks passed.',
});
const result = (lead_id, lookup_status, extra = {}) => ({
  lead_id, lookup_status, message: lookupMessages[lookup_status], ...extra,
});
const finishStatuses = new Set(['candidate_review','customer_review','no_match','waiting_for_credits','lookup_unavailable','lookup_uncertain']);
const conclusive = new Set(['candidate_review','no_match','customer_review']);
const protectedInputs = new Set(['customer','customer_review','sequence_active','skipped_recent']);
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

export function companyWebsiteDomain(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    const value = input.trim();
    const u = new URL(value.includes('://') ? value : 'https://' + value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const domain = domainToASCII(u.hostname).toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (domain.length > 253 || isIP(domain) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
    if (/(^|\.)(gmail\.com|google\.com|hotmail\.com|outlook\.com|yahoo\.com|linkedin\.com|facebook\.com|instagram\.com|wixsite\.com|godaddysites\.com|wordpress\.com|example\.com)$/.test(domain)) return null;
    return domain;
  } catch { return null; }
}

export async function ensureContactLookups(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_contact_lookups (
    company_id text NOT NULL, lead_id uuid NOT NULL, lookup_status text NOT NULL,
    context_hash text NOT NULL, attempt_id uuid, attempt_kind text,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,lead_id)
  )`);
}

async function creditBalance() {
  const response = await fetch('https://api.apollo.io/api/v1/usage_stats/credit_usage_stats', {
    method: 'POST', headers: {'x-api-key': process.env.APOLLO_API_KEY, 'content-type':'application/json'},
    body: '{}', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error('credit_balance_unavailable');
  const balance = (await response.json()).credit_usage_stats?.lead_credit?.left_over;
  if (!Number.isFinite(balance) || balance < 0) throw Error('credit_balance_unavailable');
  return balance;
}
const crmId = value => typeof value === 'object' ? value?.value ?? value?.id : value;
async function readContext(leadId) {
  const me = await pd.getCurrentCompanyUser();
  if (String(me?.company_id) !== COMPANY || me.company_domain !== 'proswpppllc') throw Error('lookup_company_mismatch');
  const lead = await pd.getLead(leadId, {failFast:true});
  if (lead?.id !== leadId) throw Error('lookup_lead_mismatch');
  const personId = crmId(lead.person_id), orgId = crmId(lead.organization_id);
  const [person, org] = await Promise.all([
    personId ? pd.getPerson(personId, {failFast:true}) : null,
    orgId ? pd.getOrganization(orgId, {failFast:true}) : null,
  ]);
  if ((personId && String(person?.id) !== String(personId)) || (orgId && String(org?.id) !== String(orgId))) throw Error('lookup_identity_mismatch');
  const emails = person?.email;
  const primary = Array.isArray(emails) && (emails.find(e=>e.primary) || emails[0]);
  const email = typeof primary?.value === 'string' ? primary.value.trim().toLowerCase() : '';
  if (process.env.SDR_SUPPRESS_CUSTOMERS === 'off') throw Error('lookup_customer_check_unavailable');
  const customer = !!await isCustomerLead(leadId,{leadRecord:{...lead, organization:org}});
  return {email, domain:companyWebsiteDomain(org?.website), personId, orgId, customer,
    stage:lead[STAGE], sequence:!!lead[SEQUENCE],
    held:lead.is_archived !== false || Boolean(personId && crmId(person.org_id) && String(crmId(person.org_id)) !== String(orgId)),
  };
}
const defaults = {
  readContext, creditBalance,
  holds: async (db, leadId, email) => (await getOutreachControls(db, {
    leadId, companyId:COMPANY, channel:'email', recipientEmail:email, serviceId:'import-contact-lookup',
  })).length > 0,
  verdict: async (db, leadId, email) => {
    const v = await checkSdrAddressInTransaction(db, {leadId, email, companyId:COMPANY}, {readOnly:true, cacheOnly:true});
    return canonicalVerdict(v?.status);
  },
};

export async function importContactLookup(pool, input, deps = defaults) {
  const leadId = input?.lead_id;
  if (typeof leadId !== 'string' || !UUID.test(leadId)) throw invalid('Invalid lead ID');
  if (input.protection != null && !protectedInputs.has(input.protection)) throw invalid('Invalid lookup protection');
  const finish = input.attempt_id != null || input.lookup_status != null;
  if (finish && (!UUID.test(input.attempt_id || '') || !finishStatuses.has(input.lookup_status))) throw invalid('Invalid lookup result');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['import-contact:' + leadId]);
    const prior = (await db.query('SELECT * FROM lead_contact_lookups WHERE company_id=$1 AND lead_id=$2 FOR UPDATE',[COMPANY,leadId])).rows[0];
    let output;
    if (finish) {
      if (!prior || prior.attempt_id !== input.attempt_id) throw invalid('Lookup attempt mismatch',409);
      if (prior.lookup_status !== 'running' && prior.lookup_status !== input.lookup_status) throw invalid('Lookup already recorded',409);
      if (prior.attempt_kind === 'customer' && !['customer_review','lookup_unavailable','lookup_uncertain'].includes(input.lookup_status)
          || prior.attempt_kind !== 'customer' && input.lookup_status === 'customer_review') throw invalid('Lookup branch mismatch',409);
      if (prior.lookup_status === 'running') await db.query('UPDATE lead_contact_lookups SET lookup_status=$3,updated_at=now() WHERE company_id=$1 AND lead_id=$2',[COMPANY,leadId,input.lookup_status]);
      output = result(leadId,input.lookup_status);
    } else if (prior && ['running','lookup_uncertain'].includes(prior.lookup_status)) {
      output = result(leadId,'lookup_uncertain');
    } else {
      const ctx = await deps.readContext(leadId);
      const hash = createHash('sha256').update(JSON.stringify(ctx)).digest('hex');
      let status;
      if (ctx.held || !['AGC','LBA'].includes(ctx.stage) || await deps.holds(db,leadId,ctx.email)) status='outreach_held';
      else if (ctx.sequence || input.protection==='sequence_active') status='sequence_active';
      else if (prior && prior.context_hash===hash && conclusive.has(prior.lookup_status) &&
               Date.now()-new Date(prior.updated_at).getTime()<30*86400000 && input.force!==true && input.winner_changed!==true) {
        await db.query('COMMIT');
        return result(leadId,prior.lookup_status);
      }
      else if (ctx.customer || ['customer','customer_review'].includes(input.protection)) status='customer_review';
      else {
        const verdict = looksLikeEmail(ctx.email) ? await deps.verdict(db,leadId,ctx.email) : 'hard_fail';
        if (verdict==='valid') status='verified_address';
        else if (verdict==='soft') status='uncertain_address';
        else if (verdict!=='hard_fail') status='verification_pending';
        else if (!ctx.domain) status='missing_domain';
        else if ((!prior || prior.lookup_status==='skipped_recent') && input.protection==='skipped_recent' && input.force!==true && input.winner_changed!==true) status='skipped_recent';
        else {
          try { status=await deps.creditBalance()>0 ? 'ready_for_lookup' : 'waiting_for_credits'; }
          catch { status='lookup_unavailable'; }
        }
      }
      const kind=status==='ready_for_lookup'?'standard':status==='customer_review'?'customer':null;
      const attempt=kind?randomUUID():null;
      await db.query(`INSERT INTO lead_contact_lookups(company_id,lead_id,lookup_status,context_hash,attempt_id,attempt_kind)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,lead_id) DO UPDATE SET
        lookup_status=EXCLUDED.lookup_status, context_hash=EXCLUDED.context_hash, attempt_id=EXCLUDED.attempt_id,
        attempt_kind=EXCLUDED.attempt_kind, updated_at=now()`,[COMPANY,leadId,kind?'running':status,hash,attempt,kind]);
      output=result(leadId,status,attempt?{attempt_id:attempt,...(kind==='standard'?{company_domain:ctx.domain}:{})}:{});
    }
    await db.query('COMMIT');
    return output;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export function registerImportContactLookup(app, pool) {
  app.post('/api/internal/import-contact-lookup',async(req,res)=>{
    if (!pool || process.env.SDR_CRM_COMPANY_ID!==COMPANY) return res.status(503).json({error:'Contact lookup unavailable'});
    try { return res.json(await importContactLookup(pool,req.body)); }
    catch (error) {
      const status=[400,409].includes(error.status)?error.status:503;
      return res.status(status).json({lead_id:req.body?.lead_id,lookup_status:'lookup_unavailable',message:lookupMessages.lookup_unavailable});
    }
  });
}
