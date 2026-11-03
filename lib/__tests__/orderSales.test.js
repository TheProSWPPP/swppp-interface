import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { buildOrderFacts, parseOrderDate, cardCreatedDay, parseInvoiceTotal, isTestProject, summarizeOrderFacts, refreshOrderFacts,
  orderSalesMetrics, salesSource } from '../orderSales.js';
import { fetchOrdersBoard, paidOptionsFrom } from '../trelloClient.js';
import { PAID_FIELD_ID } from '../sdrOrderReconciliation.js';

// Card ids carry their creation time in the first 8 hex digits.
const cardId = (iso, n = 1) => Math.floor(Date.parse(iso) / 1000).toString(16).padStart(8, '0') + String(n).padStart(16, '0');
const C1 = cardId('2026-09-10T15:00:00Z', 1), C2 = cardId('2026-09-12T15:00:00Z', 2), C3 = cardId('2026-11-02T05:30:00Z', 3);
const paidOptions = { optY: 'Y', optN: 'N' };
const card = (id, paid) => ({ id, shortLink: id.slice(-8), idList: 'list', customFieldItems: paid ? [{ idCustomField: PAID_FIELD_ID, idValue: paid }] : [] });
const cards = [card(C1, 'optY'), card(C2, 'optN'), card(C3)];
const project = (id, data = {}, extra = {}) => ({ id, name: `Project ${id}`, status: 'complete', archived: false, deleted_at: null,
  data: { projectName: `Project ${id}`, companyName: 'Acme Builders', email: `owner${id}@acme.test`, trelloLink: `https://trello.com/c/${C1}/12-order`, dateReceived: '09/10/26', ...data }, ...extra });

describe('order dates and values', () => {
  it.each([['09/10/26', '2026-09-10'], ['9/1/26', '2026-09-01'], ['12/31/2025', '2025-12-31'], ['2026-02-03', '2026-02-03'], ['2026-02-03T10:00:00Z', '2026-02-03'],
    ['02/30/26', null], ['13/01/26', null], ['', null], [null, null], ['soon', null]])('parses %j as %j', (value, expected) => {
    expect(parseOrderDate(value)).toBe(expected);
  });
  it('falls back to the card creation time, as a Chicago day', () => {
    expect(cardCreatedDay(C3)).toBe('2026-11-01'); // 23:30 CST
    expect(cardCreatedDay(C1)).toBe('2026-09-10');
    expect(cardCreatedDay('abc12345')).toBeNull();
  });
  it('reads invoice totals typed by hand', () => {
    expect(parseInvoiceTotal('$1,250.50')).toBe(1250.5);
    expect(parseInvoiceTotal(900)).toBe(900);
    expect([parseInvoiceTotal(''), parseInvoiceTotal('n/a'), parseInvoiceTotal('0'), parseInvoiceTotal(-5)]).toEqual([null, null, null, null]);
  });
  it('defaults to the Pipedrive source', () => {
    expect(salesSource({})).toBe('pipedrive');
    expect(salesSource({ SDR_SALES_SOURCE: 'orders' })).toBe('orders');
    expect(salesSource({ SDR_SALES_SOURCE: 'trello' })).toBe('pipedrive');
  });
});

