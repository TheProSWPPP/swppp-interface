import {describe,it,expect} from 'vitest';
import {resolveReplyProject} from '../sdrReplyContext.js';

// A pool with no message facts or CRM conversation rows: only our own send records.
function fakePool(drafts) {
  const calls=[];
  return {calls,async query(sql,params) {
    calls.push(sql);
    if(sql.includes('to_regclass')) return {rows:[{name:['sdr_drafts','sdr_mailboxes'].includes(params[0]) ? params[0] : null}]};
    if(sql.includes('FROM sdr_drafts')) {
      const [mailbox,recipients,receivedAt]=params;
      return {rows:drafts.filter(d=>d.mailbox===mailbox.toLowerCase() && recipients.includes(d.email) && +new Date(d.sent_at)<=+new Date(receivedAt))
        .map(d=>({id:d.id,pipedrive_lead_id:d.lead,subject:d.subject}))};
    }
    throw new Error(`unexpected query ${sql}`);
  }};
}
const mailbox='dc@proswppp.co';
const out=(over={})=>({id:'g-out',messageId:'<out@apollo.test>',from:`Dan <${mailbox}>`,to:'Bill <bill@gc.test>',subject:'East Regional FM SWPPP',receivedAt:'2026-10-01T15:00:00Z',lastOutbound:true,...over});
const reply=(over={})=>({id:'g-in',messageId:'<in@gc.test>',from:'Bill <bill@gc.test>',to:mailbox,subject:'Re: East Regional FM SWPPP',receivedAt:'2026-10-05T15:00:00Z',...over});
const draft=(over={})=>({id:'d1',lead:'lead-east',mailbox,email:'bill@gc.test',subject:'East Regional FM SWPPP',sent_at:'2026-10-01T14:59:00Z',...over});
const resolve=(pool,{thread,message,candidates=[{pipedrive_lead_id:'lead-east'},{pipedrive_lead_id:'lead-other'}]})=>
  resolveReplyProject(pool,{mailbox,thread,message,candidates});

describe('reply linked through our own sent draft',()=>{
  it('links a reply from a person with two projects to the one this mailbox emailed',async()=>{
    const pool=fakePool([draft(),draft({id:'d9',lead:'lead-other',mailbox:'jg@proswppp.co'})]);
    const r=await resolve(pool,{thread:{id:'t1',messages:[out(),reply()]},message:reply()});
    expect(r).toEqual({status:'verified',leadId:'lead-east',evidence:'gmail-thread:t1:outbound-message:g-out:sent-draft:d1'});
  });

  it('links the same way when re-checked later without candidates',async()=>{
    const r=await resolveReplyProject(fakePool([draft()]),{mailbox,thread:{id:'t1',messages:[out(),reply()]},message:reply()});
    expect(r).toMatchObject({status:'verified',leadId:'lead-east'});
  });

  it('narrows two projects from the same mailbox by the exact subject',async()=>{
    const pool=fakePool([draft(),draft({id:'d2',lead:'lead-other',subject:'Settlers Park Ph 2 SWPPP'})]);
    expect(await resolve(pool,{thread:{id:'t1',messages:[out(),reply()]},message:reply()})).toMatchObject({status:'verified',leadId:'lead-east'});
  });

  it('stays ambiguous when two projects from the same mailbox share the subject',async()=>{
    const pool=fakePool([draft(),draft({id:'d2',lead:'lead-other'})]);
    expect(await resolve(pool,{thread:{id:'t1',messages:[out(),reply()]},message:reply()})).toMatchObject({status:'ambiguous'});
  });

  it.each([
    ['a different subject, such as a bounce notice',{message:{subject:'Delivery Status Notification (Failure)'}}],
    ['no outbound earlier in the thread',{thread:'reply-only'}],
    ['a draft sent after the reply arrived',{draft:{sent_at:'2026-10-06T00:00:00Z'}}],
    ['a draft sent from another mailbox',{draft:{mailbox:'jg@proswppp.co'}}],
    ['a draft to a different person',{draft:{email:'someone@gc.test'}}],
  ])('does not link on %s',async(_,change)=>{
    const message=reply(change.message);
    const thread={id:'t1',messages:change.thread==='reply-only' ? [message] : [out(),message]};
    expect(await resolve(fakePool([draft(change.draft)]),{thread,message})).toMatchObject({status:'ambiguous'});
  });
});

describe('returned email linked through our own sent draft',()=>{
  const ndr=(subject)=>({id:'g-ndr',messageId:'<ndr@mail.test>',from:'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',to:mailbox,subject,receivedAt:'2026-10-05T15:00:00Z'});
  it('links a delivery failure to the project the returned outbound was about',async()=>{
    const message=ndr('Delivery Status Notification (Failure)');
    expect(await resolveReplyProject(fakePool([draft()]),{mailbox,thread:{id:'t1',messages:[out(),message]},message})).toMatchObject({status:'verified',leadId:'lead-east'});
  });
  it('keeps a delay notice held',async()=>{
    const message=ndr('Delivery Status Notification (Delay)');
    expect(await resolveReplyProject(fakePool([draft()]),{mailbox,thread:{id:'t1',messages:[out(),message]},message})).toMatchObject({status:'unlinked'});
  });
});
