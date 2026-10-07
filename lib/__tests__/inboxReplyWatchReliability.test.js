import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import { pollInboxReplies, createReplyActionClients as createClients, SEQUENCE_STARTED_FIELD } from '../inboxReplyWatch.js';
const db = reportingTestDb('reply_watch');
const now = new Date('2026-10-05T15:10:00Z');
const arrived = '2026-10-05T15:01:00Z';
const incoming = (id, subject = 'Interested') => ({ id, messageId: `<${id}@buyer.test>`, from: 'Alias <alias@buyer.test>', subject, snippet: 'yes please', receivedAt: arrived, lastOutbound: false });
const createReplyActionClients = args => createClients({gmail:{getThread:async()=>thread('message-1')},...args});
const thread = id => ({ id: `thread-${id}`, participants: ['original@buyer.test','alias@buyer.test','rep@example.test'], messages: [{id:'outgoing',messageId:'<outgoing@sender.test>',subject:'Interested',lastOutbound:true,receivedAt:'2026-10-05T14:00:00Z'},incoming(id)] });

describe.skipIf(!db)('gated durable inbox collection', () => {
  beforeAll(async () => {
    await db.setup();
    await db.pool.query(`CREATE TABLE sdr_inbox_accounts(mailbox_email text); CREATE TABLE sdr_mailboxes(email text, pipedrive_sender_id bigint);
      CREATE TABLE sdr_lead_state(pipedrive_lead_id text,person_email text,lead_title text,sequence_started text);
      CREATE TABLE sdr_sends(id text,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,status text,last_status_at timestamptz,updated_at timestamptz)`);
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-reply-actions.sql', import.meta.url), 'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-provider-operations.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE sdr_provider_membership_observations,sdr_provider_operations,sdr_reply_actions,sdr_reply_messages,sdr_reply_routes,sdr_inbox_watch_cursors,sdr_sends,sdr_lead_state,sdr_inbox_accounts,sdr_mailboxes');
    await db.pool.query('DROP TABLE IF EXISTS sdr_message_facts CASCADE');
    await migrateReporting();
    await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,pipedrive_lead_id,link_status,link_evidence) VALUES('gmail','outgoing','out','rep@example.test','original@buyer.test','lead-a','verified','explicit-outbound-send:fixture')`);
    await db.pool.query("INSERT INTO sdr_inbox_accounts VALUES ('rep@example.test'); INSERT INTO sdr_mailboxes VALUES ('rep@example.test',7); INSERT INTO sdr_lead_state VALUES ('lead-a','original@buyer.test','Project A','2026-10-05T14:00:00Z'); INSERT INTO sdr_sends VALUES ('s','lead-a','seq','contact','enrolled',NOW(),NOW())");
    await db.pool.query("INSERT INTO sdr_inbox_watch_cursors(mailbox_email,enabled_since,high_water_at) VALUES ('rep@example.test','2026-10-05T15:00:00Z','2026-10-05T15:00:00Z')");
    await db.pool.query("INSERT INTO sdr_reply_routes(mailbox_email,forward_to,pipedrive_user_id,verified_at) VALUES ('rep@example.test','verified@example.test',7,NOW())");
  });
  const options = extra => ({ featureEnabled: true, reportingEnabled:false, now, getToken: async () => 'fixture-token',
    gmail: { listThreadPage: async () => ({ threads: [thread('message-1')],nextPageToken: null }) },
    classifyIntent: async () => ({ worth: true,label: 'interested' }), ...extra });
  it('never verifies a unique participant without independent message evidence',async()=>{
    await db.pool.query('DELETE FROM sdr_message_facts');
    await pollInboxReplies(db.pool,options());
    expect((await db.pool.query('SELECT pipedrive_lead_id,link_status FROM sdr_reply_messages')).rows[0]).toEqual({pipedrive_lead_id:null,link_status:'ambiguous'});
    expect((await db.pool.query('SELECT kind,payload FROM sdr_reply_actions WHERE kind<>\'forward\'')).rows).toMatchObject([{kind:'match_lead',payload:{mailbox:'rep@example.test',threadId:'thread-message-1',sourceMessageId:'message-1',candidates:['lead-a']}}]);
    expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('enrolled');
  });
  it('rejects a contradictory project subject despite an exact outbound anchor',async()=>{
    const t=thread('different-project');t.messages[1].subject='Re: Other Project';
    await pollInboxReplies(db.pool,options({gmail:{listThreadPage:async()=>({threads:[t]})}}));
    expect((await db.pool.query('SELECT link_status FROM sdr_reply_messages')).rows[0].link_status).toBe('ambiguous');
    expect((await db.pool.query('SELECT kind FROM sdr_reply_actions WHERE kind<>\'forward\'')).rows).toEqual([{kind:'match_lead'}]);
  });
  it('ignores inbound and participant-derived facts as evidence',async()=>{
    await db.pool.query("UPDATE sdr_message_facts SET link_evidence='gmail-thread:t:unique-participant-project:lead-a'");
    await pollInboxReplies(db.pool,options());
    expect((await db.pool.query('SELECT link_status FROM sdr_reply_messages')).rows[0].link_status).toBe('ambiguous');
  });
  it('rescans retained mail and places later unknown outbound in review without relinking or replay',async()=>{
    let query;
    const t=thread('rescan');const gmail={listThreadPage:async(_,{query:q})=>{query=q;return {threads:[t]};}};
    await pollInboxReplies(db.pool,options({gmail}));
    const before=(await db.pool.query('SELECT * FROM sdr_reply_messages')).rows[0];
    const ids=(await db.pool.query('SELECT id FROM sdr_reply_actions ORDER BY id')).rows;
    t.messages.push({...incoming('out-later'),lastOutbound:true,receivedAt:'2026-10-05T15:02:00Z'});
    await pollInboxReplies(db.pool,options({gmail}));
    expect(query).not.toContain('in:inbox');expect(query).toContain('-in:sent');expect(query).toContain('-in:spam');expect(query).toContain('-in:trash');
    expect((await db.pool.query('SELECT * FROM sdr_reply_messages')).rows[0]).toEqual(before);
    expect((await db.pool.query('SELECT id FROM sdr_reply_actions ORDER BY id')).rows).toEqual(ids);
    const actions=(await db.pool.query("SELECT requires_review,safe_error,payload FROM sdr_reply_actions WHERE kind IN ('forward','create_task')")).rows;
    expect(actions).toHaveLength(2);expect(actions.every(a=>a.requires_review && a.safe_error==='later_outbound_unverified')).toBe(true);
    expect(actions[0].payload.replyContext.laterMessages[0].id).toBe('out-later');
  });
  it.each(['forward','create_task'])('rechecks a fresh thread before %s and never treats unknown outbound as staff or a receipt',async kind=>{
    const t=thread('fresh');t.messages.push({...incoming('later'),lastOutbound:true,receivedAt:'2026-10-05T15:02:00Z'});
    let writes=0;const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',gmail:{getThread:async()=>t,sendMail:async()=>{writes++;}},pipedrive:{addActivity:async()=>{writes++;}}});
    await expect(clients[kind].execute({id:'a',payload:{mailbox:'rep@example.test',leadId:'lead-a',userId:7,forwardTo:'verified@example.test',threadId:t.id,sourceMessageId:'fresh'}})).rejects.toMatchObject({replyContextReason:'later_outbound_unverified',definiteFailure:true});
    expect(writes).toBe(0);
  });
  it('does not use a verified inbound fact as an outbound anchor',async()=>{
    await db.pool.query("UPDATE sdr_message_facts SET direction='in'");
    await pollInboxReplies(db.pool,options());
    expect((await db.pool.query('SELECT link_status FROM sdr_reply_messages')).rows[0].link_status).toBe('ambiguous');
  });
  it('requires reply headers to agree with the outbound anchor when available',async()=>{
    const t=thread('wrong-reference');t.messages[1].inReplyTo='<different@sender.test>';
    await pollInboxReplies(db.pool,options({gmail:{listThreadPage:async()=>({threads:[t]})}}));
    expect((await db.pool.query('SELECT link_status FROM sdr_reply_messages')).rows[0].link_status).toBe('ambiguous');
  });
  it('keeps an independently anchored project despite shared contact candidates',async()=>{
    await db.pool.query("INSERT INTO sdr_lead_state VALUES ('lead-b','original@buyer.test','Project B',NULL)");
    await pollInboxReplies(db.pool,options());
    expect((await db.pool.query('SELECT pipedrive_lead_id,link_status FROM sdr_reply_messages')).rows[0]).toEqual({pipedrive_lead_id:'lead-a',link_status:'verified'});
  });
  it('rechecks a stored reply older than the cursor overlap when its thread resurfaces',async()=>{
    const t=thread('older-reply');const gmail={listThreadPage:async()=>({threads:[t]})};
    await pollInboxReplies(db.pool,options({gmail}));
    await db.pool.query("UPDATE sdr_inbox_watch_cursors SET high_water_at='2026-10-05T16:00:00Z'");
    t.messages.push({...incoming('late-response'),lastOutbound:true,receivedAt:'2026-10-05T16:01:00Z'});
    await pollInboxReplies(db.pool,options({gmail,now:new Date('2026-10-05T16:02:00Z')}));
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind IN ('forward','create_task') AND safe_error='later_outbound_unverified'")).rows[0].n).toBe(2);
  });
  it('does not propagate historical participant-derived project links into missing reporting facts',async()=>{
    await pollInboxReplies(db.pool,options());
    await db.pool.query("UPDATE sdr_reply_messages SET link_evidence='gmail-thread:old:unique-participant-project:lead-a'");
    await db.pool.query('DELETE FROM sdr_message_facts');
    await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    expect((await db.pool.query('SELECT pipedrive_lead_id,link_status FROM sdr_message_facts')).rows[0]).toEqual({pipedrive_lead_id:null,link_status:'ambiguous'});
    expect((await db.pool.query('SELECT pipedrive_lead_id FROM sdr_reply_messages')).rows[0].pipedrive_lead_id).toBe('lead-a');
  });
  it.each(['forward','create_task'])('holds %s when fresh thread retrieval is unavailable',async kind=>{
    let writes=0;const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',gmail:{getThread:async()=>{throw new Error('fetch unavailable');},sendMail:async()=>{writes++;}},pipedrive:{addActivity:async()=>{writes++;}}});
    await expect(clients[kind].execute({id:'a',payload:{mailbox:'rep@example.test',leadId:'lead-a',userId:7,forwardTo:'verified@example.test',threadId:'t',sourceMessageId:'m'}})).rejects.toMatchObject({replyContextReason:'reply_context_unavailable',definiteFailure:true});
    expect(writes).toBe(0);
  });
  it('uses the fetched full thread for later evidence before skipping an existing reply',async()=>{
    const t=thread('full-thread');let full=t;
    const gmail={listThreadPage:async()=>({threads:[t]}),getThread:async()=>full};
    await pollInboxReplies(db.pool,options({gmail}));
    full={...t,messages:[...t.messages,{...incoming('new-outgoing'),lastOutbound:true,receivedAt:'2026-10-05T15:02:00Z'}]};
    await pollInboxReplies(db.pool,options({gmail}));
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind IN ('forward','create_task') AND safe_error='later_outbound_unverified'")).rows[0].n).toBe(2);
  });
  it('preserves uncertain delivery reconciliation when a later outbound appears',async()=>{
    const t=thread('uncertain');const gmail={listThreadPage:async()=>({threads:[t]})};
    await pollInboxReplies(db.pool,options({gmail}));
    await db.pool.query("UPDATE sdr_reply_actions SET status='failed',requires_review=true,safe_error='completion_uncertain' WHERE kind='forward'");
    t.messages.push({...incoming('out'),lastOutbound:true,receivedAt:'2026-10-05T15:02:00Z'});
    await pollInboxReplies(db.pool,options({gmail}));
    expect((await db.pool.query("SELECT safe_error,payload FROM sdr_reply_actions WHERE kind='forward'")).rows[0]).toMatchObject({safe_error:'completion_uncertain',payload:{replyContext:{state:'later_outbound_unverified'}}});
  });
  it.each(['create_task','create_note','stop_sequence','clear_sequence_flag'])('does not execute %s from a historical participant-only project match',async kind=>{
    await db.pool.query('DELETE FROM sdr_message_facts');
    let writes=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',gmail:{getThread:async()=>thread('old')},pipedrive:{addActivity:async()=>{writes++;return {id:42,user_id:7};},addNote:async()=>{writes++;}},apollo:{getContact:async()=>{writes++;}}});
    await expect(clients[kind].execute({id:'old-action',payload:{mailbox:'rep@example.test',leadId:'lead-a',userId:7,threadId:'thread-old',sourceMessageId:'old'}})).rejects.toMatchObject({replyContextReason:'project_context_unverified',definiteFailure:true});
    expect(writes).toBe(0);
  });
  it('detects body-only out-of-office in a full thread without producing actions',async()=>{
    const summary=thread('body-auto');const full={...summary,messages:[summary.messages[0],{...summary.messages[1],snippet:undefined,subject:'Interested',body:'I am on vacation until Monday.'}]};
    await pollInboxReplies(db.pool,options({gmail:{listThreadPage:async()=>({threads:[summary]}),getThread:async()=>full}}));
    expect((await db.pool.query('SELECT reply_kind FROM sdr_reply_messages')).rows[0].reply_kind).toBe('auto');
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_actions')).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('enrolled');
  });
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
  it('resolves an off-contact alias through exact independent outbound evidence', async () => {
    await pollInboxReplies(db.pool, options());
    expect((await db.pool.query('SELECT pipedrive_lead_id,link_status FROM sdr_reply_messages')).rows[0]).toEqual({pipedrive_lead_id:'lead-a',link_status:'verified'});
  });
  it('puts two possible projects in review instead of selecting the first row', async () => {
    await db.pool.query("DELETE FROM sdr_message_facts; INSERT INTO sdr_lead_state VALUES ('lead-b','original@buyer.test','Project B',NULL)");
    await pollInboxReplies(db.pool, options());
    expect((await db.pool.query('SELECT kind,requires_review FROM sdr_reply_actions WHERE kind<>\'forward\'')).rows).toEqual([{kind:'match_lead',requires_review:true}]);
    expect((await db.pool.query('SELECT status FROM sdr_sends')).rows[0].status).toBe('enrolled');
  });
  it('makes unknown identity a durable review item', async () => {
    await db.pool.query('TRUNCATE sdr_lead_state; DELETE FROM sdr_message_facts');
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
    expect((await db.pool.query('SELECT staff_response_at FROM sdr_reply_messages')).rows[0].staff_response_at).toBeNull();
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_reply_actions WHERE kind IN ('forward','create_task') AND requires_review")).rows[0].n).toBe(2);
  });
  it('uses the verified assignee without Pipedrive fallback and records actual ownership', async () => {
    let task;
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',gmail:{getThread:async()=>thread('task-reply')},pipedrive:{addActivity:async payload=>{task=payload;return {id:42,user_id:7};}}});
    const receipt = await clients.create_task.execute({id:'action-1',payload:{mailbox:'rep@example.test',leadId:'lead-a',userId:7,intent:'interested',threadId:'thread-task-reply',sourceMessageId:'task-reply'}});
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
    await expect(clients.stop_sequence.execute({payload:{mailbox:'rep@example.test',threadId:'thread-message-1',sourceMessageId:'message-1',leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}})).rejects.toMatchObject({permanent:true});
  });
  it('does not invent a stop receipt from an undefined removal response', async () => {
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{removeContactsFromSequence:async()=>undefined,getContact:async()=>({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'seq',status:'active'}]})}});
    await expect(clients.stop_sequence.execute({payload:{mailbox:'rep@example.test',threadId:'thread-message-1',sourceMessageId:'message-1',leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}})).rejects.toMatchObject({uncertain:true});
  });
  it('retains stop review despite a fresh read because conditional generation removal is unverified', async () => {
    let reads = 0, removals = 0;
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{removeContactsFromSequence:async()=>{removals++;},getContact:async()=>({id:'contact',contact_campaign_statuses:reads++ === 0 ? [{emailer_campaign_id:'seq',status:'active'}] : []})}});
    const action = {payload:{mailbox:'rep@example.test',threadId:'thread-message-1',sourceMessageId:'message-1',leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}};
    await expect(clients.stop_sequence.execute(action)).rejects.toMatchObject({uncertain:true});
    expect(await clients.stop_sequence.reconcile(action)).toMatchObject({state:'unknown'});
    expect(removals).toBe(0);
  });
  it('does not interpret malformed membership entries as proof of absence', async () => {
    const clients = createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{getContact:async()=>({id:'contact',contact_campaign_statuses:[{}]})}});
    expect(await clients.stop_sequence.reconcile({payload:{mailbox:'rep@example.test',threadId:'thread-message-1',sourceMessageId:'message-1',contactId:'contact',sequenceId:'seq'}})).toEqual({state:'unknown'});
  });
  const migrateReporting = async () => {
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql',import.meta.url),'utf8'));
    await db.pool.query(await readFile(new URL('../../migrations/2026-10-04-sdr-metric-evidence.sql',import.meta.url),'utf8'));
  };
  it('writes actual body-free inbound facts before claiming a new reply', async () => {
    await migrateReporting();
    const result = await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    expect(result.coverage).toBe('complete');
    const {rows} = await db.pool.query("SELECT * FROM sdr_message_facts WHERE direction='in'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({provider:'gmail',provider_message_id:'message-1',direction:'in',mailbox_email:'rep@example.test',prospect_email:'alias@buyer.test',thread_id:'thread-message-1',occurred_at:new Date(arrived),human_reply:true,reply_intent:'interested',pipedrive_lead_id:'lead-a',link_status:'verified'});
    expect(rows[0].link_evidence).toContain('thread-message-1');
    expect(JSON.stringify(rows)).not.toContain('yes please');
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_job_runs')).rows[0].n).toBe(0);
  });
  it('retains ambiguous/unmatched facts without inventing project evidence', async () => {
    await migrateReporting();
    await db.pool.query("DELETE FROM sdr_message_facts; INSERT INTO sdr_lead_state VALUES ('lead-b','original@buyer.test','Project B',NULL)");
    await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    expect((await db.pool.query('SELECT pipedrive_lead_id,link_status FROM sdr_message_facts')).rows[0]).toEqual({pipedrive_lead_id:null,link_status:'ambiguous'});
    await db.pool.query('TRUNCATE sdr_lead_state; DELETE FROM sdr_message_facts');
    await pollInboxReplies(db.pool,options({reportingEnabled:true,gmail:{listThreadPage:async()=>({threads:[thread('unmatched')],nextPageToken:null})}}));
    expect((await db.pool.query("SELECT pipedrive_lead_id,link_status FROM sdr_message_facts WHERE provider_message_id='unmatched'")).rows[0]).toEqual({pipedrive_lead_id:null,link_status:'unmatched'});
  });
  it('does not lose a fact when the required reporting write fails then recovers', async () => {
    await db.pool.query('DROP TABLE sdr_message_facts CASCADE');
    expect(await pollInboxReplies(db.pool,options({reportingEnabled:true}))).toMatchObject({coverage:'partial'});
    expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_messages')).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT high_water_at FROM sdr_inbox_watch_cursors')).rows[0].high_water_at).toEqual(new Date('2026-10-05T15:00:00Z'));
    await migrateReporting();
    expect(await pollInboxReplies(db.pool,options({reportingEnabled:true}))).toMatchObject({coverage:'complete',counts:{detected:1}});
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_message_facts WHERE direction='in'")).rows[0].n).toBe(1);
  });
  it('upserts reporting facts for an already detected message without replaying its actions', async () => {
    await pollInboxReplies(db.pool,options());
    const before = (await db.pool.query('SELECT id FROM sdr_reply_actions ORDER BY id')).rows;
    await migrateReporting();
    await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    await pollInboxReplies(db.pool,options({reportingEnabled:true}));
    expect((await db.pool.query('SELECT id FROM sdr_reply_actions ORDER BY id')).rows).toEqual(before);
    expect((await db.pool.query("SELECT count(*)::int n FROM sdr_message_facts WHERE direction='in'")).rows[0].n).toBe(1);
  });
  it.each([
    {contact_campaign_statuses:[]},
    {id:'contact'},
    {id:'contact',contact_campaign_statuses:[{}]},
  ])('does not remove after an unverified membership read %j',async response=>{
    let removals=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',apollo:{getContact:async()=>response,removeContactsFromSequence:async()=>{removals++;}}});
    await expect(clients.stop_sequence.execute({payload:{mailbox:'rep@example.test',threadId:'thread-message-1',sourceMessageId:'message-1',leadId:'lead-a',sendId:'s',sequenceId:'seq',contactId:'contact'}})).rejects.toMatchObject({uncertain:true});
    expect(removals).toBe(0);
  });
  const clearAction = async () => {
    await pollInboxReplies(db.pool,options());
    await db.pool.query("UPDATE sdr_reply_actions SET status='completed',external_id='contact',receipt_at=$1 WHERE kind='stop_sequence'",[now]);
    const row=(await db.pool.query("SELECT * FROM sdr_reply_actions WHERE kind='clear_sequence_flag'")).rows[0];
    expect(row).toBeTruthy();
    return row;
  };
  it('preserves the CRM marker without atomic conditional write support',async()=>{
    const action=await clearAction(); let updated=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',pipedrive:{getLead:async()=>({id:'lead-a',is_archived:false,[SEQUENCE_STARTED_FIELD]:updated ? '' : '2026-10-05T14:00:00Z'}),updateLead:async(id,fields)=>{expect(id).toBe('lead-a');expect(fields).toEqual({[SEQUENCE_STARTED_FIELD]:''});updated++;return {id};}}});
    await expect(clients.clear_sequence_flag.execute(action)).rejects.toMatchObject({permanent:true});
    expect(updated).toBe(0);
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
  it('observes an already cleared marker without issuing another write',async()=>{
    const action=await clearAction();let updated=0;
    const clients=createReplyActionClients({pool:db.pool,getToken:async()=> 'fixture',pipedrive:{getLead:async()=>({id:'lead-a',is_archived:false,[SEQUENCE_STARTED_FIELD]:''}),updateLead:async()=>{updated++;}}});
    expect(await clients.clear_sequence_flag.reconcile(action)).toEqual({state:'completed',receipt:{id:'lead-a'}});
    expect(updated).toBe(0);
  });
});