describe('buildOrderFacts', () => {
  it('excludes test, archived and deleted records', () => {
    const { facts, excluded } = buildOrderFacts([
      project('1'), project('2', { projectName: 'E2E smoke' }), project('3', { email: 'qa@example.test' }), project('4', { isTest: true }),
      project('5', {}, { archived: true }), project('6', {}, { archived: true, deleted_at: '2026-10-01' }),
    ], cards, [], { paidOptions });
    expect(facts.map(f => f.projectId)).toEqual(['1']);
    expect(excluded).toMatchObject({ test: 3, archived: 1, deleted: 1 });
    expect(isTestProject(project('7', { projectName: 'Testa Plaza' }))).toBe(false);
  });
  it('requires exactly one real card on the board', () => {
    const { facts, excluded } = buildOrderFacts([
      project('1', { trelloLink: '' }), project('2', { trelloLink: 'https://trello.com/c/zzzzzzzz' }), project('3', { trelloLink: 'https://evil.test/c/' + C1 }),
      project('4', { trelloLink: `https://trello.com/c/${C2}` }),
    ], cards, [], { paidOptions });
    expect(facts.map(f => f.projectId)).toEqual(['4']);
    expect(excluded).toMatchObject({ no_card_link: 1, card_unmatched: 2 });
    const twin = [card(C1), { ...card(C2), shortLink: C1.slice(-8) }];
    expect(buildOrderFacts([project('5', { trelloLink: `https://trello.com/c/${C1.slice(-8)}` })], twin).excluded.card_ambiguous).toBe(1);
  });
  it('counts a project once and a card once', () => {
    const { facts, excluded } = buildOrderFacts([project('1'), project('1'), project('2')], cards, []);
    expect(facts.map(f => f.projectId)).toEqual(['1']);
    expect(excluded).toMatchObject({ duplicate: 1, card_reused: 1 });
  });
  it('dates by intake date, else the card creation day', () => {
    const { facts } = buildOrderFacts([project('1', { dateReceived: '10/05/26' }), project('2', { dateReceived: 'unknown', trelloLink: `https://trello.com/c/${C3}` })], cards);
    expect(facts.map(f => [f.orderedOn, f.orderedOnSource])).toEqual([['2026-10-05', 'date_received'], ['2026-11-01', 'card_created']]);
  });
  it('values from the matched deal, else the invoice, else not valued', () => {
    const deals = [{ id: 501, status: 'won', currency: 'USD', value: 4000, person_email: 'owner1@acme.test' },
      { id: 502, status: 'won', currency: 'EUR', value: 9000, person_email: 'owner2@acme.test' },
      { id: 503, status: 'lost', currency: 'USD', value: 7000, person_email: 'owner3@acme.test' },
      { id: 504, status: 'won', currency: 'USD', value: 1, person_email: 'twin@acme.test' }, { id: 505, status: 'won', currency: 'USD', value: 2, person_email: 'twin@acme.test' }];
    const { facts } = buildOrderFacts([
      project('1', { invoiceTotal: '999' }),
      project('2', { invoiceTotal: '$1,500', trelloLink: `https://trello.com/c/${C2}` }),
      project('3', { trelloLink: `https://trello.com/c/${C3}` }),
      project('4', { email: 'twin@acme.test', trelloLink: `https://trello.com/c/${cards[0].id}` }),
    ], cards, deals, { paidOptions });
    expect(facts.map(f => [f.projectId, f.valueUsd, f.valueSource, f.dealMatch, f.dealId])).toEqual([
      ['1', 4000, 'pipedrive', 'email', '501'], ['2', 1500, 'invoice', 'email', '502'], ['3', null, null, 'unmatched', null]]);
    expect(summarizeOrderFacts(facts)).toMatchObject({ orders: 3, valued: 2, value: 5500, matched: 2 });
    const twin = buildOrderFacts([project('4', { email: 'twin@acme.test' })], cards, deals).facts[0];
    expect([twin.dealMatch, twin.dealId]).toEqual(['ambiguous', null]);
  });
  it('maps the Trello Paid field', () => {
    const { facts } = buildOrderFacts([project('1'), project('2', { trelloLink: `https://trello.com/c/${C2}` }), project('3', { trelloLink: `https://trello.com/c/${C3}` })], cards, [], { paidOptions });
    expect(facts.map(f => f.paid)).toEqual(['paid', 'unpaid', 'unknown']);
  });
});

