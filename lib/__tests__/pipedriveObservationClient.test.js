import { describe, it, expect, vi } from 'vitest';
import { createPipedriveObservationClient } from '../pipedriveObservationClient.js';

function fixture(body) { return { ok:true, status:200, json:async()=>body }; }
describe('read-only Pipedrive observation adapter', () => {
  it('uses active lead updated_since but never sends that unsupported filter to archived leads', async () => {
    const urls=[];
    const client=createPipedriveObservationClient({token:'test',fetchImpl:async url=>{urls.push(new URL(url));return fixture({success:true,data:[],additional_data:{pagination:{more_items_in_collection:false}}});}});
    await client.listScope('leads_active',{since:'2026-10-05T12:00:00.007Z'});
    await client.listScope('leads_archived',{since:'2026-10-05T12:00:00.007Z',cursor:'100'});
    expect(urls[0].pathname).toBe('/v1/leads');
    expect(urls[0].searchParams.get('updated_since')).toBe('2026-10-05T12:00:00Z');
    expect(urls[1].pathname).toBe('/v1/leads/archived');
    expect(urls[1].searchParams.has('updated_since')).toBe(false);
    expect(urls[1].searchParams.get('sort')).toBe('update_time DESC');
    expect(urls[1].searchParams.get('start')).toBe('100');
  });
  it('requests all owners and done states for activities, with whole-second UTC boundary', async () => {
    const urls=[];
    const client=createPipedriveObservationClient({token:'test',fetchImpl:async url=>{urls.push(new URL(url));return fixture({success:true,data:[],additional_data:{next_cursor:null}});}});
    await client.listScope('activities',{since:'2026-10-05T12:00:00.999Z'});
    expect(urls[0].pathname).toBe('/api/v2/activities');
    expect(urls[0].searchParams.get('updated_since')).toBe('2026-10-05T12:00:00Z');
    expect(urls[0].searchParams.has('owner_id')).toBe(false);
    expect(urls[0].searchParams.has('done')).toBe(false);
  });
  it('uses notes offset and v2 entity cursors and rejects malformed next pages', async () => {
    const fetchImpl=vi.fn(async url=>fixture({success:true,data:[{id:1}],additional_data:new URL(url).pathname.endsWith('/notes')?{pagination:{more_items_in_collection:true,next_start:100}}:{next_cursor:'opaque-next'}}));
    const client=createPipedriveObservationClient({token:'test',fetchImpl});
    expect((await client.listScope('notes',{})).nextCursor).toBe('100');
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe('/v1/notes');
    expect((await client.listScope('persons',{})).nextCursor).toBe('opaque-next');
  });
  it('requests explicit lead conversion mapping on deal collection and exact hydration',async()=>{
    const urls=[];
    const client=createPipedriveObservationClient({token:'test',fetchImpl:async raw=>{urls.push(new URL(raw));return fixture({success:true,data:raw.includes('/deals/5')?{id:5,source_lead_id:'lead-1'}:[],additional_data:{next_cursor:null}});}});
    await client.listScope('deals',{});await client.listScope('deals_archived',{});await client.getEntity('deal',5);
    expect(urls.map(url=>url.searchParams.get('include_fields'))).toEqual(['source_lead_id','source_lead_id','source_lead_id']);
  });
  it('returns unresolved status for an exact 404 and never attempts a write', async () => {
    const calls=[];
    const client=createPipedriveObservationClient({token:'test',fetchImpl:async(url,init)=>{calls.push([url,init]);return {ok:false,status:404,json:async()=>({success:false,error:'Not found'})};}});
    await expect(client.getEntity('lead','lead-1')).rejects.toMatchObject({status:404});
    expect(calls[0][1].method).toBe('GET');
  });
  it('exhausts exact lead notes and activities plus linked identity before marking evidence complete',async()=>{
    const urls=[];
    const fetchImpl=async raw=>{const url=new URL(raw);urls.push(url);const path=url.pathname;
      if(path==='/v1/leads/lead-1')return fixture({success:true,data:{id:'lead-1',person_id:5,organization_id:7}});
      if(path==='/api/v2/persons/5')return fixture({success:true,data:{id:5,email:[{value:'a@example.com',primary:true}]}});
      if(path==='/api/v2/organizations/7')return fixture({success:true,data:{id:7,name:'ACME'}});
      if(path==='/v1/notes')return fixture({success:true,data:[{id:9,lead_id:'lead-1',content:'Call first'}],additional_data:{pagination:{more_items_in_collection:false}}});
      if(path==='/api/v2/activities')return fixture({success:true,data:[{id:10,lead_id:'lead-1',done:false,subject:'Call'}],additional_data:{next_cursor:null}});
      throw Error(`Unexpected ${path}`);
    };
    const evidence=await createPipedriveObservationClient({token:'test',fetchImpl}).listLeadEvidence('lead-1');
    expect(evidence).toMatchObject({complete:true,lead:{id:'lead-1',is_archived:false},person:{id:5},organization:{id:7},notes:[{id:9}],activities:[{id:10}],errors:[]});
    expect(urls.filter(u=>u.pathname==='/v1/notes')[0].searchParams.get('lead_id')).toBe('lead-1');
    expect(urls.filter(u=>u.pathname==='/api/v2/activities')[0].searchParams.get('lead_id')).toBe('lead-1');
  });
  it('reports page caps and provider failures as incomplete evidence',async()=>{
    const client=createPipedriveObservationClient({token:'test',fetchImpl:async raw=>{
      const path=new URL(raw).pathname;
      if(path==='/v1/leads/lead-2')return fixture({success:true,data:{id:'lead-2'}});
      if(path==='/v1/notes')return fixture({success:true,data:[{id:1}],additional_data:{pagination:{more_items_in_collection:true,next_start:100}}});
      return fixture({success:true,data:[],additional_data:{next_cursor:null}});
    }});
    expect((await client.listLeadEvidence('lead-2',{maxPages:1})).complete).toBe(false);
  });
  it('rejects missing and contradictory pagination instead of certifying a partial page complete',async()=>{
    const absent=createPipedriveObservationClient({token:'test',fetchImpl:async()=>fixture({success:true,data:[{id:1}]})});
    await expect(absent.listScope('notes',{})).rejects.toThrow('pagination');
    await expect(absent.listScope('activities',{})).rejects.toThrow('pagination');
    const evidenceClient=createPipedriveObservationClient({token:'test',fetchImpl:async raw=>fixture({success:true,data:new URL(raw).pathname==='/v1/leads/lead-1'?{id:'lead-1'}:[]})});
    const evidence=await evidenceClient.listLeadEvidence('lead-1');
    expect(evidence.complete).toBe(false);
    expect(evidence.errors[0].message).toContain('pagination');
    const contradiction=createPipedriveObservationClient({token:'test',fetchImpl:async()=>fixture({success:true,data:[{id:1}],additional_data:{pagination:{more_items_in_collection:true}}})});
    await expect(contradiction.listScope('notes',{})).rejects.toThrow('pagination');
  });
});

it('reads the user directory with GET without exposing provider user fields',async()=>{
  const calls=[];
  const client=createPipedriveObservationClient({token:'test',fetchImpl:async(url,options)=>{
    calls.push({url,options});return {ok:true,status:200,json:async()=>({success:true,data:[{id:7,name:'Derek',email:'private@example.test',active_flag:true}]})};
  }});
  expect(await client.listUsers()).toEqual([{id:'7',name:'Derek'}]);
  expect(calls[0].options.method).toBe('GET');
  expect(new URL(calls[0].url).pathname).toBe('/v1/users');
});

it('uses canonical V1 entity paths while retaining V2 API paths',async()=>{
  const paths=[];
  const client=createPipedriveObservationClient({token:'test',fetchImpl:async(raw,options)=>{
    paths.push(new URL(raw).pathname);expect(options.method).toBe('GET');
    return {ok:true,status:200,json:async()=>({success:true,data:{id:'7'}})};
  }});
  for(const entity of ['lead','note','deal','activity','person','organization'])await client.getEntity(entity,'7');
  expect(paths).toEqual(['/v1/leads/7','/v1/notes/7','/api/v2/deals/7','/api/v2/activities/7','/api/v2/persons/7','/api/v2/organizations/7']);
});
