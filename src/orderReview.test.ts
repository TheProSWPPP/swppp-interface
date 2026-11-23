import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project } from './data';
import { OrderLookupWarnings, OrderReviewStatus } from './components/OrderReviewStatus';
import { changedProjectFields } from './projectPersistence';
import { getOrderEnvironmentReview, getOrderProgress, guardPlanVerification, invalidateChangedPlanVerification, orderActionConfirmation } from './orderReview';

const record = {
  id: 'order', projectName: 'Local order', status: 'Pending Review', landDisturbanceArea: 0,
  projectAddress: 'Recorded address', projectDescription: 'Building work', plansUploaded: true,
  waterway: 'River', soilData: 'Loam', endangeredSpecies: 'Species list', ms4Operator: 'Local authority',
  environmentLookupStatus: { waterway: 'complete', soil: 'approved-order-input', species: 'complete', ms4: 'complete', overall: 'review-required' },
  environmentLookupNotes: { overall: 'Location is approximate (geocoded from the submitted project address).' },
} as Project;
const receipts = {
  schemaVersion: 1, runId: 'fixture', contextDigest: 'fixture', approvedAt: '2026-01-01T00:00:00Z', events: [],
  outputs: {
    swppp: { documentKey: 'swppp', outcome: 'review_required', reason: 'OPS must prepare the SWPPP.' },
    job_order: { documentKey: 'job_order', outcome: 'produced', url: 'https://example.invalid/job.pdf' },
  },
} as const;

describe('recorded lookup history and approval', () => {
  it('preserves the overall geocoding warning alongside four positive recorded outcomes', () => {
    const review = getOrderEnvironmentReview(record);
    expect(review.checks.filter(check => check.resolved)).toHaveLength(4);
    expect(review.siteWarnings[0]).toMatchObject({ target: 'order-field-coordinates' });
    const html = renderToStaticMarkup(createElement(OrderReviewStatus, { project: record, review }));
    expect(html).toContain('4 of 4 complete or approved');
    expect(html).toContain('Lookup history for this order');
    expect(html).toContain('Read the site lookup warning');
    expect(html).not.toContain('href="#');
    const warning = renderToStaticMarkup(createElement(OrderLookupWarnings, { review }));
    expect(warning).toContain(record.environmentLookupNotes!.overall);
    expect(warning).toContain('Review coordinates');
  });
  it.each(['approve', 'regenerate'] as const)('carries original site and package instructions into %s without losing zero acreage', action => {
    const order = { ...record, generationNote: 'OPS must review the package.', generationState: 'current', generation: receipts } as unknown as Project;
    const message = orderActionConfirmation(order, action);
    expect(message).toContain(record.environmentLookupNotes!.overall);
    expect(message).toContain('OPS must review the package.');
    expect(message).toContain('OPS must prepare the SWPPP.');
    expect(message).not.toContain('Disturbed Area');
    expect(message).not.toContain('Delivered');
    expect(orderActionConfirmation({ ...order, generationState: 'stale' }, action)).not.toContain('OPS must prepare the SWPPP.');
  });
  it('keeps failed history after a correction and treats missing, malformed and placeholder information conservatively', () => {
    const review = getOrderEnvironmentReview({ ...record, soilData: 'TBD', environmentLookupStatus: { soil: 'complete', ms4: 'inferred', waterway: 'FAILED' } } as unknown as Project);
    expect(review.checks.map(check => [check.key, check.label, check.resolved])).toEqual([
      ['waterway', 'Lookup unconfirmed', false], ['soil', 'Value needs review', false],
      ['species', 'Lookup unconfirmed', false], ['ms4', 'Inferred operator or value', false],
    ]);
    expect(review.checks[3].detail).toContain('verify jurisdiction and operator');
    expect(review.siteWarnings[0].message).toContain('geocoded');
    expect(getOrderEnvironmentReview({ ...record, environmentLookupStatus: null } as unknown as Project).siteWarnings[0].message).toContain('could not be read');
  });
  it('retains bounded notes and suppresses malformed notes', () => {
    const changed = { ...record, ms4Operator: 'Corrected town', environmentLookupStatus: { ms4: 'failed' }, environmentLookupNotes: { ms4: 'Historical MS4 provider outage.', overall: 'x'.repeat(301) } } as Project;
    const message = orderActionConfirmation(changed, 'approve');
    expect(message).toContain('Historical MS4 provider outage.');
    expect(message).not.toContain('x'.repeat(301));
    const save = changedProjectFields(record, changed);
    expect(save.patch).not.toHaveProperty('environmentLookupStatus');
    expect(save.patch).not.toHaveProperty('environmentLookupNotes');
  });
});

describe('order progress', () => {
  it.each(['Ready', 'Complete', 'Open - OPS QA', 'generated'])('does not infer confirmation or delivery for historical %s', status => {
    const progress = getOrderProgress({ ...record, status } as Project);
    expect(progress.heading).toContain(status);
    expect(progress.steps).toEqual(['Unconfirmed', 'Unconfirmed', 'Check files']);
  });
  it('distinguishes approval, current receipts, failures and stale outcomes', () => {
    const pending = { ...record, status: 'Approved for Generation' } as Project;
    expect(getOrderProgress(pending).steps).toEqual(['Approved', 'Awaiting results', 'Check files']);
    const current = { ...pending, generation: receipts, generationState: 'current' } as unknown as Project;
    expect(getOrderProgress(current).steps).toEqual(['Approved', 'Results recorded', 'Needs review']);
    expect(getOrderProgress({ ...current, status: 'Generation Incomplete' }).steps[1]).toBe('Incomplete');
    expect(getOrderProgress({ ...current, generationState: 'stale' }).steps).toEqual(['Approved', 'Awaiting results', 'Earlier inputs']);
  });
});

describe('civil plans verification', () => {
  it.each(['projectAddress', 'latitude', 'longitude', 'city', 'state', 'county', 'civilDrawingsLink', 'folderLink'])('invalidates a sign-off after changing %s', field => {
    expect(invalidateChangedPlanVerification(record, { ...record, [field]: 'new source' }).plansUploaded).toBe(false);
  });
  it('keeps a sign-off for ordinary edits and protects the site from a concurrent change during approval', () => {
    const edited = invalidateChangedPlanVerification(record, { ...record, soilData: 'New soil' });
    expect(edited.plansUploaded).toBe(true);
    const submitted: Project = { ...record, status: 'Approved for Generation' };
    const { patch, expected } = changedProjectFields(record, submitted);
    guardPlanVerification(record, submitted, patch, expected);
    expect(expected).toMatchObject({ status: 'Pending Review', plansUploaded: true, projectAddress: record.projectAddress });
    expect(patch).toMatchObject({ status: 'Approved for Generation', plansUploaded: true, projectAddress: record.projectAddress });
    expect(patch).not.toHaveProperty('generationNote');
    expect(patch).not.toHaveProperty('environmentLookupStatus');
  });
});

it("includes a legacy acreage range in approval without treating it as empty", () => {
  const project = { ...record, landDisturbanceArea: "1 - 5 Acres" } as unknown as Project;
  const prompt = orderActionConfirmation(project, "approve");
  expect(prompt).toContain("1 - 5 Acres");
  expect(prompt).not.toContain("Missing order information: Disturbed Area");
});
