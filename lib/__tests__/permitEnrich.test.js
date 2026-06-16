import { describe, it, expect } from "vitest";
import { enrichOne } from "../permitEnrich.js";

// minimal fake pg pool capturing queries
function fakePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; },
  };
}

const FIXTURE = `Summary of Authorization TXR05DP22
Authorization Status:ACTIVE
Site Name on Permit:STEPHENVILLE IRON AND METAL
Operator:
CN605404029 - Stephenville Iron And Metal, LLC
Annual Fee Billing Address:
MARSHALL DAVIS
PO BOX 1250 STEPHENVILLE TX 76401 0012
Permitted Site Information
Primary SIC Code:
5093`;

describe("enrichOne", () => {
  it("fetches, parses, and writes enrichment + facility update", async () => {
    const pool = fakePool();
    const fetcher = async () => FIXTURE;
    const res = await enrichOne(pool, "TXR05DP22", { fetcher });
    expect(res.ok).toBe(true);
    expect(res.contact_name).toBe("MARSHALL DAVIS");
    const sqls = pool.calls.map((c) => c.sql).join(" ");
    expect(sqls).toMatch(/INSERT INTO permit_enrichment/i);
    expect(sqls).toMatch(/UPDATE permit_facilities/i);
  });

  it("marks not-found without throwing when TCEQ has no record", async () => {
    const pool = fakePool();
    const fetcher = async () => "No authorization found";
    const res = await enrichOne(pool, "TXR05NONE", { fetcher });
    expect(res.ok).toBe(false);
  });

  it("returns ok:false when the fetch returns null", async () => {
    const pool = fakePool();
    const fetcher = async () => null;
    const res = await enrichOne(pool, "TXR05X", { fetcher });
    expect(res.ok).toBe(false);
  });
});
