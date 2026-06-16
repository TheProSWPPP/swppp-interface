import { describe, it, expect } from "vitest";
import { buildDirectMailCsv } from "../permitCsv.js";

describe("buildDirectMailCsv", () => {
  it("produces a header + one row per record with the deadline column", () => {
    const csv = buildDirectMailCsv([
      { contact_name: "MARSHALL DAVIS", operator_name: "Stephenville Iron And Metal, LLC",
        mailing_address: "PO BOX 1250, STEPHENVILLE TX 76401", city: "STEPHENVILLE",
        external_permit_nmbr: "TXR05DP22", expiration_date: "2026-08-13" },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("contact_name,operator_name,mailing_address,city,permit_number,permit_expires,deadline_hook");
    expect(lines[1]).toContain("MARSHALL DAVIS");
    expect(lines[1]).toContain("TXR05DP22");
    expect(lines[1]).toContain("2026-08-13");
  });

  it("quotes fields containing commas or quotes (RFC-4180)", () => {
    const csv = buildDirectMailCsv([
      { contact_name: 'JANE "JJ" DOE', operator_name: "Acme, Inc.", mailing_address: "1 Main St, Austin TX 78701",
        city: "AUSTIN", external_permit_nmbr: "TXR05AA01", expiration_date: "2026-08-13" },
    ]);
    expect(csv).toContain('"Acme, Inc."');
    expect(csv).toContain('"JANE ""JJ"" DOE"');
  });

  it("returns just the header for an empty list", () => {
    expect(buildDirectMailCsv([]).trim()).toBe("contact_name,operator_name,mailing_address,city,permit_number,permit_expires,deadline_hook");
  });
});
