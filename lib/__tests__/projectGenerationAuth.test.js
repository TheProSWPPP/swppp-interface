import {describe,it,expect} from 'vitest';
import express from 'express';
import {callbackSecretValid,registerGenerationResultRoute} from '../projectGenerationResults.js';
describe('generation callback authorization and limits',()=>{
 it.each([[undefined,'secret'],['secret',''],['wrong','secret'],['longer-than-secret','secret'],[['secret'],'secret']])('rejects malformed/missing callback credentials', (supplied,secret)=>expect(callbackSecretValid(supplied,secret)).toBe(false));
 it('accepts exact header secret',()=>expect(callbackSecretValid('fixture-secret','fixture-secret')).toBe(true));
 async function request({enabled=true,header,body={}}={}){const app=express();app.use(express.json());const pool={connect(){throw new Error('Database must not be touched');}};registerGenerationResultRoute(app,{pool,secret:'fixture-secret',enabled:()=>enabled});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));try{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/1/generation-results?callback_secret=fixture-secret`,{method:'POST',headers:{'Content-Type':'application/json',...(header?{'X-N8N-Callback-Secret':header}:{})},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};}finally{await new Promise(resolve=>server.close(resolve));}}
 it('default-disabled route refuses processing before database access',async()=>expect(await request({enabled:false,header:'fixture-secret'})).toMatchObject({status:404}));
 it('query parameter is not authorization',async()=>expect(await request()).toMatchObject({status:401}));
});

import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
it('actual app Basic wall rejects missing/bearer/query credentials; authenticated disabled consumer stays closed',async()=>{
 const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{PATH:process.env.PATH,PORT:'5198',ADMIN_USERNAME:'fixture-admin',ADMIN_PASSWORD:'fixture-password'}});
 let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 try{await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Local server did not start')),10000);const check=setInterval(()=>{if(output.includes('Server running on port')){clearInterval(check);clearTimeout(deadline);resolve();}else if(child.exitCode!==null){clearInterval(check);clearTimeout(deadline);reject(new Error('Local server exited'));}},50);});
 const url='http://127.0.0.1:5198/api/projects/fixture/generation-results';
 for(const headers of [{},{Authorization:'Bearer fixture'},{'X-N8N-Callback-Secret':'fixture'}])expect((await fetch(url+'?callback_secret=fixture',{method:'POST',headers})).status).toBe(401);
 const basic='Basic '+Buffer.from('fixture-admin:fixture-password').toString('base64');expect((await fetch(url,{method:'POST',headers:{Authorization:basic}})).status).toBe(404);
 }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
},15000);
it('enabled consumer with no database reports unavailable without trying a memory receipt',async()=>{let handler;registerGenerationResultRoute({post(_p,fn){handler=fn;}},{pool:null,secret:'fixture-secret',enabled:()=>true});let status=200;await handler({get:()=> 'fixture-secret',params:{id:'1'},body:{}},{status(n){status=n;return this;},json(){}});expect(status).toBe(503);});
