// LinkedIn prospect search for Derek's four lanes. The default source is Apify (no cookie, no
// seat). The Unipile Sales Navigator adapter is off unless SDR_LINKEDIN_SEARCH_SOURCE is
// unipile_salesnav, and then it is capped at 10 search POSTs a day on Derek's seat.
import { APIFY_ACTORS, apifyMaxItems } from './apifyClient.js';
import { canonicalProfile } from './sdrLinkedinStore.js';

const fail = (code, detail) => Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) });

export const US_STATES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

// SDR_LINKEDIN_STATES: comma list of served state codes. Staging refuses without it (lanes A and D).
export function configuredStates(value = process.env.SDR_LINKEDIN_STATES) {
  const codes = String(value || '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
  return [...new Set(codes)].filter(code => US_STATES[code]);
}

// "Dallas, Texas, United States", "Texas", "TX" or "Greater Houston" (no state) -> code or null.
// LinkedIn often gives a metro instead of a state ("Dallas-Fort Worth Metroplex", "Greater
// Houston"). Only unambiguous metros are listed: no Kansas City, Columbus, Portland, Springfield.
export const METRO_STATES = Object.freeze({
  TX: ['dallas fort worth', 'dfw', 'dallas', 'fort worth', 'houston', 'san antonio', 'austin', 'el paso', 'corpus christi', 'lubbock', 'amarillo', 'mcallen', 'killeen', 'waco', 'midland', 'odessa', 'beaumont', 'tyler', 'brownsville', 'laredo', 'college station'],
  OK: ['oklahoma city', 'okc', 'tulsa'], LA: ['new orleans', 'baton rouge', 'shreveport', 'lafayette louisiana'], AR: ['little rock', 'fayetteville arkansas', 'northwest arkansas'],
  NM: ['albuquerque', 'santa fe'], CO: ['denver', 'colorado springs'], AZ: ['phoenix', 'tucson'], GA: ['atlanta'], TN: ['nashville', 'memphis', 'knoxville', 'chattanooga'],
  IL: ['chicago'], NC: ['charlotte', 'raleigh', 'durham'], FL: ['miami', 'tampa', 'orlando', 'jacksonville', 'fort lauderdale'], NV: ['las vegas', 'reno'], UT: ['salt lake city'],
  AL: ['birmingham alabama', 'huntsville', 'mobile alabama'], MS: ['jackson mississippi'], KY: ['louisville', 'lexington kentucky'], IN: ['indianapolis'], MO: ['st louis', 'saint louis'], NE: ['omaha'], KS: ['wichita'],
});
const metroWords = text => ` ${String(text || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `;
export function stateFromLocation(text, allowed = Object.keys(US_STATES)) {
  const parts = String(text || '').split(',').map(v => v.trim()).filter(Boolean);
  for (const part of parts) {
    const upper = part.toUpperCase();
    if (US_STATES[upper] && allowed.includes(upper)) return upper;
    const code = Object.keys(US_STATES).find(key => US_STATES[key].toLowerCase() === part.toLowerCase());
    if (code && allowed.includes(code)) return code;
  }
  // A state named inside a longer part ("Texas Metropolitan Area") counts; a named state outside
  // the list is never overridden by a metro. "Kansas City" and "Washington DC" name no state.
  let words = metroWords(text).replace(/ kansas city /g, ' ').replace(/ washington d ?c /g, ' ');
  const named = [];
  for (const code of Object.keys(US_STATES).sort((x, y) => US_STATES[y].length - US_STATES[x].length)) {
    const name = ` ${US_STATES[code].toLowerCase()} `;
    if (words.includes(name)) { named.push(code); words = words.split(name).join(' '); }
  }
  if (named.length || parts.some(part => US_STATES[part.toUpperCase()])) return named.length === 1 && allowed.includes(named[0]) ? named[0] : null;
  // A metro is read only for a US location: one part with no country ("Greater Houston") or a
  // last part naming the US. "Durham, England, United Kingdom" is never North Carolina.
  const last = parts.length ? parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '') : '';
  if (parts.length > 1 && !['unitedstates', 'unitedstatesofamerica', 'usa', 'us'].includes(last)) return null;
  const hits = Object.entries(METRO_STATES).filter(([, metros]) => metros.some(metro => words.includes(` ${metro} `))).map(([code]) => code);
  return hits.length === 1 && allowed.includes(hits[0]) ? hits[0] : null;
}

