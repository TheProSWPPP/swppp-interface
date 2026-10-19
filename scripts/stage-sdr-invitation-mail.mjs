import {readFile,writeFile} from 'node:fs/promises';
import {stageInvitationMailPreview} from '../lib/sdrInvitationMailPreview.js';

const args={};
for(let i=2;i<process.argv.length;i+=2){
 const key=process.argv[i],value=process.argv[i+1];
 if(!key?.startsWith('--')||!value||args[key])throw new Error('Invalid preview arguments');
 args[key]=value;
}
for(const key of Object.keys(args))if(!['--register','--company-id','--as-of','--out'].includes(key))throw new Error('Invalid preview argument');
for(const key of ['--register','--company-id','--as-of','--out'])if(!args[key])throw new Error(`Missing ${key}`);
const register=JSON.parse(await readFile(args['--register'],'utf8'));
const result=stageInvitationMailPreview({register,companyId:args['--company-id'],asOf:args['--as-of']});
await writeFile(args['--out'],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify(result.counts)+'\n');
