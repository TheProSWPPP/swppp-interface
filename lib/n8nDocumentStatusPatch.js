export function patchDocumentStatusWorkflow(workflow) {
  const patched = structuredClone(workflow);
  const completionNames = ['Prepare Status Update', 'Prepare Status Update JO-ONLY'];
  const outputNodes = new Set(workflow.nodes.filter(n => n.type === 'n8n-nodes-base.executeWorkflow').map(n => n.name));
  const expectedByJobOrder = {};
  for (const start of outputNodes) {
    if (!start.endsWith(' - JOB-ORDER')) continue;
    const seen = new Set(), queue = [start], expected = [];
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name) || completionNames.includes(name)) continue;
      seen.add(name);
      if (outputNodes.has(name) && name.startsWith(start.split(' - ')[0] + ' - ')) expected.push(name);
      for (const port of workflow.connections[name]?.main || []) for (const edge of port || []) queue.push(edge.node);
    }
    expectedByJobOrder[start] = expected;
  }
  const replaceOnce = (code, before, after) => {
    if (code.split(before).length !== 2) throw new Error('Document status source changed; reconcile before patching');
    return code.replace(before, after);
  };
  for (const name of completionNames) {
    const node = patched.nodes.find(n => n.name === name);
    if (!node) throw new Error(`Missing document completion node: ${name}`);
    let code = node.parameters.jsCode;
    code = replaceOnce(code, 'const results = [];', `const expectedByJobOrder = ${JSON.stringify(expectedByJobOrder)};\nconst results = [];`);
    code = replaceOnce(code,
      'const missing = results.filter(result => !result.receipt && !result.skipped).map(result => result.spec.label);',
      `const expectedNames = expectedByJobOrder[jo?.spec.name] || [];
const missing = [...new Set([
  ...results.filter(result => !result.receipt && !result.skipped).map(result => result.spec.label),
  ...expectedNames.filter(name => !results.some(result => result.spec.name === name && (result.receipt || result.skipped)))
    .map(name => specs.find(spec => spec.name === name)?.label || name)
])];`);
    code = replaceOnce(code, "status: warnings.length ? 'Pending Review' : 'Ready'",
      "status: !results.some(result => result.receipt) ? 'Generation Failed' : missing.length || !jo?.receipt ? 'Generation Incomplete' : 'Generated'");
    node.parameters.jsCode = code;
  }
  const held = patched.nodes.find(n => n.name === 'Prepare Routing Review');
  if (!held) throw new Error('Missing routing review node');
  held.parameters.jsCode = replaceOnce(held.parameters.jsCode, "status:'Pending Review'", "status:'Generation Failed'");
  return patched;
}
