// Sales number from ORDERS (SDR_SALES_SOURCE=orders), not from won CRM deals.
//
// An order is an app project (website intake) that is not archived, deleted or a test, and
// whose trelloLink resolves to exactly one card on the orders board. One order per project,
// one project per card. Date: the project's dateReceived (MM/DD/YY, entered in Chicago),
// else the Trello card's creation time. Value: the matched Pipedrive deal's USD value, else
// the invoice total entered on the project, else none (counted, not valued). Payment comes
// from the Trello "Paid" field and is shown separately.
//
// Reporting only: reads projects, Trello (lib/trelloClient.js, GET only) and the stored
// Pipedrive deal facts; writes sdr_order_facts and an sdr_job_runs receipt (job 'orders').
import { resolveProjectCard, resolveReviewedDeal, invoicePaidState } from './sdrOrderReconciliation.js';
import { fetchOrdersBoard } from './trelloClient.js';

export const SALES_SOURCES = Object.freeze(['pipedrive', 'orders']);
export function salesSource(env = process.env) { return env.SDR_SALES_SOURCE === 'orders' ? 'orders' : 'pipedrive'; }

const TZ = 'America/Chicago';
const chicagoDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// Test records: explicit flag, obvious test names, or the known test addresses.
const TEST_NAME = /^(e2e\b|\[test\]|internal test\b|test (project|order|job)\b|test$)/i;
const TEST_EMAIL = /@example\.|prodtest|ivan\.manfredi2001/i;
export function isTestProject(project) {
  const d = project?.data || {};
  if (d.isTest === true || d.test === true) return true;
  return [project?.name, d.projectName, d.companyName].some(v => TEST_NAME.test(String(v || '').trim())) || TEST_EMAIL.test(String(d.email || ''));
}

