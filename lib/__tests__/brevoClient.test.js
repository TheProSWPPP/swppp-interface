import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brevo from '../brevoClient.js';
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => { vi.stubEnv('BREVO_API_KEY', 'test-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Brevo reporting truthfulness', () => {
 it('loads every campaign page and requests the documented statistics window', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(reply({count:3,campaigns:[{id:3},{id:2}]})).mockResolvedValueOnce(reply({count:3,campaigns:[{id:1}]})); vi.stubGlobal('fetch',fetch);
  expect((await brevo.listCampaigns({limit:2})).map(c=>c.id)).toEqual([3,2,1]);
  expect(new URL(fetch.mock.calls[1][0]).searchParams.get('offset')).toBe('2');
  expect(new URL(fetch.mock.calls[0][0]).searchParams.get('statistics')).toBe('globalStats');
 });
 it('does not fabricate zero for missing statistics or contact totals', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(reply({count:1,campaigns:[{id:1,statistics:{globalStats:{sent:10,uniqueViews:0,delivered:'9',hardBounces:-1}}}]})).mockResolvedValueOnce(reply({contacts:[]})).mockResolvedValueOnce(reply({contacts:[]})));
  const [c]=await brevo.listCampaigns(); expect(c.stats.uniqueViews).toBe(0); expect(c.stats.delivered).toBeNull(); expect(c.stats.hardBounces).toBeNull(); expect(c.stats.uniqueClicks).toBeNull(); expect(c.statsWindow).toBe('last_six_months');
  expect(await brevo.listContactCount(1)).toBeNull(); expect((await brevo.listContacts(1)).count).toBeNull();
 });
 it.each([['listLists','lists'],['listTemplates','templates'],['listFolders','folders']])('paginates %s',async(fn,field)=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(reply({count:3,[field]:[{id:3},{id:2}]})).mockResolvedValueOnce(reply({count:3,[field]:[{id:1}]})));
  expect((await brevo[fn]({limit:2})).map(x=>x.id)).toEqual([3,2,1]);
 });
 it('surfaces failed link reports instead of returning an empty successful result',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply({message:'Unavailable'},503))); await expect(brevo.getCampaignLinks(1)).rejects.toMatchObject({status:503});
 });
 it('refuses repeated pages rather than reporting a truncated catalog as complete',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>reply({count:4,lists:[{id:2},{id:1}]}))); await expect(brevo.listLists({limit:2})).rejects.toThrow(/incomplete/i);
 });
 it('rejects malformed successful collection payloads',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply({message:'oops'}))); await expect(brevo.listCampaigns()).rejects.toThrow(/unexpected/i);
 });
 it('does not silently finish when a declared count exceeds the returned records',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply({count:3,templates:[{id:1}]}))); await expect(brevo.listTemplates()).rejects.toThrow(/incomplete/i);
 });
 it('does not present older sent campaign statistics as zero',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply({count:1,campaigns:[{id:1,sentDate:'2000-01-01',statistics:{globalStats:{sent:0,delivered:0,uniqueViews:0}}}]})));
  expect((await brevo.listCampaigns())[0].stats).toBeNull();
 });
 it('marks engagement without delivered history as unavailable',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply({count:1,campaigns:[{id:1,statistics:{globalStats:{sent:0,delivered:0,uniqueViews:3}}}]})));
  expect((await brevo.listCampaigns())[0].stats).toBeNull();
 });
 it('never labels SMS plan credits as email credits',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply({plan:[{type:'sms',creditsType:'sendLimit',credits:500},{type:'marketing',creditsType:'sendLimit',credits:10}]})));
  expect((await brevo.getAccount()).credits).toBe(10);
 });
 it('encodes IDs before constructing a provider URL',async()=>{
  const fetch=vi.fn().mockResolvedValue(reply({}));vi.stubGlobal('fetch',fetch);await brevo.sendCampaignTest('123/sendNow?', ['staff@example.test']);
  expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/v3/emailCampaigns/123%2FsendNow%3F/sendTest');
 });
 it('adds a bounded timeout and refuses redirects for server credentials',async()=>{
  const fetch=vi.fn().mockResolvedValue(reply({senders:[]})); vi.stubGlobal('fetch',fetch);await brevo.listSenders();expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);expect(fetch.mock.calls[0][1].redirect).toBe('error');
 });
});
