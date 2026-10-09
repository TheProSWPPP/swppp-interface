import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {registerSdrOrderReconciliationRoutes} from '../sdrOrderReconciliationRoutes.js';
import {readOrderReconciliation} from '../sdrOrderReconciliation.js';

const db=reportingTestDb('order_auth');
const user={sub:'11111111-1111-4111-8111-111111111111',role:'admin'};
(db?describe:describe.skip)('legacy order route real database authorization',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_users(id uuid PRIMARY KEY,role text,active boolean);
 CREATE TABLE projects(id integer PRIMARY KEY,name text,status text,data jsonb,archived boolean);
 INSERT INTO projects VALUES(1,'Fixture one','Ready','{"projectName":"Fixture one"}',false),(2,'Archived','Ready','{}',true),(3,'Fixture three','Draft','{}',false);`);});
 beforeEach(async()=>{await db.pool.query('DELETE FROM sdr_users');await db.pool.query("INSERT INTO sdr_users VALUES($1,'admin',true)",[user.sub]);});
 afterAll(()=>db.close());
 async function invoke({read=readOrderReconciliation,query={}}={}){
  let handler,status=200,body;const headers={},hook=vi.fn(async()=>null),spy=vi.fn(read);
  registerSdrOrderReconciliationRoutes({get(_path,fn){handler=fn;}},{pool:db.pool,companyId:'13105180',read:spy,readCards:hook});
  await handler({sdrUser:user,query},{set(k,v){headers[k]=v;return this;},status(n){status=n;return this;},json(v){body=v;return this;}});
  return {status,body,headers,read:spy,hook};
 }
 it('uses actual read-only repeatable-read transaction and preserves inventory, staff data and paging',async()=>{
  const before=await db.pool.query('SELECT * FROM projects ORDER BY id');
  const staffBefore=await db.pool.query('SELECT * FROM sdr_users');
  const r=await invoke({query:{limit:'1',offset:'1'},read:async(client,options)=>{
   expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
   expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');
   expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s');
   return readOrderReconciliation(client,options);
  }});
  expect(r.status).toBe(200);expect(r.headers['Cache-Control']).toBe('no-store');expect(r.body).toMatchObject({total:2,limit:1,offset:1,items:[{projectId:'1',projectName:'Fixture one',documentStatus:'Ready'}]});
  expect((await db.pool.query('SELECT * FROM projects ORDER BY id')).rows).toEqual(before.rows);expect((await db.pool.query('SELECT * FROM sdr_users')).rows).toEqual(staffBefore.rows);
 });
 it.each(['inactive','demoted','deleted'])('rejects stale admin token after %s database change before reader or hooks',async(mode)=>{
  if(mode==='inactive')await db.pool.query('UPDATE sdr_users SET active=false');
  if(mode==='demoted')await db.pool.query("UPDATE sdr_users SET role='rep'");
  if(mode==='deleted')await db.pool.query('DELETE FROM sdr_users');
  const r=await invoke();expect(r.status).toBe(403);expect(r.read).not.toHaveBeenCalled();expect(r.hook).not.toHaveBeenCalled();expect(r.headers['Cache-Control']).toBe('no-store');
 });
 it('the database itself prevents an accidental writer in the reader and rollback preserves data',async()=>{
  const before=(await db.pool.query('SELECT * FROM projects ORDER BY id')).rows;
  const r=await invoke({read:async(client)=>{await client.query("UPDATE projects SET name='changed'");return {};}});
  expect(r.status).toBe(503);expect(r.body).toEqual({error:'Order reconciliation temporarily unavailable'});expect((await db.pool.query('SELECT * FROM projects ORDER BY id')).rows).toEqual(before);
  expect((await invoke()).status).toBe(200);
 });
});
