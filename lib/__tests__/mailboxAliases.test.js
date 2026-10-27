import {describe,expect,it,vi} from 'vitest';
import {canonicalMailbox,MAILBOX_ALIASES} from '../mailboxAliases.js';
import {observeOutbound} from '../sdrReportingIngest.js';
import {recordCompletedOutreach} from '../sdrEngagementReceipts.js';

// 2026-10-27: admin@proswppp.co became mf@proswppp.co (Michael Forster). Apollo keeps reporting
// the old address for people already in a sequence; it must land on the moved mailbox.
describe('moved mailbox addresses',()=>{
 it('resolves the former address, case and spacing aside, and leaves others alone',()=>{
  expect(MAILBOX_ALIASES).toEqual({'admin@proswppp.co':'mf@proswppp.co'});
  expect(canonicalMailbox(' Admin@ProSWPPP.co ')).toBe('mf@proswppp.co');
  expect(canonicalMailbox('mf@proswppp.co')).toBe('mf@proswppp.co');
  expect(canonicalMailbox('jg@proswppp.co')).toBe('jg@proswppp.co');
  expect(canonicalMailbox('admin@proswppp.com')).toBe('admin@proswppp.com');
  expect(canonicalMailbox(null)).toBe('');
 });
 it('records an Apollo message sent from the former address under the moved mailbox',async()=>{
  const pool={query:vi.fn(async()=>({rows:[{inserted:true}]}))};
  await observeOutbound(pool,{id:'m1',from_email:'admin@proswppp.co',to_email:'buyer@example.test',campaign_position:2,completed_at:'2026-10-27T12:00:00Z',status:'completed'});
  expect(pool.query.mock.calls[0][1][3]).toBe('mf@proswppp.co');
 });
 it('credits a completed send from the former address to the moved mailbox in the outreach ledger',async()=>{
  const queries=[];
  const db={query:vi.fn(async(sql,params)=>{queries.push([sql,params]);
   if(/FROM sdr_engagement_events/.test(sql))return {rows:[{event_type:'email_sent',apollo_emailer_message_id:'m1',payload:{completed_at:'2026-10-27T12:00:00Z',email_account:{email:'admin@proswppp.co'},email:'buyer@example.test',sequence_id:'seq'}}]};
   return {rows:[]};})};
  expect(await recordCompletedOutreach(db,{eventId:'e1',sendRow:{pipedrive_lead_id:'lead',apollo_sequence_id:'seq',contact_email_snapshot:'buyer@example.test'},sendMatch:'message_id'})).toMatchObject({recorded:true});
  const insert=queries.find(([sql])=>/INSERT INTO sdr_outreach_log/.test(sql));
  expect(insert[1]).toContain('mf@proswppp.co');
 });
});