// MM/DD/YY (how intake stores it), MM/DD/YYYY or YYYY-MM-DD -> 'YYYY-MM-DD'. The value is a
// calendar date entered in Chicago, so it is already the Chicago day. Invalid -> null.
export function parseOrderDate(value) {
  const text = String(value || '').trim();
  let y, m, d;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (us) { m = +us[1]; d = +us[2]; y = us[3].length === 2 ? 2000 + +us[3] : +us[3]; }
  else if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// A Trello card id starts with its creation time (8 hex digits, seconds). Chicago day.
export function cardCreatedDay(cardId) {
  if (!/^[a-f0-9]{24}$/i.test(String(cardId || ''))) return null;
  return chicagoDay(new Date(parseInt(String(cardId).slice(0, 8), 16) * 1000));
}

export function parseInvoiceTotal(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const emptyExcluded = () => ({ test: 0, archived: 0, deleted: 0, duplicate: 0, no_card_link: 0, card_unmatched: 0, card_ambiguous: 0, card_reused: 0, no_date: 0 });

// Pure. projects: rows {id,name,status,data,archived,deleted_at}; cards: Trello cards;
// deals: won Pipedrive deals {id,status,currency,value,person_email}; links: reviewed
// project/card -> deal links (sdrOrderReconciliation semantics).
export function buildOrderFacts(projects, cards, deals = [], { links = [], paidOptions = {} } = {}) {
  const excluded = emptyExcluded();
  const facts = [], seen = new Set(), cardOwner = new Map();
  const won = (deals || []).filter(d => d?.status === 'won');
  const byEmail = new Map();
  for (const deal of won) {
    const email = String(deal.person_email || '').trim().toLowerCase();
    if (email) byEmail.set(email, [...(byEmail.get(email) || []), deal]);
  }
  const ordered = [...(projects || [])].sort((a, b) => String(a.id ?? a.data?.id).localeCompare(String(b.id ?? b.data?.id)));
  for (const project of ordered) {
    const data = project.data || {};
    const id = String(project.id ?? data.id);
    if (seen.has(id)) { excluded.duplicate++; continue; }
    seen.add(id);
    if (project.deleted_at || data.deletedAt) { excluded.deleted++; continue; }
    if (project.archived === true) { excluded.archived++; continue; }
    if (isTestProject(project)) { excluded.test++; continue; }
    if (!data.trelloLink) { excluded.no_card_link++; continue; }
    const identity = resolveProjectCard(project, cards || []);
    if (identity.state === 'ambiguous') { excluded.card_ambiguous++; continue; }
    if (identity.state !== 'verified') { excluded.card_unmatched++; continue; }
    if (cardOwner.has(identity.cardId)) { excluded.card_reused++; continue; }
    cardOwner.set(identity.cardId, id);
    const card = cards.find(c => c.id === identity.cardId);
    const received = parseOrderDate(data.dateReceived);
    const orderedOn = received || cardCreatedDay(card.id);
    if (!orderedOn) { excluded.no_date++; continue; }
    let deal = null, dealMatch = 'unmatched';
    const reviewed = resolveReviewedDeal(id, identity.cardId, won, links);
    if (reviewed.state === 'verified') { deal = reviewed.deal; dealMatch = 'reviewed'; }
    else if (reviewed.state === 'ambiguous') dealMatch = 'ambiguous';
    else {
      const candidates = byEmail.get(String(data.email || '').trim().toLowerCase()) || [];
      if (candidates.length === 1) { deal = candidates[0]; dealMatch = 'email'; }
      else if (candidates.length > 1) dealMatch = 'ambiguous';
    }
    const dealValue = deal && deal.currency === 'USD' && deal.value != null && Number.isFinite(Number(deal.value)) ? Number(deal.value) : null;
    const invoice = parseInvoiceTotal(data.invoiceTotal);
    facts.push({ projectId: id, cardId: identity.cardId, orderedOn, orderedOnSource: received ? 'date_received' : 'card_created',
      valueUsd: dealValue ?? invoice, valueSource: dealValue != null ? 'pipedrive' : invoice != null ? 'invoice' : null,
      paid: invoicePaidState(card.customFieldItems, paidOptions), dealId: deal ? String(deal.id) : null, dealMatch });
  }
  return { facts, excluded };
}

export function summarizeOrderFacts(facts) {
  const valued = facts.filter(f => f.valueUsd != null);
  return { orders: facts.length, valued: valued.length, value: valued.reduce((s, f) => s + f.valueUsd, 0),
    matched: facts.filter(f => ['reviewed', 'email'].includes(f.dealMatch)).length,
    paid: facts.filter(f => f.paid === 'paid').length, from: facts.map(f => f.orderedOn).sort()[0] || null };
}

export async function storeOrderFacts(pool, { facts, excluded, coverage, now = new Date() }) {
  const summary = summarizeOrderFacts(facts);
  const complete = coverage?.complete === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sdr_order_facts'))");
    await client.query('UPDATE sdr_order_facts SET current=false WHERE current AND NOT (project_id=ANY($1::text[]))', [facts.map(f => f.projectId)]);
    for (const f of facts) {
      await client.query(`INSERT INTO sdr_order_facts(project_id,card_id,ordered_on,ordered_on_source,value_usd,value_source,paid,pipedrive_deal_id,deal_match,current,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) ON CONFLICT(project_id) DO UPDATE SET card_id=EXCLUDED.card_id,ordered_on=EXCLUDED.ordered_on,
          ordered_on_source=EXCLUDED.ordered_on_source,value_usd=EXCLUDED.value_usd,value_source=EXCLUDED.value_source,paid=EXCLUDED.paid,
          pipedrive_deal_id=EXCLUDED.pipedrive_deal_id,deal_match=EXCLUDED.deal_match,current=true,observed_at=EXCLUDED.observed_at`,
      [f.projectId, f.cardId, f.orderedOn, f.orderedOnSource, f.valueUsd, f.valueSource, f.paid, f.dealId, f.dealMatch, now]);
    }
    const counts = { ...summary, value: Math.round(summary.value * 100) / 100, excluded, cards_complete: complete };
    await client.query("INSERT INTO sdr_job_runs(job,scope,status,finished_at,counts) VALUES('orders','company',$1,$2,$3)", [complete ? 'complete' : 'partial', now, counts]);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function tableAvailable(db, name) {
  return Boolean((await db.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name);
}

export async function readOrderInputs(pool, { readBoard = fetchOrdersBoard } = {}) {
  const projects = (await pool.query('SELECT id, name, status, data, archived, deleted_at FROM projects')).rows;
  const board = await readBoard();
  const deals = await tableAvailable(pool, 'sdr_reporting_deals')
    ? (await pool.query(`SELECT d.pipedrive_deal_id AS id, d.status, d.currency, d.value::float8 AS value, d.won_at,
        lower(trim(ls.person_email)) AS person_email FROM sdr_reporting_deals d
        LEFT JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=d.pipedrive_lead_id WHERE d.status='won'`)).rows : [];
  return { projects, board, deals };
}

// Every 6 hours with the sales history (server.js). Never writes to Trello or Pipedrive.
export async function refreshOrderFacts(pool, { readBoard = fetchOrdersBoard, now = new Date() } = {}) {
  if (!await tableAvailable(pool, 'sdr_order_facts')) return { skipped: 'schema_missing' };
  const { projects, board, deals } = await readOrderInputs(pool, { readBoard });
  const { facts, excluded } = buildOrderFacts(projects, board.cards, deals, { paidOptions: board.paidOptions });
  return storeOrderFacts(pool, { facts, excluded, coverage: board.coverage, now });
}

const unknown = reason => ({ value: null, state: 'unavailable', reason });
const metric = (value, complete) => ({ value: Number(value || 0), state: complete ? 'available' : 'partial', ...(complete ? {} : { reason: 'incomplete_coverage' }) });

// Same keys and shapes as the Pipedrive company_* metrics, so the Sales page and charts
// work unchanged. A partial Trello read is reported as partial, never as a silent total.
export async function orderSalesMetrics(pool, { window, now = new Date() }) {
  const missing = reason => ({ metrics: { company_won_deals: unknown(reason), company_won_booked_value: unknown(reason), company_average_won_deal_value: unknown(reason) },
    byDay: new Map(), company_sales: { source: 'orders', history_from: null, history_to: null, freshness: { last_complete_at: null, state: 'unknown' } }, excludedTests: null });
  if (!await tableAvailable(pool, 'sdr_order_facts') || !await tableAvailable(pool, 'sdr_job_runs')) return missing('orders_sync_missing');
  const run = (await pool.query(`SELECT status, finished_at, counts FROM sdr_job_runs WHERE job='orders' AND scope='company'
    AND status IN ('complete','partial') AND finished_at <= $1 ORDER BY finished_at DESC LIMIT 1`, [now])).rows[0];
  if (!run) return missing('orders_sync_missing');
  const complete = run.status === 'complete' && run.counts?.cards_complete === true;
  const args = [window.from, window.to];
  const total = (await pool.query(`SELECT count(*)::int AS orders, count(*) FILTER (WHERE value_usd IS NOT NULL)::int AS valued,
      COALESCE(sum(value_usd),0)::float8 AS value, count(*) FILTER (WHERE deal_match IN ('reviewed','email'))::int AS matched,
      count(*) FILTER (WHERE paid='paid')::int AS paid, COALESCE(sum(value_usd) FILTER (WHERE paid='paid'),0)::float8 AS paid_value,
      count(*) FILTER (WHERE paid='unknown')::int AS paid_unknown
    FROM sdr_order_facts WHERE current AND ordered_on >= $1::date AND ordered_on < $2::date`, args)).rows[0];
  const days = (await pool.query(`SELECT to_char(ordered_on,'YYYY-MM-DD') AS date, count(*)::int AS wins,
      count(*) FILTER (WHERE value_usd IS NOT NULL)::int AS valued_wins, COALESCE(sum(value_usd),0)::float8 AS value
    FROM sdr_order_facts WHERE current AND ordered_on >= $1::date AND ordered_on < $2::date GROUP BY 1`, args)).rows;
  const allValued = total.valued === total.orders;
  const finished = new Date(run.finished_at);
  return {
    metrics: {
      company_won_deals: metric(total.orders, complete),
      company_won_booked_value: total.valued || complete ? metric(total.value, complete && allValued) : unknown('no_valued_orders'),
      company_average_won_deal_value: total.valued ? { ...metric(total.value / total.valued, complete && allValued), numerator: total.value, denominator: total.valued } : unknown('no_valued_orders'),
    },
    byDay: new Map(days.map(row => [row.date, row])),
    company_sales: { source: 'orders', history_from: run.counts?.from || null, history_to: chicagoDay(finished),
      freshness: { last_complete_at: finished.toISOString(), state: now - finished > 24 * 3600000 ? 'stale' : 'fresh' },
      matched: { count: total.matched, of: total.orders }, valued: { count: total.valued, of: total.orders },
      paid: { count: total.paid, value: total.paid_value, unknown: total.paid_unknown } },
    excludedTests: Number(run.counts?.excluded?.test ?? 0),
  };
}
