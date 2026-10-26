import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {businessDaysBetween,newText,mailBodyText,properCase,pickBuyerName,displayName,planQuietStep,fallbackDraft,taskSubject,taskNote,cleanDraft,runQuietConversationClock,MAX_TASKS_PER_RUN,quietTaskDue,createGeminiQuietDrafter,cleanQuote,projectMatch,isAutoReply} from '../quietConversationClock.js';

const d=s=>new Date(s);

describe('business days between',()=>{
 it('counts weekdays after the start day',()=>{
  expect(businessDaysBetween('2026-10-16','2026-10-23')).toBe(5); // Fri -> Fri
  expect(businessDaysBetween('2026-10-23','2026-10-26')).toBe(1); // Fri -> Mon
  expect(businessDaysBetween('2026-10-23','2026-10-23')).toBe(0);
 });
});

describe('task hours',()=>{
 it('weekdays only: waits before 07:00, due today until 15:00, then due the next business day',()=>{
  expect(quietTaskDue({today:'2026-10-23',hour:6})).toBeNull(); // Fri 06:00
  expect(quietTaskDue({today:'2026-10-23',hour:7})).toBe('2026-10-23');
  expect(quietTaskDue({today:'2026-10-23',hour:14})).toBe('2026-10-23');
  expect(quietTaskDue({today:'2026-10-23',hour:16})).toBe('2026-10-26'); // Fri 16:00 -> Mon
  expect(quietTaskDue({today:'2026-10-24',hour:17})).toBeNull(); // Sat 17:00
  expect(quietTaskDue({today:'2026-10-25',hour:10})).toBeNull(); // Sun
 });
});

describe('drafter',()=>{
 const reply=(decision)=>vi.fn(async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({decision,body:'Hey A,\n\nHi.\n\nRegards,'})}]}}]})}));
 it('an unknown label is a failed read, not a needs-a-person verdict',async()=>{
  await expect(createGeminiQuietDrafter({apiKey:'k',model:'m',fetchImpl:reply('maybe')})({step:'nudge1',messages:[]})).rejects.toThrow(/decision/);
  expect(await createGeminiQuietDrafter({apiKey:'k',model:'m',fetchImpl:reply('draft')})({step:'nudge1',messages:[]})).toMatchObject({decision:'draft'});
 });
});

describe('new text only',()=>{
 it('drops the quoted history',()=>{
  expect(newText('Sounds good, send it over.\n\nOn Tue, Oct 14, 2026 at 9:00 AM Derek <dc@proswppp.co> wrote:\n> Hey')).toBe('Sounds good, send it over.');
  expect(newText('What number?\n> old')).toBe('What number?');
 });
});

describe('display name',()=>{
 it('takes the sender name, not the lead contact',()=>{
  expect(displayName('"Niyaz Ahmed" <n@x.com>')).toBe('Niyaz Ahmed');
  expect(displayName('Rodger Caffey <rc@x.com>')).toBe('Rodger Caffey');
  expect(displayName('rc@x.com')).toBeNull();
 });
});

describe('plan',()=>{
 const today='2026-10-23'; // Fri
 it('waiting: buyer wrote last, 2 business days without an answer',()=>{
  expect(planQuietStep({lastIn:d('2026-10-22T15:00:00Z'),lastOut:d('2026-10-20T15:00:00Z'),today})).toBeNull();
  expect(planQuietStep({lastIn:d('2026-10-21T15:00:00Z'),lastOut:null,today})).toMatchObject({step:'waiting'});
 });
 it('waiting is left alone while the reply-watch task is still open',()=>{
  expect(planQuietStep({lastIn:d('2026-10-15T15:00:00Z'),lastOut:null,today,replyTaskOpen:true})).toBeNull();
 });
 it('nudge1: we wrote last, buyer silent 5 business days',()=>{
  expect(planQuietStep({lastIn:d('2026-10-10T15:00:00Z'),lastOut:d('2026-10-19T15:00:00Z'),today})).toBeNull();
  expect(planQuietStep({lastIn:d('2026-10-10T15:00:00Z'),lastOut:d('2026-10-16T15:00:00Z'),today})).toMatchObject({step:'nudge1'});
 });
 it('nudge2 7 business days after nudge1, then nothing more',()=>{
  const lastIn=d('2026-10-01T15:00:00Z'),lastOut=d('2026-10-05T15:00:00Z');
  expect(planQuietStep({lastIn,lastOut,today,marks:new Map([['nudge1',d('2026-10-16T13:00:00Z')]])})).toBeNull();
  expect(planQuietStep({lastIn,lastOut,today,marks:new Map([['nudge1',d('2026-10-14T13:00:00Z')]])})).toMatchObject({step:'nudge2'});
  expect(planQuietStep({lastIn,lastOut,today,marks:new Map([['nudge1',d('2026-10-01T13:00:00Z')],['nudge2',d('2026-10-12T13:00:00Z')]])})).toBeNull();
 });
 it('keys the conversation on the buyer message, so a new message starts over',()=>{
  expect(planQuietStep({lastIn:d('2026-10-10T15:00:00Z'),lastOut:d('2026-10-16T15:00:00Z'),today}).key).toBe('2026-10-10T15:00:00.000Z');
 });
});

describe('copy',()=>{
 it('fallback nudges use the first name and project, and waiting has no canned answer',()=>{
  expect(fallbackDraft({step:'nudge1',buyerName:'Rodger Caffey',project:'Sugarcane Research Lab'})).toBe('Hey Rodger,\n\nJust checking back in on Sugarcane Research Lab. Anything else you need from us on the SWPPP side?\n\nRegards,');
  expect(fallbackDraft({step:'waiting',buyerName:'Rodger',project:'X'})).toBeNull();
  for(const step of ['nudge1','nudge2']) expect(fallbackDraft({step,buyerName:'A B',project:'X'})).not.toMatch(/[—!]/);
 });
 it('task subjects say what to do',()=>{
  expect(taskSubject({step:'waiting',buyerName:'Rodger Caffey',project:'Nike Park',since:d('2026-10-09T15:00:00Z')})).toBe('Reply waiting: Rodger Caffey on Nike Park (since Oct 9)');
  expect(taskSubject({step:'nudge1',project:'Nike Park',since:d('2026-10-09T15:00:00Z')})).toBe('Follow up: Nike Park (no answer since Oct 9)');
 });
 it('note carries the buyer text escaped, the draft and the link, and says nothing was sent',()=>{
  const note=taskNote({step:'waiting',draft:'Hey A,\n\nYes.',lastBuyerText:'What <number>?',lastBuyerAt:d('2026-10-09T15:00:00Z'),link:'https://x/#/sdr?inboxLead=1'});
  expect(note).toContain('Nothing has been sent');
  expect(note).toContain('What &lt;number&gt;?');
  expect(note).toContain('Hey A,<br><br>Yes.');
  expect(note).toContain('https://x/#/sdr?inboxLead=1');
  expect(taskNote({step:'waiting',draft:null})).toContain('No draft');
 });
 it('turns a Pipedrive mail body into the new text only',()=>{
  expect(mailBodyText('<style>div.pipe-mailbody{a:b}</style><div>Hi Derek,<br>Send it&nbsp;over &amp; thanks</div><blockquote>old</blockquote>')).toBe('Hi Derek,\nSend it over & thanks');
 });
 it('greets the right person',()=>{
  expect(pickBuyerName('Work Email <s@x.com>','s@x.com','Soran Walker')).toBe('Soran Walker');
  // the contact's own address: the Pipedrive name, not the header's nickname
  expect(pickBuyerName('Katie Caffey <k@x.com>','k@x.com','Kathreen Caffey')).toBe('Kathreen Caffey');
  expect(pickBuyerName('Rodger Caffey <r@x.com>','k@x.com','Kathreen Caffey')).toBe('Rodger Caffey');
  expect(pickBuyerName('s@x.com','s@x.com','Soran Walker')).toBe('Soran Walker');
 });
 it('capitalises an all-lowercase name only',()=>{
  expect(properCase('steve klasna')).toBe('Steve Klasna');
  expect(properCase("mary o'neil-smith")).toBe("Mary O'Neil-Smith");
  expect(properCase('McDonald')).toBe('McDonald');
 });
 it('cleans model dashes and exclamation marks',()=>{
  expect(cleanDraft('Thanks — sounds great!')).toBe('Thanks, sounds great.');
 });
});

