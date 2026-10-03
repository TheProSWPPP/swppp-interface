import crypto from 'node:crypto';
import fs from 'node:fs';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const protectedPath = /^\/api\/(?:projects(?:\/|$)|archive(?:\/|$))/;
const protectedNames = new Set(['upload', 'N8N_WEBHOOK_URL', 'GEMINI_PROMPT', 'callGemini', 'callGeminiWithFile', 'memoryProjects', 'memoryArchive']);

export function checkProtectedAppFiles(expected) {
  const issues = [];
  for (const file of expected) {
    try {
      if (hash(fs.readFileSync(file.path)) !== file.sha256) issues.push(`changed ${file.path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      issues.push(`missing ${file.path}`);
    }
  }
  return issues;
}

export function protectedDeclarationHashes(source) {
  const file = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && protectedNames.has(statement.name.text)) {
      declarations.push({ name: statement.name.text, sha256: hash(statement.getText(file)) });
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && protectedNames.has(declaration.name.text)) {
          declarations.push({ name: declaration.name.text, sha256: hash(statement.getText(file)) });
        }
      }
    }
  }
  return declarations;
}

export function checkProtectedDeclarations(source, expected) {
  const actual = protectedDeclarationHashes(source);
  const issues = [];
  for (const declaration of expected) {
    const matches = actual.filter((item) => item.name === declaration.name);
    if (!matches.length) issues.push(`missing ${declaration.name}`);
    else if (matches.length > 1) issues.push(`duplicate ${declaration.name}`);
    else if (matches[0].sha256 !== declaration.sha256) issues.push(`changed ${declaration.name}`);
  }
  return issues;
}

export function protectedRouteHashes(source) {
  const file = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const routes = [];
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(file) !== 'app') continue;
    const method = call.expression.name.text.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
    const path = call.arguments[0];
    if (!path || !ts.isStringLiteral(path) || !protectedPath.test(path.text)) continue;
    routes.push({ method, path: path.text, sha256: hash(statement.getText(file)) });
  }
  return routes;
}

export function checkProtectedDocumentContract(source, expected) {
  const actual = protectedRouteHashes(source);
  const issues = [];
  for (const route of expected) {
    const matches = actual.filter((item) => item.method === route.method && item.path === route.path);
    const label = `${route.method} ${route.path}`;
    if (matches.length === 0) issues.push(`missing ${label}`);
    else if (matches.length > 1) issues.push(`duplicate ${label}`);
    else if (matches[0].sha256 !== route.sha256) issues.push(`changed ${label}`);
  }
  for (const route of actual) {
    if (!expected.some((item) => item.method === route.method && item.path === route.path)) {
      issues.push(`new ${route.method} ${route.path}`);
    }
  }
  return issues;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const receipt = JSON.parse(fs.readFileSync('tools/sdr-protected-baseline.json', 'utf8'));
  const server = fs.readFileSync('server.js', 'utf8');
  const issues = checkProtectedDocumentContract(server, receipt.protectedServerRoutes);
  issues.push(...checkProtectedDeclarations(server, receipt.protectedServerDeclarations));
  issues.push(...checkProtectedAppFiles(receipt.protectedAppFiles));
  if (issues.length) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Protected document contract intact: ${receipt.protectedAppFiles.length} files, ${receipt.protectedServerRoutes.length} routes, ${receipt.protectedServerDeclarations.length} dependencies`);
  }
}
