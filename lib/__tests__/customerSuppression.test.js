import { describe, it, expect, afterEach } from "vitest";
import {
  customerMatch,
  customerSuppressionEnabled,
  companyKeyVariants,
  CUSTOMER_LEAD_LABEL_ID,
  CUSTOMER_ORG_LABEL_ID,
} from "../customerSuppression.js";
import { companyKey } from "../permitMatch.js";

// Context: Derek asked on 2026-07-29 to stop drips to existing customers. The signal already
// existed as a Pipedrive label (lead + org), maintained weekly by n8n te0dP1zV1XduMS6B, and
// nothing in the sending path had ever read it. 63 sends to 43 tagged customer companies had
// already gone out.
//
// The load-bearing subtlety: Pipedrive holds ~15,791 org records for ~13,086 distinct company
// names. Crossland Construction has 34 org records and only 3 carry the tag, so matching on
// organization_id catches just 31 of the 63 real cases. These tests pin the name resolution.

const OTHER_LABEL = "7a75991e-f3f3-4510-bc3c-1b987e93ee62"; // "Hot"

const index = {
  orgIds: new Set(["18013", "9001"]),
  keys: new Set([companyKey("Crossland Construction"), companyKey("C&A Construction, LLC")]),
};

afterEach(() => {
  delete process.env.SDR_SUPPRESS_CUSTOMERS;
});

describe("customerMatch", () => {
  it("catches the lead label", () => {
    const m = customerMatch({ label_ids: [CUSTOMER_LEAD_LABEL_ID] }, index);
    expect(m?.matchedOn).toBe("lead_label");
  });

  it("catches the lead's own tagged org", () => {
    const m = customerMatch({ label_ids: [], org_id: 18013 }, index);
    expect(m?.matchedOn).toBe("org_label");
  });

  it("catches a DUPLICATE org record by company name — the Crossland case", () => {
    // Real shape: the lead points at an untagged Crossland copy; 3 of 34 copies carry the tag.
    const m = customerMatch(
      { label_ids: [], org_id: 999999, org_name: "Crossland Construction - Tulsa" },
      index,
    );
    expect(m?.matchedOn).toBe("company_name");
    expect(m?.reason).toContain("Crossland Construction - Tulsa");
  });

  it("normalises legal suffixes, so 'C&A Construction' matches 'C&A Construction, LLC'", () => {
    const m = customerMatch({ label_ids: [], org_id: 42, org_name: "C&A Construction" }, index);
    expect(m?.matchedOn).toBe("company_name");
  });

  it("does not fire on a non-customer lead", () => {
    expect(customerMatch({ label_ids: [OTHER_LABEL], org_id: 555, org_name: "Someone Else Inc" }, index)).toBeNull();
  });

  it("does not fire on an unrelated label alone", () => {
    expect(customerMatch({ label_ids: [OTHER_LABEL] }, index)).toBeNull();
  });

  it("does not fire when there is no org and no label", () => {
    expect(customerMatch({ label_ids: [], org_id: null, org_name: null }, index)).toBeNull();
  });

  it("compares org ids as strings, since Pipedrive returns numbers and pg returns text", () => {
    expect(customerMatch({ org_id: "18013" }, index)?.matchedOn).toBe("org_label");
    expect(customerMatch({ org_id: 18013 }, index)?.matchedOn).toBe("org_label");
  });

  it("tolerates label_ids arriving as null or a non-array", () => {
    expect(customerMatch({ label_ids: null, org_id: 18013 }, index)?.matchedOn).toBe("org_label");
    expect(customerMatch({ label_ids: "nope", org_id: 18013 }, index)?.matchedOn).toBe("org_label");
  });

  it("returns null on missing inputs rather than throwing", () => {
    expect(customerMatch(null, index)).toBeNull();
    expect(customerMatch({ org_id: 1 }, null)).toBeNull();
    expect(customerMatch({ org_id: 1 }, {})).toBeNull();
  });

  it("an empty org name must not match an empty key in the index", () => {
    const dirty = { orgIds: new Set(), keys: new Set([""]) };
    expect(customerMatch({ label_ids: [], org_id: 7, org_name: "" }, dirty)).toBeNull();
    expect(customerMatch({ label_ids: [], org_id: 7, org_name: "   " }, dirty)).toBeNull();
  });

  it("pins the live label ids so a silent constant drift fails loudly", () => {
    expect(CUSTOMER_LEAD_LABEL_ID).toBe("60f8db60-9db4-11ee-98c4-8b14e7552970");
    expect(CUSTOMER_ORG_LABEL_ID).toBe(1);
  });

  it("does NOT bleed across genuinely different companies sharing a first word", () => {
    // Both really exist in Derek's Pipedrive and are different entities.
    const heavyIdx = { orgIds: new Set(), keys: new Set([companyKey("Crossland Heavy Contractors")]) };
    expect(customerMatch({ org_id: 1, org_name: "Crossland Construction" }, heavyIdx)).toBeNull();
  });
});

describe("companyKeyVariants — the branch-record problem", () => {
  it("keys both the full name and the pre-dash base", () => {
    const v = companyKeyVariants("Crossland Construction - Tulsa");
    expect(v.has(companyKey("Crossland Construction - Tulsa"))).toBe(true);
    expect(v.has(companyKey("Crossland Construction"))).toBe(true);
  });

  it("handles the real branch shapes observed in Pipedrive", () => {
    for (const n of [
      "Crossland Construction - Tulsa",
      "Crossland Construction - Columbus (HQ)",
      "Crossland Construction - OKC",
      "Crossland Construction - Rogers",
    ]) {
      expect(companyKeyVariants(n).has(companyKey("Crossland Construction"))).toBe(true);
    }
  });

  it("refuses a single-token base, which would suppress every unrelated match", () => {
    const v = companyKeyVariants("Smith - Partners");
    expect(v.has("smith")).toBe(false);
    expect(v.size).toBe(1);
  });

  it("accepts en dash and em dash as well as hyphen", () => {
    for (const d of ["-", "–", "—"]) {
      expect(companyKeyVariants(`Crossland Construction ${d} Tulsa`).has(companyKey("Crossland Construction"))).toBe(true);
    }
  });

  it("requires whitespace around the dash, so hyphenated names stay intact", () => {
    // "C&A Construction" must not be split on the ampersand-adjacent punctuation, and a real
    // hyphenated company like Louis-Company keeps its identity.
    const v = companyKeyVariants("Louis-Company, LLC");
    expect(v.size).toBe(1);
    expect(v.has(companyKey("Louis-Company, LLC"))).toBe(true);
  });

  it("returns nothing for empty input", () => {
    expect(companyKeyVariants("").size).toBe(0);
    expect(companyKeyVariants(null).size).toBe(0);
    expect(companyKeyVariants("   ").size).toBe(0);
  });
});

describe("customerSuppressionEnabled", () => {
  it("is on by default", () => {
    expect(customerSuppressionEnabled()).toBe(true);
  });

  it("is killable without a redeploy", () => {
    process.env.SDR_SUPPRESS_CUSTOMERS = "off";
    expect(customerSuppressionEnabled()).toBe(false);
  });

  it("any other value leaves it on, so a typo cannot silently disable the gate", () => {
    process.env.SDR_SUPPRESS_CUSTOMERS = "false";
    expect(customerSuppressionEnabled()).toBe(true);
  });
});
