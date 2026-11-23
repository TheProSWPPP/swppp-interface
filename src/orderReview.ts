import type { Project } from './data';
import { documentReviewNote, orderFiles } from './orderFiles';
import { boundedReviewNote, environmentLookupReview } from './environmentLookupReview';

const checkFields = [
  { key: 'waterway', field: 'waterway', name: 'Waterbodies' },
  { key: 'soil', field: 'soilData', name: 'Soil' },
  { key: 'species', field: 'endangeredSpecies', name: 'Species' },
  { key: 'ms4', field: 'ms4Operator', name: 'MS4 operator' },
] as const;

const outcomeLabels: Record<string, string> = {
  complete: 'Lookup complete',
  'approved-order-input': 'Approved order value',
  failed: 'Lookup failed',
  'no-qualifying-results': 'No qualifying results',
  inferred: 'Inferred operator or value',
  'no-operator-found': 'No operator found',
  'review-required': 'Needs review',
};

const usableValue = (value: unknown) => typeof value === 'string' && !!value.trim()
  && !/^(?:n\/a|t\.?b\.?d\.?|tbc|unknown|pending|placeholder|test|todo|to be determined|[-?]+)$/i.test(value.trim())
  && !/^(?:(?:check|confirm|verify|follow up) (?:with|later)\b|(?:awaiting|waiting for) (?:confirmation|review|consultant|city)\b)/i.test(value.trim());

export function getOrderEnvironmentReview(project: Project) {
  const statuses = project.environmentLookupStatus;
  const notes = project.environmentLookupNotes;
  const checks = checkFields.map(({ key, field, name }) => {
    const status = statuses?.[key];
    const usable = usableValue(project[field]);
    const successful = status === 'complete' || status === 'approved-order-input';
    const outcome = typeof status === 'string' && Object.hasOwn(outcomeLabels, status) ? outcomeLabels[status] : 'Lookup unconfirmed';
    const label = !usable && successful ? 'Value needs review' : outcome;
    const note = key === 'ms4' || key === 'species' ? boundedReviewNote(notes?.[key]) : undefined;
    const warning = status === undefined ? undefined : environmentLookupReview({ [key]: status }, { [key]: note })[0];
    const detail = [
      warning || note || (successful ? 'Recorded on this order.' : 'No confirmed lookup result is recorded for this field.'),
      !usable ? 'The order needs a usable field value.' : '',
    ].filter(Boolean).join(' ');
    return { key, field, name, successful, resolved: usable && successful, label, detail, target: 'order-field-' + key };
  });
  const siteWarnings: { message: string; target: string }[] = [];
  const summary = boundedReviewNote(notes?.overall);
  const summaryTarget = summary && /geocod|location|coordinates|latitude|longitude/i.test(summary)
    ? 'order-field-coordinates' : 'order-environment';
  if (statuses !== undefined && (!statuses || typeof statuses !== 'object' || Array.isArray(statuses))) {
    siteWarnings.push({ message: environmentLookupReview(statuses, notes)[0], target: 'order-environment' });
  }
  for (const key of ['overall', 'coordinates', 'county'] as const) {
    const status = statuses?.[key];
    if (status === undefined || status === 'complete' || status === 'approved-order-input') continue;
    const message = environmentLookupReview({ [key]: status }, key === 'overall' ? { overall: summary } : {})[0];
    if (message) siteWarnings.push({ message, target: key === 'overall' ? summaryTarget : 'order-field-' + key });
  }
  // Historical orders can have the overall note without its parallel status entry.
  if (summary && (statuses?.overall === undefined || summaryTarget === 'order-field-coordinates' || checks.some(check => !check.resolved)) && !siteWarnings.some(item => item.message.endsWith(summary))) {
    siteWarnings.push({ message: summary, target: summaryTarget });
  }
  return { checks, siteWarnings };
}

export type OrderEnvironmentReview = ReturnType<typeof getOrderEnvironmentReview>;

