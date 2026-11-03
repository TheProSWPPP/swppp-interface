// Derek's LinkedIn prospect lanes (2026-11-03): people outside Pipedrive, in four lanes.
// A new in the seat, B old contacts who moved, C whoever replaced them, D talking about stormwater.
// AGC, LBA and bid-invite contacts keep getting email and calls only; this lane skips them.
import { stageCandidate, resolveProspectIdentity, canonicalProfile, withLinkedinPersonLock } from './sdrLinkedinStore.js';
import { LINKEDIN_PROSPECT_SOURCE, renderLinkedinText, linkedinFollowupSteps } from './sdrLinkedinPolicy.js';
import { laneCampaignDefaults } from './sdrLinkedinLaneCopy.js';
import { hasRecentReply, normalEmail } from './recentReply.js';
import { companyKeyVariants, customerSuppressionEnabled, isCustomerCompany } from './customerSuppression.js';
import { companyKey } from './permitMatch.js';
import { classifyLinkedinProviderId } from './sdrLinkedinIdentity.js';
import { rampInviteBudget, rampWeek, localDayString, rampStartDay } from './sdrLinkedinRamp.js';
import { searchLane, titleRank, US_STATES, configuredStates, verifyLaneDAuthor } from './sdrLinkedinSearch.js';
import { reconcileOrderProjects } from './sdrOrderReconciliation.js';

export const PROSPECT_SOURCE = LINKEDIN_PROSPECT_SOURCE;
export const isProspect = candidate => candidate?.source === PROSPECT_SOURCE;
export { titleRank };
const fail = (code, detail) => Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) });
const ACTIVE = "state NOT IN ('archived','completed_no_reply','opted_out')";
const LANE_BASE = { B: 0, D: 1000, C: 2000, A: 3000 };

