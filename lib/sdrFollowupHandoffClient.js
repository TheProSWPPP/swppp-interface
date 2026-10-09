import {createPipedriveObservationClient} from './pipedriveObservationClient.js';
// Deliberately only GET and one append-only POST. No retry or customer-send client.
export function createFollowupHandoffClient({token,companyId,sourceHost,fetchImpl=fetch,timeoutMs=10000}){
 if(!token||!/^\d+$/.test(String(companyId))||sourceHost!=='proswpppllc.pipedrive.com')throw Error('handoff_configuration');
 const boundedFetch=(url,options={})=>fetchImpl(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
 const observer=createPipedriveObservationClient({token,sourceHost,fetchImpl:boundedFetch});
 async function request(path,body){
  const url=new URL(path,'https://api.pipedrive.com');url.searchParams.set('api_token',token);
  const response=await boundedFetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok||result?.success!==true)throw Error('handoff_provider_unavailable');return result.data;
 }
 return {
  async validateIdentity(){const me=await request('/v1/users/me');if(String(me?.company_id)!==String(companyId)||me?.company_domain!==sourceHost.split('.')[0])throw Error('handoff_company_mismatch');},
  async readEvidence(leadId){const evidence=await observer.listLeadEvidence(leadId);if(evidence.complete){const raw=await observer.getEntity('lead',leadId);if(String(raw.id)!==String(leadId))throw Error('handoff_lead_mismatch');evidence.lead=raw;}return evidence;},
  addNote:({leadId,content})=>request('/v1/notes',{lead_id:leadId,content}),
  getNote:id=>observer.getEntity('note',id),
  async listNotes(leadId){let cursor=null;const items=[],seen=new Set();for(let i=0;i<20;i++){const page=await observer.listScope('notes',{leadId,cursor});items.push(...page.items);if(!page.nextCursor)return {complete:true,items};if(seen.has(page.nextCursor))break;seen.add(page.nextCursor);cursor=page.nextCursor;}return {complete:false,items};},
 };
}
