import type { EnvironmentLookupField } from './data';

const labels: Record<EnvironmentLookupField, string> = {
  soil: 'Soil', waterway: 'Waterbodies', species: 'Species', ms4: 'MS4 operator',
  county: 'County', coordinates: 'Coordinates', overall: 'Environmental',
};

export function boundedReviewNote(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 300 && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value.trim() : undefined;
}

export function environmentLookupReview(status: unknown, notes: unknown): string[] {
  if (status === undefined) return [];
  const unreadable = 'Lookup history could not be read; staff should review the environmental information.';
  if (!status || typeof status !== 'object' || Array.isArray(status)) return [unreadable];
  const noteValues = notes && typeof notes === 'object' && !Array.isArray(notes) ? notes as Record<string, unknown> : {};
  const warnings: string[] = [];
  let invalid = false;
  for (const [key, label] of Object.entries(labels)) {
    if (!Object.hasOwn(status, key)) continue;
    const value = (status as Record<string, unknown>)[key];
    let warning: string | undefined;
    switch (value) {
      case 'complete': case 'approved-order-input': break;
      case 'failed':
        warning = key === 'overall'
          ? 'A lookup failure was recorded; staff should review the environmental information.'
          : `${label} lookup recorded a failure; staff should verify current values.`;
        break;
      case 'review-required': warning = `${label} lookup needs staff review.`; break;
      case 'no-qualifying-results':
        warning = key === 'species'
          ? 'No qualifying species found in the selected lookup scope; staff should verify site requirements.'
          : `${label} lookup found no qualifying results in the selected lookup scope; staff should verify current values.`;
        break;
      case 'inferred':
        warning = key === 'ms4'
          ? 'MS4 operator was inferred during lookup; staff should verify jurisdiction and operator.'
          : `${label} was inferred during lookup; staff should verify current values.`;
        break;
      case 'no-operator-found':
        warning = key === 'ms4'
          ? 'MS4 lookup found no operator in the selected lookup scope; staff should verify jurisdiction and operator.'
          : `${label} lookup needs staff review.`;
        break;
      default: invalid = true;
    }
    if (warning) {
      const note = ['species', 'ms4', 'overall'].includes(key) ? boundedReviewNote(noteValues[key]) : undefined;
      warnings.push(note ? `${warning} ${note}` : warning);
    }
  }
  if (invalid) warnings.push(unreadable);
  // A summary note can accompany a field warning even when no overall status was recorded.
  const overallNote = boundedReviewNote(noteValues.overall);
  if (warnings.length && overallNote && !warnings.some(warning => warning.endsWith(overallNote))) warnings.push(overallNote);
  return warnings;
}
