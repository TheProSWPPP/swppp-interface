import {describe,it,expect,vi,beforeAll,afterAll} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../pipedriveClient.js',()=>({getLead:async()=>({id:'lead',title:'Synthetic project',person_id:1,organization_id:2}),getPerson:async()=>({id:1,name:'Synthetic Buyer',email:[{primary:true,value:'buyer@example.invalid'}]})}));
import {buildDraftFromLead} from '../sdrDraftGenerator.js';
const db=reportingTestDb('sender_snapshot');
describe.skipIf(!db)('draft sender snapshot',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_mailboxes(id text,email text,owner_user_id text,active boolean,warmup_status text,apollo_mailbox_id text);
 INSERT INTO sdr_mailboxes VALUES('default','rep@example.invalid','rep',TRUE,'ready','provider-one'),('selected','selected@example.invalid','other',TRUE,'ready','provider-two')`);});
 afterAll(async()=>db.close());
 const build=extra=>buildDraftFromLead({pipedriveLeadId:'lead',triggerType:'AGC',pool:db.pool,assignedUserId:'rep',...extra});
 it('captures the actual sender identity before the user reviews it',async()=>{
  const payload=await build();expect(payload.metadata).toMatchObject({sender_email:'rep@example.invalid',sender_provider_id:'provider-one'});
  await db.pool.query("UPDATE sdr_mailboxes SET apollo_mailbox_id='changed' WHERE id='default'");
  expect(payload.metadata.sender_provider_id).toBe('provider-one');
 });
 it('preserves an explicitly selected sender during refresh',async()=>{
  const payload=await build({assignedMailboxId:'selected'});
  expect(payload.assigned_mailbox_id).toBe('selected');
  expect(payload.metadata).toMatchObject({sender_email:'selected@example.invalid',sender_provider_id:'provider-two'});
 });
});
