import { afterEach, describe, expect, it, vi } from 'vitest';
import { listThreadPage, listThreads, getThread, sendMail, listSendAs, refreshAccessToken } from '../gmailInbox.js';
afterEach(() => vi.unstubAllGlobals());
const stamp = '1791212400000';
const message = { id: 'message-1', internalDate: stamp, snippet: 'Yes please', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', body: { data: Buffer.from('Yes please').toString('base64') }, headers: [
  { name: 'From', value: 'Alias <alias@buyer.test>' }, { name: 'To', value: 'rep@example.test' }, { name: 'Date', value: 'Sun, 01 Jan 2017 00:00:00 GMT' }, { name: 'Message-ID', value: '<reply@buyer.test>' },
] } };
const fixture = () => {
  const urls = [];
  vi.stubGlobal('fetch', async url => {
    urls.push(String(url));
    const data = String(url).includes('/threads?') ? { threads: [{ id: 'thread-1' }], nextPageToken: 'next-page' } : { messages: [message] };
    return { ok: true, json: async () => data };
  });
  return urls;
};
describe('Gmail page and arrival contract', () => {
  it('requires renewed authorization when a refresh token is invalidated', async () => {
    vi.stubGlobal('fetch',async()=>({ok:false,status:400,json:async()=>({error:'invalid_grant',error_description:'Token has been expired or revoked.'})}));
    await expect(refreshAccessToken('fixture-refresh')).rejects.toMatchObject({needsReconnect:true,oauthError:'invalid_grant'});
  });
  it('does not recommend mailbox reconnect for an OAuth client configuration error', async () => {
    vi.stubGlobal('fetch',async()=>({ok:false,status:400,json:async()=>({error:'invalid_client'})}));
    await expect(refreshAccessToken('fixture-refresh')).rejects.not.toMatchObject({needsReconnect:true});
  });
  it('reads sender settings from the same users/me base as inbox requests', async () => {
    const fetch = vi.fn(async () => ({ok:true,json:async()=>({sendAs:[{sendAsEmail:'rep@example.test',displayName:''}]})}));
    vi.stubGlobal('fetch',fetch);
    expect(await listSendAs('fixture-token')).toEqual([expect.objectContaining({sendAsEmail:'rep@example.test',displayName:null})]);
    expect(fetch.mock.calls[0][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs');
  });
  it('does not diagnose a missing URL as an OAuth permission gap', async () => {
    vi.stubGlobal('fetch',async()=>({ok:false,status:404,json:async()=>({error:{message:'Not found'}})}));
    await expect(listSendAs('fixture-token')).rejects.not.toMatchObject({needsReconnect:true});
  });
  it('only recommends reconnecting when Gmail confirms insufficient permissions', async () => {
    vi.stubGlobal('fetch',async()=>({ok:false,status:403,json:async()=>({error:{message:'Insufficient Permission',errors:[{reason:'insufficientPermissions'}]}})}));
    await expect(listSendAs('fixture-token')).rejects.toMatchObject({needsReconnect:true});
  });
  it('preserves page cursor and uses real internalDate independently of Date header', async () => {
    const urls = fixture();
    const result = await listThreadPage('fixture-token', { query: 'in:inbox', pageToken: 'page+/=', maxResults: 25 });
    expect(result.nextPageToken).toBe('next-page');
    expect(result.threads[0]).toMatchObject({ lastMessageId: 'message-1', receivedAt: new Date(Number(stamp)).toISOString(), messages: [{ id: 'message-1', receivedAt: new Date(Number(stamp)).toISOString(), messageId: '<reply@buyer.test>', lastOutbound: false }] });
    expect(new URL(urls[0]).searchParams.get('pageToken')).toBe('page+/=');
  });
  it('retains the listThreads array interface for the existing inbox UI', async () => {
    fixture();
    expect(await listThreads('fixture-token')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'thread-1', date: 'Sun, 01 Jan 2017 00:00:00 GMT' })]));
  });
  it('keeps copied contacts visible without changing legacy reply matching', async () => {
    const copied = {...message,payload:{...message.payload,headers:[...message.payload.headers,{name:'Cc',value:'Other buyer <copied@buyer.test>'}]}};
    const urls=[];
    vi.stubGlobal('fetch',async url=>{urls.push(String(url));return {ok:true,json:async()=>String(url).includes('/threads?')?{threads:[{id:'thread-1'}]}:{messages:[copied]}};});
    const result=await listThreadPage('fixture-token');
    expect(result.threads[0].ccParticipants).toContain('copied@buyer.test');
    expect(result.threads[0].participants).not.toContain('copied@buyer.test');
    expect(result.threads[0].messages[0].cc).toBe('Other buyer <copied@buyer.test>');
    expect(new URL(urls[1]).searchParams.getAll('metadataHeaders')).toContain('Cc');
  });
  it('includes arrival time and labels with the full message body', async () => {
    fixture();
    expect((await getThread('fixture-token','thread-1')).messages[0]).toMatchObject({ body: 'Yes please', receivedAt: new Date(Number(stamp)).toISOString(), lastOutbound: false });
  });
  it('sends a stable Message-ID for forward receipt reconciliation', async () => {
    let mime;
    vi.stubGlobal('fetch',async (_url,options)=>{mime=Buffer.from(JSON.parse(options.body).raw,'base64url').toString('utf8'); return {ok:true,json:async()=>({id:'sent'})};});
    await sendMail('fixture-token',{from:'rep@example.test',to:'verified@example.test',subject:'reply',bodyText:'forward',messageId:'<sdr-action-one@example.test>'});
    expect(mime).toContain('Message-ID: <sdr-action-one@example.test>\r\n');
  });
});
