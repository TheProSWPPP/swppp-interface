import {expect,it} from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
it('preserves staff document mutation handlers and unchanged SDR workspace layout',()=>{
 const receipt=JSON.parse(fs.readFileSync('tools/workspace-preserved-capabilities.json','utf8'));
 const app=fs.readFileSync('src/App.tsx','utf8');
 for(const [name,expected] of Object.entries(receipt.handlers)){
  const start=app.indexOf(`  const ${name} =`),end=app.indexOf('\n  };',start)+5;
  expect(start).toBeGreaterThan(-1);expect(hash(app.slice(start,end))).toBe(expected);
 }
 for(const file of receipt.sdrFiles.filter(file=>file.path!=='src/components/SdrInterface.tsx'))expect(hash(fs.readFileSync(file.path))).toBe(file.sha256);
});
