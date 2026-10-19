import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import pg from 'pg';
import {stageCandidate,resolveIdentity,readCandidate,withLinkedinPersonLock} from '../sdrLinkedinStore.js';
const url=process.env.SDR_TEST_DATABASE_URL;
if(!url) throw new Error('SDR_TEST_DATABASE_URL is required for LinkedIn integration tests');
if(!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error('local database required');
const schema=`linkedin_store_${process.pid}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
beforeAll(async()=>{await pool.query(`CREATE SCHEMA ${schema}`);const sql=await fs.readFile(new URL('../../migrations/2026-10-16-sdr-linkedin-channel.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);await pool.query("CREATE TABLE sdr_mailboxes(owner_user_id text,pipedrive_sender_id integer,active boolean); INSERT INTO sdr_mailboxes VALUES('u1',42,true)")});
afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});
describe('LinkedIn candidate store',()=>{
 it('deduplicates source rows, scopes company, and requires revision checked identity',async()=>{const input={companyId:'13105180',accountId:'sender',sourceRow:{source:'pipedrive',sourceId:'lead-1',profileUrl:'https://www.linkedin.com/in/test-one/',segment:'AGC',territory:'Illinois'},actor:'staff'};const a=await stageCandidate(pool,input);const b=await stageCandidate(pool,input);expect(b.id).toBe(a.id);await expect(stageCandidate(pool,{...input,sourceRow:{...input.sourceRow,profileUrl:'https://www.linkedin.com/in/different/'}})).rejects.toMatchObject({code:'source_conflict'});expect(await readCandidate(pool,{companyId:'other',candidateId:a.id})).toBeNull();expect(await readCandidate(pool,{companyId:'13105180',accountId:'foreign',candidateId:a.id})).toBeNull();await expect(resolveIdentity(pool,{candidateId:a.id,expectedRevision:99,evidence:{personId:'p1',organizationId:'o1',ownerId:'u1',providerId:'ACo-one',product:'classic',profileUrl:input.sourceRow.profileUrl},actor:'staff'})).rejects.toMatchObject({code:'revision_conflict'});const identified=await resolveIdentity(pool,{candidateId:a.id,expectedRevision:1,evidence:{personId:'p1',organizationId:'o1',ownerId:'u1',providerId:'ACo-one',product:'classic',profileUrl:input.sourceRow.profileUrl},actor:'staff'});expect(identified.person_id).toBe('p1');expect(identified.pipedrive_owner_id).toBe('42')});
 it('serializes work for the same person',async()=>{let active=0,max=0;await Promise.all([1,2].map(()=>withLinkedinPersonLock(pool,{companyId:'13105180',accountId:'sender',personId:'p1'},async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,20));active--})));expect(max).toBe(1)});
});
