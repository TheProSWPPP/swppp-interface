import { summarizeImportCounts } from './sdrImportAudit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE = /^(0|[1-9][0-9]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function registerSdrImportAuditRoutes(app, { pool }) {
  app.get('/api/sdr/import-audit', async (req, res) => {
    if (!req.sdrUser?.sub) return res.status(401).json({ error: 'Unauthorized' });
    if (req.sdrUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const query = req.query || {};
    if (Object.keys(query).some((key) => !['jobId', 'limit', 'cursor'].includes(key)) ||
        typeof query.jobId !== 'string' || !UUID_RE.test(query.jobId)) {
      return res.status(400).json({ error: 'Valid jobId required' });
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'limit must be 1–100' });
    }
    const cursor = query.cursor === undefined ? null :
      typeof query.cursor === 'string' ? CURSOR_RE.exec(query.cursor) : null;
    if (query.cursor !== undefined && (!cursor || Number(cursor[1]) > 2147483647)) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    if (!pool?.query) return res.status(503).json({ error: 'Import audit temporarily unavailable' });

    try {
      const jobResult = await pool.query(
        `SELECT id, status, total_rows, uploaded_rows
           FROM lead_import_jobs WHERE id = $1`,
        [query.jobId],
      );
      if (!jobResult.rows.length) return res.status(404).json({ error: 'Job not found' });
      const job = jobResult.rows[0];
      const aggregate = await pool.query(
        `SELECT COUNT(*)::int AS observed_rows,
                COUNT(*) FILTER (WHERE status = 'uploaded')::int AS observed_uploaded,
                COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_rows,
                COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_rows,
                COUNT(*) FILTER (WHERE status = 'error')::int AS error_rows,
                COUNT(*) FILTER (WHERE pipedrive_lead_id IS NULL OR btrim(pipedrive_lead_id) = '')::int AS unlinked_rows,
                COUNT(*) FILTER (WHERE cleaned_data->>'abbreviation_fallback' = 'true')::int AS review_flagged,
                COUNT(*) FILTER (WHERE status <> 'uploaded'
                  OR pipedrive_lead_id IS NULL OR btrim(pipedrive_lead_id) = ''
                  OR cleaned_data->>'abbreviation_fallback' = 'true')::int AS issue_rows
           FROM lead_import_rows WHERE job_id = $1`,
        [query.jobId],
      );
      const counts = aggregate.rows[0];
      const summary = summarizeImportCounts(job, {
        observedRows: counts.observed_rows,
        observedUploaded: counts.observed_uploaded,
        approvedRows: counts.approved_rows,
        rejectedRows: counts.rejected_rows,
        errorRows: counts.error_rows,
        unlinkedRows: counts.unlinked_rows,
        reviewFlagged: counts.review_flagged,
        issueRows: counts.issue_rows,
      }, { complete: job.status === 'done' });
      const page = await pool.query(
        `SELECT id, row_index, status,
                (pipedrive_lead_id IS NULL OR btrim(pipedrive_lead_id) = '') AS crm_link_missing,
                (cleaned_data->>'abbreviation_fallback' = 'true') AS review_flagged,
                (status <> 'uploaded') AS not_uploaded
           FROM lead_import_rows
          WHERE job_id = $1
            AND (status <> 'uploaded' OR pipedrive_lead_id IS NULL OR btrim(pipedrive_lead_id) = ''
                 OR cleaned_data->>'abbreviation_fallback' = 'true')
            AND ($2::int IS NULL OR (row_index, id) > ($2::int, $3::uuid))
          ORDER BY row_index, id
          LIMIT $4`,
        [query.jobId, cursor ? Number(cursor[1]) : null, cursor ? cursor[2] : null, limit + 1],
      );
      const hasMore = page.rows.length > limit;
      const issueRows = page.rows.slice(0, limit).map((row) => ({
        id: row.id,
        rowIndex: row.row_index,
        status: row.status,
        issues: [
          row.not_uploaded && 'not_uploaded',
          row.crm_link_missing && 'crm_link_missing',
          row.review_flagged && 'review_flagged',
        ].filter(Boolean),
      }));
      const last = issueRows.at(-1);
      return res.json({
        job: { id: job.id, status: job.status, declaredRows: job.total_rows },
        summary,
        issueRows,
        nextCursor: hasMore ? `${last.rowIndex}:${last.id}` : null,
      });
    } catch {
      return res.status(503).json({ error: 'Import audit temporarily unavailable' });
    }
  });
}
