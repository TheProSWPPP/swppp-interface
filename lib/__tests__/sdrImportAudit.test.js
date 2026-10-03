import { it, expect } from 'vitest';
import { summarizeImport } from '../sdrImportAudit.js';

it('separates a completed job counter from actual row receipts', () => {
  const result = summarizeImport({ uploaded_rows: 2 }, [
    { status: 'uploaded', pipedrive_lead_id: null, cleaned_data: { abbreviation_fallback: true } },
    { status: 'approved', pipedrive_lead_id: null, cleaned_data: {} },
  ], { complete: true });
  expect(result).toMatchObject({ state: 'needs_review', declaredUploaded: 2,
    observedUploaded: 1, unlinkedRows: 2, reviewFlagged: 1, issueRows: 2 });
  expect(result.issues).toContain('uploaded_count_mismatch');
});

it('retains partial coverage', () => {
  expect(summarizeImport({ uploaded_rows: 0 }, [], { complete: false }).state).toBe('partial');
});

it('does not treat a retained review flag as proof that an uploaded title was unreviewed', () => {
  const result = summarizeImport({ uploaded_rows: 1 }, [
    { status: 'uploaded', pipedrive_lead_id: 'lead-1', cleaned_data: { abbreviation_fallback: true } },
  ], { complete: true });
  expect(result).toMatchObject({ state: 'reconciled', reviewFlagged: 1, issues: [] });
});

it('shows missing staging rows without claiming review or outreach eligibility', () => {
  const result = summarizeImport({ total_rows: 2, uploaded_rows: 1 }, [
    { status: 'uploaded', pipedrive_lead_id: 'lead-1', cleaned_data: {} },
  ], { complete: true });
  expect(result).toMatchObject({ state: 'needs_review', declaredRows: 2,
    observedRows: 1, crmLinkedRows: 1, reviewedRows: null, eligibleRows: null });
  expect(result.issues).toContain('row_count_mismatch');
});
