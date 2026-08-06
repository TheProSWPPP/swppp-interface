import { describe, it, expect, afterEach } from "vitest";
import { isDuplicateEnrolment, classifyHop, awardOnlySequenceId } from "../sdrAutoSwitch.js";

// Context: 2026-07-30. 38 pairs of sends put a lead into the SAME Apollo sequence twice.
// 32 went to a DIFFERENT email (the auto-switch working correctly — the contact moved on),
// 6 went to the SAME email, all `initiated_by='auto-switch'`. The cause is Pipedrive
// duplicate records: person_id / org_id flips to a sibling row while the human is unchanged,
// and the engine reads that as "the contact changed".
//
// The 2026-07-28 `redundantAwardHop` guard could not catch these because it compares STAGES
// and a same-stage re-enrolment is not a hop. These tests pin the identity that matters.

const SEQ_LBA = "6a2ac17eef87e000180cb54a";
const SEQ_AGC = "6a32587c8a5c33001c728b9f";

describe("isDuplicateEnrolment", () => {
  it("blocks the same sequence to the same email", () => {
    const history = [{ apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "dboardman@mdiconst.com" }];
    expect(
      isDuplicateEnrolment(history, {
        apollo_sequence_id: SEQ_LBA,
        contact_email_snapshot: "dboardman@mdiconst.com",
      }),
    ).toBe(true);
  });

  it("allows the same sequence to a DIFFERENT email — the 32 legitimate cases", () => {
    // The real Creekside lead: jlee@ on 07-09, then cody@ on 07-22, same sequence.
    // Cody Sosner did NOT receive a duplicate; the contact genuinely changed.
    const history = [{ apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "jlee@creeksideinc.net" }];
    expect(
      isDuplicateEnrolment(history, {
        apollo_sequence_id: SEQ_LBA,
        contact_email_snapshot: "cody@creeksideinc.net",
      }),
    ).toBe(false);
  });

  it("allows a DIFFERENT sequence to the same email", () => {
    const history = [{ apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "rrost@walshgroup.com" }];
    expect(
      isDuplicateEnrolment(history, {
        apollo_sequence_id: SEQ_AGC,
        contact_email_snapshot: "rrost@walshgroup.com",
      }),
    ).toBe(false);
  });

  it("is case and whitespace insensitive, because snapshots are not normalised on write", () => {
    const history = [{ apollo_sequence_id: SEQ_AGC, contact_email_snapshot: "  JSocorro@CA-Cons.com " }];
    expect(
      isDuplicateEnrolment(history, {
        apollo_sequence_id: SEQ_AGC,
        contact_email_snapshot: "jsocorro@ca-cons.com",
      }),
    ).toBe(true);
  });

  it("matches on ANY prior send, not just the most recent", () => {
    const history = [
      { apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "a@x.com" },
      { apollo_sequence_id: SEQ_AGC, contact_email_snapshot: "target@x.com" },
      { apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "b@x.com" },
    ];
    expect(
      isDuplicateEnrolment(history, { apollo_sequence_id: SEQ_AGC, contact_email_snapshot: "target@x.com" }),
    ).toBe(true);
  });

  it("fails OPEN on a missing sequence or email rather than blocking a real send", () => {
    const history = [{ apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "a@x.com" }];
    expect(isDuplicateEnrolment(history, { apollo_sequence_id: null, contact_email_snapshot: "a@x.com" })).toBe(false);
    expect(isDuplicateEnrolment(history, { apollo_sequence_id: SEQ_LBA, contact_email_snapshot: null })).toBe(false);
    expect(isDuplicateEnrolment(history, { apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "   " })).toBe(false);
    expect(isDuplicateEnrolment(history, null)).toBe(false);
  });

  it("does not crash on empty or ragged history", () => {
    expect(isDuplicateEnrolment([], { apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "a@x.com" })).toBe(false);
    expect(isDuplicateEnrolment(null, { apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "a@x.com" })).toBe(false);
    expect(
      isDuplicateEnrolment([null, {}, { apollo_sequence_id: SEQ_LBA }], {
        apollo_sequence_id: SEQ_LBA,
        contact_email_snapshot: "a@x.com",
      }),
    ).toBe(false);
  });

  it("a null history email never matches a null candidate email", () => {
    // Guards against the classic "" === "" collapse making every unknown a duplicate.
    const history = [{ apollo_sequence_id: SEQ_LBA, contact_email_snapshot: null }];
    expect(isDuplicateEnrolment(history, { apollo_sequence_id: SEQ_LBA, contact_email_snapshot: null })).toBe(false);
  });
});

