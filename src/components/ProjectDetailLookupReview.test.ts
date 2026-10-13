import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ProjectDetail from './ProjectDetail';
import type { Project } from '../data';

const project = {
  id: 'fixture', projectName: 'Fixture', email: '', status: 'Pending Review',
  dateReceived: '', dueDate: '', specialRequirements: '', latitude: '', longitude: '',
  soilData: '', endangeredSpecies: '', waterway: '', landDisturbanceArea: 0,
  trelloLink: '', jobOrderLink: '', folderLink: '', invoiceLink: '',
} as Project;
const render = (metadata: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ProjectDetail, {
  project: { ...project, ...metadata } as Project,
  onBack: () => {}, onUpdate: () => {}, onDelete: () => {},
}));

describe('project lookup review visibility', () => {
  it('keeps legacy and ordinary complete records quiet', () => {
    expect(render()).not.toContain('Lookup review');
    expect(render({ environmentLookupStatus: { soil: 'complete', species: 'complete', overall: 'complete' } })).not.toContain('Lookup review');
    expect(render({ environmentLookupStatus: { coordinates: 'approved-order-input' } })).not.toContain('Lookup review');
  });

  it('shows a historical waterbody failure beside the environmental fields even after manual correction', () => {
    const html = render({ waterway: 'Staff verified river', environmentLookupStatus: { waterway: 'failed', overall: 'failed' } });
    expect(html).toContain('Lookup review');
    expect(html).toContain('Waterbodies lookup recorded a failure');
    expect(html).toContain('Intake recorded a lookup failure');
    expect(html).toContain('staff should verify current values');
    expect(html).toContain('value="Staff verified river"');
    expect(html.indexOf('Lookup review')).toBeGreaterThan(html.indexOf('Location &amp; Environmental'));
    expect(html.indexOf('Lookup review')).toBeLessThan(html.indexOf('Coordinates'));
  });

  it('labels species zero as selected-scope results and preserves a bounded species note', () => {
    const html = render({ environmentLookupStatus: { species: 'no-qualifying-results' }, environmentLookupNotes: { species: 'County listing filters returned zero qualifying rows.' } });
    expect(html).toContain('No qualifying species found in the selected lookup scope');
    expect(html).toContain('staff should verify site requirements');
    expect(html).toContain('County listing filters returned zero qualifying rows.');
    expect(html).not.toContain('No endangered species present');
  });

  it.each(['inferred', 'no-operator-found'])('requires jurisdiction review for %s MS4 history', status => {
    const html = render({ environmentLookupStatus: { ms4: status } });
    expect(html).toContain('Lookup review');
    expect(html).toContain('staff should verify jurisdiction and operator');
    expect(html).not.toContain('No MS4 jurisdiction');
    expect(html).not.toContain('MS4 not required');
  });

  it('shows explicit provider review without turning project status into proof of success', () => {
    const html = render({ status: 'Ready', environmentLookupStatus: { soil: 'review-required' }, generationNote: 'SWPPP upload failed; check the project folder before delivery.' });
    expect(html).toContain('Soil lookup needs staff review');
    expect(html).toContain('SWPPP upload failed; check the project folder before delivery.');
    expect(html).toContain('Document review');
  });

  it.each([null, [], 'complete', { waterway: 'success' }, { soil: 42 }])('handles malformed marked lookup history without claiming completion: %j', status => {
    const html = render({ environmentLookupStatus: status });
    expect(html).toContain('Lookup review');
    expect(html).toContain('Lookup history could not be read');
    expect(html).not.toContain('Lookup completed');
  });

  it('ignores unknown keys and rejects non-string, oversized and control-character notes', () => {
    const html = render({
      environmentLookupStatus: { ms4: 'review-required', arbitrary: 'complete' },
      environmentLookupNotes: { ms4: 'x'.repeat(301), overall: { nested: 'Bad note' }, species: 'Bad\u0000note', arbitrary: 'Unapproved note' },
      generationNote: { nested: 'Bad generation note' },
    });
    expect(html).toContain('MS4 operator lookup needs staff review');
    expect(html).not.toContain('x'.repeat(301));
    expect(html).not.toContain('Bad note');
    expect(html).not.toContain('Unapproved note');
    expect(html).not.toContain('Bad generation note');
  });

  it('renders valid review notes as text rather than HTML', () => {
    const html = render({ environmentLookupStatus: { ms4: 'inferred' }, environmentLookupNotes: { ms4: '<script>bad()</script>' }, generationNote: '<script>documentBad()</script>' });
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;documentBad()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