export function getOrderProgress(project: Project) {
  const current = project.generationState === 'current' ? project.generation : undefined;
  const receipts = Object.values(current?.outputs || {});
  const approval = Boolean(current?.approvedAt) || project.status === 'Approved for Generation';
  const hasIssues = receipts.some(receipt => receipt?.outcome && receipt.outcome !== 'produced');
  let review = approval ? 'Approved' : 'Unconfirmed';
  let generation = receipts.length ? 'Results recorded' : approval ? 'Awaiting results' : 'Unconfirmed';
  let files = hasIssues || documentReviewNote(project.generationNote) ? 'Needs review' : 'Check files';
  let stage: number | undefined;
  let heading: string;
  switch (project.status) {
    case 'New': case 'Pending Review': case '':
      heading = project.status === 'New' ? 'New request' : project.status === '' ? 'Draft order' : 'Pending review';
      review = 'Review order';
      stage = 0;
      if (!receipts.length && !approval) generation = 'Awaiting approval';
      break;
    case 'Approved for Generation':
      heading = 'Approval recorded';
      stage = 1;
      break;
    case 'Processing':
      heading = 'Order processing';
      stage = 1;
      break;
    case 'Manual Processing':
      heading = 'Manual processing';
      generation = 'Handled by staff';
      stage = 1;
      break;
    case 'Generation Incomplete': case 'Generation Failed':
      heading = project.status;
      generation = project.status === 'Generation Failed' ? 'Failed' : 'Incomplete';
      files = 'Needs review';
      stage = 1;
      break;
    case 'Generated': case 'Complete': case 'Ready':
      heading = project.status === 'Generated' ? 'Generation recorded' : 'Order marked ' + project.status;
      if (project.status === 'Generated' && !receipts.length) generation = 'Marked generated';
      stage = 2;
      break;
    default:
      heading = project.status || 'Status unconfirmed';
  }
  if (project.generationState === 'stale') files = 'Earlier inputs';
  return { heading, stage, steps: [review, generation, files] };
}

const verificationSources = ['projectAddress', 'latitude', 'longitude', 'state', 'county', 'city', 'civilDrawingsLink', 'folderLink'] as const;

export function planSourcesChanged(before: Project, after: Project): boolean {
  return verificationSources.some(key => before[key] !== after[key]);
}

export function invalidateChangedPlanVerification(before: Project, after: Project): Project {
  return after.plansUploaded && planSourcesChanged(before, after)
    ? { ...after, plansUploaded: false } : after;
}

// An approval or plan sign-off must still refer to the same site and drawings when
// the server locks the order. The existing API checks expectations for patch keys.
export function guardPlanVerification(base: Project, submitted: Project, patch: Partial<Project>, expected: Record<string, unknown>) {
  const changesSource = verificationSources.some(key => Object.hasOwn(patch, key));
  const changesSignoff = Object.hasOwn(patch, 'plansUploaded');
  const approval = Object.hasOwn(patch, 'status') && (submitted.status === 'Approved for Generation' || submitted.status === 'Manual Processing');
  if (!changesSource && !changesSignoff && !approval) return;
  const keys = ['status', 'plansUploaded', 'isIndustrial', ...verificationSources] as const;
  for (const key of keys) {
    (patch as Record<string, unknown>)[key] = submitted[key] ?? null;
    expected[key] = base[key] ?? null;
  }
}

export function hasRecordedAcreage(value: unknown): boolean {
  return (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
}

export function recordedAreaText(value: unknown): string {
  return typeof value === 'string' && !hasRecordedAcreage(value) ? value.trim() : '';
}

export function orderActionConfirmation(project: Project, action: 'approve' | 'regenerate'): string {
  const review = getOrderEnvironmentReview(project);
  const issues = review.siteWarnings.map(warning => warning.message);
  for (const check of review.checks) {
    if (!check.resolved) issues.push(check.name + ' — ' + check.label + '. ' + check.detail);
  }
  const missing = [];
  const areaText = recordedAreaText(project.landDisturbanceArea);
  if (areaText) issues.push('Disturbed area is recorded as “' + areaText + '”. Confirm the required acreage before using the documents.');
  else if (!hasRecordedAcreage(project.landDisturbanceArea)) missing.push('Disturbed Area');
  if (!project.projectAddress?.trim()) missing.push('Project Address');
  if (!project.projectDescription?.trim()) missing.push('Project Description');
  if (missing.length) issues.push('Missing order information: ' + missing.join(', ') + '.');
  const note = documentReviewNote(project.generationNote);
  if (note) issues.push(note);
  if (project.generationState === 'current') {
    const files = orderFiles(project);
    for (const name of files.targets) {
      const receipt = project.generation?.outputs?.[files.keys[name]];
      if (receipt && receipt.outcome !== 'produced') {
        const outcome = { failed: 'Output failed', not_configured: 'Not configured', review_required: 'Needs review' }[receipt.outcome];
        issues.push(name + ' — ' + (boundedReviewNote(receipt.reason) || outcome || 'Unconfirmed output'));
      }
    }
  } else if (project.generationState === 'stale') {
    issues.push('Earlier file results refer to different order inputs.');
  }
  const question = action === 'regenerate' ? 'Start a new document generation run for "' + project.projectName + '"?'
    : project.isIndustrial ? 'Route "' + project.projectName + '" to manual processing?'
    : 'Approve "' + project.projectName + '" for document generation?';
  return [question, 'Check that the recorded lookup results apply to the current site and field values.', issues.length ? 'Items to review on this order:\n• ' + issues.join('\n• ') : '',
    action === 'regenerate' ? 'Existing files remain available. Review the results of the new run.' : '',
  ].filter(Boolean).join('\n\n');
}