describe('trello client (read only)', () => {
  it('pages the whole board with GET only and reports completeness', async () => {
    const calls = [];
    const all = Array.from({ length: 5 }, (_, i) => card(cardId('2026-09-01T00:00:00Z', i + 1)));
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([init.method, url.pathname, url.searchParams.get('before')]);
      if (url.pathname.endsWith('/customFields')) return { ok: true, json: async () => [{ id: PAID_FIELD_ID, options: [{ id: 'optY', value: { text: 'Y' } }, { id: 'optN', value: { text: 'n' } }] }] };
      const before = url.searchParams.get('before');
      const page = all.filter(c => !before || c.id < before).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 2);
      return { ok: true, json: async () => page };
    });
    const board = await fetchOrdersBoard({ apiKey: 'k', token: 't', boardId: 'b', fetchImpl, limit: 2, now: new Date('2026-11-03T00:00:00Z') });
    expect(board.cards).toHaveLength(5);
    expect(board.coverage).toEqual({ kind: 'current_board', complete: true, observedAt: '2026-11-03T00:00:00.000Z' });
    expect(board.paidOptions).toEqual({ optY: 'Y', optN: 'N' });
    expect(calls.every(([method]) => method === 'GET')).toBe(true);
    const capped = await fetchOrdersBoard({ apiKey: 'k', token: 't', boardId: 'b', fetchImpl, limit: 2, maxPages: 1 });
    expect(capped.coverage.complete).toBe(false);
    await expect(fetchOrdersBoard({ apiKey: '', token: 't', boardId: 'b', fetchImpl })).rejects.toThrow('trello_configuration_missing');
    expect(paidOptionsFrom(null)).toEqual({});
  });
});

const db = reportingTestDb('order_sales');
describe.skipIf(!db)('order facts (local Postgres)', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE projects(id text PRIMARY KEY, name text, status text, data jsonb NOT NULL, archived boolean DEFAULT false, deleted_at timestamp);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY, person_email text)`);
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-11-03-sdr-order-facts.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-11-03-sdr-order-facts.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE projects, sdr_lead_state, sdr_deal_facts, sdr_job_runs, sdr_order_facts');
    for (const p of [project('1', { invoiceTotal: '1000' }), project('2', { trelloLink: `https://trello.com/c/${C2}`, dateReceived: '09/12/26' }), project('3', { projectName: 'E2E check' })])
      await db.pool.query('INSERT INTO projects VALUES($1,$2,$3,$4,$5,$6)', [p.id, p.name, p.status, p.data, p.archived, p.deleted_at]);
    await db.pool.query("INSERT INTO sdr_lead_state VALUES ('lead-2','owner2@acme.test')");
    await db.pool.query("INSERT INTO sdr_deal_facts(pipedrive_deal_id,pipedrive_lead_id,currency,value,status,won_at) VALUES ('77','lead-2','USD',2500,'won','2026-09-20T15:00:00Z')");
  });
  const window = { from: '2026-09-01', to: '2026-10-01', timezone: 'America/Chicago' };
  const now = new Date('2026-11-03T12:00:00Z');
  const board = complete => async () => ({ cards, paidOptions, coverage: { kind: 'current_board', complete, observedAt: now.toISOString() } });

  it('stores one row per order with a job receipt and reports the window', async () => {
    const counts = await refreshOrderFacts(db.pool, { readBoard: board(true), now });
    expect(counts).toMatchObject({ orders: 2, valued: 2, matched: 1, paid: 1, cards_complete: true, excluded: { test: 1 } });
    const result = await orderSalesMetrics(db.pool, { window, now });
    expect(result.metrics.company_won_deals).toEqual({ value: 2, state: 'available' });
    expect(result.metrics.company_won_booked_value).toEqual({ value: 3500, state: 'available' });
    expect(result.metrics.company_average_won_deal_value).toMatchObject({ value: 1750, numerator: 3500, denominator: 2 });
    expect(result.company_sales).toMatchObject({ source: 'orders', matched: { count: 1, of: 2 }, paid: { count: 1, value: 1000 }, history_from: '2026-09-10' });
    expect(result.byDay.get('2026-09-12')).toMatchObject({ wins: 1, value: 2500 });
    // Rerun replaces, never duplicates.
    await refreshOrderFacts(db.pool, { readBoard: board(true), now });
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_order_facts WHERE current')).rows[0].n).toBe(2);
  });
  it('an incomplete Trello read is partial, never a silent total', async () => {
    await refreshOrderFacts(db.pool, { readBoard: board(false), now });
    const result = await orderSalesMetrics(db.pool, { window, now });
    expect(result.metrics.company_won_deals).toMatchObject({ value: 2, state: 'partial', reason: 'incomplete_coverage' });
  });
  it('is unavailable until the first refresh', async () => {
    expect((await orderSalesMetrics(db.pool, { window, now })).metrics.company_won_deals).toMatchObject({ state: 'unavailable', reason: 'orders_sync_missing' });
  });
});
