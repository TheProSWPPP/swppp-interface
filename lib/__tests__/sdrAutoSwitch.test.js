import { describe, it, expect } from "vitest";
import { isDuplicateEnrolment } from "../sdrAutoSwitch.js";

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
