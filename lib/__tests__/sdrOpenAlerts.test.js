import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {enqueueOpenAlert,drainOpenAlerts,createOpenAlertClients,checkOpenAlertContext} from '../sdrOpenAlerts.js';
const db=reportingTestDb('open_alerts');
const now=new Date('2026-10-07T12:00:00Z');
const event={eventId:'open-1',leadId:'lead-a',opens:3,contactEmail:'buyer@customer.test',mailboxEmail:'rep@proswppp.co',occurredAt:now,now};
const ready=async()=>({status:'ready'});
const receipt=async a=>({id:`external-${a.kind}`});
describe.skipIf(!db)('durable open alerts',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_sends(id text,pipedrive_lead_id text,status text,mailbox_id text,contact_email_snapshot text,sent_at timestamptz);
 CREATE TABLE sdr_mailboxes(id text,email text,pipedrive_sender_id integer); CREATE TABLE sdr_lead_state(pipedrive_lead_id text,person_email text,lead_title text,pipedrive_person_id text,pipedrive_org_id text);
 CREATE TABLE sdr_engagement_events(apollo_event_id text,pipedrive_lead_id text,event_type text,mailbox_email text,occurred_at timestamptz);
 CREATE TABLE sdr_inbox_reply_log(pipedrive_lead_id text,from_addr text);`);
 for(const f of ['2026-10-03-sdr-reply-actions.sql','2026-10-07-sdr-open-alerts.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));});
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_open_alert_actions,sdr_open_alerts,sdr_reply_actions,sdr_reply_messages,sdr_reply_routes,sdr_sends,sdr_mailboxes,sdr_lead_state,sdr_engagement_events,sdr_inbox_reply_log');
 await db.pool.query(`INSERT INTO sdr_mailboxes VALUES('mb','rep@proswppp.co',7); INSERT INTO sdr_lead_state VALUES('lead-a','buyer@customer.test','Project A','person-1','org-1'); INSERT INTO sdr_sends VALUES('send-a','lead-a','enrolled','mb','buyer@customer.test','2026-10-07T10:00:00Z'); INSERT INTO sdr_reply_routes VALUES('rep@proswppp.co','owner@proswppp.com',7,NOW(),true)`);
 await db.pool.query("INSERT INTO sdr_engagement_events VALUES('open-1','lead-a','email_opened','rep@proswppp.co',$1)",[now]);});
 const rows=async()=> (await db.pool.query('SELECT * FROM sdr_open_alert_actions ORDER BY kind')).rows;
 it('records two independent pending actions and deduplicates concurrent enqueues',async()=>{
 await Promise.all([enqueueOpenAlert(db.pool,event),enqueueOpenAlert(db.pool,event)]);
 expect((await rows()).map(r=>[r.kind,r.status,r.external_id])).toEqual([['email','pending',null],['note','pending',null]]);
 });
 it('retries definite note failure without repeating completed email',async()=>{
 await enqueueOpenAlert(db.pool,event);const email=vi.fn(receipt);const note=vi.fn().mockRejectedValueOnce(Object.assign(new Error('private'),{status:429})).mockImplementation(receipt);
 await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{email,note}});
 await drainOpenAlerts(db.pool,{featureEnabled:true,now:new Date(+now+60000),checkContext:ready,clients:{email,note}});
 expect((await rows()).map(r=>[r.status,r.attempts])).toEqual([['completed',1],['completed',2]]);expect(email).toHaveBeenCalledTimes(1);
 });
 it('holds uncertain sends and reconciles receipt without resend',async()=>{
 await enqueueOpenAlert(db.pool,event);const execute=vi.fn(async()=>{throw new Error('timeout secret');});
 await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{email:execute}});
 expect((await rows())[0]).toMatchObject({requires_review:true,safe_error:'completion_uncertain',attempts:1});
 await drainOpenAlerts(db.pool,{featureEnabled:true,now:new Date(+now+60000),checkContext:ready,clients:{email:{execute,reconcile:async()=>({state:'completed',receipt:{id:'found-sent'}})}}});
 expect((await rows())[0]).toMatchObject({status:'completed',external_id:'found-sent',attempts:1});expect(execute).toHaveBeenCalledTimes(1);
 });
 it.each(['reply','send','engagement','legacy'])('suppresses %s reply signal at drain time',async signal=>{
 await enqueueOpenAlert(db.pool,event);
 if(signal==='reply')await db.pool.query("INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind) VALUES('reply','gmail','r','rep@proswppp.co',NOW(),'lead-a','verified','human')");
 if(signal==='send')await db.pool.query("UPDATE sdr_sends SET status='replied'");
 if(signal==='engagement')await db.pool.query("INSERT INTO sdr_engagement_events VALUES('r','lead-a','email_replied',NULL,NOW())");
 if(signal==='legacy')await db.pool.query("INSERT INTO sdr_inbox_reply_log VALUES('lead-a','buyer@customer.test')");
 const execute=vi.fn(receipt);await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{email:execute,note:execute}});
 expect((await rows()).every(r=>r.status==='skipped'&&r.safe_error==='reply_recorded'&&!r.external_id)).toBe(true);expect(execute).not.toHaveBeenCalled();
 });
 it('does not resurrect historical markers or queue stale/future opens',async()=>{
 await db.pool.query("INSERT INTO sdr_engagement_events VALUES('high_intent:lead-a','lead-a','high_intent',NULL,NOW())");
 expect(await enqueueOpenAlert(db.pool,event)).toMatchObject({skipped:'historical_marker'});
 await db.pool.query("DELETE FROM sdr_engagement_events WHERE event_type='high_intent'");
 expect(await enqueueOpenAlert(db.pool,{...event,now:new Date(+now+97*3600000)})).toMatchObject({skipped:'stale_open'});
 expect(await enqueueOpenAlert(db.pool,{...event,now:new Date(+now-60000)})).toMatchObject({skipped:'future_open'});
 expect(await rows()).toHaveLength(0);
 });
 it('requires a persisted matching open event',async()=>{expect(await enqueueOpenAlert(db.pool,{...event,eventId:'missing'})).toMatchObject({review:'source_unverified'});expect(await rows()).toHaveLength(0);});
 it('does not guess .com routes or send after a route changes',async()=>{
 await enqueueOpenAlert(db.pool,event);await db.pool.query("UPDATE sdr_reply_routes SET forward_to='other@proswppp.com'");
 const email=vi.fn(receipt);await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{email,note:receipt}});
 expect((await rows())[0]).toMatchObject({status:'failed',requires_review:true,safe_error:'routing_changed',attempts:0});expect(email).not.toHaveBeenCalled();
 });
 it('holds missing routes while note can complete',async()=>{await db.pool.query('DELETE FROM sdr_reply_routes');await enqueueOpenAlert(db.pool,event);
 await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{email:receipt,note:receipt}});
 expect((await rows()).map(r=>[r.status,r.safe_error])).toEqual([['failed','routing_unverified'],['completed',null]]);});
 it('holds changed recipient and missing live context',async()=>{await enqueueOpenAlert(db.pool,event);await db.pool.query("UPDATE sdr_lead_state SET person_email='new@customer.test'");
 await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{email:receipt,note:receipt}});
 expect((await rows()).every(r=>r.requires_review&&r.safe_error==='context_changed')).toBe(true);
 });
 it('does not write without live context validation',async()=>{await enqueueOpenAlert(db.pool,event);const execute=vi.fn(receipt);await drainOpenAlerts(db.pool,{featureEnabled:true,now,clients:{email:execute,note:execute}});expect(execute).not.toHaveBeenCalled();expect((await rows()).every(r=>r.safe_error==='context_unverified')).toBe(true);});
 it('records handled skip separately from successful delivery',async()=>{await enqueueOpenAlert(db.pool,event);await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:async()=>({status:'skip',reason:'handled'}),clients:{email:receipt,note:receipt}});expect((await rows()).every(r=>r.status==='skipped'&&!r.receipt_at&&r.safe_error==='handled')).toBe(true);});
 it('leases prevent simultaneous duplicate work and interrupted writes require reconciliation',async()=>{await enqueueOpenAlert(db.pool,event);const execute=vi.fn(receipt);
 await Promise.all([drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{note:execute}}),drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{note:execute}})]);expect(execute).toHaveBeenCalledTimes(1);
 await db.pool.query("UPDATE sdr_open_alert_actions SET status='running',lease_until=$1 WHERE kind='email'",[new Date(+now-1)]);
 await drainOpenAlerts(db.pool,{featureEnabled:true,now,checkContext:ready,clients:{email:execute}});expect(execute).toHaveBeenCalledTimes(1);expect((await rows())[0]).toMatchObject({requires_review:true,safe_error:'completion_uncertain'});
 });
 it('verifies live CRM identity and ownership against frozen context',async()=>{
 await enqueueOpenAlert(db.pool,event);const action=(await rows())[0];
 const lead={id:'lead-a',person_id:{value:'person-1'},organization_id:{id:'org-1'},owner_id:7,is_archived:false};
 const pipedrive={getLead:async()=>lead,getPerson:async()=>({id:'person-1',email:[{value:'buyer@customer.test'}]})};
 expect(await checkOpenAlertContext(db.pool,action,{pipedrive,now})).toEqual({status:'ready'});
 lead.owner_id=8;expect(await checkOpenAlertContext(db.pool,action,{pipedrive,now})).toMatchObject({status:'review'});
 lead.owner_id=7;lead.person_id='person-2';expect(await checkOpenAlertContext(db.pool,action,{pipedrive,now})).toMatchObject({status:'review'});
 lead.person_id='person-1';lead.is_archived=true;expect(await checkOpenAlertContext(db.pool,action,{pipedrive,now})).toMatchObject({status:'skip',reason:'handled'});
 });
 it('cannot deliver using unverified or unavailable live source',async()=>{
 await enqueueOpenAlert(db.pool,event);const action=(await rows())[0];
 expect(await checkOpenAlertContext(db.pool,action,{pipedrive:{getLead:async()=>{throw new Error('secret');}},now})).toMatchObject({status:'review'});
 });
 it('disabled drain needs no migrations',async()=>{expect(await drainOpenAlerts({}, {featureEnabled:false})).toEqual({skipped:'disabled'});});
});
describe('open alert provider clients',()=>{
 it('reconciles Gmail rewritten Message-ID through exact body marker and verified participants',async()=>{
 const a={id:'action-1',payload:{mailbox:'rep@proswppp.co',forwardTo:'owner@proswppp.com',leadId:'lead-a',opens:3,contactEmail:'buyer@customer.test',leadTitle:'Project'}};
 let sent;const gmail={sendMail:async(_t,args)=>{sent=args;return {id:'initial'};},listThreadPage:async()=>({threads:[{id:'thread'}]}),getThread:async()=>({messages:[{id:'reconciled',messageId:'<rewritten@gmail.com>',from:sent.from,to:sent.to,lastOutbound:true,body:sent.bodyText}]})};
 const clients=createOpenAlertClients({gmail,getToken:async()=>'token',pipedrive:{}});await clients.email.execute(a);
 expect(await clients.email.reconcile(a)).toEqual({state:'completed',receipt:{id:'reconciled'}});
 sent.to='other@proswppp.com';expect(await clients.email.reconcile(a)).toEqual({state:'unknown'});
 });
 it('uses persisted internal route and stable message ID with neutral open wording',async()=>{const sendMail=vi.fn(async()=>({id:'sent-1'}));const gmail={sendMail,listThreadPage:vi.fn(async()=>({threads:[]}))};const clients=createOpenAlertClients({gmail,getToken:async()=>'token',pipedrive:{}});const action={id:'action-1',payload:{mailbox:'rep@proswppp.co',forwardTo:'owner@proswppp.com',leadId:'lead-a',opens:3,contactEmail:'buyer@customer.test',leadTitle:'Project'}};
 await clients.email.execute(action);const args=sendMail.mock.calls[0][1];expect(args).toMatchObject({to:'owner@proswppp.com',messageId:'<sdr-open-action-1@proswppp.co>',subject:'Open activity: Project'});expect(args.bodyText).toContain('do not confirm interest');expect(await clients.email.reconcile(action)).toEqual({state:'unknown'});
 });
});
