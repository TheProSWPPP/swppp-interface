const failure=(code,status)=>Object.assign(new Error(code),{code,status});
const providerId=id=>{if(typeof id!=='string'||!/^ACo[A-Za-z0-9_-]+$/.test(id))throw failure('classic_recipient_required');return id};
export function createLinkedinClient({baseUrl,apiKey,accountId,transport=fetch,allowWrites=false,allowHostedAuth=false}){
 if(!/^https:\/\//.test(baseUrl||'')||!baseUrl.endsWith('/api/v1')||!apiKey||!accountId)throw failure('client_unconfigured');
 const bound=given=>{if(given&&given!==accountId)throw failure('account_mismatch')};
 async function request(method,path,{query={},body,form=false,write=false}={}){
  if(write&&!allowWrites)throw failure('writes_disabled');bound(query.account_id);if(body&&!form)bound(body.account_id);
  const url=new URL(baseUrl+path);for(const [k,v] of Object.entries(query))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));
  const headers={'X-API-KEY':apiKey,Accept:'application/json'};if(body&&!form)headers['Content-Type']='application/json';
  let response;try{response=await transport(url,{method,headers,body:form?body:body?JSON.stringify(body):undefined})}catch(error){if(write)return {outcome:'unknown',reason:'network'};throw failure('read_unavailable')}
  if(!response?.ok){if(write&&(!response||response.status>=500||response.status===429))return {outcome:'unknown',status:response?.status};throw failure(response?.status===401||response?.status===403?'authentication':response?.status===429?'rate_limit':'provider_rejected',response?.status)}
  let data;try{data=await response.json()}catch{if(write)return {outcome:'unknown',reason:'invalid_receipt'};throw failure('invalid_result')}
  if(!data||typeof data!=='object'||Array.isArray(data))throw failure('invalid_result');if(data.account_id&&data.account_id!==accountId)throw failure('account_mismatch');
  if(write){const providerId=data.id||data.message_id||null;if(!providerId)return {outcome:'unknown',reason:'missing_provider_id'};return {outcome:'confirmed',providerId,chatId:data.chat_id||null,receipt:data}}
  return data;
 }
 const get=(path,query={})=>request('GET',path,{query:{...query,account_id:accountId}});
 const list=async(path,{limit=100,maxPages=3}={})=>{let cursor,items=[],complete=false;const seen=new Set();for(let page=0;page<maxPages;page++){const data=await get(path,{limit,cursor});if(!Array.isArray(data.items))throw failure('invalid_result');items.push(...data.items);if(!data.cursor){complete=true;break}if(seen.has(data.cursor))throw failure('pagination_frozen');seen.add(data.cursor);cursor=data.cursor}return {items,complete,cursor:complete?null:cursor}};
 const form=(fields)=>{const data=new FormData();for(const [k,v] of Object.entries(fields))data.append(k,v);return data};
 return {accountId,
  hostedReconnect:async({notifyUrl,name,expiresOn})=>{if(!allowHostedAuth)throw failure('hosted_auth_disabled');if(!/^https:\/\//.test(notifyUrl||'')||!name||!expiresOn)throw failure('hosted_auth_unconfigured');const data=await request('POST','/hosted/accounts/link',{body:{type:'reconnect',reconnect_account:accountId,api_url:baseUrl.slice(0,-7),expiresOn,notify_url:notifyUrl,name}});if(!/^https:\/\//.test(data.url||''))throw failure('hosted_link_invalid');return data.url},
  getAccount:async()=>{const account=await request('GET',`/accounts/${encodeURIComponent(accountId)}`);if(account.id!==accountId)throw failure('account_mismatch');return account},getSelf:()=>get('/users/me'),
  getProfile:({identifier,accountId:given}={})=>{bound(given);if(!identifier)throw failure('identifier_required');return get(`/users/${encodeURIComponent(identifier)}`)},
  listSentInvites:options=>list('/users/invite/sent',options),listRelations:options=>list('/users/relations',options),
  findChats:({attendeeId,accountId:given,maxPages=2})=>{bound(given);return list(`/chat_attendees/${encodeURIComponent(attendeeId)}/chats`,{maxPages})},
  getChat:({chatId,accountId:given})=>{bound(given);return get(`/chats/${encodeURIComponent(chatId)}`)},
  listMessages:({chatId,...options})=>list(`/chats/${encodeURIComponent(chatId)}/messages`,options),
  invite:({providerId:recipient,message,accountId:given})=>{bound(given);const body={account_id:accountId,provider_id:providerId(recipient)};if(message)body.message=message;return request('POST','/users/invite',{body,write:true})},
  sendFirst:({providerId:recipient,text,accountId:given})=>{bound(given);if(!text?.trim())throw failure('text_required');return request('POST','/chats',{body:form({account_id:accountId,text,attendees_ids:providerId(recipient)}),form:true,write:true})},
  sendInChat:({chatId,text,accountId:given})=>{bound(given);if(!chatId||!text?.trim())throw failure('text_required');return request('POST',`/chats/${encodeURIComponent(chatId)}/messages`,{body:form({account_id:accountId,text}),form:true,write:true})},
 };
}
