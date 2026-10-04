export function summarizeImport(job, rows, { complete }) {
  return summarizeImportCounts(job, {
    observedRows: rows.length,
    observedUploaded: rows.filter((row) => row.status === 'uploaded').length,
    approvedRows: rows.filter((row) => row.status === 'approved').length,
    rejectedRows: rows.filter((row) => row.status === 'rejected').length,
    errorRows: rows.filter((row) => row.status === 'error').length,
    unlinkedRows: rows.filter((row) => !row.pipedrive_lead_id).length,
    reviewFlagged: rows.filter((row) => row.cleaned_data?.abbreviation_fallback === true).length,
    issueRows: rows.filter((row) => row.status !== 'uploaded' || !row.pipedrive_lead_id ||
      row.cleaned_data?.abbreviation_fallback === true).length,
  }, { complete });
}

export function summarizeImportCounts(job, counts, { complete }) {
  const declaredRows = job.total_rows == null ? null : Number(job.total_rows);
  const observedRows = Number(counts.observedRows || 0);
  const declaredUploaded = Number(job.uploaded_rows || 0);
  const observedUploaded = Number(counts.observedUploaded || 0);
  const unlinkedRows = Number(counts.unlinkedRows || 0);
  const reviewFlagged = Number(counts.reviewFlagged || 0);
  const issues = [];
  if (complete && declaredRows !== null && observedRows !== declaredRows) issues.push('row_count_mismatch');
  if (complete && observedUploaded !== declaredUploaded) issues.push('uploaded_count_mismatch');
  if (complete && unlinkedRows) issues.push('crm_links_missing');
  return {
    state: !complete ? 'partial' : issues.length ? 'needs_review' : 'reconciled',
    declaredUploaded,
    observedUploaded,
    unlinkedRows,
    reviewFlagged,
    issues,
    declaredRows,
    observedRows,
    approvedRows: Number(counts.approvedRows || 0),
    rejectedRows: Number(counts.rejectedRows || 0),
    errorRows: Number(counts.errorRows || 0),
    crmLinkedRows: observedRows - unlinkedRows,
    reviewedRows: null,
    eligibleRows: null,
    issueRows: Number(counts.issueRows || 0),
  };
}
