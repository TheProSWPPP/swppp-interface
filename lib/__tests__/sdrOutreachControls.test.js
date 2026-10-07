import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { reportingTestDb } from './reportingTestDb.js';
import * as controls from '../sdrOutreachControls.js';

const db=reportingTestDb('manual_controls');
const context={companyId:'42',leadId:'lead-a',personId:'3',recipientEmail:'test@example.invalid',draftId:'draft-a',channel:'email',serviceId:'swppp'};
const actor={source:'sdr_ui',accountId:'rep-a',execution:'interactive'};
describe('restriction scope',()=>{
  it('matches service only within its project and channel',()=>{
    const c={company_id:'42',lead_id:'lead-a',scope_kind:'service',scope_id:'swppp',channel:'email',status:'active'};
    expect(controls.controlApplies(c,context)).toBe(true);
    expect(controls.controlApplies(c,{...context,serviceId:'inspection'})).toBe(false);
    expect(controls.controlApplies(c,{...context,leadId:'lead-b'})).toBe(false);
    expect(controls.controlApplies(c,{...context,channel:'call'})).toBe(false);
    expect(controls.controlApplies(c,{...context,serviceId:null})).toBe(true);
  });
});
describe.skipIf(!db)('durable outreach controls',()=>{
  beforeAll(async()=>{await db.setup();await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-outreach-controls.sql',import.meta.url),'utf8'));});
  afterAll(async()=>{await db.close();});
  it('keeps independent restrictions after releasing a draft hold; review dates do not expire holds',async()=>{
    const first=await controls.setOutreachControl(db.pool,{...context,scope:{kind:'draft',id:'draft-a'},reason:'Needs review',contextHash:'h1',actor});
    await controls.setOutreachControl(db.pool,{...context,scope:{kind:'recipient',id:'test@example.invalid'},reason:'Email paused',contextHash:'h1',actor});
    await db.pool.query("UPDATE sdr_outreach_controls SET review_after=NOW()-interval '1 day'");
    expect((await controls.getOutreachControls(db.pool,context)).length).toBe(2);
    await controls.resolveOutreachControl(db.pool,{id:first.id,companyId:'42',expectedVersion:1,decision:'release',evidence:'Reviewed exact draft',actor,contextHash:'h1'});
    await expect(controls.assertOutreachAllowed(db.pool,context,{action:'enroll',override:true})).rejects.toMatchObject({code:'outreach_held'});
    expect((await controls.getOutreachControls(db.pool,context)).length).toBe(1);
  });
  it('rejects stale and context-mismatched resolution and preserves provider uncertainty',async()=>{
    const c=await controls.setOutreachControl(db.pool,{...context,leadId:'lead-c',scope:{kind:'lead',id:'lead-c'},reason:'Manual pause',contextHash:'pause-v1',actor});
    await expect(controls.resolveOutreachControl(db.pool,{id:c.id,companyId:'42',expectedVersion:0,decision:'release',evidence:'reviewed',actor,contextHash:'pause-v1'})).rejects.toMatchObject({status:409});
    await expect(controls.resolveOutreachControl(db.pool,{id:c.id,companyId:'42',expectedVersion:1,decision:'release',evidence:'reviewed',actor,contextHash:'wrong'})).rejects.toMatchObject({status:409});
    const result=controls.controlSummary(await controls.getOutreachControls(db.pool,{...context,leadId:'lead-c',recipientEmail:'different@example.invalid'}));
    expect(result).toMatchObject({applicationActionsBlocked:true,providerStopStatus:'unverified'});
  });
  it('requires an explicit actor and exact scope for creating controls',async()=>{
    await expect(controls.setOutreachControl(db.pool,{...context,scope:{kind:'all',id:'*'},reason:'bad',contextHash:'h',actor})).rejects.toThrow();
    await expect(controls.setOutreachControl(db.pool,{...context,scope:{kind:'lead',id:'lead-a'},reason:'bad',contextHash:'h',actor:null})).rejects.toThrow();
  });
});