// --- classifyHop -------------------------------------------------------------------------
// Derek, 2026-07-29: "if the GC didn't change we would maybe just send one award email...
// if the GC did change, then obviously the drip is good."
//
// The 2026-07-28 guard suppressed LBA->AGC entirely, so a won job at the same GC got nothing
// while the LBA drip kept running. These pin the three outcomes.

const AWARD_SEQ = "6a6b93d210d3bd00105e3b7f"; // SWPPP - AGC Award Only (1 step)
const base = { personChanged: false, orgChanged: false, awardOnlySequence: AWARD_SEQ };

afterEach(() => {
  delete process.env.APOLLO_SEQ_AGC_AWARD_ONLY;
});

describe("classifyHop", () => {
  it("sends ONE award email when the job is won and the GC did not change", () => {
    expect(classifyHop({ ...base, enrolledTrigger: "LBA", curTrigger: "AGC" })).toBe("award-only");
  });

  it("runs the full drip when the GC changed, which is Derek's other case", () => {
    expect(classifyHop({ ...base, enrolledTrigger: "LBA", curTrigger: "AGC", orgChanged: true })).toBe("switch");
  });

  it("runs the full drip when the contact changed", () => {
    expect(classifyHop({ ...base, enrolledTrigger: "LBA", curTrigger: "AGC", personChanged: true })).toBe("switch");
  });

  it("does nothing going backwards out of an award (AGC -> LBA)", () => {
    expect(classifyHop({ ...base, enrolledTrigger: "AGC", curTrigger: "LBA" })).toBe("skip");
  });

  it("falls back to the old suppress-entirely behaviour when the feature is killed", () => {
    expect(classifyHop({ ...base, enrolledTrigger: "LBA", curTrigger: "AGC", awardOnlySequence: null })).toBe("skip");
  });

  it("treats a pre-award trigger moving into an award as a real switch", () => {
    // PB asks "did y'all win this one?" so AGC is the answer rather than a repeat.
    expect(classifyHop({ ...base, enrolledTrigger: "PB", curTrigger: "AGC" })).toBe("switch");
    expect(classifyHop({ ...base, enrolledTrigger: "CM", curTrigger: "LBA" })).toBe("switch");
  });

  it("skips when nothing moved at all", () => {
    expect(classifyHop({ ...base, enrolledTrigger: "LBA", curTrigger: "LBA" })).toBe("skip");
  });

  it("still switches on a contact or company change with no trigger change", () => {
    expect(classifyHop({ ...base, enrolledTrigger: "LBA", curTrigger: "LBA", personChanged: true })).toBe("switch");
    expect(classifyHop({ ...base, enrolledTrigger: "PB", curTrigger: "PB", orgChanged: true })).toBe("switch");
  });

  it("skips on missing trigger data rather than guessing", () => {
    expect(classifyHop({ ...base, enrolledTrigger: null, curTrigger: "AGC" })).toBe("skip");
    expect(classifyHop({ ...base, enrolledTrigger: "LBA", curTrigger: null })).toBe("skip");
  });
});

describe("awardOnlySequenceId", () => {
  it("defaults to the live award sequence so no Railway change is needed", () => {
    expect(awardOnlySequenceId()).toBe(AWARD_SEQ);
  });

  it("is killable with 'off'", () => {
    process.env.APOLLO_SEQ_AGC_AWARD_ONLY = "off";
    expect(awardOnlySequenceId()).toBeNull();
  });

  it("reads the env var", () => {
    process.env.APOLLO_SEQ_AGC_AWARD_ONLY = AWARD_SEQ;
    expect(awardOnlySequenceId()).toBe(AWARD_SEQ);
  });
});

// --- Ordering: resolve before stopping ---------------------------------------
//
// Measured 2026-08-06: 13 leads in 30 days were stopped mid-drip and never re-enrolled.
// Every one had the same trigger before and after, a person_id or org_id that had flipped to
// a Pipedrive duplicate record, and a prior send of that same sequence to the same address.
// The engine stopped the drip, then the duplicate guard refused to re-enrol, and the lead sat
// out of outreach. These tests pin the order that makes that impossible.

