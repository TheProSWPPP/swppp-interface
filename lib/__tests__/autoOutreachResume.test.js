import { describe, it, expect, vi, beforeEach } from "vitest";

// Historical auto-switch drafts remain reviewable; only legitimate initial drafts
// consume generation capacity. Provider resumption requires its own decision.

vi.mock("../sdrDraftGenerator.js", () => ({
  buildDraftFromLead: vi.fn(async ({ pipedriveLeadId, triggerType, assignedUserId }) => ({
    pipedrive_lead_id: pipedriveLeadId,
    pipedrive_contact_id: 1,
    pipedrive_org_id: 2,
    contact_id_snapshot: 1,
    contact_email_snapshot: `x@${pipedriveLeadId}.com`,
    org_id_snapshot: 2,
    trigger_type: triggerType,
    apollo_sequence_id: "seq-1",
    subject: "s",
    body: "b",
    assigned_mailbox_id: "mb-1",
    assigned_user_id: assignedUserId,
    metadata: {},
  })),
}));

vi.mock("../sendRamp.js", async (orig) => ({
  ...(await orig()),
  mailboxBounceHealth: vi.fn(async () => new Map()),
}));

const { runAutoOutreach } = await import("../autoOutreach.js");

/**
 * @param capacity  per-mailbox remaining sends today
 * @param stalled   how many pending auto-switch drafts are waiting
 * @param eligible  how many fresh leads the eligibility query would return
 */
function fakePool({ capacity, stalled, eligible }) {
  const inserts = [];
  let leadLimitAsked = null;
  let resumeLimitAsked = null;
  return {
    inserts,
    async connect(){return {query:this.query.bind(this),release(){}};},
    get leadLimitAsked() { return leadLimitAsked; },
    get resumeLimitAsked() { return resumeLimitAsked; },
    async query(sql, params) {
      if (sql.includes("FROM sdr_settings")) {
        return { rows: [{ auto_outreach_enabled: true, auto_outreach_mode: "send", auto_min_score: null }] };
      }
      if (sql.includes("FROM sdr_mailboxes")) {
        // One mailbox, daily_send_limit == capacity, never sent today (see mailboxSentToday).
        return { rows: [{ id: "mb-1", email: "a@b.co", owner_user_id: "u-1", warmup_started_at: null, daily_send_limit: capacity }] };
      }
      if (sql.includes("d.initiated_by = 'auto-switch'")) {
        resumeLimitAsked = params[0];
        const n = Math.min(stalled, params[0]);
        return { rows: Array.from({ length: n }, (_, i) => ({ id: `stalled-${i}`, assigned_user_id: "u-1" })) };
      }
      if (sql.includes("FROM sdr_lead_state s")) {
        leadLimitAsked = params[1];
        const n = Math.min(eligible, params[1]);
        return { rows: Array.from({ length: n }, (_, i) => ({ pipedrive_lead_id: `lead-${i}`, trigger_type: "LBA" })) };
      }
      if(sql.includes('SELECT * FROM sdr_lead_state WHERE'))return {rows:[{pipedrive_lead_id:params[0],trigger_type:'LBA'}]};
      if (sql.includes("INSERT INTO sdr_drafts")) {
        inserts.push(params[0]);
        return { rows: [{ id: `new-${inserts.length}`, assigned_user_id: "u-1" }] };
      }
      return { rows: [] };
    },
  };
}

// warmup_started_at null → ramp day 1 → cap 5, so capacity is min(5, daily_send_limit).
const run = (pool) => runAutoOutreach(pool, { companyId:'42', mailboxSentToday: async () => 0 });

beforeEach(() => { delete process.env.SDR_DAILY_CAP; });

describe("runAutoOutreach — preserved prior sequence decisions", () => {
  it.each([1,3,5,17])("does not adopt %s historical auto-switch drafts into new sends", async stalled => {
    const pool=fakePool({capacity:5,stalled,eligible:50});
    const res=await run(pool);
    expect(res.resumed).toBe(0);
    expect(res.created).toBe(5);
    expect(res.createdDrafts.every(d=>d.id.startsWith('new-'))).toBe(true);
    expect(pool.resumeLimitAsked).toBeNull();
  });
  it("creates nothing when the caps are spent",async()=>{
    const pool=fakePool({capacity:5,stalled:17,eligible:50});
    expect(await runAutoOutreach(pool,{companyId:'42',mailboxSentToday:async()=>5})).toMatchObject({created:0,note:'no remaining capacity'});
  });
});
