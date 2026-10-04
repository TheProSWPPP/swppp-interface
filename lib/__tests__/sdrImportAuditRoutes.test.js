import { it, expect, vi } from 'vitest';
import { registerSdrImportAuditRoutes } from '../sdrImportAuditRoutes.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const rowId = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

function harness(pool) {
  let handler;
  registerSdrImportAuditRoutes({ get(path, fn) {
    expect(path).toBe('/api/sdr/import-audit');
    handler = fn;
  } }, { pool });
  return async (user, query = { jobId: JOB_ID }) => {
    let status = 200;
    let body;
    await handler({ sdrUser: user, query }, {
      status(value) { status = value; return this; },
      json(value) { body = value; return this; },
    });
    return { status, body };
  };
}

it('rejects anonymous, non-admin and malformed requests before any SQL', async () => {
  const pool = { query: vi.fn() };
  const call = harness(pool);
  expect((await call(null)).status).toBe(401);
  expect((await call({ sub: 'rep', role: 'sdr' })).status).toBe(403);
  expect((await call({ sub: 'admin', role: 'admin' }, { jobId: 'bad' })).status).toBe(400);
  expect((await call({ sub: 'admin', role: 'admin' }, { jobId: JOB_ID, cursor: '1:bad' })).status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

it('rejects cursors above the PostgreSQL integer range before SQL', async () => {
  const pool = { query: vi.fn() };
  const call = harness(pool);
  const result = await call({ sub: 'admin', role: 'admin' }, {
    jobId: JOB_ID, cursor: `2147483648:${rowId(1)}`,
  });
  expect(result.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

it('keeps the 1,279-row summary independent of bounded issue pages', async () => {
  const rows = Array.from({ length: 1279 }, (_, row_index) => ({
    id: rowId(row_index + 1), row_index, status: row_index === 1278 ? 'approved' : 'uploaded',
    crm_link_missing: true, review_flagged: row_index < 223, not_uploaded: row_index === 1278,
  }));
  const pool = { query: vi.fn(async (sql, params) => {
    expect(sql.trimStart()).toMatch(/^SELECT/i);
    expect(sql).not.toMatch(/raw_data|error_message/i);
    if (sql.includes('FROM lead_import_jobs')) return { rows: [{ id: JOB_ID, status: 'done', total_rows: 1279, uploaded_rows: 1279 }] };
    if (sql.includes('COUNT(*)::int')) return { rows: [{ observed_rows: 1279, observed_uploaded: 1278,
      approved_rows: 1, rejected_rows: 0, error_rows: 0, unlinked_rows: 1279,
      review_flagged: 223, issue_rows: 1279 }] };
    const start = params[1] == null ? 0 : rows.findIndex((row) => row.row_index === params[1] && row.id === params[2]) + 1;
    return { rows: rows.slice(start, start + params[3]) };
  }) };
  const call = harness(pool);
  let cursor;
  const seen = [];
  do {
    const result = await call({ sub: 'admin', role: 'admin' }, { jobId: JOB_ID, limit: '100', ...(cursor ? { cursor } : {}) });
    expect(result.status).toBe(200);
    expect(result.body.summary).toMatchObject({ state: 'needs_review', declaredUploaded: 1279,
      observedUploaded: 1278, unlinkedRows: 1279, reviewFlagged: 223, observedRows: 1279,
      approvedRows: 1, issueRows: 1279 });
    expect(result.body.summary.issues).toContain('uploaded_count_mismatch');
    expect(result.body.issueRows.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(result.body)).not.toContain('raw_data');
    seen.push(...result.body.issueRows.map((row) => row.id));
    cursor = result.body.nextCursor;
  } while (cursor);
  expect(seen).toEqual(rows.map((row) => row.id));
});

it('returns an empty issue page for a reconciled empty batch', async () => {
  const pool = { query: vi.fn(async (sql) => {
    if (sql.includes('FROM lead_import_jobs')) return { rows: [{ id: JOB_ID, status: 'done', total_rows: 0, uploaded_rows: 0 }] };
    if (sql.includes('COUNT(*)::int')) return { rows: [{ observed_rows: 0, observed_uploaded: 0,
      approved_rows: 0, rejected_rows: 0, error_rows: 0, unlinked_rows: 0, review_flagged: 0, issue_rows: 0 }] };
    return { rows: [] };
  }) };
  const result = await harness(pool)({ sub: 'admin', role: 'admin' });
  expect(result.body.summary).toMatchObject({ state: 'reconciled', observedRows: 0, issues: [] });
  expect(result.body).toMatchObject({ issueRows: [], nextCursor: null });
});

it('returns a sanitized 503 when source reads fail', async () => {
  const call = harness({ query: vi.fn(async () => { throw new Error('private connection string'); }) });
  const result = await call({ sub: 'admin', role: 'admin' });
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).not.toContain('private connection string');
});