// Titles in rank order (the page: Directors of Preconstruction first, then Chief Estimators,
// then Senior PMs). Plain Estimator is off for the test.
export const LANE_TITLES = Object.freeze(['Director of Preconstruction', 'VP Preconstruction', 'Preconstruction Director', 'Chief Estimator', 'Senior Project Manager']);
export function titleRank(title) {
  const t = String(title || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 9;
  const precon = /pre-?\s?construction|precon\b/.test(t);
  if (precon && /\b(director|vp|vice president|head)\b/.test(t)) return 1;
  if (/\bchief estimator\b/.test(t)) return 2;
  if (/\b(senior|sr)\s+(project manager|pm)\b/.test(t)) return 3;
  return 9;
}

// SWPPP vendors and consultants post about stormwater too; they are not buyers.
const VENDOR = /\b(swppp|stormwater|storm water|erosion|environmental|consult(ant|ing)|inspector|inspection services|compliance services)\b/i;
export const looksLikeVendor = ({ title, company, industry }) => VENDOR.test(String(title || '')) || VENDOR.test(String(company || '')) || /environmental|consulting/i.test(String(industry || ''));

// LinkedIn headcount bands (Sales Navigator letters): E 201-500, F 501-1000, G 1001-5000, H 5001-10000, I 10001+.
export const HEADCOUNT_201_PLUS = Object.freeze(['E', 'F', 'G', 'H', 'I']);
// LinkedIn construction industry ids. Verify on the first real run; override with SDR_LINKEDIN_INDUSTRY_IDS.
export const CONSTRUCTION_INDUSTRY_IDS = () => String(process.env.SDR_LINKEDIN_INDUSTRY_IDS || '48,406,413,419,51').split(',').map(v => v.trim()).filter(Boolean);
// Each lane D author check is one Apify profile search: a stage call makes at most this many.
export const LANE_D_MAX_AUTHOR_CHECKS = 25;
export const LANE_D_KEYWORDS = Object.freeze(['SWPPP', 'stormwater pollution prevention', 'storm water permit', 'NOI stormwater', 'erosion control plan']);

const isoDay = value => {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  if (typeof value === 'object') {
    const year = Number(value.year), month = Number(value.month || 1);
    if (!Number.isInteger(year) || year < 1950) return null;
    const m = Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1;
    return `${year}-${String(m).padStart(2, '0')}-01`;
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}(-\d{2})?/.test(text)) return `${text.slice(0, 7)}-${text.slice(8, 10) || '01'}`;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
};

export function monthsSince(day, now = new Date()) {
  if (!day) return null;
  // LinkedIn gives a role start as month and year, so the age is counted in whole calendar months.
  const [y, m] = String(day).slice(0, 10).split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m)) return null;
  const n = new Date(now);
  return (n.getUTCFullYear() - y) * 12 + (n.getUTCMonth() + 1 - m);
}

// SDR_LINKEDIN_LANE_A_MONTHS=3-6 is the page's promise: started the role in the last 3 to 6 months.
export function laneAWindow(value = process.env.SDR_LINKEDIN_LANE_A_MONTHS || '3-6') {
  const [min, max] = String(value).split('-').map(Number);
  return Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max > min ? { min, max } : { min: 3, max: 6 };
}
export function withinLaneAWindow(roleStartedOn, now = new Date(), window = laneAWindow()) {
  const months = monthsSince(roleStartedOn, now);
  return months !== null && months >= window.min && months <= window.max;
}
export const laneCMaxMonths = () => { const v = Number(process.env.SDR_LINKEDIN_LANE_C_MAX_MONTHS || 12); return Number.isFinite(v) && v > 0 ? v : 12; };

const first = (...values) => values.find(v => v !== undefined && v !== null && v !== '');
const profileUrlOf = item => {
  const raw = first(item?.linkedinUrl, item?.profileUrl, item?.url, item?.profile_url, item?.publicIdentifier && `https://www.linkedin.com/in/${item.publicIdentifier}/`, item?.public_identifier && `https://www.linkedin.com/in/${item.public_identifier}/`);
  try { return canonicalProfile(raw); } catch { return null; }
};

