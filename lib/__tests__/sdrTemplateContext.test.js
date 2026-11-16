import {describe,it,expect} from 'vitest';
import {renderTemplate} from '../sdrTemplates.js';

describe('cold email project context',()=>{
  it('renders project names literally, including replacement-pattern characters',()=>{
    expect(renderTemplate('Project: {Project}\nHi {First}',{project:'Station $& Works, Lima, OH',first:'Jo'})).toBe('Project: Station $& Works, Lima, OH\nHi Jo');
  });
  it('has a readable fallback for previews without a project',()=>{
    expect(renderTemplate('Regarding {Project}.')).toBe('Regarding this project.');
  });
});
