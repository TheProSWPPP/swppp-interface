import {readFile} from 'node:fs/promises';
import express from 'express';
import {describe,it,expect} from 'vitest';
const source=await readFile(new URL('../../server.js',import.meta.url),'utf8');
const start=source.lastIndexOf('app.use((req, res, next) => {',source.indexOf('// Skip auth for health check'));
const block=source.slice(start,source.indexOf('// Database connection',start));
describe('actual SDR authentication perimeter',()=>{
 it.each(['/api/sdr/nurture/account','/API/SDR/nurture/account','/api/sdr/Nurture/account'])('requires JWT even with page Basic credentials at %s',async(path)=>{
  const app=express();new Function('app','N8N_CALLBACK_SECRET','verifySdrJwt','ADMIN_USER','ADMIN_PASS',block)(app,'test-callback',()=>null,'user','test-password');app.use((req,res)=>res.json({ok:true}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{Authorization:'Basic '+Buffer.from('user:test-password').toString('base64')}});expect(r.status).toBe(401)}finally{await new Promise(r=>server.close(r))}
 });
});