// Apify harvestapi profile shape (verify on the first real run). Tolerant of the known variants.
export function normalizeApifyProfile(item, { runId = null, observedAt = new Date().toISOString(), active30d = null, states } = {}) {
  const profileUrl = profileUrlOf(item);
  if (!profileUrl) return null;
  const positions = Array.isArray(item.currentPosition) ? item.currentPosition : Array.isArray(item.currentPositions) ? item.currentPositions : [];
  const experience = Array.isArray(item.experience) ? item.experience : [];
  // The current job is a listed current position or an experience entry marked present. The first
  // experience entry is never assumed to be current: it may be a job they already left.
  const endText = e => String(e?.endDate?.text || e?.endDate || e?.dateRange?.end?.text || '');
  const current = positions[0] || experience.find(e => /present/i.test(endText(e))) || {};
  // Jobs that have ended, for lane B: the old company must appear here as a finished position.
  const ended = experience.filter(e => e && e !== current && (e.endDate || e.dateRange?.end) && !/present/i.test(endText(e)));
  const title = first(current.position, current.title, item.position, item.jobTitle, item.headline) || null;
  const company = first(current.companyName, current.company, item.companyName, item.currentCompany) || null;
  const location = first(item.location?.linkedinText, item.location?.parsed?.text, typeof item.location === 'string' ? item.location : null, item.locationName) || null;
  const roleStartedOn = isoDay(first(current.dateRange?.start, current.startDate, current.start, current.started_on));
  const headcountRaw = first(current.companyHeadcount, item.companyHeadcount, item.company?.employeeCount, current.company?.employeeCount);
  const headcount = Number.isFinite(Number(headcountRaw)) ? Number(headcountRaw) : null;
  const publicIdentifier = profileUrl.split('/')[4];
  return {
    providerHint: first(item.id, item.urn, item.profileId, publicIdentifier),
    publicIdentifier,
    profileUrl,
    firstName: first(item.firstName, item.first_name) || null,
    lastName: first(item.lastName, item.last_name) || null,
    title,
    company,
    companyId: first(current.companyId, current.companyUrn, current.companyLinkedinUrl) || null,
    companyHeadcount: headcount,
    industry: first(current.companyIndustry, item.industry) || null,
    location,
    stateCode: stateFromLocation(location, states),
    roleStartedOn,
    active30d,
    email: first(item.email, item.emails?.[0]?.email, item.emails?.[0]) || null,
    pastCompanies: ended.map(e => first(e.companyName, e.company)).filter(Boolean),
    evidence: { source: 'apify', runId, observedAt },
  };
}

// Unipile Sales Navigator item -> the same shape. tenure_at_role {years, months} gives the start.
export function normalizeSalesNavItem(item, { observedAt = new Date().toISOString(), now = new Date(), states } = {}) {
  const profileUrl = profileUrlOf(item);
  if (!profileUrl) return null;
  const position = (Array.isArray(item.current_positions) ? item.current_positions : [])[0] || {};
  const tenure = position.tenure_at_role || {};
  const months = (Number(tenure.years) || 0) * 12 + (Number(tenure.months) || 0);
  const start = new Date(now); start.setUTCMonth(start.getUTCMonth() - months);
  const location = first(item.location, position.location) || null;
  return {
    providerHint: first(item.id, item.public_identifier),
    publicIdentifier: profileUrl.split('/')[4],
    profileUrl,
    firstName: first(item.first_name, item.firstName) || null,
    lastName: first(item.last_name, item.lastName) || null,
    title: first(position.role, item.headline) || null,
    company: first(position.company, position.company_name) || null,
    companyId: first(position.company_id) || null,
    companyHeadcount: null,
    industry: first(position.industry) || null,
    location,
    stateCode: stateFromLocation(location, states),
    roleStartedOn: tenure.years !== undefined || tenure.months !== undefined ? start.toISOString().slice(0, 10) : null,
    active30d: item.recently_posted === true || item.posted_on_linkedin === true ? true : null,
    email: null,
    evidence: { source: 'unipile_salesnav', runId: null, observedAt },
  };
}

export function laneProfileQuery({ lane, states = [], currentCompanies = [], recentlyPosted = false, maxItems = apifyMaxItems() }) {
  const base = { currentJobTitles: [...LANE_TITLES], profileScraperMode: 'Full', maxItems, takePages: Math.max(1, Math.ceil(maxItems / 25)) };
  if (lane === 'A') return { ...base, companyHeadcount: [...HEADCOUNT_201_PLUS], industryIds: CONSTRUCTION_INDUSTRY_IDS(), locations: states.map(code => `${US_STATES[code]}, United States`), yearsAtCurrentCompanyIds: ['1'], ...(recentlyPosted ? { recentlyPostedOnLinkedIn: true } : {}) };
  if (lane === 'C') return { ...base, currentCompanies: [...currentCompanies] };
  throw fail('invalid_lane');
}
export const laneDPostQuery = ({ maxItems = apifyMaxItems() } = {}) => ({ searchQueries: [...LANE_D_KEYWORDS], postedLimit: 'month', sortBy: 'date', maxPosts: maxItems });

