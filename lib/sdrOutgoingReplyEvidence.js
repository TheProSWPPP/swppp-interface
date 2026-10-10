const KIND='gmail_reply_header_v1',EDGE='gmail_reply_edge_v1',MAX_ID=255,MAX_EDGES=4,MAX_ENTRIES=16;
const rfc=value=>typeof value==='string'&&value.length<=MAX_ID&&/^<[^\s<>,@]+@[^\s<>,@]+>$/.test(value)?value:null;
const key=value=>typeof value==='string'&&value.length>0&&value.length<=MAX_ID?value:null;
const email=value=>{
  if(typeof value!=='string'||value.length>320||value.includes(',')) return null;
  const bare=value.trim();const match=/^(?:[^<>,]{0,100}<([^\s<>@,]+@[^\s<>@,]+)>|([^\s<>@,]+@[^\s<>@,]+))$/.exec(bare);
  return match?(match[1]||match[2]).toLowerCase():null;
};
const stamp=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return null;
  const date=new Date(value);
  if(!Number.isFinite(+date)||+date<=0) return null;
  const iso=date.toISOString();return value===iso||value===iso.replace('.000Z','Z')?iso:null;
};
const invalid=reason=>({kind:KIND,status:'invalid',reason});
export function summarizeGmailHeaders(headers,threadId) {
  if(!Array.isArray(headers)||headers.length>100) return {valid:false,reason:'malformed_header',threadId:key(threadId)};
  const found={};
  for(const h of headers) {
    const name=String(h?.name||'').toLowerCase();
    if(!['message-id','in-reply-to','from','to'].includes(name)) continue;
    if(Object.hasOwn(found,name)) return {valid:false,reason:'duplicate_header',threadId:key(threadId)};
    found[name]=h?.value;
  }
  const messageId=rfc(found['message-id']),parentId=found['in-reply-to']==null?null:rfc(found['in-reply-to']);
  const from=email(found.from),to=email(found.to);
  if(!key(threadId)||!messageId||found['in-reply-to']!=null&&!parentId||!from||!to) return {valid:false,reason:'malformed_header',threadId:key(threadId)};
  return {valid:true,threadId,messageId,parentId,from,to};
}
function observation(m,threadId,mailbox) {
  const h=m.headerEvidence;
  if(!h) return [invalid('missing_summary')];
  if(h.valid===false) return [invalid(h.reason==='duplicate_header'?'duplicate_header':'malformed_header')];
  const at=stamp(m.receivedAt),id=key(m.id);
  if(!id||!key(threadId)||h.threadId!==threadId||!rfc(h.messageId)||h.messageId!==m.messageId||!at||
    typeof m.lastOutbound!=='boolean'||!email(h.from)||!email(h.to)||
    (m.lastOutbound?(!rfc(h.parentId)||h.from!==mailbox||h.to===mailbox):h.from===mailbox||h.to!==mailbox)) return [invalid('invalid_message')];
  return [{kind:KIND,status:'valid',messageId:h.messageId,parentId:h.parentId||null,threadId,from:h.from,to:h.to,at,direction:m.lastOutbound?'out':'in'}];
}
export function threadReplyEvidence(thread,mailbox) {
  const account=email(mailbox),byId=new Map(),parents=new Map();
  const counts=new Map();for(const m of thread.messages||[]) counts.set(m.id,(counts.get(m.id)||0)+1);
  for(const m of thread.messages||[]) {
    const entries=counts.get(m.id)>1?[invalid('duplicate_message')]:account?observation(m,thread.id,account):[];
    byId.set(m.id,entries);
    const h=entries[0];
    if(h?.status==='valid'&&h.direction==='in') {
      const list=parents.get(h.messageId)||[];if(list.length<2) list.push({m,h});parents.set(h.messageId,list);
    }
  }
  const edges=new Map();
  for(const m of thread.messages||[]) {
    const h=byId.get(m.id)?.[0];
    if(h?.status!=='valid'||h.direction!=='out') continue;
    const matches=parents.get(h.parentId)||[];
    if(matches.length!==1) {if(matches.length>1) byId.set(m.id,[invalid('duplicate_parent')]);continue;}
    const parent=matches[0];
    if(parent.m.id===m.id||h.to!==parent.h.from||+new Date(h.at)<=+new Date(parent.h.at)) continue;
    const edge={kind:EDGE,inboundId:parent.m.id,outboundId:m.id,inboundMessageId:parent.h.messageId,outboundMessageId:h.messageId,threadId:thread.id,at:h.at};
    const list=edges.get(parent.m.id)||[];if(list.length<=MAX_EDGES) list.push(edge);edges.set(parent.m.id,list);
  }
  for(const [id,list] of edges) byId.set(id,[...(byId.get(id)||[]),...(list.length>MAX_EDGES?[invalid('edge_overflow')]:list)]);
  return byId;
}
const entries=(row,kind)=>Array.isArray(row?.source_evidence)&&row.source_evidence.length<=MAX_ENTRIES?row.source_evidence.filter(e=>e?.kind===kind):[];
function header(row,direction,mailbox) {
  const list=entries(row,KIND);if(list.length!==1||list[0].status!=='valid') return null;
  const h=list[0],at=stamp(h.at),dbAt=row.occurred_at&&new Date(row.occurred_at).toISOString();
  if(!at||at!==dbAt||h.threadId!==row.provider_thread_id||h.messageId!==row.internet_message_id||h.direction!==direction||row.direction!==direction||
    h.from!==email(row.from_address)||!Array.isArray(row.to_addresses)||row.to_addresses.length!==1||h.to!==email(row.to_addresses[0])||
    (direction==='out'&&(!rfc(h.parentId)||h.from!==mailbox))||(direction==='in'&&(!rfc(h.messageId)||h.from===mailbox||h.to!==mailbox))) return null;
  return h;
}
export function outgoingCandidates(reply,inbound) {
  if(reply.source!=='gmail'||!key(reply.sourceMessageId)||!key(reply.threadId)||!rfc(reply.id?.startsWith('rfc822:')?reply.id.slice(7):null)||
    !inbound||inbound.account_key!==reply.mailbox||inbound.provider_message_id!==reply.sourceMessageId||inbound.provider_thread_id!==reply.threadId) return [];
  const h=header(inbound,'in',reply.mailbox),edges=entries(inbound,EDGE);
  if(!h||h.messageId!==reply.id.slice(7)||edges.length>MAX_EDGES||!edges.length) return [];
  const ids=new Set();
  for(const e of edges) {
    if(!key(e.outboundId)||!rfc(e.outboundMessageId)||e.inboundId!==reply.sourceMessageId||e.inboundMessageId!==h.messageId||e.threadId!==reply.threadId||!stamp(e.at)||ids.has(e.outboundId)) return [];
    ids.add(e.outboundId);
  }
  return edges;
}
export function resolveOutgoingReply(reply,inbound,outboundRows) {
  const edges=outgoingCandidates(reply,inbound);if(!edges.length) return null;
  const parent=header(inbound,'in',reply.mailbox),matches=[];
  for(const edge of edges) {
    const row=outboundRows.get(`${reply.mailbox}\0${edge.outboundId}`),h=header(row,'out',reply.mailbox);
    if(!h||row.provider_thread_id!==reply.threadId||h.parentId!==parent.messageId||h.messageId!==edge.outboundMessageId||h.to!==parent.from||h.at!==edge.at||+new Date(h.at)<=+new Date(parent.at)) return null;
    matches.push({id:edge.outboundId,at:h.at});
  }
  matches.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  return {status:'observed',source:'connected_gmail',authorship:'unknown',providerMessageId:matches[0].id,at:matches[0].at,coverage:'partial'};
}
