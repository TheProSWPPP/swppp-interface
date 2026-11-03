// READ ONLY Trello client for the orders board (sales number, lib/orderSales.js).
// Only GET requests exist here; nothing in the app writes to Trello.
// Env: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_ORDERS_BOARD_ID.
import { PAID_FIELD_ID, COMPLETED_LIST_ID } from './sdrOrderReconciliation.js';

const TRELLO_BASE = 'https://api.trello.com/1';
export const CARD_PAGE_LIMIT = 1000;
export const MAX_CARD_PAGES = 50;

export function trelloConfigured(env = process.env) {
  return Boolean(env.TRELLO_API_KEY && env.TRELLO_TOKEN && env.TRELLO_ORDERS_BOARD_ID);
}

async function trelloGet(path, { apiKey, token, query = {}, fetchImpl = fetch }) {
  const url = new URL(`${TRELLO_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  url.searchParams.set('key', apiKey);
  url.searchParams.set('token', token);
  const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw Object.assign(new Error(`trello_http_${res.status}`), { status: res.status });
  return res.json();
}

// Paid custom field option ids -> 'Y' / 'N' (the shape invoicePaidState expects).
export function paidOptionsFrom(customFields) {
  const field = (customFields || []).find(f => f?.id === PAID_FIELD_ID);
  return Object.fromEntries((field?.options || []).filter(o => o?.id).map(o => [o.id, String(o.value?.text || '').trim().toUpperCase()]));
}

// Every card on the board, open and archived, with custom field values. Pages backwards
// by card id (ids are time-ordered). coverage.complete is true only when the last page was
// short, i.e. nothing was left unread.
export async function fetchOrdersBoard({ apiKey = process.env.TRELLO_API_KEY, token = process.env.TRELLO_TOKEN,
  boardId = process.env.TRELLO_ORDERS_BOARD_ID, fetchImpl = fetch, now = new Date(), limit = CARD_PAGE_LIMIT, maxPages = MAX_CARD_PAGES } = {}) {
  if (!apiKey || !token || !boardId) throw new Error('trello_configuration_missing');
  const auth = { apiKey, token, fetchImpl };
  const customFields = await trelloGet(`/boards/${encodeURIComponent(boardId)}/customFields`, auth);
  const cards = new Map();
  let before = null, complete = false;
  for (let page = 0; page < maxPages; page++) {
    const rows = await trelloGet(`/boards/${encodeURIComponent(boardId)}/cards/all`, { ...auth,
      query: { customFieldItems: 'true', fields: 'id,shortLink,idList,closed,dateLastActivity', limit, ...(before ? { before } : {}) } });
    if (!Array.isArray(rows) || rows.some(c => !c?.id)) throw new Error('trello_page_invalid');
    const fresh = rows.filter(c => !cards.has(c.id));
    for (const card of fresh) cards.set(card.id, card);
    if (rows.length < limit) { complete = true; break; }
    if (!fresh.length) throw new Error('trello_pagination_frozen');
    before = rows.map(c => c.id).sort()[0];
  }
  return { cards: [...cards.values()], paidOptions: paidOptionsFrom(customFields), completedListId: COMPLETED_LIST_ID,
    coverage: { kind: 'current_board', complete, observedAt: now.toISOString() } };
}
