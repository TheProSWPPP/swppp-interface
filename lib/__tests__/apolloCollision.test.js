import { describe, it, expect } from "vitest";
import { isCampaignCollision, campaignsToRelease, lastSendDaysAgo } from "../apolloCollision.js";

// Context: 2026-09-03. Derek asked why the .co drip only reached 685 of the 1,499 leads in the
// July import. 140 of 201 failed drafts were Apollo refusing to enroll a contact already in a
// campaign. Estimators bid constantly, so one send to a person retires every other project they
// are on: 413 leads across 244 contacts, worst case 12 projects behind one send.
//
// The fixtures below are shaped from real `contact_campaign_statuses` payloads pulled from the
// live Apollo API for 12 blocked contacts on 2026-09-03.

const SEQ_LBA = "6a2ac17eef87e000180cb54a";
const SEQ_AGC = "6a32587c8a5c33001c728b9f";

const finished = (id) => ({
  emailer_campaign_id: id,
  status: "finished",
  inactive_reason: "Completed last step",
});

describe("isCampaignCollision", () => {
  it("matches both spellings Apollo uses, because the middle word is not trustworthy", () => {
    // Measured: 5 contacts carrying the "active" spelling were actually `finished`, 1 `failed`.
    expect(isCampaignCollision("contacts_active_in_other_campaigns")).toBe(true);
    expect(isCampaignCollision("contacts_finished_in_other_campaigns")).toBe(true);
  });

  it("does not claim unrelated skip reasons", () => {
    expect(isCampaignCollision("contacts_with_job_change")).toBe(false);
    expect(isCampaignCollision("not added (Apollo returned no enrolled contact)")).toBe(false);
  });

  it("does not crash on a missing or non-string reason", () => {
    expect(isCampaignCollision(null)).toBe(false);
    expect(isCampaignCollision(undefined)).toBe(false);
    expect(isCampaignCollision({ reason: "x" })).toBe(false);
  });
});

describe("campaignsToRelease", () => {
  it("releases the TARGET sequence when that is the only membership", () => {
    // The dominant real case: 7 of 12 sampled contacts were blocked by the very sequence we
    // were enrolling them into, despite Apollo saying "other campaigns".
    const contact = { contact_campaign_statuses: [finished(SEQ_LBA)] };
    expect(campaignsToRelease(contact)).toEqual({ release: [SEQ_LBA], blockedBy: null });
  });

  it("releases every finished membership, including ones our own ledger never saw", () => {
    const contact = { contact_campaign_statuses: [finished(SEQ_LBA), finished(SEQ_AGC)] };
    expect(campaignsToRelease(contact).release).toEqual([SEQ_LBA, SEQ_AGC]);
  });

  it("refuses when the contact is mid-sequence somewhere", () => {
    const contact = {
      contact_campaign_statuses: [finished(SEQ_LBA), { emailer_campaign_id: SEQ_AGC, status: "active" }],
    };
    expect(campaignsToRelease(contact)).toEqual({ release: [], blockedBy: "active" });
  });

  it("refuses a contact Apollo marked failed because they REPLIED", () => {
    // Observed live: status 'failed', reason "Contact stage is Replied". That is a live
    // conversation, and dropping a cold sequence on it would be the worst outcome here.
    const contact = {
      contact_campaign_statuses: [
        { emailer_campaign_id: SEQ_LBA, status: "failed", inactive_reason: "Contact stage is Replied." },
      ],
    };
    expect(campaignsToRelease(contact)).toEqual({ release: [], blockedBy: "failed" });
  });

  it("refuses a paused membership", () => {
    const contact = { contact_campaign_statuses: [{ emailer_campaign_id: SEQ_LBA, status: "paused" }] };
    expect(campaignsToRelease(contact)).toEqual({ release: [], blockedBy: "paused" });
  });

  it("de-duplicates repeat memberships of the same campaign", () => {
    const contact = { contact_campaign_statuses: [finished(SEQ_LBA), finished(SEQ_LBA)] };
    expect(campaignsToRelease(contact).release).toEqual([SEQ_LBA]);
  });

  it("refuses when Apollo shows no membership at all rather than retrying blindly", () => {
    expect(campaignsToRelease({ contact_campaign_statuses: [] }).blockedBy).toBe(
      "no_campaign_membership_visible",
    );
    expect(campaignsToRelease({}).blockedBy).toBe("no_campaign_membership_visible");
    expect(campaignsToRelease(null).blockedBy).toBe("no_campaign_membership_visible");
  });

  it("refuses when finished memberships carry no campaign id", () => {
    const contact = { contact_campaign_statuses: [{ status: "finished" }] };
    expect(campaignsToRelease(contact)).toEqual({ release: [], blockedBy: "no_campaign_ids" });
  });
});

describe("lastSendDaysAgo", () => {
  const NOW = Date.parse("2026-09-03T12:00:00Z");

  it("reports the most recent send, not the first", () => {
    const sends = [
      { sent_at: "2026-07-02T09:00:00Z" },
      { sent_at: "2026-08-27T09:00:00Z" },
      { sent_at: "2026-08-01T09:00:00Z" },
    ];
    expect(lastSendDaysAgo(sends, NOW)).toBe(7);
  });

  it("returns null when nothing is dated, so the caller cannot read it as 0 days", () => {
    // 0 would mean "emailed today" and would block a release that should be allowed.
    expect(lastSendDaysAgo([], NOW)).toBeNull();
    expect(lastSendDaysAgo(null, NOW)).toBeNull();
    expect(lastSendDaysAgo([{ sent_at: null }], NOW)).toBeNull();
  });

  it("ignores unparseable dates rather than returning NaN", () => {
    const sends = [{ sent_at: "not a date" }, { sent_at: "2026-08-04T12:00:00Z" }];
    expect(lastSendDaysAgo(sends, NOW)).toBe(30);
  });

  it("accepts Date objects, which is what pg returns for a timestamp column", () => {
    expect(lastSendDaysAgo([{ sent_at: new Date("2026-08-20T12:00:00Z") }], NOW)).toBe(14);
  });
});
