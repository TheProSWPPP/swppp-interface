import { describe, it, expect } from "vitest";
import { normalizePhone } from "../permitPhoneFind.js";
import { buildLeadsCsv } from "../permitLeadsCsv.js";

describe("normalizePhone", () => {
  it("normalizes assorted formats to (XXX) XXX-XXXX", () => {
    expect(normalizePhone("+12102081880")).toBe("(210) 208-1880");
    expect(normalizePhone("(713) 375-3700")).toBe("(713) 375-3700");
    expect(normalizePhone("936.639.2215")).toBe("(936) 639-2215");
    expect(normalizePhone("2812775404")).toBe("(281) 277-5404");
  });
  it("rejects junk / non-US-10-digit", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("NONE")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("000-000-0000")).toBeNull();
    expect(normalizePhone("(123) 555-1212")).toBeNull(); // 555 exchange
  });
});

describe("buildLeadsCsv", () => {
  it("emits header + one row, parses city/state/zip, quotes commas", () => {
    const csv = buildLeadsCsv([{
      operator_name: "Alamo Concrete Products, LLC", facility_count: 5, best_score: "27.00",
      permit_number: "TXR05DX15", all_permit_numbers: "TXR05DX15; TXR05Z765",
      contact_name: "Jane Doe", mailing_address: "100 MAIN ST SAN ANTONIO TX 78249 1890",
      tceq_status: "ACTIVE", customer_number: "CN123", sector: "D",
      phone: "(210) 208-1880",
      has_viol: true, viol_q: 2, penalties: 0,
    }]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("permit_number");
    expect(lines[0]).toContain("phone");
    expect(lines[0]).not.toContain("email");        // email dropped
    expect(lines[0]).not.toContain("phone_source"); // source dropped
    expect(lines[1]).toContain('"Alamo Concrete Products, LLC",TXR05DX15,5,'); // name, permit#, count
    expect(lines[1]).toContain("TXR05DX15; TXR05Z765"); // all permits (semicolon list, no comma so unquoted)
    expect(lines[1]).toContain("SAN ANTONIO,TX,78249");
    expect(lines[1]).toContain("(210) 208-1880");
  });
  it("leaves city/zip blank for a narrative (non-mailable) address", () => {
    const csv = buildLeadsCsv([{
      operator_name: "Vulcan", facility_count: 1, permit_number: "TXR05AA01", mailing_address: "LOCATED APPROX 1.5 MILES EAST OF US 90",
      has_viol: false,
    }]);
    // operator_name, permit_number, num_permits, all_permits(empty), violation(N)...
    expect(csv.trim().split("\n")[1]).toContain("Vulcan,TXR05AA01,1,,N,");
  });
});
