import { describe, it, expect } from "vitest";
import { isActiveNoi, operatorKey, shapeFacility } from "../permitIngest.js";

describe("isActiveNoi", () => {
  it("keeps active TXR05 NOI records", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXR05DP22", permit_status_code: "EFF" })).toBe(true);
  });
  it("drops NEC (TXRNE prefix) even if active", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXRNEU482", permit_status_code: "EFF" })).toBe(false);
  });
  it("drops expired/terminated records", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXR05BB10", permit_status_code: "EXP" })).toBe(false);
    expect(isActiveNoi({ external_permit_nmbr: "TXR05BB10", permit_status_code: "TRM" })).toBe(false);
  });
  it("is case-insensitive on status and tolerant of missing fields", () => {
    expect(isActiveNoi({ external_permit_nmbr: "TXR05BB10", permit_status_code: "eff" })).toBe(true);
    expect(isActiveNoi({})).toBe(false);
  });
});

describe("operatorKey", () => {
  it("normalizes case, punctuation, and legal suffixes so dupes collapse", () => {
    expect(operatorKey("Uvalde Concrete, LLC")).toBe(operatorKey("UVALDE CONCRETE LLC"));
    expect(operatorKey("K.A.T. Excavation & Construction Inc.")).toBe(
      operatorKey("KAT EXCAVATION & CONSTRUCTION INC")
    );
  });
  it("returns empty string for missing names", () => {
    expect(operatorKey(null)).toBe("");
    expect(operatorKey("")).toBe("");
  });
});

describe("shapeFacility", () => {
  it("maps an EPA row to our facility record shape", () => {
    const f = shapeFacility({
      external_permit_nmbr: "TXR05DP22",
      permit_name: "Stephenville Iron And Metal, LLC",
      permit_status_code: "EFF",
      effective_date: "2021-12-01 00:00:00",
      expiration_date: "2026-08-13 00:00:00",
      original_issue_date: "2017-03-31 00:00:00",
    });
    expect(f).toMatchObject({
      external_permit_nmbr: "TXR05DP22",
      master_permit: "TXR050000",
      state: "TX",
      operator_name: "Stephenville Iron And Metal, LLC",
      coverage_type: "NOI",
      status: "pool",
    });
    expect(f.operator_key).toBe(operatorKey("Stephenville Iron And Metal, LLC"));
    expect(f.expiration_date).toBe("2026-08-13");
  });
});
