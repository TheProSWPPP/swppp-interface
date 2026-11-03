// READ ONLY readiness report before setting SDR_SALES_SOURCE=orders. Per month: won
// Pipedrive deals vs website orders (count and USD value), plus orders that could not be
// counted (no card, ambiguous card) or valued, and how many matched a Pipedrive deal.
// Reads the database in a READ ONLY transaction and Trello with GET only. Writes nothing.
//   DATABASE_URL=... TRELLO_API_KEY=... TRELLO_TOKEN=... TRELLO_ORDERS_BOARD_ID=... \
//     node scripts/sales-source-compare.mjs [--from=2025-01] [--json]
import pg from 'pg';
import { buildOrderFacts, readOrderInputs } from '../lib/orderSales.js';

const args = process.argv.slice(2);
const from = (args.find(a => a.startsWith('--from=')) || '--from=0000-00').slice(7);
if (!/^\d{4}-\d{2}$/.test(from)) throw new Error('--from must be YYYY-MM');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const month = day => String(day).slice(0, 7);
const chicagoMonth = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).format(new Date(date));
const money = n => `$${Math.round(n).toLocaleString('en-US')}`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  let report;
  try {
    await client.query('BEGIN READ ONLY');
    const { projects, board, deals, links } = await readOrderInputs(client);
    const { facts, excluded } = buildOrderFacts(projects, board.cards, deals, { paidOptions: board.paidOptions, links });
    const rows = new Map();
    const row = m => rows.get(m) || rows.set(m, { month: m, crm_won: 0, crm_value: 0, orders: 0, order_value: 0, unvalued: 0, matched: 0, paid: 0 }).get(m);
    for (const deal of deals) {
      if (!deal.won_at || deal.status !== 'won') continue;
      const r = row(chicagoMonth(deal.won_at));
      r.crm_won++;
      if (deal.currency === 'USD' && deal.value != null) r.crm_value += Number(deal.value);
    }
    for (const f of facts) {
      const r = row(month(f.orderedOn));
      r.orders++;
      if (f.valueUsd == null) r.unvalued++; else r.order_value += f.valueUsd;
      if (['reviewed', 'email'].includes(f.dealMatch)) r.matched++;
      if (f.paid === 'paid') r.paid++;
    }
    report = { board: { cards: board.cards.length, complete: board.coverage.complete }, projects: projects.length, excluded,
      months: [...rows.values()].filter(r => r.month >= from).sort((a, b) => a.month.localeCompare(b.month)) };
    await client.query('COMMIT');
  } finally { client.release(); }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Trello cards read: ${report.board.cards} (${report.board.complete ? 'complete' : 'INCOMPLETE, totals are understated'}). Projects: ${report.projects}.`);
    console.log(`Not counted as orders: ${Object.entries(report.excluded).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    console.log(['month', 'CRM won', 'CRM value', 'orders', 'order value', 'not valued', 'matched to CRM', 'paid'].join('\t'));
    for (const r of report.months) console.log([r.month, r.crm_won, money(r.crm_value), r.orders, money(r.order_value), r.unvalued, r.matched, r.paid].join('\t'));
  }
} finally { await pool.end(); }
