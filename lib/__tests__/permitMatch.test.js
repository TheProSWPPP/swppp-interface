import { describe, it, expect } from "vitest";
import { companyKey, crossRefIndex } from "../permitMatch.js";

describe("companyKey", () => {
  it("normalizes punctuation/case/suffix so variants collide", () => {
    expect(companyKey("Brenntag Southwest, LLC")).toBe(companyKey("BRENNTAG SOUTHWEST LLC"));
    expect(companyKey("")).toBe("");
    expect(companyKey(null)).toBe("");
  });
});

describe("crossRefIndex", () => {
  it("builds a Set of normalized keys via accessor", () => {
    const idx = crossRefIndex([{ name: "Acme, Inc." }, { name: "" }], (r) => r.name);
    expect(idx.has(companyKey("acme inc"))).toBe(true);
    expect(idx.size).toBe(1); // empty name dropped
  });
});
