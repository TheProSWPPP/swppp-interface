import { describe, it, expect } from "vitest";
import { engineGateError } from "../permitGate.js";

describe("engineGateError", () => {
  it("returns null when the engine is active", () => {
    expect(engineGateError({ active: true })).toBeNull();
  });
  it("returns a reason when inactive", () => {
    expect(engineGateError({ active: false })).toBe("Permit engine is inactive — activate it before running this action.");
  });
  it("treats missing/undefined settings as inactive (fail closed)", () => {
    expect(engineGateError(null)).toMatch(/inactive/);
    expect(engineGateError(undefined)).toMatch(/inactive/);
  });
});
