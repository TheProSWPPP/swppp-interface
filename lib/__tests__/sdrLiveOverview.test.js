import {expect,it} from 'vitest';
import {readLiveOverview} from '../sdrLiveOverview.js';
const pool=({pending=0,eligible=0}={})=>({query:async sql=>({rows:sql.includes('FROM sdr_drafts')?[{pending,ready:0,failed:0}]
 :sql.includes('FROM sdr_lead_state')?[{total:eligible,eligible}]:sql.includes('FROM sdr_mailboxes')?[{total:1,active:1,incomplete:0}]
 :sql.includes('generate_series')?[]:[{count:0}]})});
it('lists pending drafts with a short line and no CRM-status lead row',async()=>{
 const result=await readLiveOverview(pool({pending:4,eligible:3558}));
 expect(result.actions).toEqual([{id:'pending',title:'Review pending drafts',description:'Check message and recipient, then approve.',count:4,target:'queue',severity:'info'}]);
 expect(result.leads).toEqual({total:3558,eligible:3558});
});
