import type { EnvironmentLookupField, EnvironmentLookupOutcome, Project } from './data';

export interface LookupMetadata {
  environmentLookupStatus: Partial<Record<EnvironmentLookupField, EnvironmentLookupOutcome>>;
  environmentLookupNotes: Partial<Record<'species' | 'ms4' | 'overall', string>>;
}
export interface LookupProvenance {
  metadata: LookupMetadata;
  expected: { environmentLookupStatus: unknown; environmentLookupNotes: unknown };
}
export interface RetriggerResult {
  updates: Partial<Project>;
  metadata: LookupMetadata;
  failed: boolean;
  needsReview: boolean;
}
const statusKeys = ['soil', 'waterway', 'species', 'ms4', 'county', 'coordinates', 'overall'];
const outcomes = ['complete', 'approved-order-input', 'no-qualifying-results', 'inferred', 'review-required', 'no-operator-found', 'failed'];
const noteKeys = ['species', 'ms4', 'overall'];
const fields = ['latitude', 'longitude', 'state', 'county', 'city', 'countyFips', 'soilData', 'endangeredSpecies', 'waterway', 'landDisturbanceArea', 'ms4Operator'] as const;
const fieldStatus: Partial<Record<typeof fields[number], EnvironmentLookupField>> = {latitude:'coordinates',longitude:'coordinates',state:'coordinates',city:'coordinates',county:'county',countyFips:'county',soilData:'soil',endangeredSpecies:'species',waterway:'waterway',ms4Operator:'ms4'};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new Error('Invalid lookup result'); }

