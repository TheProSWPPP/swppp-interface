import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { dispatchLinkedinAction } from '../sdrLinkedinOperations.js';
import { createLinkedinProspectFreshContext } from '../sdrLinkedinProspectFreshContext.js';
import { ingestLinkedinEvent } from '../sdrLinkedinSync.js';
import { linkedinHash } from '../sdrLinkedinStore.js';
import { LINKEDIN_OUTSTANDING_INVITE_CAP } from '../sdrLinkedinRamp.js';
import { testPool, createProspectSchema, prospectConfig, approvalDigest } from './helpers/linkedinProspectFixture.js';

// Prospect lanes since 2026-11-03: the same fences, on lane B prospects (no customer lookup).
const { schema, pool } = testPool('linkedin_failures');
const NOW = new Date('2027-10-19T16:00:00Z');

beforeAll(async () => { await createProspectSchema(pool, schema); });
afterAll(async () => {
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

async function fixture(accountId, sourceIds, budget = 1, readBudget = 100) {
  const config = prospectConfig({ lane: 'B', sourceIds, lateAcceptancePolicy: 'hold', budgets: { invite: budget, dm: budget }, copy: { dm1: 'A', followup1: 'B', inmail: { subject: 'S', body: 'I' } } });
  await pool.query("INSERT INTO sdr_linkedin_accounts(company_id,account_id,sender_provider_id,status,mode,read_budget,read_timezone,ramp_started_on) VALUES('13105180',$1,'ACo-sender','healthy','live',$2,'America/Chicago','2027-09-01')", [accountId,readBudget]);
  const campaign = (await pool.query(`INSERT INTO sdr_linkedin_campaigns(company_id,account_id,status,approval_digest,cohort_digest,config,approved_by,approved_at,expires_at)
    VALUES('13105180',$1,'approved',$2,'cohort',$3,'owner',now(),'2030-01-01T00:00:00Z') RETURNING id`,
  [accountId, approvalDigest(accountId, config), JSON.stringify(config)])).rows[0];
  const actions = [];
  for (const sourceId of sourceIds) {
    const candidate = (await pool.query(`INSERT INTO sdr_linkedin_candidates(company_id,account_id,source,source_id,profile_url,segment,territory,person_id,organization_id,owner_id,provider_id,product,state,campaign_id,lane,resolved_email,firm,source_context)
      VALUES('13105180',$1,'linkedin_prospect',$2,$3,'B','TX',$4,'example gc','owner',$5,'classic','reviewed',$6,'B',$7,'Example GC',$8) RETURNING id`,
    [accountId, sourceId, `https://www.linkedin.com/in/${sourceId}/`, `li:ACo-${sourceId}`, `ACo-${sourceId}`, campaign.id, `${sourceId}@example.test`, JSON.stringify({ fullName: `Pat ${sourceId}` })])).rows[0];
    const action = (await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash)
      VALUES('13105180',$1,$2,$3,$4,1,'invite',$5,now()-interval '1 minute','hash') RETURNING id`,
    [accountId, candidate.id, `li:ACo-${sourceId}`, campaign.id, `invite-${sourceId}`])).rows[0];
    actions.push({ actionId: action.id, candidateId: candidate.id });
  }
  return actions;
}

const allow = async () => ({ allowed: true, contextHash: 'hash' });

describe('LinkedIn failure boundaries on isolated Postgres', () => {
  it('atomically excludes holds and known messages committed after the earlier checks',async()=>{
    for(const kind of ['hold','in','unknown','out']){
      const sourceId=`atomic-${kind}`,[row]=await fixture(sourceId,[sourceId]);let injected=false,calls=0;
      const interleavedPool={connect:async()=>{
        const db=await pool.connect();return {release:()=>db.release(),query:async(sql,params)=>{
          if(!injected&&sql.includes("SET state='network_started'")){
            injected=true;
            // A prospect has no lead: a lead-less control (here one buyer's address) is what fences it.
            if(kind==='hold')await pool.query("INSERT INTO sdr_outreach_controls(company_id,lead_id,status,scope_kind,scope_id) VALUES('13105180',NULL,'active','recipient',$1)",[`${sourceId}@example.test`]);
            else await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,source_message_id,direction,coverage,payload_hash) VALUES('13105180',$1,$2,$3,'message_received','fixture',$4,$5,'event',$4)`,[sourceId,row.candidateId,`li:ACo-${sourceId}`,`capture-${sourceId}`,kind]);
          }
          return db.query(sql,params);
        }};
      }};
      const result=await dispatchLinkedinAction({pool:interleavedPool,actionId:row.actionId,client:{invite:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}},readFreshContext:allow,mode:'live',now:new Date('2027-10-19T16:00:00Z')});
      expect(injected,kind).toBe(true);expect(result.state,kind).toBe('held');expect(calls,kind).toBe(0);
      await pool.query("DELETE FROM sdr_outreach_controls");
    }
  });
  it('atomically excludes human email replies committed after the earlier checks',async()=>{
    await pool.query(`CREATE TABLE sdr_message_facts(direction text,prospect_email text,human_reply boolean,occurred_at timestamptz);
      CREATE TABLE sdr_inbox_reply_log(from_addr text,created_at timestamptz)`);
    try{
      for(const kind of ['fact','legacy']){
        const sourceId=`atomic-email-${kind}`,[row]=await fixture(sourceId,[sourceId]);let injected=false,calls=0;
        const interleavedPool={connect:async()=>{
          const db=await pool.connect();return {release:()=>db.release(),query:async(sql,params)=>{
            if(!injected&&sql.includes("SET state='network_started'")){
              injected=true;
              if(kind==='fact')await pool.query("INSERT INTO sdr_message_facts VALUES('in',$1,true,now())",[`${sourceId.toUpperCase()}@EXAMPLE.TEST`]);
              else await pool.query('INSERT INTO sdr_inbox_reply_log VALUES($1,now())',[`Prospect <${sourceId.toUpperCase()}@EXAMPLE.TEST>`]);
            }
            return db.query(sql,params);
          }};
        }};
        const result=await dispatchLinkedinAction({pool:interleavedPool,actionId:row.actionId,client:{invite:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}},readFreshContext:allow,mode:'live',now:new Date('2027-10-19T16:00:00Z')});
        expect(injected,kind).toBe(true);expect(result.state,kind).toBe('held');expect(calls,kind).toBe(0);
      }
      const sourceId='atomic-email-automatic',[row]=await fixture(sourceId,[sourceId]);let calls=0;
      await pool.query("INSERT INTO sdr_message_facts VALUES('in',$1,false,now()),('out',$1,true,now())",[`${sourceId}@example.test`]);
      await pool.query('INSERT INTO sdr_inbox_reply_log VALUES($1,now())',[`[auto-reply] ${sourceId}@example.test`]);
      const allowed=await dispatchLinkedinAction({pool,actionId:row.actionId,client:{invite:async()=>{calls++;return {outcome:'confirmed',providerId:'sent'}}},readFreshContext:allow,mode:'live',now:new Date('2027-10-19T16:00:00Z')});
      expect(allowed.state).toBe('confirmed');expect(calls).toBe(1);
    }finally{
      await pool.query('DROP TABLE sdr_message_facts,sdr_inbox_reply_log');
    }
  });
  it('does not send from an account with the default zero read allowance',async()=>{const [row]=await fixture('zero-reads',['zero-reads'],1,0);let calls=0;expect((await dispatchLinkedinAction({pool,actionId:row.actionId,client:{invite:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}},readFreshContext:allow,mode:'live',now:new Date('2027-10-19T16:00:00Z')})).state).toBe('held');expect(calls).toBe(0)});
  it('records a bounded hold reason when the fresh read budget is exhausted',async()=>{const [row]=await fixture('read-hold',['read-hold']);let calls=0;const result=await dispatchLinkedinAction({pool,actionId:row.actionId,client:{invite:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}},readFreshContext:async()=>({allowed:false,reasons:['read_budget_exhausted']}),mode:'live',now:NOW});expect(result).toMatchObject({state:'held',reason:'read_budget_exhausted'});expect((await pool.query('SELECT hold_reason FROM sdr_linkedin_actions WHERE id=$1',[row.actionId])).rows[0].hold_reason).toBe('read_budget_exhausted');expect(calls).toBe(0)});
  it('serializes two people against one account budget', async () => {
    const actions = await fixture('shared-budget', ['budget-one', 'budget-two']);
    let calls = 0;
    const client = { invite: async () => ({ outcome: 'confirmed', providerId: `invite-${++calls}` }) };
    const results = await Promise.all(actions.map(({ actionId }) => dispatchLinkedinAction({ pool, actionId, client, readFreshContext: allow, mode: 'live', now: NOW })));
    expect(results.map(result => result.state).sort()).toEqual(['budget_exhausted', 'confirmed']);
    expect(calls).toBe(1);
  });
  it('caps outstanding invitations on their own counter, not the DM budget',async()=>{
    const [row]=await fixture('outstanding-cap',['outstanding-cap'],2);
    const campaign=(await pool.query('SELECT campaign_id FROM sdr_linkedin_actions WHERE id=$1',[row.actionId])).rows[0].campaign_id;
    await pool.query(`INSERT INTO sdr_linkedin_candidates(company_id,account_id,source,source_id,profile_url,person_id,provider_id,product,state,lane,owner_id) SELECT '13105180','outstanding-cap','linkedin_prospect','old-'||n,'https://www.linkedin.com/in/old-'||n||'/','li:ACo-old-'||n,'ACo-old-'||n,'classic','reviewed','B','owner' FROM generate_series(1,$1::int) n`,[LINKEDIN_OUTSTANDING_INVITE_CAP]);
    await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,state,reserved_at,confirmed_at,provider_id) SELECT c.company_id,c.account_id,c.id,c.person_id,$1,1,'invite','old-'||c.id,$2::timestamptz-interval '10 days','h','confirmed',$2::timestamptz-interval '10 days',$2::timestamptz-interval '10 days','inv-'||c.id FROM sdr_linkedin_candidates c WHERE c.account_id='outstanding-cap' AND c.source_id LIKE 'old-%'`,[campaign,NOW]);
    let calls=0;const client={invite:async()=>{calls++;return {outcome:'confirmed',providerId:'expected'}}};
    expect((await dispatchLinkedinAction({pool,actionId:row.actionId,client,readFreshContext:allow,mode:'live',now:NOW})).state).toBe('outstanding_invites_capped');
    await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,coverage,payload_hash) SELECT company_id,account_id,id,person_id,'new_relation','fixture',provider_id,'event','rel-'||id FROM sdr_linkedin_candidates WHERE account_id='outstanding-cap' AND source_id='old-1'`);
    expect((await dispatchLinkedinAction({pool,actionId:row.actionId,client,readFreshContext:allow,mode:'live',now:NOW})).state).toBe('confirmed');
    expect(calls).toBe(1);
  });

  it('holds a candidate changed before the network boundary', async () => {
    const [{ actionId, candidateId }] = await fixture('changed-candidate', ['changed-one']);
    let calls = 0;
    await pool.query("UPDATE sdr_linkedin_candidates SET state='held',hold_reason='inbound' WHERE id=$1", [candidateId]);
    const result = await dispatchLinkedinAction({ pool, actionId, mode: 'live', client: { invite: async () => { calls++; } }, readFreshContext: allow, now: NOW });
    expect(result.state).toBe('held');
    expect(calls).toBe(0);
  });

  it('blocks an archived candidate and an invitation outside the approved window',async()=>{
    const [archived] = await fixture('archived-send',['archived-send']);
    await pool.query("UPDATE sdr_linkedin_candidates SET state='archived' WHERE id=$1",[archived.candidateId]);
    let calls=0;const client={invite:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}};
    expect((await dispatchLinkedinAction({pool,actionId:archived.actionId,client,readFreshContext:allow,mode:'live',now:new Date('2027-10-19T16:00:00Z')})).state).toBe('held');
    const [weekend]=await fixture('weekend-send',['weekend-send']);
    expect((await dispatchLinkedinAction({pool,actionId:weekend.actionId,client,readFreshContext:allow,mode:'live',now:new Date('2027-10-23T15:00:00Z')})).state).toBe('window_closed');
    expect(calls).toBe(0);
  });

  it('rechecks same-day DM1 acceptance at dispatch after a queued action is delayed',async()=>{
    const [row]=await fixture('late-dm',['late-dm']);
    const campaign=(await pool.query('SELECT campaign_id FROM sdr_linkedin_actions WHERE id=$1',[row.actionId])).rows[0].campaign_id;
    const current=(await pool.query('SELECT config FROM sdr_linkedin_campaigns WHERE id=$1',[campaign])).rows[0].config;
    current.budgets.dm=1;
    await pool.query("UPDATE sdr_linkedin_campaigns SET config=$2,approval_digest=$3 WHERE id=$1",[campaign,JSON.stringify(current),linkedinHash({companyId:'13105180',accountId:'late-dm',revision:1,config:current,cohort:'cohort',expiresAt:'2030-01-01T00:00:00.000Z'})]);
    await pool.query("UPDATE sdr_linkedin_actions SET step='dm1',due_at='2026-10-19T16:00:00Z',body='Hello' WHERE id=$1",[row.actionId]);
    await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,source_at,coverage,payload_hash) VALUES('13105180','late-dm',$1,'li:ACo-late-dm','new_relation','fixture','ACo-late-dm','2026-10-19T16:00:00Z','event','late-relation')`,[row.candidateId]);
    let calls=0;
    expect((await dispatchLinkedinAction({pool,actionId:row.actionId,client:{sendFirst:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}},readFreshContext:allow,mode:'live',now:new Date('2026-10-20T16:00:00Z')})).state).toBe('held');
    expect(calls).toBe(0);
  });

  it('holds an invitation when fresh reads cross the closing hour',async()=>{
    const [row]=await fixture('window-cross',['window-cross']);let elapsed=0,calls=0;
    const result=await dispatchLinkedinAction({pool,actionId:row.actionId,client:{invite:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}},readFreshContext:async()=>{elapsed=4*60_000;return {allowed:true,contextHash:'hash'}},mode:'live',now:new Date('2027-10-19T21:58:00Z'),clock:()=>elapsed});
    expect(result.state).toBe('held');expect(calls).toBe(0);
  });
  it('never sends DM1 outside the weekday send window, even right after acceptance',async()=>{
    const [row]=await fixture('midnight-dm',['midnight-dm']);
    await pool.query("UPDATE sdr_linkedin_actions SET step='dm1',body='Hello',due_at='2027-10-19T04:58:00Z' WHERE id=$1",[row.actionId]);
    await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,source_at,coverage,payload_hash) VALUES('13105180','midnight-dm',$1,'li:ACo-midnight-dm','new_relation','fixture','ACo-midnight-dm','2027-10-19T04:58:00Z','event','midnight-relation')`,[row.candidateId]);
    let elapsed=0,calls=0;const outcome=await dispatchLinkedinAction({pool,actionId:row.actionId,client:{sendFirst:async()=>{calls++;return {outcome:'confirmed',providerId:'wrong'}}},readFreshContext:async()=>{elapsed=4*60_000;return {allowed:true,contextHash:'hash'}},mode:'live',now:new Date('2027-10-19T04:59:00Z'),clock:()=>elapsed});expect(outcome.state).toBe('window_closed');expect(calls).toBe(0);
  });

  it('rechecks campaign, owner, account and inbound after asynchronous context reads', async () => {
    const changes = [
      ['campaign', async row => pool.query("UPDATE sdr_linkedin_campaigns SET status='unapproved' WHERE id=(SELECT campaign_id FROM sdr_linkedin_actions WHERE id=$1)", [row.actionId])],
      ['owner', async row => pool.query("UPDATE sdr_linkedin_candidates SET owner_id='changed' WHERE id=$1", [row.candidateId])],
      ['account', async (_row, accountId) => pool.query("UPDATE sdr_linkedin_accounts SET status='restricted' WHERE account_id=$1", [accountId])],
      ['inbound', async (row, accountId) => pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,source_message_id,direction,coverage,payload_hash) VALUES('13105180',$1,$2,$3,'message_received','fixture',$4,'in','event',$4)`, [accountId,row.candidateId,`li:ACo-${accountId}`,`inbound-${accountId}`])],
    ];
    for (const [kind, change] of changes) {
      const accountId = `race-${kind}`;
      const [row] = await fixture(accountId, [accountId]);
      let calls = 0;
      const readFreshContext = async () => { await change(row, accountId); return { allowed: true, contextHash: 'hash' }; };
      const result = await dispatchLinkedinAction({ pool, actionId: row.actionId, client: { invite: async () => { calls++; return { outcome: 'confirmed', providerId: 'unexpected' }; } }, readFreshContext, mode: 'live', now: NOW });
      expect(result.state, kind).toBe('held');
      expect(calls, kind).toBe(0);
    }
  });

  it('uses the production fresh-context callback and still blocks a campaign revoked during CRM reads',async()=>{
    for(const revoke of [false,true]){
      const accountId=revoke?'fresh-revoked':'fresh-valid',sourceId=accountId,[row]=await fixture(accountId,[sourceId]);
      const campaign=(await pool.query('SELECT campaign_id FROM sdr_linkedin_actions WHERE id=$1',[row.actionId])).rows[0].campaign_id;
      const contextHash=linkedinHash({candidateId:row.candidateId,campaignId:campaign,revision:1,ownerId:'owner',profileUrl:`https://www.linkedin.com/in/${sourceId}/`,body:null});
      await pool.query('UPDATE sdr_linkedin_actions SET context_hash=$2 WHERE id=$1',[row.actionId,contextHash]);
      let calls=0;
      const client={getAccount:async()=>({id:accountId,type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-sender'}),getProfile:async()=>{if(revoke)await pool.query("UPDATE sdr_linkedin_campaigns SET status='unapproved' WHERE id=$1",[campaign]);return {provider_id:`ACo-${sourceId}`,public_identifier:sourceId,is_relationship:false}},findChats:async()=>({complete:true,items:[]}),invite:async()=>{calls++;return {outcome:'confirmed',providerId:`receipt-${sourceId}`}}};
      const fresh=createLinkedinProspectFreshContext({pool,client});
      const outcome=await dispatchLinkedinAction({pool,actionId:row.actionId,client,readFreshContext:fresh,mode:'live',now:new Date('2027-10-19T16:00:00Z')});
      expect(outcome.state,revoke?'revoked':'valid').toBe(revoke?'held':'confirmed');expect(calls).toBe(revoke?0:1);
    }
  });
  it('persists authenticated inbound and account restriction while a fresh CRM read is paused behind the person lock',async()=>{
    for(const kind of ['inbound','restricted']){
      const accountId=`ingest-race-${kind}`,sourceId=accountId,[row]=await fixture(accountId,[sourceId]);
      const campaign=(await pool.query('SELECT campaign_id FROM sdr_linkedin_actions WHERE id=$1',[row.actionId])).rows[0].campaign_id;
      await pool.query('UPDATE sdr_linkedin_actions SET context_hash=$2 WHERE id=$1',[row.actionId,linkedinHash({candidateId:row.candidateId,campaignId:campaign,revision:1,ownerId:'owner',profileUrl:`https://www.linkedin.com/in/${sourceId}/`,body:null})]);
      let entered,release;const paused=new Promise(resolve=>{entered=resolve});const resume=new Promise(resolve=>{release=resolve});let calls=0;
      const client={getAccount:async()=>({id:accountId,type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-sender'}),getProfile:async()=>{entered();await resume;return {provider_id:`ACo-${sourceId}`,public_identifier:sourceId,is_relationship:false}},findChats:async()=>({complete:true,items:[]}),invite:async()=>{calls++;return {outcome:'confirmed',providerId:'unexpected'}}};
      const fresh=createLinkedinProspectFreshContext({pool,client});
      const sending=dispatchLinkedinAction({pool,actionId:row.actionId,client,readFreshContext:fresh,mode:'live',now:new Date('2027-10-19T16:00:00Z')});await paused;
      const payload=kind==='inbound'?{account_id:accountId,event:'message_received',message:{id:`race-${kind}`,chat_id:`chat-${kind}`},account_info:{user_id:'ACo-sender'},sender:{attendee_provider_id:`ACo-${sourceId}`}}:{account_id:accountId,event:'account_status',id:`race-${kind}`,status:'RESTRICTED'};
      const ingestion=ingestLinkedinEvent(pool,{companyId:'13105180',boundAccountId:accountId,payload});
      let durable=false;for(let i=0;i<30;i++){const result=await pool.query('SELECT 1 FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND safe_payload->>\'event\'=$3',[ '13105180',accountId,kind==='inbound'?'message_received':'account_status']);if(result.rowCount){durable=true;break}await new Promise(resolve=>setTimeout(resolve,10))}
      release();const result=await sending;await ingestion;expect(durable,kind).toBe(true);expect(result.state,kind).toBe('held');expect(calls,kind).toBe(0);
    }
  });

  it('keeps a transport exception uncertain across a second worker and restart', async () => {
    const [{ actionId }] = await fixture('unknown-result', ['unknown-one']);
    let calls = 0;
    const client = { invite: async () => { calls++; throw Error('transport lost after POST'); } };
    expect((await dispatchLinkedinAction({ pool, actionId, client, readFreshContext: allow, mode: 'live', now: NOW })).state).toBe('uncertain_provider_result');
    expect((await dispatchLinkedinAction({ pool, actionId, client, readFreshContext: allow, mode: 'live', now: NOW })).state).toBe('uncertain_provider_result');
    expect(calls).toBe(1);
    expect((await pool.query('SELECT network_started_at,request_hash FROM sdr_linkedin_actions WHERE id=$1', [actionId])).rows[0]).toMatchObject({ request_hash: expect.any(String) });
  });

  it('restricts the account after provider rate limit and blocks the next person', async () => {
    const actions = await fixture('provider-restricted', ['restricted-one', 'restricted-two'], 2);
    let calls = 0;
    const client = { invite: async () => { calls++; return { outcome: 'unknown', status: 429, reason: 'rate_limited' }; } };
    expect((await dispatchLinkedinAction({ pool, actionId: actions[0].actionId, client, readFreshContext: allow, mode: 'live', now: NOW })).state).toBe('uncertain_provider_result');
    expect((await dispatchLinkedinAction({ pool, actionId: actions[1].actionId, client, readFreshContext: allow, mode: 'live', now: NOW })).state).toBe('held');
    expect(calls).toBe(1);
    expect((await pool.query("SELECT status FROM sdr_linkedin_accounts WHERE account_id='provider-restricted'")).rows[0].status).toBe('restricted');
  });
});
