import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import * as journal from '../sdrChangeJournal.js';
import { reportingTestDb } from './reportingTestDb.js';

const meta={change_source:'api',user_id:'shared',company_id:'42',entity:'lead',entity_id:'l',id:'event-1'};
const receipt={actionId:'action-1',status:'confirmed',companyId:'42',entity:'lead',entityId:'l',providerReceipt:{eventId:'event-1'}};
describe('change provenance',()=>{
  it('keeps account identity separate from execution and ownership',()=>{
    expect(journal.classifyActor({meta})).toEqual({source:'pipedrive_api',accountId:'shared',actionId:null,execution:'unknown',ownership:'external_or_unknown'});
    expect(journal.classifyActor({meta:{...meta,change_source:'app'}})).toMatchObject({source:'pipedrive_app',execution:'unknown',ownership:'external_or_unknown'});
  });
  it('requires an exact company/entity/event receipt, not account or timestamp proximity',()=>{
    expect(journal.classifyActor({meta,ownReceipt:receipt})).toMatchObject({actionId:'action-1',ownership:'matched_own_receipt'});
    for(const ownReceipt of [{...receipt,entityId:'other'},{...receipt,companyId:'other'},{...receipt,status:'unresolved'},{...receipt,providerReceipt:{user_id:'shared',timestamp:meta.timestamp}}])
      expect(journal.classifyActor({meta,ownReceipt}).ownership).toBe('external_or_unknown');
  });
  it('only labels authenticated local actions interactive with explicit execution evidence',()=>{
    expect(journal.classifyActor({authenticatedAction:{authenticated:true,actionId:'a',accountId:'u',execution:'interactive'}})).toMatchObject({source:'sdr_ui',execution:'interactive',accountId:'u'});
    expect(journal.classifyActor({authenticatedAction:{actionId:'a',accountId:'u',execution:'interactive'}})).toMatchObject({source:'unknown',execution:'unknown'});
  });
  it('canonicalizes identity but binds all safety decisions and excludes unrelated notes',()=>{
    const input={companyId:42,leadId:'l',personId:1,recipientEmail:' A@EXAMPLE.TEST ',stage:'PB',cadence:'award_only'};
    const hash=journal.hashDecisionContext(input);
    expect(hash).toBe(journal.hashDecisionContext({...input,companyId:'42',personId:'1',recipientEmail:'a@example.test',comment:'new note',sourceRevision:'other'}));
    for(const field of ['personId','recipientEmail','organizationId','projectRole','stage','trigger','mailboxId','sequenceId','scheduledFor','overrideDecisionId','roleExceptionId','cadence'])
      expect(journal.hashDecisionContext({...input,[field]:'changed'})).not.toBe(hash);
  });
  it('propagates journal failure before the caller can mutate',async()=>{
    let mutations=0;
    await expect((async()=>{await journal.recordChangeIntent({query:async()=>{throw Error('disk');}},{actionId:'a',companyId:'42',entity:'lead',entityId:'l',expectedFields:{title:'old'},proposedFields:{title:'new'},reason:'review',actor:{},contextHash:'h'});mutations++;})()).rejects.toThrow('disk');
    expect(mutations).toBe(0);
  });
});
const db=reportingTestDb('journal');
describe.skipIf(!db)('append-only journal and coherent context',()=>{
  beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY, pipedrive_person_id text, pipedrive_org_id text,person_email text,person_name text,project_stage text,trigger_type text,trigger_override text,sequence_started text,owner_name text); CREATE TABLE sdr_drafts(id text,pipedrive_lead_id text,created_at timestamptz,status text,assigned_mailbox_id text,apollo_sequence_id text,scheduled_for timestamptz,metadata jsonb,revision bigint DEFAULT 1)`);await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql',import.meta.url),'utf8'));await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-manual-protection.sql',import.meta.url),'utf8'));});
  afterAll(async()=>{await db.close();});
  it('retains intent and every receipt and rejects action ID reuse and mutation',async()=>{
    const intent={actionId:'immutable',companyId:'42',entity:'lead',entityId:'l',expectedFields:{title:'old'},proposedFields:{title:'new'},actor:{source:'service'},reason:'review',contextHash:'hash'};
    await journal.recordChangeIntent(db.pool,intent);
    await journal.recordChangeReceipt(db.pool,{actionId:'immutable',status:'unresolved',providerReceipt:null,observedFields:null});
    await journal.recordChangeReceipt(db.pool,{actionId:'immutable',status:'confirmed',providerReceipt:{eventId:'event-1'},observedFields:{title:'new'}});
    expect((await db.pool.query('SELECT status FROM sdr_change_receipts ORDER BY id')).rows.map(r=>r.status)).toEqual(['unresolved','confirmed']);
    await expect(journal.recordChangeIntent(db.pool,{...intent,proposedFields:{title:'other'}})).rejects.toThrow();
    await expect(db.pool.query("UPDATE sdr_change_intents SET reason='rewrite' WHERE action_id='immutable'")).rejects.toThrow('append_only');
    await expect(db.pool.query('DELETE FROM sdr_change_receipts')).rejects.toThrow('append_only');
  });
  it('marks absent or partially observed context incomplete and returns explicit nulls',async()=>{
    const context=await journal.readDecisionContext(db.pool,'missing',{companyId:'42'});
    expect(context).toMatchObject({companyId:'42',leadId:'missing',personId:null,complete:false,cadence:'review'});
    expect(context.contextHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uses current source selections and preserves a local override in a coherent snapshot',async()=>{
    await db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,trigger_override,safety_context) VALUES('l','AGC','{"projectRole":"estimator","roleExceptionId":"review-1","cadence":"award_only","overrideDecisionId":"override-1"}')`);
    await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at) VALUES('42','lead','l','{"id":"l","person_id":1,"organization_id":2,"7c1852c27664d1118f75660223a6af9e99d10f2c":"PB"}',now()),('42','person','1','{"id":1,"email":[{"value":"Current@Example.test","primary":true}]}',now()),('42','organization','2','{"id":2}',now())`);
    await db.pool.query(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,status,created_at,assigned_mailbox_id,apollo_sequence_id) VALUES('d','l','pending',now(),'m','s')`);
    const unreviewed=await journal.readDecisionContext(db.pool,'l',{companyId:'42'});
    expect(unreviewed).toMatchObject({complete:false,technicalComplete:true,businessReviewed:false,reviewEvidence:{status:'unknown'}});
    await db.pool.query("UPDATE sdr_lead_state SET safety_context=safety_context||jsonb_build_object('identityHash',$1::text,'evidence','Reviewed estimator role') WHERE pipedrive_lead_id='l'",[journal.hashContextDependencies(unreviewed)]);
    const reviewed=await journal.readDecisionContext(db.pool,'l',{companyId:'42'});
    expect(reviewed).toMatchObject({personId:'1',organizationId:'2',recipientEmail:'current@example.test',trigger:'AGC',cadence:'award_only',complete:true,reviewEvidence:{status:'reviewed',evidence:'Reviewed estimator role'}});
    expect(reviewed.reviewEvidence.contextHash).toBe(reviewed.contextHash);
    await db.pool.query("UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{email}','[{\"value\":\"changed@example.test\",\"primary\":true}]') WHERE entity='person'");
    expect(await journal.readDecisionContext(db.pool,'l',{companyId:'42'})).toMatchObject({complete:false,reviewEvidence:{status:'unknown'}});
    await db.pool.query("UPDATE sdr_crm_snapshots SET access_status='denied' WHERE entity='person'");
    expect(await journal.readDecisionContext(db.pool,'l',{companyId:'42'})).toMatchObject({recipientEmail:null,complete:false});
  });
});
