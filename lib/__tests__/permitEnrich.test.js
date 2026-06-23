import { describe, it, expect } from "vitest";
import { enrichOne, enrichBatch } from "../permitEnrich.js";

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

describe("enrichBatch", () => {
  function batchPool(selectRows) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT external_permit_nmbr/i.test(sql)) return { rows: selectRows, rowCount: selectRows.length };
        return { rows: [], rowCount: 1 };
      },
    };
  }

  it("scope 'all' selects one permit per not-yet-enriched operator", async () => {
    const pool = batchPool([{ external_permit_nmbr: "TXR05A" }]);
    const res = await enrichBatch(pool, { scope: "all", cap: 10, delayMs: 0, fetcher: async () => null });
    const sel = pool.calls.find((c) => /SELECT external_permit_nmbr/i.test(c.sql));
    expect(sel.sql).toMatch(/DISTINCT ON \(f\.operator_key\)/i);
    expect(sel.sql).toMatch(/NOT EXISTS/i);
    expect(res.processed).toBe(1);
  });

  it("skips phone-find when APOLLO_API_KEY is unset (no network in tests)", async () => {
    const had = process.env.APOLLO_API_KEY;
    delete process.env.APOLLO_API_KEY;
    const pool = batchPool([{ external_permit_nmbr: "TXR05DP22" }]);
    const FIXTURE = "Summary of Authorization TXR05DP22\nAuthorization Status:ACTIVE\nOperator:\nCN1 - X, LLC\nAnnual Fee Billing Address:\nJOE\nPO BOX 1 AUSTIN TX 78701\nPrimary SIC Code:\n5093";
    const res = await enrichBatch(pool, { scope: "promoted", cap: 5, delayMs: 0, phoneFind: true, fetcher: async () => FIXTURE });
    expect(res.phones).toBeNull();
    expect(res.ok).toBe(1);
    if (had) process.env.APOLLO_API_KEY = had;
  });
});