const db=reportingTestDb('quiet_followup_clock');
describe.skipIf(!db)('quiet-conversation clock (Postgres)',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`
  CREATE TABLE sdr_reply_messages(provider_message_id text PRIMARY KEY,thread_id text,mailbox_email text,received_at timestamptz,pipedrive_lead_id text,link_status text,reply_kind text,intent text,source_message_id text);
  CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,person_email text,person_name text,lead_title text,crm_status text);
  CREATE TABLE sdr_engagement_events(event_type text,pipedrive_lead_id text,occurred_at timestamptz);
  CREATE TABLE sdr_conversation_messages(provider text,account_key text,provider_message_id text,from_address text,to_addresses jsonb DEFAULT '[]',cc_addresses jsonb DEFAULT '[]',occurred_at timestamptz,direction text,provider_thread_id text,internet_message_id text,pipedrive_lead_id text,PRIMARY KEY(provider,account_key,provider_message_id));`);});
 afterAll(()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_reply_messages,sdr_lead_state,sdr_conversation_messages,sdr_engagement_events');await db.pool.query('DROP TABLE IF EXISTS quiet_followup_marks');});
 const now=new Date('2026-10-23T15:00:00Z'); // Fri
 const lead=(id,{intent='interested',received='2026-10-09T15:00:00Z',email=`${id}@buyer.test`,kind='human',link='verified',status='active'}={})=>Promise.all([
  db.pool.query(`INSERT INTO sdr_reply_messages VALUES($1,$2,'dc@proswppp.co',$3,$4,$5,$6,$7)`,['m-'+id,'t-'+id,received,id,link,kind,intent]),
  db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,$2,$3,'Rodger Caffey','Project '||$1,$4)`,[id,'p-'+id,email,status]),
 ]);
 const clients=({thread=[],activities=[],person={},leadData={owner_id:4242},mails=[],bodies={}}={})=>({
  pd:{getLead:vi.fn(async()=>leadData),getPerson:vi.fn(async()=>person),listActivitiesPage:vi.fn(async()=>({data:activities})),addActivity:vi.fn(async a=>({id:900,...a})),
   listPersonMailMessages:vi.fn(async()=>mails),getMailMessage:vi.fn(async id=>({id,body:bodies[id]}))},
  getThread:vi.fn(async()=>({messages:thread})),
 });
 const msg=(from,at,body,sent=false)=>({from,receivedAt:at,body,lastOutbound:sent});

 it('makes a follow-up task for the owner when we answered and the buyer went quiet',async()=>{
  await lead('a');
  const c=clients({thread:[msg('Rodger <a@buyer.test>','2026-10-09T15:00:00Z','What number?'),msg('Derek <dc@proswppp.co>','2026-10-10T15:00:00Z','It is $2,400.',true)]});
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Rodger,\n\nChecking in on the number.\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,appBase:'https://app',now})).toMatchObject({created:1});
  const a=c.pd.addActivity.mock.calls[0][0];
  expect(a).toMatchObject({leadId:'a',type:'task',userId:4242,dueDate:'2026-10-23',subject:'Follow up: Project a (no answer since Oct 10)'});
  expect(a.note).toContain('Checking in on the number.');
  expect(a.note).toContain('What number?');
  expect(draft.mock.calls[0][0]).toMatchObject({step:'nudge1',project:'Project a'});
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:0});
 });

 it('links the task to this project\'s own reply thread, not the buyer\'s newest thread',async()=>{
  await lead('a');
  const c=clients({thread:[msg('Rodger <a@buyer.test>','2026-10-09T15:00:00Z','What number?'),msg('Derek <dc@proswppp.co>','2026-10-10T15:00:00Z','It is $2,400.',true)]});
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Rodger,\n\nChecking in.\n\nRegards,'}));
  await runQuietConversationClock(db.pool,{...c,draft,appBase:'https://app',now});
  expect(c.pd.addActivity.mock.calls[0][0].note).toContain('https://app/#/sdr?inboxLead=a&thread=t-a&mailbox=dc%40proswppp.co');
 });

 it('sees a reply sent from another mailbox (collected messages and Pipedrive) as an answer',async()=>{
  await lead('a',{received:'2026-10-19T15:00:00Z'});
  await db.pool.query(`INSERT INTO sdr_conversation_messages VALUES('pipedrive','dc@proswppp.com','x',null,'["Rodger <A@buyer.test>"]','[]','2026-10-20T15:00:00Z','out')`);
  const c=clients({thread:[msg('a@buyer.test','2026-10-19T15:00:00Z','Can you send the quote?')]});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:0}); // answered, not quiet long enough
  const c2=clients({thread:[msg('a@buyer.test','2026-10-19T15:00:00Z','Can you send the quote?')],person:{last_outgoing_mail_time:'2026-10-14 10:00:00'}});
  await db.pool.query('TRUNCATE sdr_conversation_messages');
  expect(await runQuietConversationClock(db.pool,{...c2,now})).toMatchObject({created:1});
  expect(c2.pd.addActivity.mock.calls[0][0].subject).toMatch(/^Reply waiting: Rodger Caffey on Project a/);
 });

 it('skips not-interested, nurture, auto, unverified, inactive and archived leads',async()=>{
  await lead('n',{intent:'not_interested'});await lead('u',{intent:'nurture'});await lead('b',{kind:'auto'});
  await lead('l',{link:'ambiguous'});await lead('i',{status:'inactive'});
  const c=clients({thread:[msg('x@buyer.test','2026-10-09T15:00:00Z','hi')]});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:0});
  await lead('r');
  const c2=clients({leadData:{is_archived:true}});
  expect(await runQuietConversationClock(db.pool,{...c2,now})).toMatchObject({created:0});
 });

 it('respects a planned future touch and our own open task',async()=>{
  await lead('a');
  const thread=[msg('a@buyer.test','2026-10-09T15:00:00Z','hi'),msg('dc@proswppp.co','2026-10-10T15:00:00Z','hello',true)];
  expect(await runQuietConversationClock(db.pool,{...clients({thread,activities:[{subject:'Call Rodger',due_date:'2026-10-28',done:false}]}),now})).toMatchObject({created:0});
  expect(await runQuietConversationClock(db.pool,{...clients({thread,activities:[{subject:'Follow up: Project a (no answer since Oct 10)',due_date:'2026-10-16',done:false}]}),now})).toMatchObject({created:0});
  expect(await runQuietConversationClock(db.pool,{...clients({thread,activities:[{subject:'Call Rodger',due_date:'2026-10-01',done:false}]}),now})).toMatchObject({created:1});
 });

 it('with the drafter down the task has no draft and says to read the thread first, and the claim is released when Pipedrive refuses',async()=>{
  await lead('a');
  const c=clients({thread:[msg('a@buyer.test','2026-10-09T15:00:00Z','hi'),msg('dc@proswppp.co','2026-10-10T15:00:00Z','hello',true)]});
  c.pd.addActivity.mockRejectedValueOnce(new Error('boom'));
  const draft=vi.fn(async()=>{throw new Error('model down');});
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({failed:1});
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  const note=c.pd.addActivity.mock.calls[1][0].note;
  expect(note).toContain('nothing has checked whether they already said no');
  expect(note).not.toContain('Just checking back in');
 });

 it('a buyer who already said no gets no task and is never nudged on that conversation',async()=>{
  await lead('a');
  const c=clients({thread:[msg('Kevin <a@buyer.test>','2026-10-09T15:00:00Z','No, we are not.'),msg('dc@proswppp.co','2026-10-10T15:00:00Z','hello',true)]});
  const draft=vi.fn(async()=>({decision:'declined',body:null}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:0,skipped:1});
  expect(await runQuietConversationClock(db.pool,{...c,draft,now:new Date('2026-11-20T15:00:00Z')})).toMatchObject({created:0});
  expect(c.pd.addActivity).not.toHaveBeenCalled();
 });

 it('a question only a person can answer gets the task without a draft, addressed to who actually wrote',async()=>{
  await lead('a');
  const c=clients({thread:[msg('Niyaz Ahmed <n@buyer.test>','2026-10-09T15:00:00Z','What number?')]});
  const draft=vi.fn(async()=>({decision:'needs_human',body:null}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  const a=c.pd.addActivity.mock.calls[0][0];
  expect(a.subject).toMatch(/^Reply waiting: Niyaz Ahmed on Project a/);
  expect(a.note).toContain('No draft');
  expect(draft.mock.calls[0][0].buyerName).toBe('Niyaz Ahmed');
 });

 it('an old first reply still counts when the conversation kept going, and a long-dead one does not',async()=>{
  await lead('a',{received:'2026-09-16T15:00:00Z'});
  const c=clients({thread:[msg('a@buyer.test','2026-09-16T15:00:00Z','Send pricing'),msg('dc@proswppp.co','2026-09-17T15:00:00Z','Here it is',true)],person:{last_incoming_mail_time:'2026-10-12 22:03:04',last_outgoing_mail_time:'2026-10-12 22:20:09'},
   mails:[{id:1,message_time:'2026-10-12 22:03:04',sent_flag:0,from:[{email_address:'a@buyer.test'}]}],bodies:{1:'<p>What do you charge?</p>'}});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:1});
  expect(c.pd.addActivity.mock.calls[0][0].subject).toBe('Follow up: Project a (no answer since Oct 12)');
  await lead('b',{received:'2026-08-01T15:00:00Z'});
  const c2=clients({thread:[msg('b@buyer.test','2026-08-01T15:00:00Z','Send pricing'),msg('dc@proswppp.co','2026-08-03T15:00:00Z','Here it is',true)]});
  expect(await runQuietConversationClock(db.pool,{...c2,onlyLeads:['b'],now})).toMatchObject({created:0});
  expect(c2.pd.getLead).not.toHaveBeenCalled();
 });

 it('reads Apollo replies with the Pipedrive-synced mail as the conversation',async()=>{
  const apollo=async(id,at)=>{await db.pool.query(`INSERT INTO sdr_engagement_events VALUES('email_replied',$1,$2)`,[id,at]);await db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,$2,$3,'Chad Kamins','Project '||$1,'active')`,[id,'p-'+id,id+'@buyer.test']);};
  await apollo('w','2026-09-16T15:00:00Z');
  const mails=[
   {id:2,message_time:'2026-10-12 22:20:09',sent_flag:1,subject:'RE: Project w',from:[{email_address:'dc@proswppp.com',name:'Derek'}]},
   {id:1,message_time:'2026-10-12 22:03:04',sent_flag:0,subject:'Re: Project w SWPPP',from:[{email_address:'w@buyer.test',name:'Chad Kamins'}]},
  ];
  const bodies={1:'<style>p{x:1}</style><p>Are you still able to price Washington?</p><blockquote>On Sep 16 we wrote</blockquote>',2:'<p>Yes, pricing attached.</p>'};
  const c=clients({mails,bodies,person:{last_incoming_mail_time:'2026-10-12 22:03:04',last_outgoing_mail_time:'2026-10-12 22:20:09'}});
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Chad,\n\nChecking in on Washington.\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  expect(draft.mock.calls[0][0]).toMatchObject({step:'nudge1',buyerName:'Chad Kamins',messages:[{from:'buyer',text:'Are you still able to price Washington?'},{from:'ProSWPPP',text:'Yes, pricing attached.'}]});
  expect(c.pd.addActivity.mock.calls[0][0].subject).toBe('Follow up: Project w (no answer since Oct 12)');
  expect(c.pd.listActivitiesPage).toHaveBeenCalledWith({leadId:'w',limit:100});
  // the newest reply is unreadable and only an older buyer email is: no task
  await apollo('o','2026-10-12T15:00:00Z');
  const c3=clients({mails:[{id:5,message_time:'2026-01-30 15:00:00',sent_flag:0,subject:'Re: Project o',from:[{email_address:'o@buyer.test'}]},{id:6,message_time:'2026-10-12 22:20:09',sent_flag:1,subject:'Project o',from:[{email_address:'dc@proswppp.com'}]}],bodies:{5:'<p>We did not get this one.</p>',6:'<p>New bid attached.</p>'},person:{last_outgoing_mail_time:'2026-10-12 22:20:09'}});
  expect(await runQuietConversationClock(db.pool,{...c3,onlyLeads:['o'],now})).toMatchObject({created:0,skipped:1});
  // no readable buyer text: no task
  await apollo('q','2026-10-09T15:00:00Z');
  const c2=clients({person:{last_incoming_mail_time:'2026-10-09 15:00:00'}});
  expect(await runQuietConversationClock(db.pool,{...c2,onlyLeads:['q'],now})).toMatchObject({created:0,skipped:1});
 });

 it('one buyer on two leads: the task goes on the lead the mail is about, and a buyer silent for over 60 days gets none',async()=>{
  const two=async(id,person,at,title)=>{await db.pool.query(`INSERT INTO sdr_engagement_events VALUES('email_replied',$1,$2)`,[id,at]);await db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,$2,'v@buyer.test','Vickie Guy',$3,'active')`,[id,person,title]);};
  await two('h1','p-v','2026-09-08T15:00:00Z','Guymon Maint Fac');await two('h2','p-v','2026-09-08T15:00:00Z','Boise City Terminal Bldg');
  const mails=[{id:1,message_time:'2026-09-08 15:00:00',sent_flag:0,subject:'RE: Boise City Terminal Building, Boise City, OK',from:[{email_address:'v@buyer.test',name:'Vickie Guy'}]},{id:2,message_time:'2026-10-08 15:00:00',sent_flag:1,subject:'Re: Boise City Terminal Building, Boise City, OK',from:[{email_address:'dc@proswppp.com'}]}];
  const c=clients({mails,bodies:{1:'<p>As soon as I know something I will let you know.</p>',2:'<p>Any news?</p>'},person:{last_incoming_mail_time:'2026-09-08 15:00:00',last_outgoing_mail_time:'2026-10-08 15:00:00'}});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:1});
  expect(c.pd.addActivity).toHaveBeenCalledTimes(1);
  const a=c.pd.addActivity.mock.calls[0][0];
  expect(a).toMatchObject({leadId:'h2',subject:'Follow up: Boise City Terminal Bldg (no answer since Oct 8)'});
  expect(a.note).toContain('(Sep 8, "Boise City Terminal Building, Boise City, OK")');
  await db.pool.query('TRUNCATE sdr_engagement_events,sdr_lead_state');await db.pool.query('DROP TABLE quiet_followup_marks');
  await two('old','p-o','2026-05-05T15:00:00Z','Project old');
  const c2=clients({mails,bodies:{1:'<p>Confirmed</p>',2:'<p>Hi</p>'},person:{last_incoming_mail_time:'2026-05-05 15:00:00',last_outgoing_mail_time:'2026-10-16 15:00:00'}});
  expect(await runQuietConversationClock(db.pool,{...c2,now})).toMatchObject({created:0});
  expect(c2.pd.getLead).not.toHaveBeenCalled();
 });

 it('an Apollo reply with no reply row is read from the .co thread it was collected in',async()=>{
  await db.pool.query(`INSERT INTO sdr_engagement_events VALUES('email_replied','g','2026-10-01T15:00:00Z')`);
  await db.pool.query(`INSERT INTO sdr_lead_state VALUES('g','p-g','g@buyer.test','Jim Sydor','Project g','active')`);
  await db.pool.query(`INSERT INTO sdr_conversation_messages VALUES('gmail','sr@proswppp.co','x1','Jim <G@buyer.test>','[]','[]','2026-10-01T15:00:00Z','in','thr-9')`);
  const c=clients({thread:[{...msg('Steve <sr@proswppp.co>','2026-09-29T15:00:00Z','Can we quote the SWPPP?',true),subject:'Project g SWPPP'},{...msg('Jim <g@buyer.test>','2026-10-01T15:00:00Z','Yes, send it over.'),subject:'RE: Project g SWPPP'},{...msg('Steve <sr@proswppp.co>','2026-10-02T15:00:00Z','Attached.',true),subject:'RE: Project g SWPPP'}]});
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Jim,\n\nChecking in.\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  expect(c.getThread).toHaveBeenCalledWith('sr@proswppp.co','thr-9');
  expect(draft.mock.calls[0][0].messages.map(m=>m.text)).toEqual(['Can we quote the SWPPP?','Yes, send it over.','Attached.']);
  // a mailbox that can't be read is not a failure, just nothing readable
  await db.pool.query('DROP TABLE quiet_followup_marks');
  const c2=clients();c2.getThread.mockRejectedValue(new Error('Mailbox sr@proswppp.co not connected'));
  expect(await runQuietConversationClock(db.pool,{...c2,now})).toMatchObject({created:0,failed:0,skipped:1});
  // not re-read on every run, but nothing parked: after the back-off the same conversation gets its task
  expect(await runQuietConversationClock(db.pool,{...c,draft,now:new Date('2026-10-23T20:00:00Z')})).toMatchObject({created:0,reasons:{unreadable_recently:1}});
  expect(c.getThread).toHaveBeenCalledTimes(1);
  expect(await runQuietConversationClock(db.pool,{...c,draft,now:new Date('2026-10-26T15:00:00Z')})).toMatchObject({created:1});
 });

 it('one task per buyer within two weeks across leads, and a one-word sender label uses the contact name',async()=>{
  const mk=async(id)=>{await db.pool.query(`INSERT INTO sdr_engagement_events VALUES('email_replied',$1,'2026-10-09T15:00:00Z')`,[id]);await db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,'p-same','w@buyer.test','soran amin','Project '||$1,'active')`,[id]);};
  await mk('k1');await mk('k2');
  const c=clients({thread:[msg('Work <w@buyer.test>','2026-10-09T15:00:00Z','What was your quote again?'),msg('dc@proswppp.co','2026-10-10T15:00:00Z','Here it is.',true)]});
  await db.pool.query(`INSERT INTO sdr_conversation_messages VALUES('gmail','dc@proswppp.co','w1','w@buyer.test','[]','[]','2026-10-09T15:00:00Z','in','t-w')`);
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Soran,\n\nChecking in.\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  expect(draft.mock.calls[0][0].buyerName).toBe('Soran Amin');
 });

 it('a classified no beats a later Apollo reply event',async()=>{
  await lead('a',{intent:'not_interested'});
  await db.pool.query(`INSERT INTO sdr_engagement_events VALUES('email_replied','a','2026-10-15T15:00:00Z')`);
  const c=clients({thread:[msg('a@buyer.test','2026-10-09T15:00:00Z','No thanks')]});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:0});
  expect(c.pd.getLead).not.toHaveBeenCalled();
 });

 it('pilot mode only touches listed leads, and a run stops at the cap',async()=>{
  for(let i=0;i<MAX_TASKS_PER_RUN+3;i++) await lead('z'+String(i).padStart(2,'0'));
  const c=clients({thread:[msg('x@buyer.test','2026-10-09T15:00:00Z','hi')]});
  expect(await runQuietConversationClock(db.pool,{...c,onlyLeads:['z03'],now})).toMatchObject({created:1});
  expect(c.pd.addActivity.mock.calls[0][0].leadId).toBe('z03');
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:MAX_TASKS_PER_RUN});
 });

 const quiet=[msg('a@buyer.test','2026-10-09T15:00:00Z','Send the quote'),msg('dc@proswppp.co','2026-10-10T15:00:00Z','Here it is',true)];
 const marksTable=`CREATE TABLE quiet_followup_marks (pipedrive_lead_id TEXT NOT NULL, conversation_key TEXT NOT NULL, step TEXT NOT NULL, outcome TEXT NOT NULL, activity_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (pipedrive_lead_id, conversation_key, step))`;

 it('makes tasks on weekdays from 07:00 Chicago only, due Monday when made late Friday, and every run says why it made nothing',async()=>{
  await lead('a');
  const c=clients({thread:quiet});
  expect(await runQuietConversationClock(db.pool,{...c,now:new Date('2026-10-24T22:00:00Z')})).toMatchObject({checked:0,created:0,waiting:'outside_task_hours'}); // Sat 17:00
  expect(await runQuietConversationClock(db.pool,{...c,now:new Date('2026-10-23T11:00:00Z')})).toMatchObject({checked:0,created:0,waiting:'outside_task_hours'}); // Fri 06:00
  expect(c.pd.getLead).not.toHaveBeenCalled();
  expect(await runQuietConversationClock(db.pool,{...c,now:new Date('2026-10-23T21:00:00Z')})).toMatchObject({created:1}); // Fri 16:00
  expect(c.pd.addActivity.mock.calls[0][0].dueDate).toBe('2026-10-26');
  expect(await runQuietConversationClock(db.pool,{...c,now})).toEqual({checked:1,created:0,skipped:1,failed:0,reasons:{not_due:1}});
 });

 it('releases a claim left pending by a run that died, and a pending Follow up never times the Last follow-up',async()=>{
  await lead('a');
  await db.pool.query(marksTable);
  await db.pool.query(`INSERT INTO quiet_followup_marks VALUES('a','2026-10-09T15:00:00.000Z','nudge1','pending',null,NOW()-INTERVAL '2 hours')`);
  const seen=[];
  for (const at of ['2026-10-23T15:00:00Z','2026-10-27T15:00:00Z','2026-11-03T15:00:00Z']) {
   const c=clients({thread:quiet});
   await runQuietConversationClock(db.pool,{...c,now:new Date(at)});
   seen.push(...c.pd.addActivity.mock.calls.map(x=>x[0].subject));
  }
  expect(seen).toEqual(['Follow up: Project a (no answer since Oct 10)']);
  // a claim made moments ago belongs to a run still working: left alone, and no Last follow-up from it
  await db.pool.query(`DELETE FROM quiet_followup_marks`);
  await db.pool.query(`INSERT INTO quiet_followup_marks VALUES('a','2026-10-09T15:00:00.000Z','nudge1','pending',null,NOW()-INTERVAL '1 minute')`);
  const c=clients({thread:quiet});
  expect(await runQuietConversationClock(db.pool,{...c,now:new Date('2026-11-06T15:00:00Z')})).toMatchObject({created:0,reasons:{claimed:1}});
 });

 it('an open reply-watch task blocks only while it is about the buyer\'s latest message and nobody has answered',async()=>{
  await lead('a');
  const asked=[msg('a@buyer.test','2026-10-09T15:00:00Z','Send the quote')];
  const task=(add_time,subject='Reply received — follow up [SDR reply action 5f2c]')=>({id:31,type:'task',subject,due_date:'2026-10-15',add_time,done:false,user_id:7});
  // unanswered, task made after their message: the owner already has it
  for (const subject of ['Reply received — follow up [SDR reply action 5f2c]','Reply received from a@buyer.test — follow up']) {
   const c=clients({thread:asked,activities:[task('2026-10-09 15:04:00',subject)]});
   expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:0,reasons:{reply_task_open:1}});
  }
  // we answered after it: the old reply task no longer holds back the Follow up
  const c=clients({thread:quiet,activities:[task('2026-10-09 15:04:00')]});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:1});
  expect(c.pd.addActivity.mock.calls[0][0].subject).toMatch(/^Follow up:/);
  expect(c.pd.addActivity.mock.calls[0][0].note).toContain('The earlier task "Reply received');
  // a reply task about an older message: the buyer's newer message gets its Reply waiting task
  await db.pool.query('DROP TABLE quiet_followup_marks');
  const c2=clients({thread:asked,activities:[task('2026-09-20 15:04:00')]});
  expect(await runQuietConversationClock(db.pool,{...c2,now})).toMatchObject({created:1});
  expect(c2.pd.addActivity.mock.calls[0][0].subject).toMatch(/^Reply waiting:/);
  // a finished one never blocks
  await db.pool.query('DROP TABLE quiet_followup_marks');
  const c3=clients({thread:asked,activities:[{...task('2026-10-09 15:04:00'),done:true}]});
  expect(await runQuietConversationClock(db.pool,{...c3,now})).toMatchObject({created:1});
 });

 it('when the buyer writes again, our own earlier open task does not block the next step and is only named, never edited',async()=>{
  await lead('a');
  expect(await runQuietConversationClock(db.pool,{...clients({thread:quiet}),now})).toMatchObject({created:1});
  const ours={id:900,type:'task',subject:'Follow up: Project a (no answer since Oct 10)',due_date:'2026-10-23',add_time:'2026-10-23 15:00:00',done:false};
  // same conversation, our task still open: nothing new
  expect(await runQuietConversationClock(db.pool,{...clients({thread:quiet,activities:[ours]}),now:new Date('2026-11-04T15:00:00Z')})).toMatchObject({created:0,reasons:{own_task_open:1}});
  const again=[...quiet,msg('a@buyer.test','2026-10-26T15:00:00Z','Yes we got the job, send the contract')];
  const c=clients({thread:again,activities:[ours]});
  expect(await runQuietConversationClock(db.pool,{...c,now:new Date('2026-10-28T15:00:00Z')})).toMatchObject({created:1});
  const a=c.pd.addActivity.mock.calls[0][0];
  expect(a.subject).toBe('Reply waiting: Rodger Caffey on Project a (since Oct 26)');
  expect(a.note).toContain('The earlier task "Follow up: Project a (no answer since Oct 10)" is about an older point in this conversation');
  expect(c.pd.addActivity).toHaveBeenCalledTimes(1);
 });

 it('ignores auto-replies in Pipedrive mail, collected messages and the .co thread',async()=>{
  await lead('a');
  const ooo=(subject,body)=>clients({thread:quiet,person:{last_incoming_mail_time:'2026-10-19 14:00:00'},
   mails:[{id:7,message_time:'2026-10-19 14:00:00',sent_flag:0,subject,from:[{email_address:'a@buyer.test',name:'Rodger'}]}],bodies:{7:body}});
  for (const c of [ooo('Automatic reply: Project a','<p>I am away.</p>'),ooo('Re: Project a','<p>I am out of the office until Monday with limited access to email.</p>')]) {
   await db.pool.query('DROP TABLE IF EXISTS quiet_followup_marks');
   expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:1});
   expect(c.pd.addActivity.mock.calls[0][0].subject).toBe('Follow up: Project a (no answer since Oct 10)');
   expect(c.pd.addActivity.mock.calls[0][0].note).not.toContain('out of the office');
  }
  // collected inbound that the reply watch recorded as an auto-reply
  await db.pool.query('DROP TABLE quiet_followup_marks');
  await db.pool.query(`INSERT INTO sdr_conversation_messages VALUES('gmail','dc@proswppp.co','g-ooo','Rodger <a@buyer.test>','[]','[]','2026-10-20T15:00:00Z','in','t-other')`);
  await db.pool.query(`INSERT INTO sdr_reply_messages VALUES('gmail:dc@proswppp.co:g-ooo','t-other','dc@proswppp.co','2026-10-20T15:00:00Z',NULL,'unlinked','auto','automatic','g-ooo')`);
  const c2=clients({thread:quiet});
  expect(await runQuietConversationClock(db.pool,{...c2,now})).toMatchObject({created:1});
  expect(c2.pd.addActivity.mock.calls[0][0].subject).toMatch(/^Follow up:/);
  // an auto-reply in the .co thread itself, with no Auto-Submitted header
  await db.pool.query('DROP TABLE quiet_followup_marks');
  const c3=clients({thread:[...quiet,msg('a@buyer.test','2026-10-21T15:00:00Z','Thank you for your email. I am currently out of the office and will return on Monday.')]});
  expect(await runQuietConversationClock(db.pool,{...c3,now})).toMatchObject({created:1});
  expect(c3.pd.addActivity.mock.calls[0][0].subject).toMatch(/^Follow up:/);
 });

 it('a drafter that is down never sends the stock nudge to a buyer who said no',async()=>{
  await lead('a');
  const c=clients({thread:[msg('a@buyer.test','2026-10-09T15:00:00Z','We went with another company on this one.'),msg('dc@proswppp.co','2026-10-10T15:00:00Z','Understood, thanks',true)]});
  const draft=vi.fn(async()=>{throw new Error('gemini 503');});
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  const note=c.pd.addActivity.mock.calls[0][0].note;
  expect(note).not.toContain('Just checking back in');
  expect(note).toContain('Read the thread before sending anything');
 });

 // ---- 2026-10-26 review (A1) ----
 const pdMail=(id,at,{subject,lead=null,sent=false,from='v@buyer.test',name='Vickie Guy'}={})=>({id,message_time:at,sent_flag:sent?1:0,subject,lead_id:lead,from:[{email_address:sent?'dc@proswppp.com':from,name:sent?'Derek':name}]});
 const apolloLead=async(id,person,title,{email='v@buyer.test',name='Vickie Guy',at='2026-09-08T15:00:00Z',status='active'}={})=>{
  await db.pool.query(`INSERT INTO sdr_engagement_events VALUES('email_replied',$1,$2)`,[id,at]);
  await db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,$2,$3,$4,$5,$6)`,[id,person,email,name,title,status]);
 };

 it('A1.1 Guymon: mail about another project with no lead of its own is named, never quoted or drafted as this lead',async()=>{
  await apolloLead('guy','p-v','Guymon Maint Fac');
  await db.pool.query(`INSERT INTO sdr_lead_state VALUES('dawn','p-v','v@buyer.test','Vickie Guy','Dawn Aerospace Hangar & Ofc','active')`);
  const mails=[
   pdMail(3,'2026-10-08 19:21:04',{subject:'Dawn Aerospace Hangar & Office SWPPP',lead:'dawn',sent:true}),
   pdMail(2,'2026-09-29 15:12:20',{subject:'Re: Boise City Terminal Building, Boise City Municipal Airport, Boise City, OK',sent:true}),
   pdMail(1,'2026-09-08 18:28:46',{subject:'RE: Boise City Terminal Building, Boise City Municipal Airport, Boise City, OK'}),
  ];
  const c=clients({mails,bodies:{1:'<p>As soon as I know something I will let you know.</p>',2:'<p>Any update?</p>',3:'<p>Bid attached.</p>'},person:{last_incoming_mail_time:'2026-09-08 18:28:46',last_outgoing_mail_time:'2026-10-08 19:21:04'}});
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Vickie,\n\nAny news on Boise City and Dawn Aerospace?\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  const a=c.pd.addActivity.mock.calls[0][0];
  expect(a.leadId).toBe('guy');
  // timed from our Boise email (Sep 29), not the Dawn Aerospace one (Oct 8, another lead)
  expect(a.subject).toMatch(/^Follow up: "Boise City Terminal Building, Boise City Municipal Airport.*" \(lead: Guymon Maint Fac, no answer since Sep 29\)$/);
  expect(a.note).toContain('doesn\'t clearly match this lead (Guymon Maint Fac)');
  expect(a.note).not.toContain('As soon as I know');
  expect(a.note).not.toContain('Dawn Aerospace');
  expect(a.note).not.toContain('READY TO SEND');
 });

 it('A1.1 Vinita: a weak subject match (one shared word with another lead) is not this lead\'s conversation; a Pipedrive lead link is',async()=>{
  await apolloLead('vin','p-b','Vinita Terminal Bldg',{email:'b@buyer.test',name:'Ben Warren',at:'2026-09-28T15:00:00Z'});
  await db.pool.query(`INSERT INTO sdr_lead_state VALUES('6m2','p-b','b@buyer.test','Ben Warren','6M2 Hangar','active')`);
  const box=[pdMail(2,'2026-10-13 15:00:00',{subject:'RE: Box Hangars Poteau OK',sent:true}),pdMail(1,'2026-09-28 15:00:00',{subject:'Box Hangars Poteau OK',from:'b@buyer.test',name:'Ben Warren'})];
  const bodies={1:'<p>Derek,</p><p>We are still working through the quotes.</p><p>Thanks,</p><p>Ben Warren</p><p>Estimator</p>',2:'<p>Checking in.</p>',5:'<p>Yes, we will need SWPPP on Vinita.</p>',6:'<p>Great, quote attached.</p>'};
  const c=clients({mails:box,bodies});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:1});
  const a=c.pd.addActivity.mock.calls[0][0];
  expect(a.leadId).toBe('vin');
  expect(a.subject).toMatch(/^Follow up: "Box Hangars Poteau OK" \(lead: Vinita Terminal Bldg/);
  expect(a.note).not.toContain('still working through the quotes');
  // a reply Pipedrive linked to the Vinita lead is the Vinita conversation, whatever its subject says
  await db.pool.query('DROP TABLE quiet_followup_marks');
  const linked=[pdMail(6,'2026-10-14 15:00:00',{subject:'Re: quote',lead:'vin',sent:true}),pdMail(5,'2026-10-13 15:00:00',{subject:'Re: quote',lead:'vin',from:'b@buyer.test',name:'Ben Warren'}),...box];
  const c2=clients({mails:linked,bodies});
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Ben,\n\nChecking in on Vinita.\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c2,draft,now:new Date('2026-10-22T15:00:00Z')})).toMatchObject({created:1});
  const b=c2.pd.addActivity.mock.calls[0][0];
  expect(b.subject).toBe('Follow up: Vinita Terminal Bldg (no answer since Oct 14)');
  expect(b.note).toContain('Yes, we will need SWPPP on Vinita.');
  expect(b.note).not.toContain('Poteau');
  expect(draft.mock.calls[0][0].messages.map(m=>m.text)).toEqual(['Yes, we will need SWPPP on Vinita.','Great, quote attached.']);
 });

 it('A1.1/A1.2 Cow Pond: a file-share notice is not the buyer writing, so it is never quoted',async()=>{
  await apolloLead('cow','p-al','Cow Pond Brook Fields Imp',{email:'al@buyer.test',name:'Al Gouveia',at:'2026-09-29T15:00:00Z'});
  const mails=[pdMail(2,'2026-10-06 15:00:00',{subject:'Re: Cow Pond Brook Fields Imp',sent:true}),pdMail(1,'2026-09-29 15:00:00',{subject:'Al Gouveia shared "Riverbend 2026 Landscape Project" with you',from:'al@buyer.test',name:'Al Gouveia'})];
  const c=clients({mails,bodies:{1:'<p>[Share image]</p><p>Al Gouveia shared a file with you</p>',2:'<p>Please send drawings.</p>'}});
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:0});
  expect(c.pd.addActivity).not.toHaveBeenCalled();
  expect(isAutoReply({subject:'Al Gouveia shared "Riverbend 2026 Landscape Project" with you',text:''})).toBe(true);
 });

 it('A1.3 the reply-task-blocked buyers: a stale reply-watch task from September no longer starves the October follow-up',async()=>{
  await lead('s',{received:'2026-09-11T15:00:00Z'});
  const thread=[msg('Chris <s@buyer.test>','2026-09-11T15:00:00Z','over budget and will be redesigned/rebid'),msg('dc@proswppp.co','2026-10-02T15:00:00Z','Any update on the rebid?',true)];
  const c=clients({thread,activities:[{id:35579,type:'task',subject:'Reply received from s@buyer.test — follow up',add_time:'2026-09-11 19:05:57',done:false}]});
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Chris,\n\nAny news on the rebid?\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now:new Date('2026-10-12T15:00:00Z')})).toMatchObject({created:1,reasons:{}});
 });

 it('A1.4 a reply the classifier could not read (intent unknown) gets a task; the drafter decides',async()=>{
  await lead('v',{intent:'unknown',received:'2026-10-15T15:00:00Z'});
  const c=clients({thread:[msg('v@buyer.test','2026-10-15T15:00:00Z','Did you send me an estimate?')]});
  const draft=vi.fn(async()=>({decision:'needs_human',body:null}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  expect(c.pd.addActivity.mock.calls[0][0].subject).toMatch(/^Reply waiting: Rodger Caffey on Project v/);
  await lead('n',{intent:'not_interested'});
  expect(await runQuietConversationClock(db.pool,{...clients(),onlyLeads:['n'],now})).toMatchObject({created:0,reasons:{not_active_intent:1}});
 });

 it('A1.6 the task is only ever assigned to the lead owner (no retry on the token owner)',async()=>{
  await lead('a');
  const c=clients({thread:quiet});
  await runQuietConversationClock(db.pool,{...c,now});
  expect(c.pd.addActivity.mock.calls[0][0]).toMatchObject({userId:4242,strictAssignee:true});
 });

 it('A1.7 a no on one project never blocks another project of the same buyer; the same message is never tasked twice',async()=>{
  await apolloLead('p1','p-x','Elm Street Bridge',{email:'x@buyer.test',name:'Kim Lee',at:'2026-10-01T15:00:00Z'});
  await apolloLead('p2','p-x','Oak Park Pavilion',{email:'x@buyer.test',name:'Kim Lee',at:'2026-10-01T15:00:00Z'});
  await db.pool.query(marksTable);
  // declined long ago on Elm Street (a different message)
  await db.pool.query(`INSERT INTO quiet_followup_marks VALUES('p1','2026-08-01T15:00:00.000Z','nudge1','skipped:declined',null,'2026-08-05T15:00:00Z')`);
  const mails=[pdMail(2,'2026-10-12 15:00:00',{subject:'RE: Oak Park Pavilion SWPPP',sent:true}),pdMail(1,'2026-10-09 15:00:00',{subject:'Oak Park Pavilion SWPPP',from:'x@buyer.test',name:'Kim Lee'})];
  const c=clients({mails,bodies:{1:'<p>Send pricing please.</p>',2:'<p>Pricing attached.</p>'}});
  expect(await runQuietConversationClock(db.pool,{...c,now:new Date('2026-10-20T15:00:00Z')})).toMatchObject({created:1});
  expect(c.pd.addActivity.mock.calls[0][0].leadId).toBe('p2');
  // the same buyer message already handled on another lead weeks ago still blocks (no 14-day limit)
  await db.pool.query(`DELETE FROM quiet_followup_marks`);
  await db.pool.query(`INSERT INTO quiet_followup_marks VALUES('p1','2026-10-09T15:00:00.000Z','nudge1','created','77',NOW()-INTERVAL '40 days')`);
  const c2=clients({mails,bodies:{1:'<p>Send pricing please.</p>',2:'<p>Pricing attached.</p>'}});
  expect(await runQuietConversationClock(db.pool,{...c2,onlyLeads:['p2'],now:new Date('2026-10-20T15:00:00Z')})).toMatchObject({created:0,reasons:{other_lead_task:1}});
 });

 it('A1.8 Last follow-up is timed from our actual send of the Follow up, not from when the task was made',async()=>{
  await lead('a');
  await db.pool.query(marksTable);
  await db.pool.query(`INSERT INTO quiet_followup_marks VALUES('a','2026-10-09T15:00:00.000Z','nudge1','created','900','2026-10-19T15:00:00Z')`);
  // the owner sent the Follow up on Oct 23; 7 business days from Oct 19 would be Oct 28
  const sent=[...quiet,msg('dc@proswppp.co','2026-10-23T15:00:00Z','Just checking back in.',true)];
  expect(await runQuietConversationClock(db.pool,{...clients({thread:sent}),now:new Date('2026-10-28T15:00:00Z')})).toMatchObject({created:0,reasons:{not_due:1}});
  const c=clients({thread:sent});
  expect(await runQuietConversationClock(db.pool,{...c,now:new Date('2026-11-03T15:00:00Z')})).toMatchObject({created:1});
  expect(c.pd.addActivity.mock.calls[0][0].subject).toBe('Last follow-up: Project a (no answer since Oct 23)');
  // then the conversation is finished, and the run says so
  expect(await runQuietConversationClock(db.pool,{...clients({thread:sent}),now:new Date('2026-11-20T15:00:00Z')})).toMatchObject({created:0,reasons:{finished:1}});
 });

 it('A1.8 a team note newer than the buyer\'s message goes to the drafter and into the task',async()=>{
  await lead('a');
  const c=clients({thread:quiet,activities:[{id:5,type:'call',subject:'1st Call Made',done:true,add_time:'2026-10-01 20:00:00',marked_as_done_time:'2026-10-01 20:00:00',note:''}]});
  c.pd.listLeadNotes=vi.fn(async()=>[{id:1,add_time:'2026-10-11 19:58:46',content:'Said he has his subs picked out already.'},{id:2,add_time:'2026-10-12 04:26:25',content:'[Auto] Project stage updated'}]);
  const draft=vi.fn(async()=>({decision:'draft',body:'Hey Rodger,\n\nChecking in.\n\nRegards,'}));
  expect(await runQuietConversationClock(db.pool,{...c,draft,now})).toMatchObject({created:1});
  expect(draft.mock.calls[0][0].messages.at(-1)).toMatchObject({from:'team note',text:'Said he has his subs picked out already.'});
  expect(c.pd.addActivity.mock.calls[0][0].note).toContain('Newer note from the team</b> (Oct 11)');
 });

 it('A1.8 a declined conversation is reported as declined, not as not due',async()=>{
  await lead('a');
  await db.pool.query(marksTable);
  await db.pool.query(`INSERT INTO quiet_followup_marks VALUES('a','2026-10-09T15:00:00.000Z','nudge1','skipped:declined',null,NOW())`);
  expect(await runQuietConversationClock(db.pool,{...clients({thread:quiet}),now})).toMatchObject({created:0,reasons:{declined_earlier:1}});
 });

 it('A1.8 two runs never overlap, and a hung provider call fails the lead instead of holding the run',async()=>{
  await lead('a');
  let release;
  const c=clients({thread:quiet});
  c.getThread=vi.fn(()=>new Promise(r=>{release=()=>r({messages:quiet});}));
  const first=runQuietConversationClock(db.pool,{...c,now});
  await vi.waitFor(()=>expect(c.getThread).toHaveBeenCalled());
  expect(await runQuietConversationClock(db.pool,{...c,now})).toMatchObject({created:0,waiting:'already_running'});
  release();
  expect(await first).toMatchObject({created:1});
  await db.pool.query('DROP TABLE quiet_followup_marks');
  const hung=clients({thread:quiet});hung.pd.getLead=vi.fn(()=>new Promise(()=>{}));
  expect(await runQuietConversationClock(db.pool,{...hung,now,timeoutMs:50})).toMatchObject({created:0,failed:1});
  // a timed-out task create is never retried (Pipedrive may have made it): no second copy
  await db.pool.query('DROP TABLE quiet_followup_marks');
  const slow=clients({thread:quiet});slow.pd.addActivity=vi.fn(()=>new Promise(()=>{}));
  expect(await runQuietConversationClock(db.pool,{...slow,now,timeoutMs:50})).toMatchObject({failed:1});
  const again=clients({thread:quiet});
  expect(await runQuietConversationClock(db.pool,{...again,now})).toMatchObject({created:0});
  expect(again.pd.addActivity).not.toHaveBeenCalled();
 });

 it('A1.8 a Gmail quota refusal stops further thread reads for the rest of the run',async()=>{
  await lead('a');await lead('b');
  const c=clients();c.getThread.mockRejectedValue(new Error("Gmail GET /threads/x?format=full → 403: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"));
  await runQuietConversationClock(db.pool,{...c,now});
  expect(c.getThread).toHaveBeenCalledTimes(1);
 });

 it('A1.5 records when its own task is marked done or removed in Pipedrive',async()=>{
  await lead('a');
  await db.pool.query(marksTable);
  await db.pool.query(`INSERT INTO quiet_followup_marks VALUES('a','k1','nudge1','created','900',NOW()),('a','k2','nudge1','created','901',NOW()),('a','k3','nudge1','created','902',NOW())`);
  const c=clients({activities:[{id:900,done:true,marked_as_done_time:'2026-10-22 14:00:00'},{id:901,done:false}]});
  await runQuietConversationClock(db.pool,{...c,onlyLeads:['none'],now});
  const {rows}=await db.pool.query(`SELECT activity_id,task_state,task_done_at FROM quiet_followup_marks ORDER BY activity_id`);
  expect(rows.map(r=>[r.activity_id,r.task_state])).toEqual([['900','done'],['901','open'],['902','done']]);
  expect(rows[0].task_done_at.toISOString()).toBe('2026-10-22T14:00:00.000Z');
 });
});

describe('A1.2 quote cleaning (live notes 38544, 38551, 38552)',()=>{
 it('drops the signature block with phones and address',()=>{
  const t='As soon as I know something I will let you know.\n\nIf you have any questions, please feel free to contact me.\n\nVickie Guy\nProposal / Purchasing Consultant\n\n1900 NE 36th Street, Suite 106\nOklahoma City, OK 73111\nOffice: 405-555-0100 Ext. 211 | Cell: 405-555-0101 | Fax: 405-555-0102\nEmail: v@buyer.test';
  expect(cleanQuote(t)).toBe('As soon as I know something I will let you know.\n\nIf you have any questions, please feel free to contact me.');
 });
 it('stops at the sign-off and drops tel:/mailto:/link fragments and image placeholders',()=>{
  const t='Derek,\n\nWe are still working through the quotes.\n\nThanks,\n\n[Southern Brothers Construction]\nBen Warren\nEstimator\nO\n479-555-0100&lt;tel:+14795550100&gt;\nE\nb@buyer.test&lt;mailto:b@buyer.test&gt;\nCONFIDENTIALITY NOTICE: This email is confidential.';
  expect(cleanQuote(t)).toBe('Derek,\n\nWe are still working through the quotes.\n\nThanks,');
  expect(cleanQuote('See plans [cid:bb8bb21a-2608] here <https://x.test/a?d=1>')).toBe('See plans  here');
 });
 it('cuts quoted history flattened onto one line, and never double-escapes',()=>{
  const t='Hello, I appreciate that. What was your quote for again? Thanks, Sent from my iPhone On Sep 17, 2026, at 9:26 AM, Pro SWPPP &lt;dc@proswppp.co&gt; wrote\nHey Soran,\nWe sent you a bid';
  expect(cleanQuote(t)).toBe('Hello, I appreciate that. What was your quote for again? Thanks,');
  const note=taskNote({step:'nudge1',draft:'Hey A,\n\nOk.',lastBuyerText:'Is 5 &lt; 6?',lastBuyerAt:d('2026-10-09T15:00:00Z')});
  expect(note).toContain('Is 5 &lt; 6?');
  expect(note).not.toContain('&amp;lt;');
 });
 it('never cuts the buyer\'s first line as signature, and stops at an Outlook "*From:*" header (live: Lyons Rd, Vicksburg)',()=>{
  expect(cleanQuote('Has not bid yet \n\n\nRudy Polselli \nHeavy Civil Division Manager\nAll County Paving \n561-555-0100\n\n-----------')).toBe('Has not bid yet');
  expect(cleanQuote('Cameron,\n\nDid you send me an estimate?\n\nGPH\n\n*From:* Pro SWPPP <pm@proswppp.co>\n*Sent:* Friday, October 16, 2026 8:23 AM\n\nGary,\nSaw y\'all were low')).toBe('Cameron,\n\nDid you send me an estimate?\n\nGPH');
 });
 it('keeps the quote visibly apart from the ready-to-send text',()=>{
  const note=taskNote({step:'nudge1',draft:'Hey A,\n\nChecking in.',lastBuyerText:'What number?',lastBuyerAt:d('2026-10-09T15:00:00Z')});
  expect(note).toMatch(/<b>THEIR LAST MESSAGE<\/b>[^]*<i>What number\?<\/i>[^]*<p>_{10,}<\/p><p><b>READY TO SEND<\/b>/);
 });
 it('matches a project only when the subject clearly names it',()=>{
  expect(projectMatch('Re: 1433 Catalpa St WM Installation SWPPP','1433 Catalpa St WM Installation')).toBe('strong');
  expect(projectMatch('Dawn Aerospace Hangar & Office SWPPP','Dawn Aerospace Hangar & Ofc')).toBe('strong');
  expect(projectMatch('RE: Guymon Maintenance Facility','Guymon Maint Fac')).toBe('strong');
  expect(projectMatch('Re: Boise City Terminal Building','Vinita Terminal Bldg')).toBe('weak');
  expect(projectMatch('Box Hangars Poteau OK','6M2 Hangar')).toBe('weak');
  expect(projectMatch('Riverbend 2026 Landscape Project','Cow Pond Brook Fields Imp')).toBeNull();
 });
});
