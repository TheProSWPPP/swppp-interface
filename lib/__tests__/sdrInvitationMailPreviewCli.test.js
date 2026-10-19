import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const script=fileURLToPath(new URL('../../scripts/stage-sdr-invitation-mail.mjs',import.meta.url));

it('writes a private offline preview from reviewed invitation evidence and refuses overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-preview-'));
 try{
  const input=join(dir,'register.json'),output=join(dir,'preview.json');
  await writeFile(input,JSON.stringify({companyId:'13105180',entries:[{platform:'Procore',classification:'real_project_invitation',source:{provider:'pipedrive',accountId:'a',threadId:1,messageId:2,subject:'Library bid'},due:[{date:'2026-10-21',meaning:'printed Bid Due'}]}]}));
  await run(process.execPath,[script,'--register',input,'--company-id','13105180','--as-of','2026-10-19T12:00:00Z','--out',output]);
  expect((await readFile(output,'utf8'))).toContain('future_printed_deadline');
  await expect(run(process.execPath,[script,'--register',input,'--company-id','13105180','--as-of','2026-10-19T12:00:00Z','--out',output])).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