// Lower runs sooner: B warmest, D "go first", then C, then A; Directors > Chief Estimators >
// Senior PMs; active in the last 30 days first; lane A nearest the 4.5 month midpoint first.
export function lanePriority({ lane, titleRank: rank = 9, active30d = false, roleStartedOn = null, now = new Date() }) {
  let priority = (LANE_BASE[lane] ?? 4000) + Math.max(1, Math.min(9, Number(rank) || 9)) * 100 - (active30d ? 50 : 0);
  if (lane === 'A' && roleStartedOn) {
    const days = Math.round((new Date(now).getTime() - new Date(`${String(roleStartedOn).slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000);
    if (Number.isFinite(days)) priority += Math.min(49, Math.abs(days - 137));
  }
  return priority;
}

const normalName = value => String(value || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
const tableExists = async (db, name) => Boolean((await db.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name);
const NAME_SQL = column => `lower(regexp_replace(regexp_replace(coalesce(${column},''),'[^A-Za-z[:space:]''-]',' ','g'),'\\s+',' ','g'))`;

// Customer check for lanes A and D. A check that cannot be made holds the person, never passes.
export async function defaultCustomerCheck(company) {
  if (!customerSuppressionEnabled() || !process.env.PIPEDRIVE_API_TOKEN) throw fail('customer_check_unavailable');
  return isCustomerCompany(company);
}

// The first reason this person must not get LinkedIn outreach, or null. Local tables only
// (plus the cached customer index for lanes A and D), so it is re-run at dispatch.
// Lead names are matched without the organization: the organization name is not stored locally,
// so a same-name person on an open lead holds rather than passes.
export async function prospectSkipReason(db, { companyId, person = {}, lane, now = new Date(), excludeCandidateId = null, customerCheck = defaultCustomerCheck }) {
  const email = normalEmail(person.email);
  const fullName = normalName(person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' '));
  let profileUrl = null; try { profileUrl = person.profileUrl ? canonicalProfile(person.profileUrl) : null; } catch { profileUrl = null; }
  const personId = person.personId || (person.providerId ? `li:${person.providerId}` : null);
  if (!profileUrl && !personId) return 'identity_unverified';
  if ((await db.query(`SELECT 1 FROM sdr_linkedin_candidates WHERE company_id=$1 AND ${ACTIVE} AND ($2::uuid IS NULL OR id<>$2::uuid) AND (($3::text IS NOT NULL AND person_id=$3) OR ($4::text IS NOT NULL AND profile_url=$4)) LIMIT 1`, [companyId, excludeCandidateId, personId, profileUrl])).rows.length) return 'already_candidate';
  if (!await tableExists(db, 'sdr_lead_state') || !await tableExists(db, 'sdr_sends')) return 'source_unavailable';
  const who = `((NULLIF($1,'') IS NOT NULL AND lower(btrim(ls.person_email))=$1) OR (NULLIF($2,'') IS NOT NULL AND ${NAME_SQL('ls.person_name')}=$2))`;
  if ((await db.query(`SELECT 1 FROM sdr_sends s JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=s.pipedrive_lead_id WHERE s.status='enrolled' AND ${who} LIMIT 1`, [email, fullName])).rows.length) return 'pipedrive_active_sequence';
  if ((await db.query(`SELECT 1 FROM sdr_lead_state ls WHERE coalesce(ls.crm_status,'unknown') NOT IN ('archived','missing') AND (upper(coalesce(ls.trigger_type,'')) IN ('AGC','LBA') OR lower(btrim(coalesce(ls.lead_origin,''))) LIKE 'bid invite%') AND ${who} LIMIT 1`, [email, fullName])).rows.length) return 'agc_lba_or_bid_invite';
  if (email) {
    const since = new Date(new Date(now).getTime() - 3 * 86_400_000);
    if (await tableExists(db, 'sdr_message_facts') && (await db.query(`SELECT 1 FROM sdr_message_facts WHERE direction='out' AND lower(trim(prospect_email))=$1 AND occurred_at>$2 LIMIT 1`, [email, since])).rows.length) return 'emailed_last_3_days';
    if (await tableExists(db, 'sdr_engagement_events') && (await db.query(`SELECT 1 FROM sdr_engagement_events e JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=e.pipedrive_lead_id WHERE e.event_type='email_sent' AND e.occurred_at>$2 AND lower(btrim(ls.person_email))=$1 LIMIT 1`, [email, since])).rows.length) return 'emailed_last_3_days';
    if (await hasRecentReply(db, email)) return 'recent_reply';
  }
  if (person.providerId && (await db.query(`SELECT 1 FROM sdr_linkedin_events WHERE company_id=$1 AND kind='message_received' AND provider_id=$2 AND direction IS DISTINCT FROM 'out' LIMIT 1`, [companyId, person.providerId])).rows.length) return 'linkedin_conversation';
  if (lane === 'A' || lane === 'D') {
    if (!String(person.company || '').trim()) return 'customer_check_unavailable';
    let customer;
    try { customer = await customerCheck(person.company); } catch { return 'customer_check_unavailable'; }
    if (customer) return 'customer_company';
  }
  return null;
}

// One thin seat read per finalist (charged through the client's onRead budget).
export async function finalistCheck(client, { identifier }) {
  const profile = await client.getProfile({ identifier });
  const providerId = profile?.provider_id == null ? null : String(profile.provider_id);
  let profileUrl = null;
  try { profileUrl = canonicalProfile(profile?.profile_url || (profile?.public_identifier && `https://www.linkedin.com/in/${profile.public_identifier}/`)); } catch { profileUrl = null; }
  if (classifyLinkedinProviderId(providerId) !== 'classic' || !profileUrl) return { skip: 'linkedin_identity_unverified' };
  if (profile.is_relationship === true) return { skip: 'already_connected', providerId, profileUrl };
  if (profile.invitation?.status === 'PENDING') return { skip: 'pending_invite', providerId, profileUrl };
  return { skip: null, providerId, profileUrl };
}

const verified = (value, evidenceRef, observedAt) => (value ? { value, verified: true, evidenceRef, observedAt } : undefined);
// Facts each lane's copy may use. {state} is verified only from a served-state location.
export function prospectFacts({ lane, person, oldCompany = null, lastProject = null, states = configuredStates(), observedAt = new Date().toISOString() }) {
  const ref = `${person.evidence?.source || 'search'}:${person.evidence?.runId || 'run'}:${person.publicIdentifier || ''}`;
  const facts = {};
  const company = verified(person.company, ref, observedAt);
  if (company) facts.company = company;
  if (lane === 'B') { if (company) facts.newCompany = { ...company }; if (oldCompany) facts.oldCompany = { value: oldCompany, verified: true, evidenceRef: 'old_customer_csv', observedAt }; }
  if (person.stateCode && states.includes(person.stateCode)) facts.state = { value: US_STATES[person.stateCode], verified: true, evidenceRef: ref, observedAt };
  if (lane === 'C' && lastProject?.verified) facts.lastProject = { value: lastProject.value, verified: true, evidenceRef: lastProject.evidenceRef, observedAt };
  return facts;
}

// Lane C's {lastProject}: named only when exactly one most recent project for that company is
// an order backed by a verified Trello card (completed) or a verified won Pipedrive deal.
// Without a card or deal source nothing verifies, and the optional clause drops.
export async function resolveLastProject(pool, { company, readCards, readDeals }) {
  const keys = companyKeyVariants(company);
  if (!keys.size || (!readCards && !readDeals)) return null;
  const rows = (await pool.query('SELECT id, name, status, data FROM projects WHERE archived = FALSE ORDER BY id DESC LIMIT 500')).rows
    .filter(row => [...companyKeyVariants(row.data?.companyName)].some(key => keys.has(key)));
  if (!rows.length) return null;
  const [cards, deals] = await Promise.all([readCards ? readCards().catch(() => null) : null, readDeals ? readDeals().catch(() => null) : null]);
  const result = reconcileOrderProjects(rows, { cards: cards?.cards, cardCoverage: cards?.coverage, paidOptions: cards?.paidOptions, completedListId: cards?.completedListId, deals: deals?.deals, dealLinks: deals?.links, dealCoverage: deals?.coverage });
  const orders = result.items.filter(item => item.projectName && ((item.cardLinkState === 'verified' && item.jobCompleted === true) || (item.dealLinkState === 'verified' && item.crmStatus === 'won')));
  if (!orders.length) return null;
  const latest = orders[0];
  if (orders.filter(item => item.projectId === latest.projectId).length !== 1) return null;
  return { value: String(latest.projectName).trim(), verified: true, evidenceRef: `project:${latest.projectId}` };
}

// Insert one prospect and resolve its synthetic identity in one transaction. Lane D lands in
// copy_review until its post line is approved.
export async function stageProspect(pool, { companyId, accountId, lane, person, facts, actor, ownerId, oldCustomerId = null, post = null, now = new Date() }) {
  if (!ownerId) throw fail('owner_unconfigured');
  const observedAt = new Date(now).toISOString();
  const profileUrl = canonicalProfile(person.profileUrl);
  const rank = titleRank(person.title);
  const priority = lanePriority({ lane, titleRank: rank, active30d: person.active30d === true, roleStartedOn: person.roleStartedOn, now });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`linkedin:${companyId}:${accountId}:li:${person.providerId}`]);
    const context = { evidence: person.evidence, firstName: person.firstName || null, firstNameVerified: Boolean(person.firstName), fullName: [person.firstName, person.lastName].filter(Boolean).join(' ') || null, title: person.title || null, facts, ...(post ? { post } : {}), stagedBy: actor, stagedAt: observedAt };
    const row = await stageCandidate(db, { companyId, accountId, actor, sourceRow: { source: PROSPECT_SOURCE, sourceId: `${lane}:${profileUrl.split('/')[4]}`, observedAt, profileUrl, segment: lane, territory: person.stateCode || 'unknown', firm: person.company || null, role: person.title || null, context } });
    if (row.person_id || row.state !== 'staged') throw fail('already_candidate');
    const updated = (await db.query(`UPDATE sdr_linkedin_candidates SET lane=$2,priority=$3,title_rank=$4,active_30d=$5,role_started_on=$6,company_key=$7,resolved_email=$8,old_customer_id=$9,revision=revision+1 WHERE id=$1 RETURNING *`,
      [row.id, lane, priority, rank, person.active30d === true, person.roleStartedOn || null, person.company ? companyKey(person.company) || null : null, normalEmail(person.email) || null, oldCustomerId])).rows[0];
    const candidate = await resolveProspectIdentity(db, { candidateId: updated.id, expectedRevision: updated.revision, actor, transactional: true, evidence: { providerId: person.providerId, profileUrl, ownerId } });
    await db.query('COMMIT');
    return candidate;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') throw fail('already_candidate');
    throw error;
  } finally { db.release(); }
}

const countReasons = list => list.reduce((acc, item) => { acc[item.reason] = (acc[item.reason] || 0) + 1; return acc; }, {});

// Search -> normalize -> skip rules -> finalist GET -> stage. dryRun does everything except the
// finalist GET and the insert, and returns the would-stage list.
export async function stageLane({ pool, client, apify, salesNav, source = 'apify', lane, limit = 25, dryRun = false, companyId, accountId, actor, ownerId, states = configuredStates(), currentCompanies, now = new Date(), customerCheck = defaultCustomerCheck, draftLaneD, oldCustomerId = null, readCards, readDeals }) {
  if (!['A', 'C', 'D'].includes(lane)) throw fail('invalid_lane');
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw fail('invalid_limit');
  if (!dryRun && !ownerId) throw fail('owner_unconfigured');
  if ((lane === 'A' || lane === 'D') && !states.length) throw fail('states_unconfigured');
  const params = { states, currentCompanies };
  const run = (await pool.query(`INSERT INTO sdr_linkedin_search_runs(company_id,lane,source,query) VALUES($1,$2,$3,$4) RETURNING id`, [companyId, lane, source, JSON.stringify({ lane, states, currentCompanies: currentCompanies || null, dryRun })])).rows[0];
  const skipped = [], staged = [], wouldStage = [];let stopped = null, considered = 0;
  const finish = async (state, error = null) => {
    await pool.query(`UPDATE sdr_linkedin_search_runs SET state=$2,items=$3,staged=$4,skipped=$5,error=$6,finished_at=now() WHERE id=$1`, [run.id, state, considered, dryRun ? wouldStage.length : staged.length, JSON.stringify(countReasons(skipped)), error]);
  };
  let found;
  try { found = await searchLane({ lane, source, apify, unipile: salesNav, params, now }); }
  catch (error) { await finish('failed', error?.code || 'search_unavailable'); throw fail(error?.code || 'search_unavailable'); }
  let entries;
  if (lane === 'D') entries = found.posts.map(post => ({ post }));
  else {
    const kept = new Set((found.kept || found.people).map(p => p.profileUrl));
    entries = found.people.map(person => ({ person, outsideWindow: !kept.has(person.profileUrl) }));
  }
  const lastProject = lane === 'C' && currentCompanies?.length === 1 ? await resolveLastProject(pool, { company: currentCompanies[0], readCards, readDeals }).catch(() => null) : null;
  for (const entry of entries) {
    if (staged.length + wouldStage.length >= limit) break;
    considered++;
    let person = entry.person;
    const name = () => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || entry.post?.author?.name || null;
    const skip = reason => skipped.push({ name: name(), profileUrl: person?.profileUrl || entry.post?.author?.profileUrl || null, reason });
    try {
      if (lane === 'D') {
        const author = await verifyLaneDAuthor({ post: entry.post, apify, states, now });
        if (!author.ok) { skip(author.reason); continue; }
        person = { ...author.person, active30d: true };
      }
      if (entry.outsideWindow) { skip(lane === 'A' ? 'role_start_outside_window' : 'role_start_too_old'); continue; }
      if (titleRank(person.title) > 3) { skip('title_not_target'); continue; }
      if ((lane === 'A' || lane === 'D') && !person.stateCode) { skip('outside_states'); continue; }
      const reason = await prospectSkipReason(pool, { companyId, person: { ...person, providerId: null }, lane, now, customerCheck });
      if (reason) { skip(reason); continue; }
      const facts = prospectFacts({ lane, person, lastProject, states });
      const summary = { name: name(), title: person.title, company: person.company, state: person.stateCode, lane, profileUrl: person.profileUrl, roleStartedOn: person.roleStartedOn, active30d: person.active30d === true, priority: lanePriority({ lane, titleRank: titleRank(person.title), active30d: person.active30d === true, roleStartedOn: person.roleStartedOn, now }) };
      if (dryRun) { wouldStage.push(summary); continue; }
      const check = await finalistCheck(client, { identifier: person.publicIdentifier || person.providerHint });
      if (check.skip) { skip(check.skip); continue; }
      if (check.profileUrl !== person.profileUrl) { skip('profile_conflict'); continue; }
      const again = await prospectSkipReason(pool, { companyId, person: { ...person, providerId: check.providerId }, lane, now, customerCheck });
      if (again) { skip(again); continue; }
      let post = null;
      if (lane === 'D') {
        post = { url: entry.post.postUrl, excerpt: entry.post.text.slice(0, 600), postedAt: entry.post.postedAt };
        const lines = draftLaneD ? await draftLaneD({ post: entry.post, person }).catch(() => null) : null;
        if (lines?.topic) facts.topic = { value: lines.topic, verified: false, draft: true, observedAt: new Date(now).toISOString() };
        if (lines?.reaction) facts.reaction = { value: lines.reaction, verified: false, draft: true, observedAt: new Date(now).toISOString() };
      }
      const candidate = await stageProspect(pool, { companyId, accountId, lane, person: { ...person, providerId: check.providerId }, facts, actor, ownerId, oldCustomerId, post, now });
      staged.push({ ...summary, candidateId: candidate.id, state: candidate.state });
    } catch (error) {
      if (error?.code === 'read_budget_exhausted') { stopped = 'read_budget_exhausted'; break; }
      if (error?.code === 'authentication') { stopped = 'authentication'; break; }
      skip(error?.code || 'stage_unavailable');
    }
  }
  await finish(stopped ? 'stopped' : 'complete', stopped);
  return { runId: run.id, lane, dryRun, considered, staged, wouldStage, skipped: countReasons(skipped), skippedPeople: skipped.slice(0, 100), stopped };
}

// Lane B: an old customer contact whose profile shows a new company. The customer-company
// rule does not apply to B or C (they are Derek's customers by definition).
export async function stageMovedContact({ pool, client, companyId, accountId, actor, ownerId, row, person, states = configuredStates(), now = new Date(), dryRun = false }) {
  const merged = { ...person, email: person.email || row.email || null };
  const reason = await prospectSkipReason(pool, { companyId, person: { ...merged, providerId: null }, lane: 'B', now });
  if (reason) return { skipped: reason };
  if (dryRun) return { wouldStage: { name: row.full_name, company: person.company, oldCompany: row.company } };
  const check = await finalistCheck(client, { identifier: person.publicIdentifier || person.providerHint });
  if (check.skip) return { skipped: check.skip };
  if (check.profileUrl !== person.profileUrl) return { skipped: 'profile_conflict' };
  const again = await prospectSkipReason(pool, { companyId, person: { ...merged, providerId: check.providerId }, lane: 'B', now });
  if (again) return { skipped: again };
  const facts = prospectFacts({ lane: 'B', person: merged, oldCompany: row.company, states });
  const candidate = await stageProspect(pool, { companyId, accountId, lane: 'B', person: { ...merged, providerId: check.providerId }, facts, actor, ownerId, oldCustomerId: row.id, now });
  return { staged: { candidateId: candidate.id, name: row.full_name, company: person.company, oldCompany: row.company } };
}

// The reply exit (lib/replyExit.js, a separate change) calls this to hold every active
// LinkedIn lane for a person, matched by email, profile URL or synthetic person id. It never
// sends; it only holds the candidate and cancels pending actions under the person lock.
export async function holdLinkedinLaneForPerson(pool, { companyId, email = null, profileUrl = null, personId = null, reason = 'cross_sequence_reply' }) {
  if (!companyId) throw fail('scope_required');
  let profile = null; try { profile = profileUrl ? canonicalProfile(profileUrl) : null; } catch { profile = null; }
  const address = normalEmail(email) || null;
  if (!address && !profile && !personId) return { held: 0 };
  const rows = (await pool.query(`SELECT id,account_id,person_id FROM sdr_linkedin_candidates WHERE company_id=$1 AND source=$5 AND state NOT IN ('held','replied','archived','opted_out','completed_no_reply','staff_takeover') AND (($2::text IS NOT NULL AND lower(resolved_email)=$2) OR ($3::text IS NOT NULL AND profile_url=$3) OR ($4::text IS NOT NULL AND person_id=$4))`, [companyId, address, profile, personId, PROSPECT_SOURCE])).rows;
  let held = 0;
  for (const row of rows) {
    const work = async db => {
      const result = await db.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason=$2,revision=revision+1 WHERE id=$1 AND state NOT IN ('held','replied','archived','opted_out','completed_no_reply','staff_takeover')`, [row.id, String(reason).slice(0, 60)]);
      if (row.person_id) await db.query(`UPDATE sdr_linkedin_actions SET state='cancelled' WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='pending'`, [companyId, row.account_id, row.person_id]);
      held += result.rowCount;
    };
    if (row.person_id) await withLinkedinPersonLock(pool, { companyId, accountId: row.account_id, personId: row.person_id }, work); else await work(pool);
  }
  return { held };
}

// Which facts a copy line needs that this person does not have verified.
export function missingFacts(text, facts = {}, identity = {}) {
  const required = String(text || '').replace(/\[\[[\s\S]*?\]\]/g, '').match(/\{([a-zA-Z]+)\}/g) || [];
  return [...new Set(required.map(m => m.slice(1, -1)).filter(field => !(field === 'firstName' && identity.firstNameVerified && identity.firstName) && !(facts[field]?.verified && facts[field].value)))];
}

function renderPreview(config, candidate) {
  const facts = candidate.source_context?.facts || {};
  const identity = { firstName: candidate.source_context?.firstName || null, firstNameVerified: candidate.source_context?.firstNameVerified === true };
  const out = {};
  const steps = ['dm1', ...linkedinFollowupSteps(config)];
  for (const step of steps) {
    try { out[step] = { body: renderLinkedinText(config.copy?.[step], { identity, facts }), reason: null }; }
    catch { out[step] = { body: null, reason: 'copy_facts_unverified', missing: missingFacts(config.copy?.[step], facts, identity) }; }
  }
  if (config.inmail && config.copy?.inmail) {
    try { out.inmail = { subject: renderLinkedinText(config.copy.inmail.subject, { identity, facts }), body: renderLinkedinText(config.copy.inmail.body, { identity, facts }), reason: null }; }
    catch { out.inmail = { body: null, reason: 'copy_facts_unverified', missing: [...new Set([...missingFacts(config.copy.inmail.subject, facts, identity), ...missingFacts(config.copy.inmail.body, facts, identity)])] }; }
  }
  return out;
}

// Today's dry run: local tables only, no provider call and no seat read.
export async function previewProspectDay(pool, { companyId, accountId, now = new Date() }) {
  const account = (await pool.query('SELECT ramp_started_on,read_timezone,mode,status,inmail_balance,coverage FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2', [companyId, accountId])).rows[0] || null;
  const tz = account?.read_timezone || 'America/Chicago';
  const started = Boolean(account?.ramp_started_on);
  const rampStartedOn = started ? account.ramp_started_on : localDayString(now, tz);
  const rampBudget = rampInviteBudget({ rampStartedOn, now, tz });
  const campaigns = (await pool.query(`SELECT DISTINCT ON (config->>'lane') id,status,revision,config,expires_at FROM sdr_linkedin_campaigns WHERE company_id=$1 AND account_id=$2 AND config->'sources' @> '["linkedin_prospect"]'::jsonb ORDER BY config->>'lane',created_at DESC`, [companyId, accountId])).rows;
  const byLane = Object.fromEntries(campaigns.map(c => [c.config.lane, c]));
  const usedToday = (await pool.query(`SELECT COUNT(*)::int AS n FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND step='invite' AND state IN ('reserved','network_started','confirmed','uncertain_provider_result') AND (reserved_at AT TIME ZONE $4)::date=($3::timestamptz AT TIME ZONE $4)::date`, [companyId, accountId, now, tz])).rows[0].n;
  const queue = (await pool.query(`SELECT c.* FROM sdr_linkedin_candidates c WHERE c.company_id=$1 AND c.account_id=$2 AND c.source=$3 AND c.state='reviewed' AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id AND a.step='invite') ORDER BY c.priority,c.created_at LIMIT 200`, [companyId, accountId, PROSPECT_SOURCE])).rows;
  const remaining = Math.max(0, rampBudget - usedToday);
  const lanes = { A: [], B: [], C: [], D: [] };
  queue.slice(0, remaining).forEach((c, index) => {
    const config = byLane[c.lane]?.config || { lane: c.lane, ...laneCampaignDefaults(c.lane) };
    lanes[c.lane]?.push({ order: index + 1, candidateId: c.id, name: c.source_context?.fullName || null, title: c.role, company: c.firm, state: c.territory, lane: c.lane, priority: c.priority, active30d: c.active_30d === true, roleStartedOn: c.role_started_on, profileUrl: c.profile_url, inCampaign: Boolean(c.campaign_id), campaignStatus: byLane[c.lane]?.status || 'none', copy: renderPreview(config, c) });
  });
  const held = (await pool.query(`SELECT coalesce(hold_reason,state) AS reason,COUNT(*)::int AS n FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND source=$3 AND state IN ('held','copy_review') GROUP BY 1`, [companyId, accountId, PROSPECT_SOURCE])).rows;
  const awaitingCopy = (await pool.query(`SELECT id,revision,role,firm,territory,profile_url,source_context FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND source=$3 AND state='copy_review' ORDER BY priority,created_at LIMIT 50`, [companyId, accountId, PROSPECT_SOURCE])).rows
    .map(c => ({ candidateId: c.id, revision: c.revision, name: c.source_context?.fullName || null, title: c.role, company: c.firm, state: c.territory, profileUrl: c.profile_url, post: c.source_context?.post || null, topic: c.source_context?.facts?.topic?.value || '', reaction: c.source_context?.facts?.reaction?.value || '' }));
  const aged = async (days, lanesFilter) => (await pool.query(`SELECT c.id,c.lane,c.source_context->>'fullName' AS name,c.firm,a.provider_id,COALESCE(a.confirmed_at,a.network_started_at) AS sent_at FROM sdr_linkedin_actions a JOIN sdr_linkedin_candidates c ON c.id=a.candidate_id
    WHERE a.company_id=$1 AND a.account_id=$2 AND a.step='invite' AND a.state IN ('confirmed','uncertain_provider_result') AND c.source=$5 AND c.state NOT IN ('held','replied','staff_takeover','archived','opted_out','completed_no_reply')
    AND COALESCE(a.confirmed_at,a.network_started_at) <= $3::timestamptz - make_interval(days => $4::int) AND ($6::text[] IS NULL OR c.lane=ANY($6::text[]))
    AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=c.company_id AND e.account_id=c.account_id AND e.person_id=c.person_id AND e.kind='new_relation')
    AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions o WHERE o.candidate_id=c.id AND o.step=$7) ORDER BY 6 LIMIT 100`, [companyId, accountId, now, days, PROSPECT_SOURCE, lanesFilter, days === 21 ? 'withdraw' : 'inmail'])).rows
    .map(r => ({ candidateId: r.id, lane: r.lane, name: r.name, company: r.firm, sentAt: r.sent_at, invitationIdKnown: Boolean(r.provider_id) }));
  return {
    providerCalls: 0, at: new Date(now).toISOString(),
    ramp: { started, rampStartedOn: started ? rampStartDay(rampStartedOn) : null, weekInRamp: started ? rampWeek({ rampStartedOn, now, tz }) : null, rampBudget, usedToday, remaining },
    account: account ? { mode: account.mode, status: account.status, inmailBalance: account.inmail_balance, snSyncStale: account.coverage?.snSyncStale === true } : null,
    campaigns: Object.fromEntries(campaigns.map(c => [c.config.lane, { id: c.id, status: c.status, revision: c.revision, budgets: c.config.budgets, expiresAt: c.expires_at }])),
    lanes, held: Object.fromEntries(held.map(r => [r.reason, r.n])), awaitingCopy,
    wouldWithdraw: await aged(21, null), wouldInmail: await aged(14, ['A', 'B']),
  };
}
