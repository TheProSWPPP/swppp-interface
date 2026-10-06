import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { receivePipedriveEvent, processPendingPipedriveEvents, reconcilePipedriveScope, readLeadCrmObservations, readCrmFollowups, readCrmSyncHealth, recordReviewedCrmExclusion, filterReviewedCrmEvidence } from '../sdrCrmObservations.js';

const db=reportingTestDb('crm_observation');
const testDb=db?describe:describe.skip;
const event=(id,action='change',entity='lead',entityId='lead-1',timestamp='2026-10-05T12:00:00.000Z')=>({meta:{id,company_id:'42',version:'2.0',entity,entity_id:entityId,action,timestamp,host:'example.pipedrive.com'},data:{id:entityId},previous:null});
const companyEvent=(company,id,action,entity,entityId,timestamp,previous=null)=>({...event(id,action,entity,entityId,timestamp),meta:{...event(id,action,entity,entityId,timestamp).meta,company_id:company},previous});
testDb('durable CRM observations',()=>{
  beforeAll(async()=>{await db.setup();await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql',import.meta.url),'utf8'));await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-manual-protection.sql',import.meta.url),'utf8'));});
  afterAll(async()=>{await db.close();});
  it('retains raw X-to-Y event separately from a later live Z observation',async()=>{
    const companyId='delayed-provenance';
    const a=companyEvent(companyId,'a','change','lead','l','2026-10-05T12:00:00Z',{title:'X'});
    a.meta.change_source='app';a.meta.user_id='shared';a.data={id:'l',title:'Y'};
    await receivePipedriveEvent(db.pool,a,{companyId});
    await processPendingPipedriveEvents(db.pool,{companyId,client:{getEntity:async()=>({id:'l',title:'Z',update_time:'2026-10-05T14:00:00Z'})}});
    const history=await readLeadCrmObservations(db.pool,{companyId,leadId:'l'});
    expect(history.lead.data.title).toBe('Z');
    expect(history.revisions[0]).toMatchObject({data:{title:'Y'},previous:{title:'X'},observed_data:{title:'Z'},event_payload:{meta:{id:'a',change_source:'app'}},actor_evidence:{source:'pipedrive_app',ownership:'external_or_unknown',execution:'unknown'}});
    expect(+new Date(history.revisions[0].observation_source_at)).toBeGreaterThan(+new Date(history.revisions[0].source_at));
  });
  it('validates company, schema version and entity before persistence and deduplicates by event ID',async()=>{
    await expect(receivePipedriveEvent(db.pool,event('wrong'),{companyId:'43'})).rejects.toThrow();
    await expect(receivePipedriveEvent(db.pool,{...event('v1'),meta:{...event('v1').meta,version:'1.0'}},{companyId:'42'})).rejects.toThrow();
    await expect(receivePipedriveEvent(db.pool,event('bad','change','mail'),{companyId:'42'})).rejects.toThrow();
    expect(await receivePipedriveEvent(db.pool,event('e1'),{companyId:'42'})).toMatchObject({inserted:true});
    expect(await receivePipedriveEvent(db.pool,event('e1'),{companyId:'42'})).toMatchObject({inserted:false});
    expect((await db.pool.query("SELECT count(*)::int AS n FROM sdr_crm_event_inbox WHERE company_id='42'")).rows[0].n).toBe(1);
  });
  it('does not acknowledge a database failure',async()=>{
    const broken={query:async()=>{throw new Error('disk unavailable');}};
    await expect(receivePipedriveEvent(broken,event('db-fail'),{companyId:'42'})).rejects.toThrow('disk unavailable');
  });
  it('retries after a failed hydration and recovers an expired lease after restart',async()=>{
    await receivePipedriveEvent(db.pool,event('retry'),{companyId:'42'});
    const failing={getEntity:async()=>{throw Object.assign(new Error('rate limited'),{status:429});}};
    expect((await processPendingPipedriveEvents(db.pool,{client:failing,companyId:'42',retryDelayMs:0})).failed).toBeGreaterThan(0);
    await db.pool.query("UPDATE sdr_crm_event_inbox SET status='leased',lease_until=now()-interval '1 second' WHERE event_id='retry'");
    const client={getEntity:async()=>({id:'lead-1',title:'Current',update_time:'2026-10-05T13:00:00Z',person_id:3})};
    expect((await processPendingPipedriveEvents(db.pool,{client,companyId:'42'})).processed).toBeGreaterThan(0);
    const history=await readLeadCrmObservations(db.pool,{companyId:'42',leadId:'lead-1'});
    expect(history.lead.data.title).toBe('Current');
  });
  it('retains explicit delete and merge provenance; a 404 remains unresolved',async()=>{
    await receivePipedriveEvent(db.pool,event('gone','delete','person','5','2026-10-05T14:00:00Z'),{companyId:'42'});
    await db.pool.query("UPDATE sdr_crm_event_inbox SET payload=jsonb_set(payload,'{meta,merged_to_id}','\"6\"'::jsonb) WHERE event_id='gone'");
    await processPendingPipedriveEvents(db.pool,{client:{getEntity:async()=>{throw Object.assign(new Error('missing'),{status:404});}},companyId:'42'});
    expect((await db.pool.query("SELECT lifecycle,merged_to_id FROM sdr_crm_snapshots WHERE entity='person' AND entity_id='5'")).rows[0]).toMatchObject({lifecycle:'merged',merged_to_id:'6'});
    await receivePipedriveEvent(db.pool,event('unknown','change','note','9'),{companyId:'42'});
    await processPendingPipedriveEvents(db.pool,{client:{getEntity:async()=>{throw Object.assign(new Error('missing'),{status:404});}},companyId:'42'});
    expect((await db.pool.query("SELECT lifecycle FROM sdr_crm_snapshots WHERE entity='note' AND entity_id='9'")).rows[0].lifecycle).toBe('unresolved');
  });
  it('keeps a partial checkpoint on page failure and resumes without advancing complete watermark',async()=>{
    let calls=0;
    const client={listScope:async(_scope,{cursor})=>{calls++;if(calls===2)throw Object.assign(new Error('429'),{status:429});return cursor?{items:[{id:'2',update_time:'2026-10-05T12:10:00Z'}],nextCursor:null}:{items:[{id:'1',update_time:'2026-10-05T12:00:00Z'}],nextCursor:'c2'};}};
    const first=await reconcilePipedriveScope(db.pool,{client,companyId:'42',scope:'persons',maxPages:2});
    expect(first.status).toBe('error');
    expect((await readCrmSyncHealth(db.pool,{companyId:'42'})).scopes.find(s=>s.scope==='persons').completedThrough).toBeNull();
    const second=await reconcilePipedriveScope(db.pool,{client,companyId:'42',scope:'persons',maxPages:2});
    expect(second.status).toBe('complete');
    expect(second.records).toBe(2);
  });
  it('keeps UTC source time and removes a null link when a newer revision arrives',async()=>{
    await receivePipedriveEvent(db.pool,event('link-first','change','activity','21','2026-10-05T15:00:00Z'),{companyId:'42'});
    await processPendingPipedriveEvents(db.pool,{companyId:'42',client:{getEntity:async()=>({id:21,lead_id:'lead-1',subject:'Call',update_time:'2026-10-05 15:00:00'})}});
    expect((await db.pool.query("SELECT to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS at FROM sdr_crm_snapshots WHERE entity='activity' AND entity_id='21'")).rows[0].at).toBe('2026-10-05T15:00:00');
    await receivePipedriveEvent(db.pool,event('link-null','change','activity','21','2026-10-05T16:00:00Z'),{companyId:'42'});
    await processPendingPipedriveEvents(db.pool,{companyId:'42',client:{getEntity:async()=>({id:21,lead_id:null,subject:'Unlinked',update_time:'2026-10-05 16:00:00'})}});
    expect((await db.pool.query("SELECT count(*)::int AS n FROM sdr_crm_links WHERE entity='activity' AND entity_id='21' AND link_type='lead'")).rows[0].n).toBe(0);
  });
  it('redacts cached entity content after permission denial and restores it after authorized hydration',async()=>{
    await receivePipedriveEvent(db.pool,event('visible','change','note','41','2026-10-05T17:00:00Z'),{companyId:'42'});
    await processPendingPipedriveEvents(db.pool,{companyId:'42',client:{getEntity:async()=>({id:41,lead_id:'lead-1',content:'private note',update_time:'2026-10-05T17:00:00Z'})}});
    await receivePipedriveEvent(db.pool,event('denied','change','note','41','2026-10-05T18:00:00Z'),{companyId:'42'});
    await processPendingPipedriveEvents(db.pool,{companyId:'42',client:{getEntity:async()=>{throw Object.assign(new Error('denied'),{status:403});}},retryDelayMs:100000});
    const hidden=await readLeadCrmObservations(db.pool,{companyId:'42',leadId:'lead-1'});
    expect(JSON.stringify(hidden)).not.toContain('private note');
    await receivePipedriveEvent(db.pool,event('restored','change','note','41','2026-10-05T19:00:00Z'),{companyId:'42'});
    await processPendingPipedriveEvents(db.pool,{companyId:'42',client:{getEntity:async()=>({id:41,lead_id:'lead-1',content:'public now',update_time:'2026-10-05T19:00:00Z'})}});
    expect(JSON.stringify(await readLeadCrmObservations(db.pool,{companyId:'42',leadId:'lead-1'}))).toContain('public now');
  });
  it('resolves a 404 after a later successful read even when the source update second precedes the webhook timestamp',async()=>{
    const companyId='recover-404',leadId='recover-lead';
    await receivePipedriveEvent(db.pool,companyEvent(companyId,'missing','change','lead',leadId,'2026-10-05T12:00:00.800Z'),{companyId});
    await processPendingPipedriveEvents(db.pool,{companyId,client:{getEntity:async()=>{throw Object.assign(Error('not found'),{status:404});}}});
    expect((await readLeadCrmObservations(db.pool,{companyId,leadId})).unavailable).toBe('unresolved');
    await reconcilePipedriveScope(db.pool,{companyId,scope:'leads_archived',client:{listScope:async()=>({items:[{id:leadId,title:'Recovered archive',update_time:'2026-10-05T12:00:00Z'}],nextCursor:null})}});
    expect((await readLeadCrmObservations(db.pool,{companyId,leadId})).lead).toMatchObject({data:{title:'Recovered archive'},lifecycle:'archived'});
  });
  it('does not let an older delayed 404 hide a newer successful source read',async()=>{
    const companyId='stale-404',leadId='l';
    await receivePipedriveEvent(db.pool,companyEvent(companyId,'older-404','change','lead',leadId,'2026-10-05T13:00:00Z'),{companyId});
    let rejectOlder,olderStarted;const began=new Promise(resolve=>{olderStarted=resolve;});
    const olderRun=processPendingPipedriveEvents(db.pool,{companyId,batchSize:1,client:{getEntity:async()=>{olderStarted();return new Promise((_resolve,reject)=>{rejectOlder=reject;});}}});
    await began;
    await receivePipedriveEvent(db.pool,companyEvent(companyId,'newer-success','change','lead',leadId,'2026-10-05T13:00:01Z'),{companyId});
    await processPendingPipedriveEvents(db.pool,{companyId,batchSize:1,client:{getEntity:async()=>({id:leadId,title:'Visible',update_time:'2026-10-05T12:00:00Z'})}});
    rejectOlder(Object.assign(Error('not found'),{status:404}));await olderRun;
    expect((await readLeadCrmObservations(db.pool,{companyId,leadId})).lead).toMatchObject({data:{title:'Visible'},lifecycle:'active'});
  });
  it('retains delete-first previous project links and source URL for note and converted deal revisions',async()=>{
    const companyId='delete-first';
    await reconcilePipedriveScope(db.pool,{companyId,scope:'leads_active',client:{listScope:async()=>({items:[{id:'parent',title:'Parent',update_time:'2026-10-05T12:00:00Z'}],nextCursor:null})}});
    await receivePipedriveEvent(db.pool,companyEvent(companyId,'delete-note','delete','note','n','2026-10-05T13:00:00Z',{id:'n',lead_id:'parent',content:'Deleted body'}),{companyId});
    await receivePipedriveEvent(db.pool,companyEvent(companyId,'delete-deal','delete','deal','d','2026-10-05T13:00:01Z',{id:'d',source_lead_id:'parent',title:'Converted deal'}),{companyId});
    await processPendingPipedriveEvents(db.pool,{companyId,client:{getEntity:async()=>{throw Error('delete must not hydrate');}}});
    const history=await readLeadCrmObservations(db.pool,{companyId,leadId:'parent'});
    expect(history.revisions.filter(row=>['n','d'].includes(row.entity_id)).map(row=>row.entity_id).sort()).toEqual(['d','n']);
    expect(history.revisions.find(row=>row.entity_id==='n').source_url).toBe('https://example.pipedrive.com/leads/inbox/parent');
    expect((await db.pool.query("SELECT link_type,linked_id FROM sdr_crm_links WHERE company_id=$1 AND entity='deal' AND entity_id='d' AND link_type='lead'",[companyId])).rows).toMatchObject([{link_type:'lead',linked_id:'parent'}]);
  });
  it('hides child history and followups behind a reviewed excluded deal, then restores on exact include',async()=>{
    const companyId='excluded-intermediate';
    const scan=async(scope,items)=>reconcilePipedriveScope(db.pool,{companyId,scope,client:{listScope:async()=>({items,nextCursor:null})}});
    await scan('leads_active',[{id:'parent',title:'Parent',update_time:'2026-10-05T12:00:00Z'}]);
    await scan('deals',[{id:4,title:'Test deal',source_lead_id:'parent',update_time:'2026-10-05T12:00:00Z'}]);
    await scan('activities',[{id:5,subject:'Excluded followup',deal_id:4,lead_id:'parent',done:false,update_time:'2026-10-05T12:00:00Z'}]);
    await scan('notes',[{id:6,content:'Excluded deal note',deal_id:4,lead_id:'parent',update_time:'2026-10-05T12:00:00Z'}]);
    await recordReviewedCrmExclusion(db.pool,{companyId,entity:'deal',matchType:'id',matchValue:'4',evidence:'Reviewed test deal',reviewedBy:'reviewer'});
    expect((await readCrmFollowups(db.pool,{companyId})).items).toEqual([]);
    const hidden=await readLeadCrmObservations(db.pool,{companyId,leadId:'parent'});
    expect(JSON.stringify(hidden)).not.toContain('Excluded followup');
    expect(JSON.stringify(hidden)).not.toContain('Excluded deal note');
    await recordReviewedCrmExclusion(db.pool,{companyId,entity:'deal',matchType:'id',matchValue:'4',decision:'include',evidence:'Reviewed as real',reviewedBy:'reviewer'});
    expect((await readCrmFollowups(db.pool,{companyId})).items).toMatchObject([{id:'5'}]);
    expect(JSON.stringify(await readLeadCrmObservations(db.pool,{companyId,leadId:'parent'}))).toContain('Excluded deal note');
  });
  it('hides cached note revision bodies while current visibility is unresolved and restores after a current read',async()=>{
    const companyId='unresolved-child';
    const scan=async(scope,items)=>reconcilePipedriveScope(db.pool,{companyId,scope,client:{listScope:async()=>({items,nextCursor:null})}});
    await scan('leads_active',[{id:'parent',title:'Parent',update_time:'2026-10-05T12:00:00Z'}]);
    await scan('notes',[{id:1,lead_id:'parent',content:'Cached now-unavailable note',update_time:'2026-10-05T12:00:00Z'}]);
    await receivePipedriveEvent(db.pool,companyEvent(companyId,'not-found','change','note','1','2026-10-05T13:00:00Z'),{companyId});
    await processPendingPipedriveEvents(db.pool,{companyId,client:{getEntity:async()=>{throw Object.assign(Error('not found'),{status:404});}}});
    expect(JSON.stringify(await readLeadCrmObservations(db.pool,{companyId,leadId:'parent'}))).not.toContain('Cached now-unavailable note');
    await receivePipedriveEvent(db.pool,companyEvent(companyId,'found','change','note','1','2026-10-05T13:00:01Z'),{companyId});
    await processPendingPipedriveEvents(db.pool,{companyId,client:{getEntity:async()=>({id:1,lead_id:'parent',content:'Recovered note',update_time:'2026-10-05T12:00:00Z'})}});
    expect(JSON.stringify(await readLeadCrmObservations(db.pool,{companyId,leadId:'parent'}))).toContain('Recovered note');
  });
  it('retries the same page if checkpoint persistence fails after record writes',async()=>{
    let fail=true;const cursors=[];
    const faultPool={query:db.pool.query.bind(db.pool),connect:async()=>{
      const raw=await db.pool.connect();return {release:()=>raw.release(),query:(sql,args)=>{
        if(fail&&String(sql).includes('INSERT INTO sdr_crm_scope_coverage')){fail=false;throw new Error('checkpoint disk error');}
        return raw.query(sql,args);
      }};
    }};
    const client={listScope:async(_scope,{cursor})=>{cursors.push(cursor);return cursor?{items:[{id:52,update_time:'2026-10-05T20:00:00Z'}],nextCursor:null}:{items:[{id:51,update_time:'2026-10-05T19:00:00Z'}],nextCursor:'next'};}};
    const failed=await reconcilePipedriveScope(faultPool,{client,companyId:'42',scope:'organizations',maxPages:2});
    expect(failed).toMatchObject({status:'error',cursor:null,pages:0,records:0});
    const resumed=await reconcilePipedriveScope(db.pool,{client,companyId:'42',scope:'organizations',maxPages:2});
    expect(resumed).toMatchObject({status:'complete',pages:2,records:2});
    expect(cursors).toEqual([null,null,'next']);
  });
  it('hides child content when parent lead visibility is denied and restores it after observation',async()=>{
    await db.pool.query("UPDATE sdr_crm_snapshots SET access_status='denied' WHERE entity='lead' AND entity_id='lead-1'");
    const hidden=await readLeadCrmObservations(db.pool,{companyId:'42',leadId:'lead-1'});
    expect(hidden).toMatchObject({items:[],revisions:[],unavailable:'permission_denied'});
    expect(JSON.stringify(hidden)).not.toContain('public now');
    expect((await readCrmFollowups(db.pool,{companyId:'42'})).items.every(item=>item.leadId!=='lead-1')).toBe(true);
    await db.pool.query("UPDATE sdr_crm_snapshots SET access_status='accessible' WHERE entity='lead' AND entity_id='lead-1'");
  });
  it('paginates history without losing the lead and includes only explicitly linked converted deal evidence',async()=>{
    await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,lifecycle) VALUES
      ('42','deal','500','{"id":500,"source_lead_id":"lead-1"}','2026-10-05T20:00:00Z','active'),
      ('42','note','501','{"id":501,"deal_id":500,"content":"deal note"}','2026-10-05T20:01:00Z','active')`);
    await db.pool.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES
      ('42','deal','500','lead','lead-1','pipedrive:source_lead_id'),
      ('42','note','501','deal','500','pipedrive:deal_id')`);
    await db.pool.query("UPDATE sdr_crm_snapshots SET observed_at=now()+interval '1 second' WHERE entity='note' AND entity_id='501'");
    const history=await readLeadCrmObservations(db.pool,{companyId:'42',leadId:'lead-1',limit:1});
    expect(history.lead.entity_id).toBe('lead-1');
    expect(history.items[0].data.content).toBe('deal note');
    expect(history.hasMore.items).toBe(true);
  });
  it('lists current followups by owner and lifecycle with an honest next page',async()=>{
    await db.pool.query("UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{owner_name}','\"Different lead owner\"'::jsonb) WHERE entity='lead' AND entity_id='lead-1'");
    await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,lifecycle,source_url) VALUES
      ('42','activity','600','{"id":600,"lead_id":"lead-1","owner_id":9,"done":false,"subject":"Call","type":"call","due_date":"2026-10-06"}','2026-10-05T20:00:00Z','active','https://example.pipedrive.com/leads/inbox/lead-1'),
      ('42','activity','601','{"id":601,"lead_id":"lead-1","owner_id":9,"done":false,"subject":"Email","type":"email","due_date":"2026-10-07"}','2026-10-05T20:00:00Z','active',NULL)`);
    await db.pool.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES
      ('42','activity','600','lead','lead-1','pipedrive:lead_id'),('42','activity','601','lead','lead-1','pipedrive:lead_id')`);
    const first=await readCrmFollowups(db.pool,{companyId:'42',ownerId:'9',lifecycle:'active',limit:1});
    expect(first.items).toMatchObject([{id:'600',leadId:'lead-1',leadTitle:'Current',leadLifecycle:'active',subject:'Call',type:'call',ownerName:null}]);
    expect(first.nextCursor).toBe('1');
    const next=await readCrmFollowups(db.pool,{companyId:'42',ownerId:'9',lifecycle:'active',limit:1,cursor:first.nextCursor});
    expect(next.items).toMatchObject([{id:'601',subject:'Email'}]);
    const calls=await readCrmFollowups(db.pool,{companyId:'42',ownerId:'9',activityType:'call',limit:1});
    expect(calls).toMatchObject({items:[{id:'600',type:'call'}],nextCursor:null});
  });
  it('scans archive ties through a strictly older overlap boundary and completes a verified delta',async()=>{
    await db.pool.query(`INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,completed_through,last_full_at)
      VALUES('42','leads_archived','complete','2026-10-05T12:10:00Z',NOW())`);
    const cursors=[];
    const client={listScope:async(_scope,{cursor})=>{
      cursors.push(cursor);
      if(!cursor)return {items:[{id:'a',update_time:'2026-10-05T12:11:00Z'},{id:'b',update_time:'2026-10-05T12:08:00Z'}],nextCursor:'100'};
      return {items:[{id:'c',update_time:'2026-10-05T12:08:00Z'},{id:'d',update_time:'2026-10-05T12:07:59Z'}],nextCursor:'200'};
    }};
    const result=await reconcilePipedriveScope(db.pool,{client,companyId:'42',scope:'leads_archived',maxPages:3});
    expect(result.status).toBe('complete');
    expect(cursors).toEqual([null,'100']);
  });
  it('keeps archive watermark partial on malformed or out-of-order dates',async()=>{
    const before=(await readCrmSyncHealth(db.pool,{companyId:'42'})).scopes.find(s=>s.scope==='leads_archived').completedThrough;
    const result=await reconcilePipedriveScope(db.pool,{client:{listScope:async()=>({items:[{id:'x',update_time:'bad'}],nextCursor:null})},companyId:'42',scope:'leads_archived'});
    expect(result.status).toBe('error');
    const after=(await readCrmSyncHealth(db.pool,{companyId:'42'})).scopes.find(s=>s.scope==='leads_archived');
    expect(after.completedThrough).toEqual(before);
    const ordered=await reconcilePipedriveScope(db.pool,{client:{listScope:async()=>({items:[{id:'x',update_time:'2026-10-05T12:09:00Z'},{id:'y',update_time:'2026-10-05T12:10:00Z'}],nextCursor:null})},companyId:'42',scope:'leads_archived'});
    expect(ordered.status).toBe('error');
  });
  it('fences an expired worker from acknowledging or replacing a newer claimant',async()=>{
    const item={...event('fence','change','note','900','2026-10-05T21:00:00Z'),meta:{...event('fence','change','note','900','2026-10-05T21:00:00Z').meta,company_id:'43'}};
    await receivePipedriveEvent(db.pool,item,{companyId:'43'});
    let release,started;
    const began=new Promise(resolve=>{started=resolve;});
    const slow=processPendingPipedriveEvents(db.pool,{companyId:'43',batchSize:1,leaseSeconds:0,client:{getEntity:async()=>{started();return new Promise(resolve=>{release=resolve;});}}});
    await began;
    const fast=await processPendingPipedriveEvents(db.pool,{companyId:'43',batchSize:1,client:{getEntity:async()=>({id:900,content:'newer',update_time:'2026-10-05T22:00:00Z'})}});
    release({id:900,content:'older',update_time:'2026-10-05T21:00:00Z'});
    const stale=await slow;
    expect(fast.processed).toBe(1);
    expect(stale.processed).toBe(0);
    expect((await db.pool.query("SELECT data->>'content' AS content FROM sdr_crm_snapshots WHERE company_id='43' AND entity='note' AND entity_id='900'")).rows[0].content).toBe('newer');
  });
  it('retains project link provenance for explicit note deletion',async()=>{
    await receivePipedriveEvent(db.pool,event('note-delete','delete','note','41','2026-10-05T23:00:00Z'),{companyId:'42'});
    await processPendingPipedriveEvents(db.pool,{companyId:'42',client:{getEntity:async()=>{throw Error('delete should not hydrate');}}});
    const history=await readLeadCrmObservations(db.pool,{companyId:'42',leadId:'lead-1'});
    expect(history.items.find(item=>item.entity==='note'&&item.entity_id==='41')?.lifecycle).toBe('deleted');
  });
  it('does not resurrect a deleted entity from a concurrent older change with the same source second',async()=>{
    const company='race-delete';
    const make=(name,action)=>({...event(name,action,'note','1','2026-10-05T12:00:00Z'),meta:{...event(name,action,'note','1','2026-10-05T12:00:00Z').meta,company_id:company}});
    await receivePipedriveEvent(db.pool,make('slow','change'),{companyId:company});
    let release,started;const began=new Promise(resolve=>{started=resolve;});
    const slow=processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{started();return new Promise(resolve=>{release=resolve;});}}});
    await began;
    await receivePipedriveEvent(db.pool,make('delete','delete'),{companyId:company});
    await processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{throw Error('should not hydrate delete');}}});
    release({id:1,content:'old',update_time:'2026-10-05T12:00:00Z'});await slow;
    expect((await db.pool.query("SELECT lifecycle FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='note' AND entity_id='1'",[company])).rows[0].lifecycle).toBe('deleted');
  });
  it('keeps a tombstone against an older request even if its hydrated timestamp is later',async()=>{
    const company='race-delete-skew';
    const make=(name,action)=>({...event(name,action,'note','1','2026-10-05T12:00:00Z'),meta:{...event(name,action,'note','1','2026-10-05T12:00:00Z').meta,company_id:company}});
    await receivePipedriveEvent(db.pool,make('slow','change'),{companyId:company});
    let release,started;const began=new Promise(resolve=>{started=resolve;});
    const slow=processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{started();return new Promise(resolve=>{release=resolve;});}}});
    await began;await receivePipedriveEvent(db.pool,make('delete','delete'),{companyId:company});
    await processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>null}});
    release({id:1,content:'stale',update_time:'2026-10-05T12:00:01Z'});await slow;
    expect((await db.pool.query("SELECT lifecycle FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='note' AND entity_id='1'",[company])).rows[0].lifecycle).toBe('deleted');
  });
  it('does not replace a newer observation with an older overlapping read at equal source time',async()=>{
    const company='race-equal-change';
    const make=name=>({...event(name,'change','note','1','2026-10-05T12:00:00Z'),meta:{...event(name,'change','note','1','2026-10-05T12:00:00Z').meta,company_id:company}});
    await receivePipedriveEvent(db.pool,make('old'),{companyId:company});
    let release,started;const began=new Promise(resolve=>{started=resolve;});
    const slow=processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{started();return new Promise(resolve=>{release=resolve;});}}});
    await began;await receivePipedriveEvent(db.pool,make('new'),{companyId:company});
    await processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>({id:1,content:'new',update_time:'2026-10-05T12:00:00Z'})}});
    release({id:1,content:'old',update_time:'2026-10-05T12:00:00Z'});await slow;
    expect((await db.pool.query("SELECT data->>'content' AS content FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='note' AND entity_id='1'",[company])).rows[0].content).toBe('new');
  });
  it('accepts a newer read that started before an older read committed',async()=>{
    const company='race-overlap-newer';
    const make=name=>({...event(name,'change','note','1','2026-10-05T12:00:00Z'),meta:{...event(name,'change','note','1','2026-10-05T12:00:00Z').meta,company_id:company}});
    await receivePipedriveEvent(db.pool,make('old'),{companyId:company});
    let releaseOld,oldStarted;const oldBegan=new Promise(resolve=>{oldStarted=resolve;});
    const oldRun=processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{oldStarted();return new Promise(resolve=>{releaseOld=resolve;});}}});
    await oldBegan;await receivePipedriveEvent(db.pool,make('new'),{companyId:company});
    let releaseNew,newStarted;const newBegan=new Promise(resolve=>{newStarted=resolve;});
    const newRun=processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{newStarted();return new Promise(resolve=>{releaseNew=resolve;});}}});
    await newBegan;
    releaseOld({id:1,content:'older',update_time:'2026-10-05T12:00:00Z'});await oldRun;
    releaseNew({id:1,content:'newer',update_time:'2026-10-05T12:00:01Z'});await newRun;
    expect((await db.pool.query("SELECT data->>'content' AS content FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='note' AND entity_id='1'",[company])).rows[0].content).toBe('newer');
  });
  it('does not let a source read started before denial restore access afterward',async()=>{
    const company='race-permission';
    const make=name=>({...event(name,'change','lead','1','2026-10-05T12:00:00Z'),meta:{...event(name,'change','lead','1','2026-10-05T12:00:00Z').meta,company_id:company}});
    await receivePipedriveEvent(db.pool,make('slow'),{companyId:company});
    let release,started;const began=new Promise(resolve=>{started=resolve;});
    const slow=processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{started();return new Promise(resolve=>{release=resolve;});}}});
    await began;
    await receivePipedriveEvent(db.pool,make('denied'),{companyId:company});
    await processPendingPipedriveEvents(db.pool,{companyId:company,batchSize:1,client:{getEntity:async()=>{throw Object.assign(Error('denied'),{status:403});}}});
    release({id:'1',title:'old',update_time:'2026-10-05T12:00:00Z'});await slow;
    expect((await db.pool.query("SELECT access_status FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='lead' AND entity_id='1'",[company])).rows[0].access_status).toBe('denied');
  });
  it('redacts child evidence when its intermediate converted deal becomes denied',async()=>{
    const company='deal-permission';
    await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle,access_status) VALUES
      ($1,'lead','l','{"id":"l","title":"Lead"}','active','accessible'),
      ($1,'deal','5','{"id":5,"source_lead_id":"l"}','active','denied'),
      ($1,'note','6','{"id":6,"deal_id":5,"content":"hidden deal note"}','active','accessible'),
      ($1,'activity','7','{"id":7,"deal_id":5,"subject":"hidden followup","done":false}','active','accessible')`,[company]);
    await db.pool.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES
      ($1,'deal','5','lead','l','source_lead_id'),($1,'note','6','deal','5','deal_id'),($1,'activity','7','deal','5','deal_id')`,[company]);
    expect(JSON.stringify(await readLeadCrmObservations(db.pool,{companyId:company,leadId:'l'}))).not.toContain('hidden deal note');
    expect((await readCrmFollowups(db.pool,{companyId:company})).items).toEqual([]);
  });
  it('redacts cached lead and child content after a scope-level 403 until complete recovery',async()=>{
    const company='scope-permission';
    await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle,access_status) VALUES
      ($1,'lead','l','{"id":"l","title":"Cached lead"}','active','accessible'),
      ($1,'note','n','{"id":"n","lead_id":"l","content":"cached secret"}','active','accessible')`,[company]);
    await db.pool.query("INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES($1,'note','n','lead','l','lead_id')",[company]);
    await reconcilePipedriveScope(db.pool,{companyId:company,scope:'leads_active',client:{listScope:async()=>{throw Object.assign(Error('denied'),{status:403});}}});
    const hidden=await readLeadCrmObservations(db.pool,{companyId:company,leadId:'l'});
    expect(hidden.unavailable).toBe('permission_denied');expect(JSON.stringify(hidden)).not.toContain('cached secret');
    await reconcilePipedriveScope(db.pool,{companyId:company,scope:'leads_active',client:{listScope:async()=>({items:[{id:'l',title:'Recovered',update_time:'2026-10-05T13:00:00Z'}],nextCursor:null})}});
    expect((await readLeadCrmObservations(db.pool,{companyId:company,leadId:'l'})).unavailable).toBeUndefined();
  });
  it('does not clear a later scope permission denial with an older page response',async()=>{
    const company='scope-race';
    await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle) VALUES($1,'lead','l','{\"id\":\"l\",\"title\":\"Cached\"}','active')",[company]);
    let release,started;const began=new Promise(resolve=>{started=resolve;});
    const slow=reconcilePipedriveScope(db.pool,{companyId:company,scope:'leads_active',client:{listScope:async()=>{started();return new Promise(resolve=>{release=resolve;});}}});
    await began;
    await reconcilePipedriveScope(db.pool,{companyId:company,scope:'leads_active',client:{listScope:async()=>{throw Object.assign(Error('denied'),{status:403});}}});
    release({items:[{id:'l',title:'Older response',update_time:'2026-10-05T12:00:00Z'}],nextCursor:null});await slow;
    expect((await readLeadCrmObservations(db.pool,{companyId:company,leadId:'l'})).unavailable).toBe('permission_denied');
  });
  it('an explicit full scan restarts a saved archive delta from the head',async()=>{
    const company='force-full';
    await db.pool.query(`INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,cursor,scan_mode,completed_through,last_full_at,pages,records)
      VALUES($1,'leads_archived','partial','100','delta','2026-10-05T12:00:00Z',now(),1,50)`,[company]);
    const seen=[];
    const result=await reconcilePipedriveScope(db.pool,{companyId:company,scope:'leads_archived',full:true,client:{listScope:async(_scope,args)=>{seen.push(args);return {items:[],nextCursor:null};}}});
    expect(seen).toMatchObject([{cursor:null,since:null}]);
    expect(result.status).toBe('complete');
    expect((await db.pool.query("SELECT scan_mode FROM sdr_crm_scope_coverage WHERE company_id=$1 AND scope='leads_archived'",[company])).rows[0].scan_mode).toBe('full');
  });
  it('applies reviewed ID/pattern exclusions through refresh and supports explicit non-test override',async()=>{
    const company='review-exclusions';
    await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,lifecycle,access_status) VALUES($1,'lead','l','{\"id\":\"l\",\"title\":\"Real lead\"}','active','accessible')",[company]);
    await recordReviewedCrmExclusion(db.pool,{companyId:company,entity:'activity',matchType:'title_pattern',matchValue:'artificial call',evidence:'audited activity fixture',reviewedBy:'ivan'});
    await reconcilePipedriveScope(db.pool,{companyId:company,scope:'activities',client:{listScope:async()=>({items:[{id:29844,lead_id:'l',subject:'Artificial call',done:false,update_time:'2026-10-05T12:00:00Z'}],nextCursor:null})}});
    expect((await db.pool.query("SELECT is_test,test_evidence FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='activity' AND entity_id='29844'",[company])).rows[0]).toMatchObject({is_test:true,test_evidence:'audited activity fixture'});
    expect((await readCrmFollowups(db.pool,{companyId:company})).items).toEqual([]);
    await recordReviewedCrmExclusion(db.pool,{companyId:company,entity:'activity',matchType:'id',matchValue:'29844',decision:'include',evidence:'reviewed real call',reviewedBy:'ivan'});
    await reconcilePipedriveScope(db.pool,{companyId:company,scope:'activities',client:{listScope:async()=>({items:[{id:29844,lead_id:'l',subject:'Artificial call',done:false,update_time:'2026-10-05T13:00:00Z'}],nextCursor:null})}});
    expect((await db.pool.query("SELECT is_test,test_evidence FROM sdr_crm_snapshots WHERE company_id=$1 AND entity='activity' AND entity_id='29844'",[company])).rows[0]).toMatchObject({is_test:false,test_evidence:'reviewed real call'});
    expect((await readCrmFollowups(db.pool,{companyId:company})).items).toMatchObject([{id:'29844'}]);
  });
  it('filters fresh source notes and activities through reviewed rules without mutating raw evidence',async()=>{
    const company='fresh-review';
    await recordReviewedCrmExclusion(db.pool,{companyId:company,entity:'note',matchType:'id',matchValue:'n1',evidence:'audited fixture',reviewedBy:'ivan'});
    await recordReviewedCrmExclusion(db.pool,{companyId:company,entity:'activity',matchType:'title_pattern',matchValue:'artificial call',evidence:'audited task pattern',reviewedBy:'ivan'});
    await recordReviewedCrmExclusion(db.pool,{companyId:company,entity:'activity',matchType:'id',matchValue:'a1',decision:'include',evidence:'reviewed real call',reviewedBy:'ivan'});
    const raw={complete:true,lead:{id:'l',title:'Real'},person:{id:'p'},organization:{id:'o'},notes:[{id:'n1',content:'fixture'},{id:'n2',content:'real'}],
      activities:[{id:'a1',subject:'Artificial call'},{id:'a2',subject:'Artificial call'}],errors:[]};
    const filtered=await filterReviewedCrmEvidence(db.pool,{companyId:company,evidence:raw});
    expect(filtered.notes).toEqual([{id:'n2',content:'real'}]);
    expect(filtered.activities).toEqual([{id:'a1',subject:'Artificial call'}]);
    expect(raw.notes).toHaveLength(2);expect(raw.activities).toHaveLength(2);
  });
  it('blocks fresh context with an explicit reviewed identity exclusion reason',async()=>{
    const company='fresh-identity';
    await recordReviewedCrmExclusion(db.pool,{companyId:company,entity:'organization',matchType:'id',matchValue:'o',evidence:'reviewed test org',reviewedBy:'ivan'});
    const filtered=await filterReviewedCrmEvidence(db.pool,{companyId:company,evidence:{complete:true,lead:{id:'l'},person:null,organization:{id:'o'},notes:[{id:'n'}],activities:[],errors:[]}});
    expect(filtered.complete).toBe(false);
    expect(filtered.errors).toMatchObject([{category:'reviewed_test',entity:'organization',id:'o',evidence:'reviewed test org'}]);
    expect(filtered.organization).toBeNull();
    expect(filtered.notes).toEqual([]);
  });
});
