import {afterEach, describe, expect, it, vi} from 'vitest';
import {getThread} from '../gmailInbox.js';
import {composeSafeForward} from '../sdrForwardingSafety.js';

afterEach(() => vi.unstubAllGlobals());
const encoded = text => Buffer.from(text).toString('base64url');
const headers = [
  {name:'From',value:'Buyer <buyer@outside.test>'}, {name:'To',value:'rep@proswppp.co'},
  {name:'Subject',value:'Re: Site plan'}, {name:'Date',value:'Sun, 11 Oct 2026 10:00:00 +0000'},
  {name:'Message-ID',value:'<buyer-one@outside.test>'}, {name:'In-Reply-To',value:'<rep-one@proswppp.co>'},
  {name:'References',value:'<rep-one@proswppp.co>'},
];
const raw = (extra=[], payload={mimeType:'text/plain',body:{data:encoded('Please send the site plan.')}}) => ({
  id:'gmail-one',threadId:'thread-one',internalDate:'1791712800000',labelIds:['INBOX'],
  payload:{...payload,headers:[...headers,...extra]},
});
async function source(message) {
  vi.stubGlobal('fetch',async()=>({ok:true,json:async()=>({messages:[message]})}));
  return (await getThread('token','thread-one')).messages[0];
}
const compose = message => composeSafeForward({source:message,mailbox:'rep@proswppp.co',forwardTo:'rep@proswppp.com',actionId:'action-one',threadId:'thread-one'});

describe('Gmail-derived forward safety',()=>{
  it('uses one source sender and preserves legal repeated trace headers',async()=>{
    const msg=await source(raw([{name:'Received',value:'by mx-a'},{name:'Received',value:'by mx-b'},
      {name:'Content-Type',value:'text/plain; charset=UTF-8'}]));
    expect(msg.routingHeaders.filter(h=>h.name==='received')).toHaveLength(2);
    expect(compose(msg)).toMatchObject({mode:'reply',from:'rep@proswppp.co',to:'rep@proswppp.com',replyTo:'buyer@outside.test',subject:'Re: Site plan',inReplyTo:'<buyer-one@outside.test>'});
  });
  it.each([
    ['different Reply-To',[{name:'Reply-To',value:'other@outside.test'}]],
    ['repeated From',[{name:'From',value:'Other <other@outside.test>'}]],
    ['external Cc',[{name:'Cc',value:'observer@outside.test'}]],
    ['delegated sender',[{name:'Sender',value:'delegate@outside.test'}]],
    ['header control',[{name:'Reply-To',value:'buyer@outside.test\r\nBcc: x@outside.test'}]],
  ])('reviews %s without buyer reply routing',async(_label,extra)=>{
    const forward=compose(await source(raw(extra)));
    expect(forward.mode).toBe('review');
    expect(forward.replyTo).toBeUndefined();
    expect(forward.bodyText).toContain('Reply stays internal');
    expect(forward.bodyText).toContain('https://mail.google.com/mail/?authuser=rep%40proswppp.co#all/thread-one');
  });
  it.each([
    ['attachment',{mimeType:'multipart/mixed',parts:[{mimeType:'text/plain',body:{data:encoded('Hello')}},{mimeType:'application/pdf',filename:'plan.pdf',body:{attachmentId:'att-one',size:42}}]}],
    ['inline image',{mimeType:'multipart/related',parts:[{mimeType:'text/plain',body:{data:encoded('Hello')}},{mimeType:'image/png',body:{attachmentId:'cid-one',size:12},headers:[{name:'Content-ID',value:'<image-one>'}]}]}],
    ['missing body',{mimeType:'text/plain',body:{size:12}}],
    ['HTML only',{mimeType:'text/html',body:{data:encoded('<p>Hello</p>')}}],
    ['nested extra plain part',{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:encoded('Hello')}},
      {mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:encoded('Hidden second body')}}]}]}],
    ['malformed leaf children',{mimeType:'text/plain',body:{data:encoded('Hello')},parts:[{mimeType:'application/pdf',filename:'hidden.pdf',body:{attachmentId:'a'}}]}],
    ['disposition-only attachment',{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:encoded('Hello')},headers:[{name:'Content-Disposition',value:'attachment'}]}]}],
    ['CID-only inline part',{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:encoded('Hello')},headers:[{name:'Content-ID',value:'<inline-one>'}]}]}],
  ])('reviews %s and reports source availability',async(_label,payload)=>{
    const msg=await source(raw([],payload));
    expect(msg.mimeAudit.complete).toBe(false);
    const forward=compose(msg);
    expect(forward.mode).toBe('review');
    expect(forward.bodyText).toContain('Source thread: thread-one');
  });
  it('does not expose entity-obfuscated internal guidance in a reply-capable notification',async()=>{
    const msg=await source(raw([],{mimeType:'text/plain',body:{data:encoded('Yes. [SDR&#32;reply&#32;action secret]')}}));
    const forward=compose(msg);
    expect(forward.mode).toBe('review');
    expect(forward.replyTo).toBeUndefined();
  });
  it('reviews a routing header whose value exceeds the bounded Gmail evidence',async()=>{
    const forward=compose(await source(raw([{name:'X-Long',value:'a'.repeat(2050)}])));
    expect(forward.mode).toBe('review');
  });
  it('reviews missing Date and repeated References rather than treating either as absent',async()=>{
    const noDate=raw();noDate.payload.headers=noDate.payload.headers.filter(h=>h.name!=='Date');
    expect(compose(await source(noDate)).mode).toBe('review');
    expect(compose(await source(raw([{name:'References',value:'<other@outside.test>'}]))).mode).toBe('review');
  });
  it('reviews malformed present References and automated/list transport headers',async()=>{
    expect(compose(await source(raw([{name:'References',value:'<one@outside.test>\r\nBcc: x@outside.test'}]))).mode).toBe('review');
    expect(compose(await source(raw([{name:'List-Post',value:'<mailto:list@outside.test>'}]))).mode).toBe('review');
    expect(compose(await source(raw([{name:'X-Autoreply',value:'yes'}]))).mode).toBe('review');
    expect(compose(await source(raw([{name:'X-Autorespond',value:'yes'}]))).mode).toBe('review');
  });
  it('audits root Content-Disposition and Content-ID without filename or attachmentId',async()=>{
    for(const [name,value] of [['Content-Disposition','attachment'],['Content-ID','<inline-one>']]) {
      const msg=await source(raw([{name,value}]));
      expect(msg.mimeAudit.complete).toBe(false);
      expect(compose(msg).replyTo).toBeUndefined();
    }
  });
  it('accepts one complete multipart alternative and identical Reply-To',async()=>{
    const msg=await source(raw([{name:'Reply-To',value:'buyer@outside.test'}],{mimeType:'multipart/alternative',parts:[
      {mimeType:'text/plain',body:{data:encoded('Please send the plan.')}},
      {mimeType:'text/html',body:{data:encoded('<p>Please send the plan.</p>')}},
    ]}));
    expect(msg.mimeAudit.complete).toBe(true);
    expect(compose(msg).mode).toBe('reply');
  });
});
