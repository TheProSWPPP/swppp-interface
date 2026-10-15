import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {recentReplyEmails,hasRecentReply} from '../recentReply.js';
const db=reportingTestDb('recent_reply');
describe.skipIf(!db)('recent human replies',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_inbox_reply_log(gmail_message_id text PRIMARY KEY,from_addr text,created_at timestamptz DEFAULT NOW());
  CREATE TABLE sdr_message_facts(provider text,provider_message_id text,direction text,prospect_email text,human_reply boolean,occurred_at timestamptz)`);});
 afterAll(()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_inbox_reply_log,sdr_message_facts');
  await db.pool.query(`INSERT INTO sdr_inbox_reply_log VALUES('1','Bill <Bill@GC.test>',NOW()),('2','[bounce] mailer <gone@gc.test>',NOW()),('3','old@gc.test',NOW()-INTERVAL '200 days')`);
  await db.pool.query(`INSERT INTO sdr_message_facts VALUES('gmail','a','in','fact@gc.test',true,NOW()),('gmail','b','in','auto@gc.test',false,NOW()),('gmail','c','out','sent@gc.test',NULL,NOW())`);});
 it('lists human repliers from both sources in the window',async()=>{expect([...await recentReplyEmails(db.pool)].sort()).toEqual(['bill@gc.test','fact@gc.test']);});
 it.each([[' BILL@gc.test ',true],['fact@gc.test',true],['gone@gc.test',false],['old@gc.test',false],['auto@gc.test',false],['sent@gc.test',false],['',false],[null,false]])('checks %j -> %s',async(email,expected)=>{expect(await hasRecentReply(db.pool,email)).toBe(expected);});
});
