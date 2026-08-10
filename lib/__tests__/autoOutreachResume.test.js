import { describe, it, expect, vi, beforeEach } from "vitest";

// Context: 2026-08-10. sdrAutoSwitch stops a lead's sequence, drafts the replacement, then
// enrolls it. When that enroll hits the daily cap the draft is left `pending` and nothing
// retries it — the switched send has left the auto-switch candidate set, and runAutoOutreach
// only ever CREATED drafts. 17 leads were stranded that way, growing ~9/day after the bounce
// gate lowered the caps. These tests pin the drain, and pin that it cannot over-send.

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
      if (sql.includes("INSERT INTO sdr_drafts")) {
        inserts.push(params[0]);
        return { rows: [{ id: `new-${inserts.length}`, assigned_user_id: "u-1" }] };
      }
      return { rows: [] };
    },
  };
}

// warmup_started_at null → ramp day 1 → cap 5, so capacity is min(5, daily_send_limit).
const run = (pool) => runAutoOutreach(pool, { mailboxSentToday: async () => 0 });

beforeEach(() => { delete process.env.SDR_DAILY_CAP; });

describe("runAutoOutreach — draining stalled auto-switch drafts", () => {
  it("enrolls stalled drafts and does not create new ones in their place", async () => {
    const pool = fakePool({ capacity: 5, stalled: 5, eligible: 50 });
    const res = await run(pool);
    expect(res.resumed).toBe(5);
    expect(res.created).toBe(0);
    expect(pool.inserts).toHaveLength(0);
    expect(res.createdDrafts.map((d) => d.id)).toEqual(["stalled-0", "stalled-1", "stalled-2", "stalled-3", "stalled-4"]);
  });

  it("never hands the caller more drafts than the caps allow", async () => {
    // The whole risk of this change: stalled drafts must CONSUME capacity, not add to it.
    const pool = fakePool({ capacity: 5, stalled: 3, eligible: 50 });
    const res = await run(pool);
    expect(res.resumed).toBe(3);
    expect(res.created).toBe(2);
    expect(res.createdDrafts).toHaveLength(5); // exactly the cap, not 8
    expect(pool.leadLimitAsked).toBe(2); // only asked for the leads it still had room for
  });

  it("fills the rest of the day with fresh leads when few are stalled", async () => {
    const pool = fakePool({ capacity: 5, stalled: 1, eligible: 50 });
    const res = await run(pool);
    expect(res.resumed).toBe(1);
    expect(res.created).toBe(4);
    expect(res.createdDrafts).toHaveLength(5);
  });

  it("behaves exactly as before when nothing is stalled", async () => {
    const pool = fakePool({ capacity: 5, stalled: 0, eligible: 50 });
    const res = await run(pool);
    expect(res.resumed).toBe(0);
    expect(res.created).toBe(5);
    expect(res.createdDrafts).toHaveLength(5);
  });

  it("drains a backlog bigger than one day's capacity over successive passes", async () => {
    const pool = fakePool({ capacity: 5, stalled: 17, eligible: 50 });
    const res = await run(pool);
    expect(res.resumed).toBe(5); // today's cap only
    expect(res.created).toBe(0);
    expect(pool.resumeLimitAsked).toBe(5);
  });

  it("creates nothing at all when the caps are already spent", async () => {
    const pool = fakePool({ capacity: 5, stalled: 17, eligible: 50 });
    const res = await runAutoOutreach(pool, { mailboxSentToday: async () => 5 });
    expect(res.created).toBe(0);
    expect(res.note).toBe("no remaining capacity");
  });
});
