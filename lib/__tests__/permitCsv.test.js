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

  it("formats a Date object as YYYY-MM-DD (pg returns DATE as Date, not string)", () => {
    const csv = buildDirectMailCsv([
      { contact_name: "X", operator_name: "Y", mailing_address: "1 Main St, Austin TX 78701", city: "AUSTIN",
        external_permit_nmbr: "TXR05BB01", expiration_date: new Date(Date.UTC(2026, 7, 13)) },
    ]);
    expect(csv).toContain("2026-08-13");
    expect(csv).not.toMatch(/Aug|Thu/);
  });

  it("returns just the header for an empty list", () => {
    expect(buildDirectMailCsv([]).trim()).toBe("contact_name,operator_name,mailing_address,city,permit_number,permit_expires,deadline_hook");
  });

  it("drops non-mailable rows whose address is a narrative site description (no ZIP)", () => {
    const csv = buildDirectMailCsv([
      { contact_name: "REAL ONE", operator_name: "Op A", mailing_address: "PO BOX 5 AUSTIN TX 78701",
        city: "AUSTIN", external_permit_nmbr: "TXR05AA01", expiration_date: "2026-08-13" },
      { contact_name: null, operator_name: "Vulcan", mailing_address: "LOCATED APPROX 1.5 MILES EAST OF THE INTX OF US 90 & FM 1022",
        city: null, external_permit_nmbr: "TXR05GZ69", expiration_date: "2026-08-13" },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // header + the one mailable row
    expect(csv).toContain("TXR05AA01");
    expect(csv).not.toContain("TXR05GZ69");
  });

  it("falls back to a generic addressee when contact_name is missing (mail still routes)", () => {
    const csv = buildDirectMailCsv([
      { contact_name: null, operator_name: "Brenntag Southwest, LLC", mailing_address: "108 E 67TH ST ODESSA TX 79762",
        city: "ODESSA", external_permit_nmbr: "TXR05HA24", expiration_date: "2026-08-13" },
    ]);
    const row = csv.trim().split("\n")[1];
    expect(row.startsWith("SWPPP / Environmental Manager,")).toBe(true);
    expect(row).toContain("Brenntag Southwest");
  });
});
