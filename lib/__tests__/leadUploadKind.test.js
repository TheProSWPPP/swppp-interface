import { describe, it, expect } from "vitest";
import { normalizeLeadCsv, toCsv } from "../leadCsvNormalize.js";
import {
  readUploadKind, checkUploadKind,
  BID_SHEET_WRONG_FILE, PROJECT_LIST_WRONG_FILE, BID_SHEET_BAD_ORIGIN,
} from "../leadUploadKind.js";

// Real headers from the two sheets.
const BC_HEADERS = ["Manual Sent","Auto Sent","Bid Date","Project Title","Quick Link","Company","Contact Name","Primary Email","Secondary email","Notes"];
const CC_HEADERS = ["Manual Sent","Drafted","Bid Date","Project Title","Start Date","Quick Link","Company","Contact Name","Primary Email","Secondary Email","Phone","Notes"];
const CMD_HEADERS = ["Bid Date","Project Title","City + State","Quick Link","Start","Stage","Winning Bidder","Phone","Email","Name","Notes","Confirmed Value"];

const bc = (extra = []) => normalizeLeadCsv(toCsv([
  [...BC_HEADERS, ...extra],
  ["", "", "10/1/2026", "Tower A", "https://app.buildingconnected.com/opportunities/1", "Acme GC", "Pat", "pat@acme.com", "", "", ...extra.map(() => "")],
  ["", "", "10/2/2026", "Tower B", "", "Beta GC", "Sam", "sam@beta.com", "", "", ...extra.map(() => "")],
]));
const cc = () => normalizeLeadCsv(toCsv([
  CC_HEADERS,
  ["", "", "10/1/2026", "Depot", "11/1/2026", "https://app.constructconnect.com/x", "Gamma", "Lee", "lee@gamma.com", "", "", ""],
]));
const cmd = () => normalizeLeadCsv(toCsv([
  CMD_HEADERS,
  ["10/1/2026", "Warehouse", "Austin, TX", "https://cmdgroup.com/p/1", "11/1/2026", "Planning", "Delta", "555", "d@delta.com", "Dee", "", "1000000"],
]));

describe("readUploadKind", () => {
  it("returns null for absent or blank values", () => {
    expect(readUploadKind(undefined)).toBeNull();
    expect(readUploadKind(null)).toBeNull();
    expect(readUploadKind("  ")).toBeNull();
  });
  it("returns the trimmed value otherwise", () => {
    expect(readUploadKind(" bid_sheet ")).toBe("bid_sheet");
  });
});

describe("checkUploadKind: bid_sheet", () => {
  it("accepts the BuildingConnected tracker", () => {
    expect(bc().source).toBe("bid-aggregator");
    expect(checkUploadKind("bid_sheet", bc())).toEqual({ ok: true });
  });
  it("accepts the ConstructConnect tracker", () => {
    expect(checkUploadKind("bid_sheet", cc())).toEqual({ ok: true });
  });
  it("rejects a CMD project list with 400 and the redirect message", () => {
    expect(checkUploadKind("bid_sheet", cmd())).toEqual({ ok: false, status: 400, error: BID_SHEET_WRONG_FILE });
    expect(BID_SHEET_WRONG_FILE).toBe("This doesn't look like the bid tracker. Use Upload project list.");
  });
  it("rejects an unrecognised file", () => {
    const unknown = normalizeLeadCsv("foo,bar\n1,2\n");
    expect(unknown.source).toBe("unknown");
    expect(checkUploadKind("bid_sheet", unknown)).toMatchObject({ ok: false, status: 400 });
  });
  it("keeps the per-platform origin values and rejects a tracker whose own Lead Origin column says otherwise", () => {
    const n = bc();
    expect(n.csv).toContain("Bid Invite: BuildingConnected");
    const tampered = normalizeLeadCsv(toCsv([
      [...BC_HEADERS, "Lead Origin"],
      ["", "", "10/1/2026", "Tower A", "", "Acme GC", "Pat", "pat@acme.com", "", "", "CMD"],
    ]));
    expect(tampered.source).toBe("bid-aggregator");
    expect(checkUploadKind("bid_sheet", tampered)).toEqual({ ok: false, status: 400, error: BID_SHEET_BAD_ORIGIN });
  });
  it("accepts a tracker that already carries Bid Invite origins", () => {
    const pre = normalizeLeadCsv(toCsv([
      [...BC_HEADERS, "Lead Origin"],
      ["", "", "10/1/2026", "Tower A", "", "Acme GC", "Pat", "pat@acme.com", "", "", "Bid Invite: iSqFt"],
    ]));
    expect(checkUploadKind("bid_sheet", pre)).toEqual({ ok: true });
  });
});

describe("checkUploadKind: project_list", () => {
  it("accepts the CMD sheet", () => {
    expect(checkUploadKind("project_list", cmd())).toEqual({ ok: true });
  });
  it("rejects either tracker with 400 and the redirect message", () => {
    expect(checkUploadKind("project_list", bc())).toEqual({ ok: false, status: 400, error: PROJECT_LIST_WRONG_FILE });
    expect(checkUploadKind("project_list", cc())).toMatchObject({ ok: false, status: 400 });
    expect(PROJECT_LIST_WRONG_FILE).toBe("This looks like the estimator's bid tracker. Use Upload bid sheet.");
  });
  it("passes an unrecognised file through exactly as before", () => {
    expect(checkUploadKind("project_list", normalizeLeadCsv("foo,bar\n1,2\n"))).toEqual({ ok: true });
  });
});

describe("checkUploadKind: no kind (older clients, n8n)", () => {
  it("accepts every sheet type unchanged", () => {
    for (const n of [bc(), cc(), cmd(), normalizeLeadCsv("foo,bar\n1,2\n")]) {
      expect(checkUploadKind(null, n)).toEqual({ ok: true });
    }
  });
});

describe("checkUploadKind: bad kind", () => {
  it("rejects a value that is not one of the two kinds", () => {
    expect(checkUploadKind("auto", cmd())).toMatchObject({ ok: false, status: 400 });
  });
});
