import { describe, expect, it } from "vitest";
import { complianceFreshness, permitDate } from "./permitApi";

describe("permit dates", () => {
  it("shows calendar dates in plain form", () => {
    expect(permitDate("2026-08-13T00:00:00.000Z")).toBe("Aug 13, 2026");
    expect(permitDate("2026-08-13")).toBe("Aug 13, 2026");
    expect(permitDate(null)).toBe("—");
  });
  it("explains stale compliance data without asking staff to run anything", () => {
    const f = complianceFreshness("2026-06-23", new Date("2026-10-26T15:00:00Z"));
    expect(f?.stale).toBe(true);
    expect(f?.text).toBe("EPA compliance data last updated Jun 23, 2026 (4 months ago). Violation details may be out of date; check the EPA record before quoting them.");
    expect(f?.text).not.toMatch(/refresh/i);
    expect(complianceFreshness("2026-10-20", new Date("2026-10-26T15:00:00Z"))).toEqual({ stale: false, text: "EPA compliance data last updated Oct 20, 2026 (6 days ago)." });
    expect(complianceFreshness(null)).toBeNull();
  });
});
