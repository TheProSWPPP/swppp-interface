import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkProtectedDocumentContract, protectedRouteHashes, protectedDeclarationHashes, checkProtectedDeclarations, checkProtectedAppFiles } from '../../tools/check-protected-document-contract.mjs';

const routeSource = `app.put('/api/projects/:id', async (req, res) => {
  await pool.query('UPDATE projects SET data = $1 WHERE id = $2', [req.body, req.params.id]);
  res.json(req.body);
});`;

describe('protected document contract', () => {
  it('detects a changed document save payload and a removed route', () => {
    const expected = protectedRouteHashes(routeSource);
    expect(checkProtectedDocumentContract(routeSource.replace('req.body, req.params.id', 'req.params.id, req.body'), expected))
      .toContain('changed PUT /api/projects/:id');
    expect(checkProtectedDocumentContract('', expected)).toContain('missing PUT /api/projects/:id');
  });

  it('allows an additive SDR route without changing the protected document route', () => {
    const expected = protectedRouteHashes(routeSource);
    const additive = `${routeSource}\napp.get('/api/sdr/example', (req, res) => res.json({ ok: true }));`;
    expect(checkProtectedDocumentContract(additive, expected)).toEqual([]);
  });

  it('detects a changed document webhook dependency', () => {
    const source = "const N8N_WEBHOOK_URL = '/webhook/document';";
    const expected = protectedDeclarationHashes(source);
    expect(checkProtectedDeclarations(source.replace('document', 'other'), expected))
      .toContain('changed N8N_WEBHOOK_URL');
  });

  it('rejects changed and missing protected frontend files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdr-protected-files-'));
    const file = path.join(dir, 'ProjectDetail.tsx');
    const expected = [{ path: file, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }];
    try {
      fs.writeFileSync(file, '');
      expect(checkProtectedAppFiles(expected)).toEqual([]);
      fs.writeFileSync(file, 'changed staff form');
      expect(checkProtectedAppFiles(expected)).toEqual([`changed ${file}`]);
      fs.unlinkSync(file);
      expect(checkProtectedAppFiles(expected)).toEqual([`missing ${file}`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches the saved document source and route baseline', () => {
    const receipt = JSON.parse(fs.readFileSync('tools/sdr-protected-baseline.json', 'utf8'));
    const source = fs.readFileSync('server.js', 'utf8');
    expect(checkProtectedDocumentContract(source, receipt.protectedServerRoutes)).toEqual([]);
    expect(checkProtectedDeclarations(source, receipt.protectedServerDeclarations)).toEqual([]);
    expect(checkProtectedAppFiles(receipt.protectedAppFiles)).toEqual([]);
    expect(receipt.protectedAppFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/App.tsx' }),
      expect.objectContaining({ path: 'src/components/ProjectDetail.tsx' }),
      expect.objectContaining({ path: 'src/templates.ts' }),
    ]));
  });
});