export function normalizeApifyPost(item) {
  const author = item?.author || {};
  const profileUrl = profileUrlOf({ linkedinUrl: author.linkedinUrl || author.url, publicIdentifier: author.publicIdentifier });
  const text = String(first(item?.content, item?.text, item?.commentary) || '').trim();
  if (!profileUrl || !text) return null;
  return { postUrl: first(item.linkedinUrl, item.url, item.postUrl) || null, postId: first(item.id, item.urn) || null, text: text.slice(0, 3000), postedAt: first(item.postedAt?.date, item.postedAt, item.date) || null, author: { name: first(author.name, `${author.firstName || ''} ${author.lastName || ''}`.trim()) || null, headline: first(author.info, author.headline, author.position) || null, profileUrl } };
}

// Search one lane. Returns normalized people (lanes A and C) or post authors with their post
// (lane D); the staging step applies the skip rules.
export async function searchLane({ lane, source = 'apify', apify, unipile, params = {}, now = new Date() }) {
  const states = params.states || [];
  const observedAt = new Date(now).toISOString();
  if (source === 'unipile_salesnav') {
    if (!unipile) throw fail('salesnav_unavailable');
    if (lane === 'D' || lane === 'B') throw fail('salesnav_lane_unsupported');
    const items = await unipile.search({ lane, params });
    return { query: { lane, source }, people: items.map(item => normalizeSalesNavItem(item, { observedAt, now, states })).filter(Boolean) };
  }
  if (!apify?.runActor) throw fail('apify_unconfigured');
  if (lane === 'A') {
    const active = laneProfileQuery({ lane, states, recentlyPosted: true, maxItems: params.maxItems });
    const all = laneProfileQuery({ lane, states, recentlyPosted: false, maxItems: params.maxItems });
    // The active-in-30-days run may legitimately be empty; the full run may not.
    const activeItems = await apify.runActor({ actor: APIFY_ACTORS.profileSearch, input: active, allowEmpty: true });
    const allItems = await apify.runActor({ actor: APIFY_ACTORS.profileSearch, input: all });
    const seen = new Map();
    for (const item of activeItems) { const p = normalizeApifyProfile(item, { observedAt, active30d: true, states }); if (p) seen.set(p.profileUrl, p); }
    for (const item of allItems) { const p = normalizeApifyProfile(item, { observedAt, active30d: false, states }); if (p && !seen.has(p.profileUrl)) seen.set(p.profileUrl, p); }
    const window = laneAWindow(params.laneAMonths);
    const people = [...seen.values()];
    return { query: { active, all }, people, kept: people.filter(p => withinLaneAWindow(p.roleStartedOn, now, window)) };
  }
  if (lane === 'C') {
    if (!params.currentCompanies?.length) throw fail('company_required');
    const input = laneProfileQuery({ lane, currentCompanies: params.currentCompanies, maxItems: params.maxItems });
    const items = await apify.runActor({ actor: APIFY_ACTORS.profileSearch, input, allowEmpty: true });
    const people = items.map(item => normalizeApifyProfile(item, { observedAt, states: Object.keys(US_STATES) })).filter(Boolean);
    const max = laneCMaxMonths();
    return { query: input, people, kept: people.filter(p => { const m = monthsSince(p.roleStartedOn, now); return m !== null && m >= 0 && m <= max; }) };
  }
  if (lane === 'D') {
    const input = laneDPostQuery({ maxItems: params.maxItems });
    const posts = (await apify.runActor({ actor: APIFY_ACTORS.postSearch, input, allowEmpty: true })).map(normalizeApifyPost).filter(Boolean);
    const byAuthor = new Map();
    for (const post of posts) if (!byAuthor.has(post.author.profileUrl)) byAuthor.set(post.author.profileUrl, post);
    return { query: input, posts: [...byAuthor.values()] };
  }
  throw fail('invalid_lane');
}

