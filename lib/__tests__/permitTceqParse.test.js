import { describe, it, expect } from "vitest";
import { parseTceqDetail } from "../permitTceqParse.js";

// Real production shape: TCEQ returns raw HTML with <label>/<br> tags (plain fetch).
const HTML_FIXTURE = `<html><body>
<h2>Summary of Authorization TXR05HA27</h2>
<fieldset><legend>Authorization Details</legend>
<p><label>Authorization Status:</label>ACTIVE</p>
<p><label>Site Name on Permit:</label>AUBRYE PIT</p>
<p><label>Primary SIC Code:</label>1442</p>
<p><label>Operator:</label>CN605614999 - Moriah TFS Operations, LLC</p>
<p><label>Address:</label><br></label>PO BOX 52910 MIDLAND TX 79710 2910 </p>
<p><label>Annual Fee Billing Address:</label>
  SOMMER AHRENS
  <br>
  <label>&nbsp;</label>
  PO BOX 52910 MIDLAND TX 79710 2910 </p>
</fieldset>
<fieldset><legend>Permitted Site Information</legend>
<p><label>RN:</label>RN111449708</p>
<p><label>Site Location:</label>123 COUNTY RD MIDLAND TX 79706 1000</p>
</fieldset>
</body></html>`;

const FIXTURE = `Water Quality General Permits Search
Summary of Authorization TXR05DP22
Permit Number:TXR05DP22
Authorization Status:ACTIVE
Date Coverage Began:08/03/2017
Site Name on Permit:STEPHENVILLE IRON AND METAL
Authorization Type:INDUSTRIAL
Primary SIC Code:
5093
sector :
N
Operator:
CN605404029 - Stephenville Iron And Metal, LLC
Address:
PO BOX 1250 STEPHENVILLE TX 76401 0012
Annual Fee Billing Address:
MARSHALL DAVIS
PO BOX 1250 STEPHENVILLE TX 76401 0012
Permitted Site Information
RN:RN109885749
Site Location:
3229 N US HIGHWAY 377 STEPHENVILLE TX 76401 1514
County:ERATH`;

describe("parseTceqDetail", () => {
  it("extracts the core fields", () => {
    const r = parseTceqDetail(FIXTURE, "TXR05DP22");
    expect(r.permit).toBe("TXR05DP22");
    expect(r.status).toBe("ACTIVE");
    expect(r.site_name).toBe("STEPHENVILLE IRON AND METAL");
    expect(r.operator_name).toBe("Stephenville Iron And Metal, LLC");
    expect(r.customer_number).toBe("CN605404029");
    expect(r.contact_name).toBe("MARSHALL DAVIS");
    expect(r.sic_code).toBe("5093");
    expect(r.mailing_address).toContain("PO BOX 1250");
    expect(r.mailing_address).toContain("STEPHENVILLE TX 76401");
    expect(r.city).toBe("STEPHENVILLE");
    expect(r.zip).toBe("76401");
  });

  it("returns nulls (not throws) when the billing contact is absent", () => {
    const r = parseTceqDetail("Summary of Authorization TXR05XX99\nPermit Number:TXR05XX99\nAuthorization Status:ACTIVE\nSite Name on Permit:SOME PIT", "TXR05XX99");
    expect(r.permit).toBe("TXR05XX99");
    expect(r.contact_name).toBeNull();
    expect(r.mailing_address).toBeNull();
  });

  it("returns a found=false marker when the page isn't a valid authorization", () => {
    const r = parseTceqDetail("No authorization found", "TXR05NONE");
    expect(r.found).toBe(false);
  });

  it("parses real raw HTML (production plain-fetch shape) without tag leakage", () => {
    const r = parseTceqDetail(HTML_FIXTURE, "TXR05HA27");
    expect(r.found).toBe(true);
    expect(r.status).toBe("ACTIVE");
    expect(r.site_name).toBe("AUBRYE PIT");
    expect(r.operator_name).toBe("Moriah TFS Operations, LLC");
    expect(r.customer_number).toBe("CN605614999");
    expect(r.contact_name).toBe("SOMMER AHRENS");
    expect(r.sic_code).toBe("1442");
    expect(r.mailing_address).toContain("PO BOX 52910 MIDLAND TX 79710");
    expect(r.city).toBe("MIDLAND");
    expect(r.zip).toBe("79710");
    // no HTML tags leaked into any field
    const blob = JSON.stringify(r);
    expect(blob).not.toMatch(/<|>|label|&nbsp;/i);
  });
});
