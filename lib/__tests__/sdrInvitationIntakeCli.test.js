import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const script=fileURLToPath(new URL('../../scripts/stage-sdr-invitations.mjs',import.meta.url));

describe('offline tracker staging command',()=>{
 it('uses the previous receipt on a second process run without creating another candidate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sdr-stage-'));
  try{
   const csv=join(dir,'tracker.csv'),first=join(dir,'first.json'),second=join(dir,'second.json');
   await writeFile(csv,'Company,Contact Name,Primary Email,Project Title,Quick Link,Bid Date\nBuilder,Pat,pat@example.test,Library,https://app.buildingconnected.com/opportunities/opp-17,2026-10-21\n');
   await run(process.execPath,[script,'--csv',csv,'--batch-id','batch-1','--observed-at','2026-10-10T12:00:00Z','--out',first]);
   await run(process.execPath,[script,'--csv',csv,'--batch-id','batch-2','--observed-at','2026-10-10T13:00:00Z','--receipt',first,'--out',second]);
   const result=JSON.parse(await readFile(second,'utf8'));
   expect(result.candidates).toHaveLength(1);expect(result.receipt.candidates).toHaveLength(1);expect(result.candidates[0].sourceRows).toHaveLength(2);
   expect(result.receipt.activation).toMatchObject({status:'inactive',exportLocation:null,operator:null,cadence:null});
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
