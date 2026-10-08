import {beforeAll,afterAll,it,expect,describe} from 'vitest';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import pg from 'pg';
import {reportingTestDb} from './reportingTestDb.js';
import * as api from '../sdrApprovalObservations.js';
const db=reportingTestDb('approval_observations');
const event={id:'11111111-1111-4111-8111-111111111111',companyId:'13105180',draftId:'22222222-2222-4222-8222-222222222222',origin:'interactive',completedAt:'2026-10-08T23:00:00.000Z',httpStatus:409,responseCode:'daily_cap_reached',category:'capacity',kind:'http_refusal',contractVersion:1};
const wait=async()=>{for(let n=0;n<10;n++)await new Promise(r=>setImmediate(r));};
it('creates the bounded dedicated sink only after a finished response, containing pool errors',async()=>{
 expect(api.createApprovalObservationRecorder).toBeTypeOf('function');const pools=[];
 class Pool extends EventEmitter{constructor(options){super();this.options=options;pools.push(this);}async query(sql,args){this.sql=sql;this.args=args;return {rowCount:1};}}
 const recorder=api.createApprovalObservationRecorder({companyId:'13105180',connectionString:'synthetic-only',PoolClass:Pool});expect(pools).toHaveLength(0);
 const res=new EventEmitter();res.statusCode=409;res.json=()=>res;recorder.middleware({sdrUser:{sub:'staff'},params:{id:event.draftId}},res,()=>{});res.json({code:'daily_cap_reached'});expect(pools).toHaveLength(0);res.emit('finish');expect(pools).toHaveLength(0);await wait();
 expect(pools).toHaveLength(1);expect(pools[0].options).toMatchObject({max:1,connectionTimeoutMillis:250,statement_timeout:250,lock_timeout:100,query_timeout:500,allowExitOnIdle:true,idleTimeoutMillis:1000});
 expect(pools[0].sql).toMatch(/^INSERT INTO sdr_approval_observations/);expect(pools[0].sql).not.toMatch(/UPDATE|DELETE|sdr_drafts/);expect(()=>pools[0].emit('error',Error('private'))).not.toThrow();expect(recorder.stats()).toMatchObject({persisted:1,poolErrors:1});
});
it('contains constructor failure and disables capture without database config',async()=>{
 expect(api.createApprovalObservationRecorder).toBeTypeOf('function');let calls=0;class Pool{constructor(){calls++;throw Error('private');}}
 for(const connectionString of [undefined,'synthetic-only']){const r=api.createApprovalObservationRecorder({companyId:'13105180',connectionString,PoolClass:Pool});const res=new EventEmitter();res.statusCode=200;res.json=()=>res;r.middleware({sdrUser:{sub:'staff'},params:{id:event.draftId}},res,()=>{});res.emit('finish');await wait();expect(r.stats().persisted).toBe(0);}expect(calls).toBe(1);
});
(db?describe:describe.skip)('append-only telemetry storage',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query('CREATE TABLE fixture_business(id int primary key,value text);INSERT INTO fixture_business VALUES(1,\'keep\')');});
 afterAll(()=>db.close());
 it('rehearses migration twice, idempotent events and constraints without changing business rows',async()=>{
  const sql=await readFile(new URL('../../migrations/2026-10-09-sdr-approval-observations.sql',import.meta.url),'utf8');await db.pool.query(sql);await db.pool.query(sql);
  expect(api.insertApprovalObservation).toBeTypeOf('function');expect(await api.insertApprovalObservation(db.pool,event)).toBe(true);expect(await api.insertApprovalObservation(db.pool,event)).toBe(false);
  expect(await api.insertApprovalObservation(db.pool,{...event,id:'33333333-3333-4333-8333-333333333333'})).toBe(true);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_approval_observations')).rows[0].n).toBe(2);
  for(const override of [{companyId:'foreign'},{origin:'secret'},{responseCode:'customer content'},{kind:'sent'},{httpStatus:700}])await expect(api.insertApprovalObservation(db.pool,{...event,id:'44444444-4444-4444-8444-444444444444',...override})).rejects.toBeTruthy();
  expect((await db.pool.query('SELECT * FROM fixture_business')).rows).toEqual([{id:1,value:'keep'}]);
  expect((await db.pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='sdr_approval_observations'::regclass AND contype='f'")).rows[0].n).toBe(0);
 });
 it('contains real missing-schema and lock-timeout failures on the dedicated connection',async()=>{
  const schema=(await db.pool.query('SELECT current_schema() s')).rows[0].s;
  for(const path of [schema+'_absent',schema]){
   const connection=new URL(process.env.SDR_TEST_DATABASE_URL);connection.searchParams.set('sslmode','disable');connection.searchParams.set('options',`-c search_path=${path}`);
   let sink;class LocalPool extends pg.Pool{constructor(options){super(options);sink=this;}}
   const lock=await db.pool.connect();await lock.query('BEGIN');if(path===schema)await lock.query('LOCK TABLE sdr_approval_observations IN ACCESS EXCLUSIVE MODE');
   try{
    const recorder=api.createApprovalObservationRecorder({companyId:'13105180',connectionString:connection.toString(),PoolClass:LocalPool});const res=new EventEmitter();res.statusCode=409;res.json=()=>res;recorder.middleware({sdrUser:{sub:'staff'},params:{id:event.draftId}},res,()=>{});res.json({code:'daily_cap_reached'});res.emit('finish');
    for(let n=0;n<100&&recorder.stats().queued;n++)await new Promise(r=>setTimeout(r,10));
    expect(recorder.stats()).toMatchObject({persisted:0,failedOrUncertain:1,queued:0});
    expect((await db.pool.query('SELECT * FROM fixture_business')).rows).toEqual([{id:1,value:'keep'}]);
   }finally{await lock.query('ROLLBACK');lock.release();await sink?.end();}
  }
 });
});