export function validateLookupMetadata(value: unknown): LookupMetadata {
  if (!object(value) || !object(value.environmentLookupStatus) || !object(value.environmentLookupNotes)
    || Object.keys(value).some(key => !['environmentLookupStatus', 'environmentLookupNotes'].includes(key))
    || Object.keys(value.environmentLookupStatus).some(key => !statusKeys.includes(key))
    || Object.values(value.environmentLookupStatus).some(outcome => typeof outcome !== 'string' || !outcomes.includes(outcome))
    || Object.keys(value.environmentLookupNotes).some(key => !noteKeys.includes(key))
    || Object.values(value.environmentLookupNotes).some(note => typeof note !== 'string' || note.length > 300 || Array.from(note).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) invalid();
  return {
    environmentLookupStatus: { ...value.environmentLookupStatus as LookupMetadata['environmentLookupStatus'] },
    environmentLookupNotes: { ...value.environmentLookupNotes as LookupMetadata['environmentLookupNotes'] },
  };
}

function failedResult(note: string): RetriggerResult {
  return { updates: {}, failed: true, needsReview: true, metadata: {
    environmentLookupStatus: { overall: 'failed' }, environmentLookupNotes: { overall: note },
  } };
}

export function readRetriggerResult(value: unknown): RetriggerResult {
  try {
    if (!object(value) || Object.keys(value).some(key => ![...fields, 'environmentLookupStatus', 'environmentLookupNotes'].includes(key))) invalid();
    const metadata = validateLookupMetadata({ environmentLookupStatus: value.environmentLookupStatus, environmentLookupNotes: value.environmentLookupNotes });
    if (metadata.environmentLookupStatus.species === 'no-qualifying-results' && !metadata.environmentLookupNotes.species?.trim()) invalid();
    if (['inferred', 'review-required', 'no-operator-found'].includes(metadata.environmentLookupStatus.ms4 || '') && !metadata.environmentLookupNotes.ms4?.trim()) invalid();
    if (!['failed','review-required'].includes(metadata.environmentLookupStatus.coordinates || '') && (Object.hasOwn(value,'latitude') || Object.hasOwn(value,'longitude'))
      && !(typeof value.latitude === 'string' && value.latitude.trim() && typeof value.longitude === 'string' && value.longitude.trim())) invalid();
    const updates: Partial<Project> = {};
    for (const field of fields) {
      if (!Object.hasOwn(value, field)) continue;
      const raw = value[field];
      if (field === 'landDisturbanceArea') {
        if (!['string', 'number'].includes(typeof raw) || raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) invalid();
        updates[field] = Number(raw);
      } else {
        if (typeof raw !== 'string') invalid();
        if (!raw.trim()) continue; // An unavailable lookup cannot erase staff information.
        if (['latitude', 'longitude'].includes(field) && (!Number.isFinite(Number(raw)) || Math.abs(Number(raw)) > (field === 'latitude' ? 90 : 180))) invalid();
        const outcome = metadata.environmentLookupStatus[fieldStatus[field]!];
        if (!outcome || ['failed','review-required'].includes(outcome)) continue;
        updates[field] = raw;
      }
    }
    const values = Object.values(metadata.environmentLookupStatus);
    const failed = values.includes('failed');
    if (!values.length || !failed && !Object.keys(updates).some(key => key !== 'landDisturbanceArea')) return failedResult('The lookup returned no environmental results; staff should review the existing information.');
    return { updates, metadata, failed, needsReview: values.some(value => ['failed', 'review-required', 'inferred', 'no-operator-found'].includes(value)) };
  } catch {
    return failedResult('The lookup returned an invalid or empty result; staff should review the existing information.');
  }
}

export async function requestProjectRetrigger(payload: Record<string, unknown>): Promise<RetriggerResult> {
  try {
    const response = await window.fetch('https://proswppp.app.n8n.cloud/webhook/re-trigger', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!response.ok) return failedResult('The lookup request failed; staff should review the existing environmental information.');
    return readRetriggerResult(await response.json());
  } catch {
    return failedResult('The lookup request failed or returned an unreadable result; staff should review the existing environmental information.');
  }
}

export function prepareRetriggerSave(base: Project, requested: Project, current: Project, result: RetriggerResult) {
  let previous: LookupMetadata;
  try { previous = validateLookupMetadata({ environmentLookupStatus: base.environmentLookupStatus || {}, environmentLookupNotes: base.environmentLookupNotes || {} }); }
  catch { previous = { environmentLookupStatus: {}, environmentLookupNotes: {} }; }
  const metadata: LookupMetadata = result.failed ? {
    environmentLookupStatus: { ...previous.environmentLookupStatus, ...result.metadata.environmentLookupStatus },
    environmentLookupNotes: { ...previous.environmentLookupNotes, ...result.metadata.environmentLookupNotes },
  } : {
    environmentLookupStatus: { ...previous.environmentLookupStatus, ...result.metadata.environmentLookupStatus, overall: result.metadata.environmentLookupStatus.overall || 'complete' },
    environmentLookupNotes: { ...previous.environmentLookupNotes, ...result.metadata.environmentLookupNotes },
  };
  if (!result.failed) {
    for (const key of noteKeys as ('species' | 'ms4' | 'overall')[]) {
      if ((key === 'overall' || Object.hasOwn(result.metadata.environmentLookupStatus,key)) && !Object.hasOwn(result.metadata.environmentLookupNotes,key)) delete metadata.environmentLookupNotes[key];
    }
  }
  const submitted = { ...current };
  const staleInputs = current.status !== requested.status || ['projectAddress', 'stateTemplateId', 'stateTemplateName', 'landDisturbanceArea'].some(key => current[key as keyof Project] !== requested[key as keyof Project]);
  if (staleInputs) {
    metadata.environmentLookupStatus.overall = result.failed ? 'failed' : 'review-required';
    metadata.environmentLookupNotes.overall = 'Project inputs changed during lookup; staff should re-run the lookup or verify the earlier results.';
  } else {
    const changedCoordinates = current.latitude !== requested.latitude || current.longitude !== requested.longitude;
    for (const field of fields) {
      if (Object.hasOwn(result.updates, field) && current[field] === requested[field] && !(changedCoordinates && ['latitude', 'longitude'].includes(field))) {
        (submitted as unknown as Record<string, unknown>)[field] = result.updates[field];
      }
    }
  }
  if (current.status === requested.status) submitted.status = 'Pending Review';
  return { submitted, provenance: { metadata, expected: {
    environmentLookupStatus: base.environmentLookupStatus ?? null,
    environmentLookupNotes: base.environmentLookupNotes ?? null,
  } } satisfies LookupProvenance, needsReview: result.needsReview || staleInputs || Object.values(metadata.environmentLookupStatus).some(outcome => ['failed','review-required','inferred','no-operator-found'].includes(outcome)) };
}
