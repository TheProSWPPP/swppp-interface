import { describe, it, expect } from "vitest";
import { scoreFacility } from "../permitScoring.js";

describe("scoreFacility", () => {
  it("scores a recent multi-facility operator higher than an old single-site one", () => {
    const recent = scoreFacility({ original_issue_date: "2024-01-01", facility_count: 5 }, { now: "2026-06-15" });
    const old = scoreFacility({ original_issue_date: "2010-01-01", facility_count: 1 }, { now: "2026-06-15" });
    expect(recent).toBeGreaterThan(old);
  });
  it("returns a finite number even with missing fields", () => {
    const s = scoreFacility({}, { now: "2026-06-15" });
    expect(Number.isFinite(s)).toBe(true);
  });
  it("applies sector and compliance boosts when present (forward-compat)", () => {
    const base = scoreFacility({ original_issue_date: "2015-01-01", facility_count: 1 }, { now: "2026-06-15" });
    const boosted = scoreFacility(
      { original_issue_date: "2015-01-01", facility_count: 1, sector_weight: 10, compliance_pain: 20 },
      { now: "2026-06-15" }
    );
    expect(boosted).toBeGreaterThan(base);
  });
});
