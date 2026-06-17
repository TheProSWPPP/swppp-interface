import { describe, it, expect } from "vitest";
import { parseEchoSummary, compliancePain } from "../echoCompliance.js";

describe("parseEchoSummary", () => {
  it("extracts violation counts from the ECHO get_facilities Results block", () => {
    const json = { Results: { QueryRows: "1", SVRows: "2", CVRows: "1", VioLast4QRows: "3", INSPRows: "4", TotalPenalties: "$1,500" } };
    expect(parseEchoSummary(json)).toEqual({ found: true, sv: 2, cv: 1, vioLast4Q: 3, insp: 4, penalties: 1500 });
  });

  it("treats a permit not in ECHO (QueryRows 0) as found:false with zeros", () => {
    const json = { Results: { QueryRows: "0" } };
    expect(parseEchoSummary(json)).toEqual({ found: false, sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0 });
  });

  it("defaults missing keys and a malformed body to zeros without throwing", () => {
    expect(parseEchoSummary({})).toEqual({ found: false, sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0 });
    expect(parseEchoSummary(null)).toEqual({ found: false, sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0 });
  });
});

describe("compliancePain", () => {
  it("scores a current violation as the hottest", () => {
    expect(compliancePain({ vioLast4Q: 1, cv: 0, sv: 0, insp: 1 })).toBe(14);
  });
  it("adds significant-violation weight on top of a current violation, capped at 20", () => {
    expect(compliancePain({ vioLast4Q: 5, cv: 2, sv: 9, insp: 9 })).toBe(20);
  });
  it("returns 0 for a clean, never-inspected facility", () => {
    expect(compliancePain({ vioLast4Q: 0, cv: 0, sv: 0, insp: 0 })).toBe(0);
  });
  it("gives a small bump for inspection history alone", () => {
    expect(compliancePain({ vioLast4Q: 0, cv: 0, sv: 0, insp: 3 })).toBe(2);
  });
});