const LEAD = "13788b20-798e-11f1-b8cb-3f0d1ec5254f";
const CONTACT_EMAIL = "jsocorro@ca-cons.com";

/** Minimal pool that records every write, so a test can assert the drip was never stopped. */
function fakePool({ candidate, priorSends }) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (sql.includes("FROM sdr_sends s") && sql.includes("JOIN sdr_lead_state")) {
        return { rows: candidate ? [candidate] : [] };
      }
      if (sql.includes("SELECT s.apollo_sequence_id")) return { rows: priorSends };
      if (sql.includes("UPDATE sdr_sends SET status = 'switched'")) {
        writes.push({ op: "stop", params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sdr_drafts")) {
        writes.push({ op: "insert-draft", params });
        return { rows: [{ id: "draft-1", assigned_user_id: "user-1" }] };
      }
      return { rows: [] };
    },
  };
}

const CANDIDATE = {
  send_id: "send-1",
  pipedrive_lead_id: LEAD,
  apollo_sequence_id: SEQ_LBA,
  apollo_contact_id: "apollo-1",
  enrolled_trigger: "LBA",
  enrolled_person_id: "111",
  enrolled_org_id: "222",
  cur_trigger: "LBA",
  cur_person: "111",
  cur_org: "999", // org id flipped to a Pipedrive duplicate record
  lead_title: "Some Project",
  owner_user_id: "user-1",
};

describe("runAutoSwitch ordering", () => {
  it("leaves a working drip alone when the re-enrolment would be a duplicate", async () => {
    // No APOLLO_API_KEY / PIPEDRIVE_API_TOKEN in the test env, so the external calls no-op and
    // the sdr_sends UPDATE is the observable "we stopped the drip" write.
    const { runAutoSwitch } = await import("../sdrAutoSwitch.js");
    const pool = fakePool({
      candidate: CANDIDATE,
      priorSends: [{ apollo_sequence_id: SEQ_LBA, contact_email_snapshot: CONTACT_EMAIL }],
    });
    const res = await runAutoSwitch(pool, {
      enrollDrafts: async () => ({ enrolled: 1 }),
      buildDraft: async () => ({
        pipedrive_lead_id: LEAD,
        apollo_sequence_id: SEQ_LBA,
        contact_email_snapshot: CONTACT_EMAIL,
        trigger_type: "LBA",
      }),
    });
    expect(res.duplicatesSuppressed).toBe(1);
    expect(res.stopped).toBe(0);
    expect(pool.writes.filter((w) => w.op === "stop")).toHaveLength(0);
    expect(pool.writes.filter((w) => w.op === "insert-draft")).toHaveLength(0);
    expect(res.events[0].action).toBe("left-enrolled");
  });

  it("still stops and re-enrols when the recipient genuinely changed", async () => {
    const { runAutoSwitch } = await import("../sdrAutoSwitch.js");
    const pool = fakePool({
      candidate: CANDIDATE,
      priorSends: [{ apollo_sequence_id: SEQ_LBA, contact_email_snapshot: "someone.else@ca-cons.com" }],
    });
    const res = await runAutoSwitch(pool, {
      enrollDrafts: async () => ({ enrolled: 1 }),
      buildDraft: async () => ({
        pipedrive_lead_id: LEAD,
        apollo_sequence_id: SEQ_LBA,
        contact_email_snapshot: CONTACT_EMAIL,
        trigger_type: "LBA",
      }),
    });
    expect(res.duplicatesSuppressed).toBe(0);
    expect(res.stopped).toBe(1);
    expect(res.reEnrolled).toBe(1);
    // The stop must land before the new draft, so the lead is never in two sequences at once.
    expect(pool.writes.map((w) => w.op)).toEqual(["stop", "insert-draft"]);
  });

  it("leaves the drip running when the draft cannot be built, so the next sweep retries", async () => {
    const { runAutoSwitch } = await import("../sdrAutoSwitch.js");
    const pool = fakePool({ candidate: CANDIDATE, priorSends: [] });
    const res = await runAutoSwitch(pool, {
      enrollDrafts: async () => ({ enrolled: 1 }),
      buildDraft: async () => {
        throw new Error("Pipedrive lead not found");
      },
    });
    expect(res.reEnrollFailed).toBe(1);
    expect(res.stopped).toBe(0);
    expect(pool.writes).toHaveLength(0);
  });
});
