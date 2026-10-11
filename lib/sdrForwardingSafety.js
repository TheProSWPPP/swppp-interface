import {createHash} from 'node:crypto';

const CONTROL = /[\r\n\x00-\x1f\x7f]/;
const ID = /^<[^\s<>@]{1,200}@[^\s<>@]{1,200}>$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const forwardAddress = value => {
  if (!value || CONTROL.test(value)) return null;
  const text=String(value).trim();
  const match=text.match(/^(?:[^<>;,]*<)?([^\s<>;,]+@[^\s<>;,]+)>?$/);
  return match && EMAIL.test(match[1]) ? match[1].toLowerCase() : null;
};
const singleAddress=forwardAddress;
const values=(source,name)=>(source.routingHeaders || []).filter(h=>h.name===name).map(h=>h.value);
const one=(source,name)=>{ const found=values(source,name); return found.length===1 && !CONTROL.test(found[0]) ? found[0] : null; };
export const forwardDigest=value=>createHash('sha256').update(String(value).replace(/\r\n?/g,'\n')).digest('hex');
const decodeEntities=text=>String(text || '').replace(/&#(x[0-9a-f]+|\d+);?/gi,(_,n)=>{
  const point=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);
  return Number.isInteger(point) && point>=0 && point<=0x10ffff ? String.fromCodePoint(point) : ' ';
})
  .replace(/&(?:nbsp|#32);/gi,' ').replace(/&(?:amp|#38);/gi,'&').replace(/&(?:lt|#60);/gi,'<').replace(/&(?:gt|#62);/gi,'>');
const internalMarker=text=>/\[sdr\s+reply\s+action|open\s+in\s+(?:sdr\s+)?interface|pipedrive\.com|project\s+match\s+needs\s+review|ai\s+suggestion|internal\s+(?:note|intent|action)|proswppp-interface/i.test(decodeEntities(text));
const safeId=value=>ID.test(String(value || '')) ? value : null;

export function composeSafeForward({source,mailbox,forwardTo,actionId,threadId}) {
  const from=singleAddress(mailbox),to=singleAddress(forwardTo);
  if (!from || !to || !from.endsWith('@proswppp.co') || !to.endsWith('@proswppp.com') || !/^[a-zA-Z0-9_-]{1,200}$/.test(actionId) || !/^[a-zA-Z0-9_-]{1,200}$/.test(threadId)) throw new Error('invalid_forward_route');
  const headers=source?.routingHeaders || [];
  const buyer=singleAddress(one(source,'from'));
  const replyValues=values(source,'reply-to');
  const reply=replyValues.length===0 ? buyer : replyValues.length===1 ? singleAddress(replyValues[0]) : null;
  const parent=one(source,'message-id');
  const referenceValues=values(source,'references');
  const refs=one(source,'references');
  const subject=one(source,'subject');
  const date=one(source,'date');
  const accepted=!!(source?.id && /^[a-zA-Z0-9_-]{1,200}$/.test(source.id)
    && source.receivedAt && Number.isFinite(+new Date(source.receivedAt)) && date && Number.isFinite(+new Date(date))
    && source.mimeAudit?.complete && !source.routingHeadersTruncated && headers.length
    && buyer && reply===buyer && !buyer.endsWith('@proswppp.co') && !buyer.endsWith('@proswppp.com')
    && singleAddress(one(source,'to'))===from && !values(source,'cc').length && !values(source,'bcc').length
    && !['sender','resent-from','resent-to','resent-sender','list-id','list-unsubscribe','auto-submitted','precedence','x-google-original-from'].some(name=>values(source,name).length)
    && safeId(parent) && referenceValues.length<=1 && (!refs || /^<[^\s<>@]+@[^\s<>@]+>(?:\s+<[^\s<>@]+@[^\s<>@]+>)*$/.test(refs))
    && values(source,'in-reply-to').length<=1 && (!values(source,'in-reply-to').length || safeId(one(source,'in-reply-to')))
    && values(source,'content-type').length<=1
    && subject && !CONTROL.test(subject) && !internalMarker([...headers.map(h=>h.value),source.body,source.html].join(' ')));
  const messageId=`<sdr-action-${actionId}@proswppp.co>`;
  if (accepted) {
    const bodyText=`Buyer message received ${date}\nFrom: ${one(source,'from')}\nSubject: ${subject}\n\n${source.body}`;
    return {mode:'reply',from,to,replyTo:buyer,subject,bodyText,messageId,inReplyTo:parent,
      references:[refs,parent].filter(Boolean).join(' '),sourceMessageId:source.id,sourceThreadId:threadId,sourceReceivedAt:source.receivedAt,
      bodyDigest:forwardDigest(bodyText)};
  }
  const availability=source?.mimeAudit?.issues?.length ? `Source may contain parts not included here: ${source.mimeAudit.issues.join(', ')}.` : 'Source content or routing needs review.';
  const excerpt=source?.body ? `\n\nAvailable plain-text preview${source.body.length>4000?' (truncated)':''}:\n${source.body.slice(0,4000)}` : '';
  const bodyText=`Internal review required. Reply stays internal; open the original source before responding to the buyer.\nOpen source in Gmail: https://mail.google.com/mail/u/0/#all/${threadId}\nSource thread: ${threadId}\nSource message: ${source?.id || 'unavailable'}\n${availability}${excerpt}`;
  return {mode:'review',from,to,subject:'Buyer reply requires internal review',bodyText,messageId,
    sourceMessageId:source?.id || null,sourceThreadId:threadId,sourceReceivedAt:source?.receivedAt || null,bodyDigest:forwardDigest(bodyText)};
}
