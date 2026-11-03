import { describe, it, expect } from "vitest";
import { planRetag, DEFAULT_LEAD } from "../../scripts/retag-bid-invite-origin.mjs";

describe("retag-bid-invite-origin plan", () => {
  it("retags a bare short code to the full tag", () => {
    expect(planRetag("BC", "BuildingConnected")).toEqual({ ok: true, from: "BC", to: "Bid Invite: BuildingConnected" });
    expect(planRetag(" cc ", "ConstructConnect")).toMatchObject({ ok: true, to: "Bid Invite: ConstructConnect" });
  });
  it("refuses anything that is not exactly a short code", () => {
    for (const v of ["Bid Invite: BuildingConnected", "CMD", "", null, "BC2"]) {
      expect(planRetag(v, "BuildingConnected").ok).toBe(false);
    }
  });
  it("works out the platform from the code the lead already has", () => {
    expect(planRetag("BC")).toEqual({ ok: true, from: "BC", to: "Bid Invite: BuildingConnected" });
    expect(planRetag("cc", "").to).toBe("Bid Invite: ConstructConnect");
    expect(planRetag("ISQFT").to).toBe("Bid Invite: iSqFt");
    expect(planRetag("Other").to).toBe("Bid Invite: Other");
  });
  it("refuses a --platform that disagrees with the current code", () => {
    const r = planRetag("CC", "BuildingConnected");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("disagrees");
    expect(planRetag("BC", "buildingconnected").ok).toBe(true);
  });
  it("refuses an unknown platform", () => {
    expect(planRetag("BC", "Procore").ok).toBe(false);
  });
  it("targets the lead from the plan by default", () => {
    expect(DEFAULT_LEAD).toBe("21b9e420-b07c-11f1-b582-c7400378b13f");
  });
});