// Lane D author check: an author must hold a lane A title at a 201+ construction company in a
// served state. The vendor filter runs first on the post headline (no spend); then one capped
// profile search on the author's name with the lane A filters must return that exact profile.
export async function verifyLaneDAuthor({ post, apify, states, now = new Date() }) {
  const headline = post.author.headline || '';
  if (looksLikeVendor({ title: headline })) return { ok: false, reason: 'vendor_or_consultant' };
  const name = String(post.author.name || '').trim().split(/\s+/);
  if (name.length < 2) return { ok: false, reason: 'author_identity_unverified' };
  const input = { ...laneProfileQuery({ lane: 'A', states, maxItems: 5 }), firstNames: [name[0]], lastNames: [name.slice(1).join(' ')] };
  delete input.yearsAtCurrentCompanyIds;
  const items = await apify.runActor({ actor: APIFY_ACTORS.profileSearch, input, allowEmpty: true });
  const match = items.map(item => normalizeApifyProfile(item, { observedAt: new Date(now).toISOString(), states })).filter(Boolean).filter(p => p.profileUrl === post.author.profileUrl);
  if (match.length !== 1) return { ok: false, reason: 'author_not_buyer' };
  const person = match[0];
  if (titleRank(person.title) > 3) return { ok: false, reason: 'title_not_target' };
  if (looksLikeVendor(person)) return { ok: false, reason: 'vendor_or_consultant' };
  if (person.companyHeadcount !== null && person.companyHeadcount < 201) return { ok: false, reason: 'headcount_below_201' };
  return { ok: true, person };
}

// Unipile Sales Navigator search, charged on Derek's seat: at most 10 POSTs a day, refused at
// 10; the first ever call is a probe that must return items or the adapter turns itself off;
// a 401 restricts the account and stops.
export const SALESNAV_DAILY_SEARCH_CAP = 10;
export function salesNavBody({ lane, params = {} }) {
  const body = { api: 'sales_navigator', category: 'people', role: { include: [...LANE_TITLES] },
    company_headcount: [{ min: 201, max: 500 }, { min: 501, max: 1000 }, { min: 1001, max: 5000 }, { min: 5001, max: 10000 }, { min: 10001 }],
    tenure_at_role: [{ min: 0, max: 1 }], posted_on_linkedin: true };
  if (params.industryIds?.length) body.industry = { include: params.industryIds };
  if (params.locationIds?.length) body.location = { include: params.locationIds };
  if (lane === 'C' && params.currentCompanies?.length) { body.company = { include: params.currentCompanies }; delete body.company_headcount; }
  return body;
}

export function createSalesNavSearch({ pool, client, companyId, accountId, now = () => new Date() }) {
  const day = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(date);
  async function charge() {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT search_budget_day,search_used,coverage,status FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2 FOR UPDATE', [companyId, accountId])).rows[0];
      if (!row || row.status !== 'healthy') throw fail('account_unhealthy');
      if (row.coverage?.salesNavDisabled) throw fail('salesnav_disabled');
      const today = day(now());
      const used = row.search_budget_day === today ? row.search_used : 0;
      if (used >= SALESNAV_DAILY_SEARCH_CAP) throw fail('salesnav_search_cap');
      await db.query('UPDATE sdr_linkedin_accounts SET search_budget_day=$3,search_used=$4 WHERE company_id=$1 AND account_id=$2', [companyId, accountId, today, used + 1]);
      await db.query('COMMIT');
      return { probe: !row.coverage?.salesNavProbedAt };
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
  }
  const coverage = patch => pool.query('UPDATE sdr_linkedin_accounts SET coverage=coverage||$3::jsonb WHERE company_id=$1 AND account_id=$2', [companyId, accountId, JSON.stringify(patch)]);
  return {
    async search({ lane, params }) {
      const { probe } = await charge();
      let data;
      try { data = await client.searchSalesNav({ body: salesNavBody({ lane, params }), limit: probe ? 5 : 25 }); }
      catch (error) {
        if (error?.code === 'authentication') { await pool.query("UPDATE sdr_linkedin_accounts SET status='restricted',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2", [companyId, accountId, now()]); }
        throw error;
      }
      const items = Array.isArray(data?.items) ? data.items : [];
      if (probe) {
        if (!items.length) { await coverage({ salesNavProbedAt: now().toISOString(), salesNavDisabled: true }); throw fail('salesnav_probe_empty'); }
        await coverage({ salesNavProbedAt: now().toISOString() });
      }
      return items;
    },
  };
}
