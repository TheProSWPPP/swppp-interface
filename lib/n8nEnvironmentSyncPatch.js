const fields = ['soilData', 'waterway', 'endangeredSpecies', 'ms4Operator', 'county'];

export function patchJobOrderEnvironmentOutput(workflow) {
  const patched = structuredClone(workflow);
  const output = patched.nodes.find(node => node.name === 'Edit Fields');
  const assignments = output?.parameters.assignments?.assignments;
  if (!assignments || assignments.some(field => field.name === 'environmentData')) throw new Error('Job-order environment output changed; reconcile before patching');
  assignments.push({
    id: 'verified-environment-data-20261117', name: 'environmentData', type: 'object',
    value: '={{ ({ ' + fields.map(field => `${field}: $('Formatted Address & Coordinates').first().json.${field}`).join(', ') + ' }) }}',
  });
  return patched;
}

export function patchRouterEnvironmentSync(workflow) {
  const patched = structuredClone(workflow);
  const anchor = "const card = $('Call Trello Card ').first().json;";
  const sync = `// Keep the order screen aligned with the verified job-order inputs; never erase or replace staff values.
const environmentRow = jo?.receipt && jo.rows.find(row => row.documentOutput === jo.receipt);
const generatedEnvironment = environmentRow?.environmentData;
if (route.callbackBase && generatedEnvironment && typeof generatedEnvironment === 'object' && !Array.isArray(generatedEnvironment)) {
  for (const field of ${JSON.stringify(fields)}) {
    const value = generatedEnvironment[field];
    const approved = route.callbackBase[field];
    if (typeof value === 'string' && value.trim() && value.length <= 500 &&
        (approved == null || approved === '' || approved === value)) data[field] = value;
  }
}
`;
  for (const name of ['Prepare Status Update', 'Prepare Status Update JO-ONLY']) {
    const node = patched.nodes.find(node => node.name === name);
    const code = node?.parameters.jsCode;
    if (!code || code.split(anchor).length !== 2 || code.includes('const generatedEnvironment =')) throw new Error('Router environment callback changed; reconcile before patching');
    node.parameters.jsCode = code.replace(anchor, sync + anchor);
  }
  return patched;
}
