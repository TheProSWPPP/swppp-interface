import { describe, it, expect, afterEach } from "vitest";
import { staleDraftBlock, maxDraftAgeDays, DEFAULT_MAX_DRAFT_AGE_DAYS } from "../draftFreshness.js";

// Context: 2026-07-30. 94 drafts pending, 93 older than 14 days, 51 written on 2026-07-07
// alone, every one still approvable with one click. Nothing in the system stopped them.

const NOW = new Date("2026-07-30T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

afterEach(() => {
  delete process.env.SDR_DRAFT_MAX_AGE_DAYS;
});

describe("staleDraftBlock", () => {
  it("allows a fresh draft", () => {
    expect(staleDraftBlock({ created_at: daysAgo(1) }, { now: NOW })).toBeNull();
  });

  it("allows a draft exactly at the limit", () => {
    expect(staleDraftBlock({ created_at: daysAgo(14) }, { now: NOW })).toBeNull();
  });

  it("blocks the real 2026-07-07 backlog", () => {
    const block = staleDraftBlock({ created_at: new Date("2026-07-07T09:00:00Z") }, { now: NOW });
    expect(block).toEqual({ ageDays: 23, maxAgeDays: 14 });
  });

  it("blocks the oldest observed pending draft", () => {
    const block = staleDraftBlock({ created_at: new Date("2026-06-28T22:00:00Z") }, { now: NOW });
    expect(block?.ageDays).toBe(31);
  });

  it("accepts an ISO string as well as a Date, since pg returns both shapes", () => {
    expect(staleDraftBlock({ created_at: "2026-07-07T09:00:00Z" }, { now: NOW })?.ageDays).toBe(23);
  });

  it("fails OPEN on unknown or unparseable age", () => {
    expect(staleDraftBlock({ created_at: null }, { now: NOW })).toBeNull();
    expect(staleDraftBlock({}, { now: NOW })).toBeNull();
    expect(staleDraftBlock(null, { now: NOW })).toBeNull();
    expect(staleDraftBlock({ created_at: "not a date" }, { now: NOW })).toBeNull();
  });

  it("does not block a draft created in the future (clock skew)", () => {
    expect(staleDraftBlock({ created_at: daysAgo(-3) }, { now: NOW })).toBeNull();
  });

  it("honours an explicit maxAgeDays override", () => {
    expect(staleDraftBlock({ created_at: daysAgo(5) }, { now: NOW, maxAgeDays: 3 })?.ageDays).toBe(5);
    expect(staleDraftBlock({ created_at: daysAgo(5) }, { now: NOW, maxAgeDays: 30 })).toBeNull();
  });

  it("is fully disabled by maxAgeDays null, the kill switch", () => {
    expect(staleDraftBlock({ created_at: daysAgo(400) }, { now: NOW, maxAgeDays: null })).toBeNull();
  });
});

describe("maxDraftAgeDays", () => {
  it("defaults to 14, matching the contact cooldown already in the system", () => {
    expect(maxDraftAgeDays()).toBe(DEFAULT_MAX_DRAFT_AGE_DAYS);
    expect(DEFAULT_MAX_DRAFT_AGE_DAYS).toBe(14);
  });

  it("reads a numeric override from the environment", () => {
    process.env.SDR_DRAFT_MAX_AGE_DAYS = "7";
    expect(maxDraftAgeDays()).toBe(7);
  });

  it("treats 'off' as a kill switch", () => {
    process.env.SDR_DRAFT_MAX_AGE_DAYS = "off";
    expect(maxDraftAgeDays()).toBeNull();
  });

  it("falls back to the default on junk or non-positive input rather than disabling itself", () => {
    for (const junk of ["", "   ", "abc", "0", "-5"]) {
      process.env.SDR_DRAFT_MAX_AGE_DAYS = junk;
      expect(maxDraftAgeDays()).toBe(DEFAULT_MAX_DRAFT_AGE_DAYS);
    }
  });
});
