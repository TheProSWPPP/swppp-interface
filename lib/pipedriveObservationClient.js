// Read-only Pipedrive transport. Keep endpoint-specific pagination and filters here.
const SCOPES = {
  leads_active: {path:'/v1/leads', paging:'offset', sort:'update_time DESC', since:true},
  leads_archived: {path:'/v1/leads/archived', paging:'offset', sort:'update_time DESC'},
  deals: {path:'/api/v2/deals', paging:'cursor', since:true},
  deals_archived: {path:'/api/v2/deals/archived', paging:'cursor', since:true},
  activities: {path:'/api/v2/activities', paging:'cursor', since:true},
  notes: {path:'/v1/notes', paging:'offset', sort:'update_time DESC', since:true},
  persons: {path:'/api/v2/persons', paging:'cursor', since:true},
  organizations: {path:'/api/v2/organizations', paging:'cursor', since:true},
};
const ENTITY_PATH = {lead:'/v1/leads',deal:'/api/v2/deals',activity:'/api/v2/activities',note:'/v1/notes',person:'/api/v2/persons',organization:'/api/v2/organizations'};
export const CRM_OBSERVATION_SCOPES = Object.freeze(Object.keys(SCOPES));

export function wholeSecondUtc(value) {
  const date=new Date(value);
  if (!Number.isFinite(+date)) throw new Error('invalid_since');
  return new Date(Math.floor(+date/1000)*1000).toISOString().replace('.000Z','Z');
}

export function createPipedriveObservationClient({token,fetchImpl=fetch,baseUrl='https://api.pipedrive.com',sourceHost=null,pageSize=100}={}) {
  if (!token) throw new Error('pipedrive_token_required');
  if (!Number.isInteger(pageSize)||pageSize<1||pageSize>500) throw new Error('invalid_page_size');
  async function request(path,params={}) {
    const url=new URL(path,baseUrl);
    url.searchParams.set('api_token',token);
    for (const [key,value] of Object.entries(params)) if(value!==undefined&&value!==null) url.searchParams.set(key,String(value));
    const response=await fetchImpl(url.toString(),{method:'GET'});
    let body;
    try {body=await response.json();} catch {body=null;}
    if(!response.ok||body?.success===false) {
      const error=new Error(`Pipedrive read failed (${response.status})`);
      error.status=response.status;
      throw error;
    }
    if(!body||body.success!==true) throw new Error('invalid_pipedrive_response');
    return body;
  }
  if(sourceHost&&!/^([a-z0-9-]+\.)+pipedrive\.com$/i.test(sourceHost))throw new Error('invalid_source_host');
  const api={
    sourceHost,
    async listUsers() {
      const body=await request('/v1/users');
      if(!Array.isArray(body.data))throw new Error('invalid_pipedrive_users');
      return body.data.filter(user=>user.id!=null).map(user=>({id:String(user.id),name:String(user.name||'Unknown user')}));
    },
    async getEntity(entity,id) {
      if(!ENTITY_PATH[entity]||id===undefined||id===null||String(id)==='') throw new Error('invalid_entity');
      const body=await request(`${ENTITY_PATH[entity]}/${encodeURIComponent(String(id))}`,entity==='deal'?{include_fields:'source_lead_id'}:{});
      if(!body.data||typeof body.data!=='object') throw new Error('invalid_pipedrive_entity');
      return body.data;
    },
    async listScope(scope,{cursor=null,since=null,leadId=null}={}) {
      const config=SCOPES[scope];
      if(!config) throw new Error('invalid_crm_scope');
      const params={limit:pageSize};
      if(config.paging==='offset') {
        const start=cursor===null?0:Number(cursor);
        if(!Number.isSafeInteger(start)||start<0) throw new Error('invalid_offset');
        params.start=start;
        if(config.sort) params.sort=config.sort;
      } else {
        if(cursor) params.cursor=cursor;
        params.sort_by='update_time';params.sort_direction='asc';
      }
      if(config.since&&since) params.updated_since=wholeSecondUtc(since);
      if(scope==='deals'||scope==='deals_archived')params.include_fields='source_lead_id';
      if(leadId&&['activities','notes'].includes(scope))params.lead_id=String(leadId);
      const body=await request(config.path,params);
      if(!Array.isArray(body.data)) throw new Error('invalid_pipedrive_page');
      const extra=body.additional_data;
      if(!extra||typeof extra!=='object'||Array.isArray(extra))throw new Error('invalid_pipedrive_pagination');
      let nextCursor=null;
      if(config.paging==='offset') {
        const p=extra.pagination;
        if(!p||typeof p!=='object'||typeof p.more_items_in_collection!=='boolean')throw new Error('invalid_pipedrive_pagination');
        if(p.more_items_in_collection) {
          if(!Number.isSafeInteger(Number(p.next_start))||Number(p.next_start)<=Number(params.start)) throw new Error('invalid_pipedrive_pagination');
          nextCursor=String(p.next_start);
        }
      } else {
        const pagination=Object.hasOwn(extra,'next_cursor')?extra:extra.pagination;
        if(!pagination||!Object.hasOwn(pagination,'next_cursor'))throw new Error('invalid_pipedrive_pagination');
        nextCursor=pagination.next_cursor;
        if(nextCursor!==null&&(typeof nextCursor!=='string'||!nextCursor))throw new Error('invalid_pipedrive_pagination');
        if(extra.more_items_in_collection===true&&!nextCursor||extra.more_items_in_collection===false&&nextCursor)throw new Error('invalid_pipedrive_pagination');
      }
      return {items:body.data,nextCursor};
    },
    async listLeadEvidence(leadId,{maxPages=20}={}) {
      const evidence={complete:false,lead:null,person:null,organization:null,notes:[],activities:[],errors:[]};
      const limit=Math.max(1,Math.min(100,Number(maxPages)||20));
      try {
        const lead=await api.getEntity('lead',leadId);
        if(String(lead.id)!==String(leadId))throw new Error('lead_identity_mismatch');
        // The active lead endpoint does not return archived records.
        evidence.lead={...lead,is_archived:false};
        const personId=lead.person_id?.id??lead.person_id;
        const orgId=lead.organization_id?.id??lead.organization_id??lead.org_id?.id??lead.org_id;
        if(personId)evidence.person=await api.getEntity('person',personId);
        if(orgId)evidence.organization=await api.getEntity('organization',orgId);
        for(const scope of ['notes','activities']) {
          let cursor=null,complete=false;const seen=new Set();
          for(let page=0;page<limit;page++) {
            const response=await api.listScope(scope,{leadId,cursor});
            evidence[scope].push(...response.items);
            if(!response.nextCursor){complete=true;break;}
            if(seen.has(response.nextCursor))throw new Error('repeated_pagination_cursor');
            seen.add(response.nextCursor);cursor=response.nextCursor;
          }
          if(!complete)throw new Error(`${scope}_page_cap`);
        }
        evidence.complete=true;
      }catch(error){evidence.errors.push({category:error?.status===401||error?.status===403?'permission':error?.status===404?'unresolved':error?.status===429?'rate_limit':'incomplete',message:error.message});}
      return evidence;
    },
  };
  return api;
}
