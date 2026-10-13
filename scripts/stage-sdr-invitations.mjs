import {readFile,writeFile} from 'node:fs/promises';
import {stageInvitationBatch} from '../lib/sdrInvitationIntake.js';

const args={};
for(let i=2;i<process.argv.length;i+=2){
 const key=process.argv[i],value=process.argv[i+1];
 if(!key?.startsWith('--')||!value||args[key])throw new Error('Invalid staging arguments');
 args[key]=value;
}
for(const key of Object.keys(args))if(!['--csv','--batch-id','--observed-at','--receipt','--crm-candidates','--out'].includes(key))throw new Error('Invalid staging argument');
for(const key of ['--csv','--batch-id','--observed-at','--out'])if(!args[key])throw new Error(`Missing ${key}`);
const csvText=await readFile(args['--csv'],'utf8');
const prior= args['--receipt']?JSON.parse(await readFile(args['--receipt'],'utf8')):null;
const crmCandidates=args['--crm-candidates']?JSON.parse(await readFile(args['--crm-candidates'],'utf8')):[];
const result=stageInvitationBatch({csvText,batchId:args['--batch-id'],observedAt:args['--observed-at'],priorReceipt:prior?.receipt||prior,crmCandidates});
await writeFile(args['--out'],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({candidates:result.candidates.length,revision:result.receipt.revision,status:'staged_inactive'})+'\n');
