import { describe, it, expect } from "vitest";
import { FIELD_KEYS } from "../pipedriveSync.js";

describe("pipedriveSync field map", () => {
  it("knows the Project Value key", () => {
    expect(FIELD_KEYS.PROJECT_VALUE).toBe("63ad9184b6bc1c3bc60bf0a62b4b963e9ea17369");
  });

  it("still knows the Lead Score key it always did", () => {
    expect(FIELD_KEYS.LEAD_SCORE).toBe("e2b854536230112bff77d6b0ce33bdb49f2916eb");
  });

  it("never points Project Value at deal_value, which holds Pro SWPPP's own quote amounts", () => {
    expect(FIELD_KEYS.PROJECT_VALUE).not.toBe("deal_value");
    expect(Object.values(FIELD_KEYS)).not.toContain("deal_value");
  });

  it("keeps every key a distinct 40-char Pipedrive hash", () => {
    const keys = Object.values(FIELD_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{40}$/);
  });
});
