import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { pollInboxReplies, createReplyActionClients, SEQUENCE_STARTED_FIELD } from '../inboxReplyWatch.js';
const db = reportingTestDb('reply_watch');
const now = new Date('2026-10-05T15:10:00Z');
const arrived = '2026-10-05T15:01:00Z';
const incoming = (id, subject = 'Interested') => ({ id, messageId: `<${id}@buyer.test>`, from: 'Alias <alias@buyer.test>', subject, snippet: 'yes please', receivedAt: arrived, lastOutbound: false });
const thread = id => ({ id: `thread-${id}`, participants: ['original@buyer.test','alias@buyer.test','rep@example.test'], messages: [incoming(id)] });

describe.skipIf(!db)('gated durable inbox collection', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_inbox_accounts(mailbox_email text); CREATE TABLE sdr_mailboxes(email text, pipedrive_sender_id bigint);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text,person_email text,lead_title text,sequence_started text);
      CREATE TABLE sdr_sends(id text,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,status text,last_status_at timestamptz,updated_at timestamptz)`);
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-reply-actions.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE sdr_reply_actions,sdr_reply_messages,sdr_reply_routes,sdr_inbox_watch_cursors,sdr_sends,sdr_lead_state,sdr_inbox_accounts,sdr_mailboxes');
    await db.pool.query('DROP TABLE IF EXISTS sdr_message_facts');
    await db.pool.query("INSERT INTO sdr_inbox_accounts VALUES ('rep@example.test'); INSERT INTO sdr_mailboxes VALUES ('rep@example.test',7); INSERT INTO sdr_lead_state VALUES ('lead-a','original@buyer.test','Project A','2026-10-05T14:00:00Z'); INSERT INTO sdr_sends VALUES ('s','lead-a','seq','contact','enrolled',NOW(),NOW())");
    await db.pool.query("INSERT INTO sdr_inbox_watch_cursors(mailbox_email,enabled_since,high_water_at) VALUES ('rep@example.test','2026-10-05T15:00:00Z','2026-10-05T15:00:00Z')");
    await db.pool.query("INSERT INTO sdr_reply_routes(mailbox_email,forward_to,pipedrive_user_id,verified_at) VALUES ('rep@example.test','verified@example.test',7,NOW())");
  });
  const options = extra => ({ featureEnabled: true, reportingEnabled:false, now, getToken: async () => 'fixture-token',
    gmail: { listThreadPage: async () => ({ threads: [thread('message-1')],nextPageToken: null }) },
    classifyIntent: async () => ({ worth: true,label: 'interested' }), ...extra });
  it('reads 26+ threads through pagination and preserves actual arrival time', async () => {
    const gmail = { listThreadPage: async (_token,{pageToken}) => ({ threads: pageToken ? [thread('m-26')] : Array.from({length:25},(_,i)=>thread(`m-${i+1}`)),nextPageToken: pageToken ? null : 'page-two' }) };
    const result = await pollInboxReplies(db.pool, options({ gmail }));
    expect(result).toMatchObject({ coverage: 'complete', counts: { detected: 26 }, pages: 2 });
    const { rows } = await db.pool.query('SELECT received_at FROM sdr_reply_messages');
    expect(rows).toHaveLength(26);
    expect(rows.every(r=>+r.received_at === +new Date(arrived))).toBe(true);
  });
  it('resumes after page cap without stamping complete or replaying detected messages', async () => {
    const gmail = { listThreadPage: async (_token,{pageToken}) => ({ threads: [thread(pageToken ? 'second' : 'first')],nextPageToken: pageToken ? null : 'page-two' }) };
    expect(await pollInboxReplies(db.pool, options({gmail,maxPages:1}))).toMatchObject({ coverage: 'partial' });
    expect((await db.pool.query('SELECT page_token,high_water_at FROM sdr_inbox_watch_cursors')).rows[0]).toMatchObject({ page_token:'page-two',high_water_at:new Date('2026-10-05T15:00:00Z') });
    expect(await pollInboxReplies(db.pool, options({gmail,maxPages:1}))).toMatchObject({ coverage:'complete',counts:{detected:1} });
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_messages')).rows[0].n).toBe(2);
  });
  it('resolves an off-contact alias only through a unique project participant', async () => {
    await pollInboxReplies(db.pool, options());
    expect((await db.pool.query('SELECT pipedrive_lead_id,link_status FROM sdr_reply_messages')).rows[0]).toEqual({pipedrive_lead_id:'lead-a',link_status:'verified'});
  });
  it('puts two possible projects in review instead of selecting the first row', async () => {
    await db.pool.query("INSERT INTO sdr_lead_state VALUES ('lead-b','original@buyer.test','Project B',NULL)");
    await pollInboxReplies(db.pool, options());
    expect((await db.pool.query('SELECT kind,requires_review FROM sdr_reply_actions')).rows).toEqual([{kind:'match_lead',requires_review:true}]);
    expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('enrolled');
  });
  it('makes unknown identity a durable review item', async () => {
    await db.pool.query('TRUNCATE sdr_lead_state');
    await pollInboxReplies(db.pool, options());
    expect((await db.pool.query('SELECT safe_error FROM sdr_reply_actions')).rows[0].safe_error).toBe('lead_unlinked');
  });
  it('stops negative human replies while OOO stays observation only', async () => {
    await pollInboxReplies(db.pool, options({ classifyIntent:async()=>({worth:false,label:'unsubscribe'}),gmail:{listThreadPage:async()=>({threads:[thread('human'),{...thread('auto'),messages:[incoming('auto','Out of office')]}],nextPageToken:null})} }));
    expect((await db.pool.query('SELECT kind FROM sdr_reply_actions ORDER BY kind')).rows.map(r=>r.kind)).toEqual(['clear_sequence_flag','create_note','stop_sequence']);
    expect((await db.pool.query('SELECT reply_kind FROM sdr_reply_messages ORDER BY reply_kind')).rows.map(r=>r.reply_kind)).toEqual(['auto','human']);
  });
  it('records classifier failure for review while preserving human sequence stop', async () => {
    await pollInboxReplies(db.pool, options({classifyIntent:async()=>{throw new Error('private body');}}));
    expect((await db.pool.query("SELECT safe_error FROM sdr_reply_actions WHERE kind='match_lead'")).rows[0].safe_error).toBe('classification_unverified');
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='stop_sequence'")).rows[0].n).toBe(1);
  });
  it('reviews an invalid classifier label rather than treating it as verified intent', async () => {
    await pollInboxReplies(db.pool,options({classifyIntent:async()=>({worth:true,label:'unexpected_model_output'})}));
    expect((await db.pool.query("SELECT safe_error FROM sdr_reply_actions WHERE kind='match_lead'")).rows[0]?.safe_error).toBe('classification_unverified');
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind='forward'")).rows[0].n).toBe(0);
  });
  it('does not replay old arrivals when the new path is enabled', async () => {
    await db.pool.query('TRUNCATE sdr_inbox_watch_cursors');
    await pollInboxReplies(db.pool, options());
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_actions')).rows[0].n).toBe(0);
  });
  it('reports scoped token revocation safely without advancing the cursor', async () => {
    const result = await pollInboxReplies(db.pool,options({getToken:async()=>{throw Object.assign(new Error('token=secret'),{status:401});}}));
    expect(result).toMatchObject({coverage:'partial',mailboxes:[{mailbox:'rep@example.test',status:'failed',errorCategory:'authentication'}]});
    expect(JSON.stringify(result)).not.toContain('secret');
    expect((await db.pool.query('SELECT high_water_at FROM sdr_inbox_watch_cursors')).rows[0].high_water_at).toEqual(new Date('2026-10-05T15:00:00Z'));
  });
  it('catches inbound arrivals even if a staff message is now the latest thread message', async () => {
    const t = thread('staff-handled');
    t.messages.push({...incoming('staff-response'),lastOutbound:true,receivedAt:'2026-10-05T15:02:00Z'});
    await pollInboxReplies(db.pool,options({gmail:{listThreadPage:async()=>({threads:[t],nextPageToken:null})}}));
    expect((await db.pool.query('SELECT staff_response_at FROM sdr_reply_messages')).rows[0].staff_response_at).toEqual(new Date('2026-10-05T15:02:00Z'));
    expect((await db.pool.query('SELECT kind FROM sdr_reply_actions ORDER BY kind')).rows.map(r=>r.kind)).toEqual(['clear_sequence_flag','create_note','stop_sequence']);
  });
  it('uses the verified assignee without Pipedrive fallback and records actual ownership', async () => {
    let task;
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',pipedrive:{addActivity:async payload=>{task=payload;return {id:42,user_id:7};}}});
    const receipt = await clients.create_task.execute({id:'action-1',payload:{mailbox:'rep@example.test',leadId:'lead-a',userId:7,intent:'interested'}});
    expect(task).toMatchObject({userId:7,strictAssignee:true});
    expect(receipt).toMatchObject({id:42,assigneeId:7});
  });
  it('does not execute a forward after verified routing changed', async () => {
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture'});
    await expect(clients.forward.execute({id:'action-1',payload:{mailbox:'rep@example.test',forwardTo:'old@example.test'}})).rejects.toMatchObject({permanent:true});
  });
  it('refuses removal when another active project now owns the same membership', async () => {
    await db.pool.query("INSERT INTO sdr_sends VALUES ('other','lead-b','seq','contact','enrolled',NOW(),NOW())");
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture'});
    await expect(clients.stop_sequence.execute({payload:{leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}})).rejects.toMatchObject({permanent:true});
  });
  it('does not invent a stop receipt from an undefined removal response', async () => {
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{removeContactsFromSequence:async()=>undefined,getContact:async()=>({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'seq',status:'active'}]})}});
    await expect(clients.stop_sequence.execute({payload:{leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}})).rejects.toMatchObject({uncertain:true});
  });
  it('confirms stop via exact fresh provider membership and reconciles without removing twice', async () => {
    let reads = 0, removals = 0;
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{removeContactsFromSequence:async()=>{removals++;},getContact:async()=>({id:'contact',contact_campaign_statuses:reads++ === 0 ? [{emailer_campaign_id:'seq',status:'active'}] : []})}});
    const action = {payload:{leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}};
    expect(await clients.stop_sequence.execute(action)).toEqual({id:'contact'});
    expect(await clients.stop_sequence.reconcile(action)).toEqual({state:'completed',receipt:{id:'contact'}});
    expect(removals).toBe(1);
  });
  it('does not interpret malformed membership entries as proof of absence', async () => {
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{getContact:async()=>({id:'contact',contact_campaign_statuses:[{}]})}});
    expect(await clients.stop_sequence.reconcile({payload:{contactId:'contact',sequenceId:'seq'}})).toEqual({state:'unknown'});
  });
  const migrateReporting = async () => {
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql',import.meta.url),'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-04-sdr-metric-evidence.sql',import.meta.url),'utf8'));
  };
  it('writes actual body-free inbound facts before claiming a new reply', async () => {
    await migrateReporting();
    const result = await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    expect(result.coverage).toBe('complete');
    const {rows} = await db.pool.query('SELECT * FROM sdr_message_facts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({provider:'gmail',provider_message_id:'message-1',direction:'in',mailbox_email:'rep@example.test',prospect_email:'alias@buyer.test',thread_id:'thread-message-1',occurred_at:new Date(arrived),human_reply:true,reply_intent:'interested',pipedrive_lead_id:'lead-a',link_status:'verified'});
    expect(rows[0].link_evidence).toContain('thread-message-1');
    expect(JSON.stringify(rows)).not.toContain('yes please');
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_job_runs')).rows[0].n).toBe(0);
  });
  it('retains ambiguous/unmatched facts without inventing project evidence', async () => {
    await migrateReporting();
    await db.pool.query("INSERT INTO sdr_lead_state VALUES ('lead-b','original@buyer.test','Project B',NULL)");
    await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    expect((await db.pool.query('SELECT pipedrive_lead_id,link_status FROM sdr_message_facts')).rows[0]).toEqual({pipedrive_lead_id:null,link_status:'ambiguous'});
    await db.pool.query('TRUNCATE sdr_lead_state');
    await pollInboxReplies(db.pool,options({reportingEnabled:true,gmail:{listThreadPage:async()=>({threads:[thread('unmatched')],nextPageToken:null})}}));
    expect((await db.pool.query("SELECT pipedrive_lead_id,link_status FROM sdr_message_facts WHERE provider_message_id='unmatched'")).rows[0]).toEqual({pipedrive_lead_id:null,link_status:'unmatched'});
  });
  it('does not lose a fact when the required reporting write fails then recovers', async () => {
    expect(await pollInboxReplies(db.pool,options({reportingEnabled:true}))).toMatchObject({coverage:'partial'});
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_messages')).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT high_water_at FROM sdr_inbox_watch_cursors')).rows[0].high_water_at).toEqual(new Date('2026-10-05T15:00:00Z'));
    await migrateReporting();
    expect(await pollInboxReplies(db.pool,options({reportingEnabled:true}))).toMatchObject({coverage:'complete',counts:{detected:1}});
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_message_facts')).rows[0].n).toBe(1);
  });
  it('upserts reporting facts for an already detected message without replaying its actions', async () => {
    await pollInboxReplies(db.pool,options());
    const before = (await db.pool.query('SELECT id FROM sdr_reply_actions ORDER BY id')).rows;
    await migrateReporting();
    await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    expect((await db.pool.query('SELECT id FROM sdr_reply_actions ORDER BY id')).rows).toEqual(before);
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_message_facts')).rows[0].n).toBe(1);
  });
  it.each([
    {contact_campaign_statuses:[]},
    {id:'contact'},
    {id:'contact',contact_campaign_statuses:[{}]},
  ])('does not remove after an unverified membership read %j',async response=>{
    let removals=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{getContact:async()=>response,removeContactsFromSequence:async()=>{removals++;}}});
    await expect(clients.stop_sequence.execute({payload:{leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}})).rejects.toMatchObject({uncertain:true});
    expect(removals).toBe(0);
  });
  const clearAction = async () => {
    await pollInboxReplies(db.pool,options());
    await db.pool.query("UPDATE sdr_reply_actions SET status='completed',external_id='contact',receipt_at=$1 WHERE kind='stop_sequence'",[now]);
    const row=(await db.pool.query("SELECT * FROM sdr_reply_actions WHERE kind='clear_sequence_flag'")).rows[0];
    expect(row).toBeTruthy();
    return row;
  };
  it('clears the existing CRM marker only after verified stops and records a fresh explicit empty value',async()=>{
    const action=await clearAction(); let updated=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',pipedrive:{getLead:async()=>({id:'lead-a',is_archived:false,[SEQUENCE_STARTED_FIELD]:updated ? '' : '2026-10-05T14:00:00Z'}),updateLead:async(id,fields)=>{expect(id).toBe('lead-a');expect(fields).toEqual({[SEQUENCE_STARTED_FIELD]:''});updated++;return {id};}}});
    expect(await clients.clear_sequence_flag.execute(action)).toEqual({id:'lead-a'});
    expect(updated).toBe(1);
  });
  it('does not clear over a new active local enrollment',async()=>{
    const action=await clearAction();
    await db.pool.query("INSERT INTO sdr_sends VALUES ('new-send','lead-a','new-seq','new-contact','enrolled',NOW(),NOW())");
    let updated=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',pipedrive:{updateLead:async()=>{updated++;}}});
    await expect(clients.clear_sequence_flag.execute(action)).rejects.toMatchObject({permanent:true});
    expect(updated).toBe(0);
  });
  it('does not clear a changed CRM marker or infer missing field as empty',async()=>{
    const action=await clearAction();
    for(const record of [{id:'lead-a',is_archived:false,[SEQUENCE_STARTED_FIELD]:'new-marker'},{id:'lead-a',is_archived:false}]) {
      let updated=0;
      const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',pipedrive:{getLead:async()=>record,updateLead:async()=>{updated++;}}});
      await expect(clients.clear_sequence_flag.execute(action)).rejects.toMatchObject({permanent:true});
      expect(updated).toBe(0);
    }
  });
  it('keeps post-clear timeout in review and reconciles explicit cleared state without a repeat write',async()=>{
    const action=await clearAction();let updated=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',pipedrive:{getLead:async()=>({id:'lead-a',is_archived:false,[SEQUENCE_STARTED_FIELD]:updated ? '' : '2026-10-05T14:00:00Z'}),updateLead:async()=>{updated++;throw Object.assign(new Error('private body'),{code:'ETIMEDOUT'});}}});
    await expect(clients.clear_sequence_flag.execute(action)).rejects.toMatchObject({code:'ETIMEDOUT'});
    expect(await clients.clear_sequence_flag.reconcile(action)).toEqual({state:'completed',receipt:{id:'lead-a'}});
    expect(updated).toBe(1);
  });
});
