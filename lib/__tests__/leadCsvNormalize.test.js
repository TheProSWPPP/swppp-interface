import { describe, it, expect } from "vitest";
import { detectSource, parseProjectValue, normalizeLeadCsv, parseCsv, detectPlatform, platformFromColumn, parseBidDate } from "../leadCsvNormalize.js";
import { checkUploadKind } from "../leadUploadKind.js";

// Measured 2026-08-03 against the two real sheets.
// MBT JUL 2026.xlsx  -> canonical CMD shape + a new "Confirmed Value" column L
// Multi Bid BC iSQFT CC Tracker.xlsx -> 3 renames, 4 columns absent
const CMD_HEADERS = ["Bid Date","Project Title","City + State","Quick Link","Start","Stage","Winning Bidder","Phone","Email","Name","Notes","Confirmed Value"];
const AGG_HEADERS = ["Manual Sent","Auto Sent","Bid Date","Project Title","Quick Link","Company","Contact Name","Primary Email","Secondary email","Notes"];

describe("detectSource", () => {
  it("recognises the CMD sheet", () => {
    expect(detectSource(CMD_HEADERS)).toBe("cmd");
  });

  it("recognises the aggregator sheet by its renamed columns", () => {
    expect(detectSource(AGG_HEADERS)).toBe("bid-aggregator");
  });

  it("still recognises CMD without the new value column, so June-style files keep working", () => {
    expect(detectSource(CMD_HEADERS.filter((h) => h !== "Confirmed Value"))).toBe("cmd");
  });

  it("tolerates the extra columns each sheet actually carries", () => {
    // June 2026 shipped a "Drafted in Outlook" column; it imported fine.
    expect(detectSource([...CMD_HEADERS, "Drafted in Outlook"])).toBe("cmd");
  });

  it("returns unknown rather than guessing", () => {
    expect(detectSource(["foo", "bar"])).toBe("unknown");
  });

  it("does not crash on null or empty input", () => {
    expect(detectSource(null)).toBe("unknown");
    expect(detectSource([])).toBe("unknown");
  });
});

describe("parseProjectValue", () => {
  it("parses a plain number", () => {
    expect(parseProjectValue("1171783")).toBe(1171783);
  });

  it("strips currency formatting", () => {
    expect(parseProjectValue("$1,171,783.00")).toBe(1171783);
  });

  it("maps the real junk values to null, NOT zero", () => {
    // 'na' and 'No update' appear in column L. Zero would collect the sub-$500k penalty.
    expect(parseProjectValue("na")).toBeNull();
    expect(parseProjectValue("No update")).toBeNull();
    expect(parseProjectValue("")).toBeNull();
    expect(parseProjectValue(null)).toBeNull();
    expect(parseProjectValue("   ")).toBeNull();
  });

  it("rejects a negative or zero amount rather than storing it", () => {
    expect(parseProjectValue("0")).toBeNull();
    expect(parseProjectValue("-5000")).toBeNull();
  });

  it("keeps the real extremes of the July sheet", () => {
    expect(parseProjectValue("2774")).toBe(2774);
    expect(parseProjectValue("464000000")).toBe(464000000);
  });
});

describe("normalizeLeadCsv", () => {
  it("passes a CMD file through untouched apart from tagging the source", () => {
    const csv = "Bid Date,Project Title,City + State,Quick Link,Start,Stage,Winning Bidder,Phone,Email,Name,Notes,Confirmed Value\n46204,The Junction,\"Wagoner, OK\",http://x,46265,PB,TekTone Builders,(918)-695-9461,d@x.com,Derrick,MB,1171783\n";
    const out = normalizeLeadCsv(csv);
    expect(out.source).toBe("cmd");
    expect(out.renamed).toEqual([]);
    expect(out.csv.split("\n")[0]).toContain("Confirmed Value");
    expect(out.csv.split("\n")[0]).toContain("Lead Origin");
    expect(out.csv.split("\n")[1]).toContain("CMD");
  });

  it("renames the aggregator columns and injects the missing ones", () => {
    const csv = "Manual Sent,Auto Sent,Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Secondary email,Notes\nNo,46144,46145,City Hall Addition,http://bc,Frost Contracting Services LLC,RJ Frost,rj@frost.com,,\n";
    const out = normalizeLeadCsv(csv);
    expect(out.source).toBe("bid-aggregator");
    expect(out.renamed.sort()).toEqual(["Company", "Contact Name", "Primary Email"]);
    const header = out.csv.split("\n")[0];
    for (const h of ["Winning Bidder", "Name", "Email", "Stage", "Phone", "City + State", "Start", "Lead Origin"]) {
      expect(header).toContain(h);
    }
    expect(header).not.toContain("Primary Email");
  });

  it("sets Stage to Bid Invite on every aggregator row, so no cold sequence or CMD lookup matches", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,http://bc,Frost,RJ,rj@frost.com,\n46146,Y,http://bc2,Acme,Jo,jo@acme.com,\n";
    const out = normalizeLeadCsv(csv);
    const rows = parseCsv(out.csv);
    const stageIdx = rows[0].indexOf("Stage");
    expect(rows.slice(1).every((r) => r[stageIdx] === "Bid Invite")).toBe(true);
    expect(out.injected).toContain("Stage");
  });

  it("tags aggregator rows as Bid Invite so the scorer can pay them 50", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,http://bc,Frost,RJ,rj@frost.com,\n";
    const out = normalizeLeadCsv(csv);
    const cols = out.csv.split("\n")[0].split(",");
    const idx = cols.indexOf("Lead Origin");
    expect(out.csv.trim().split("\n")[1].split(",")[idx]).toBe("Bid Invite");
  });

  it("leaves an unknown file completely alone so nothing is silently mangled", () => {
    const csv = "foo,bar\n1,2\n";
    const out = normalizeLeadCsv(csv);
    expect(out.source).toBe("unknown");
    expect(out.csv).toBe(csv);
    expect(out.renamed).toEqual([]);
  });

  it("does not crash on a header-only file", () => {
    const out = normalizeLeadCsv("foo,bar\n");
    expect(out.source).toBe("unknown");
  });

  it("preserves quoted fields containing commas", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,\"Hall, Phase 2\",http://bc,Frost,RJ,rj@frost.com,\n";
    const out = normalizeLeadCsv(csv);
    expect(out.csv).toContain('"Hall, Phase 2"');
  });

  it("does not double-append Lead Origin if the sheet already has one", () => {
    const csv = "Bid Date,Project Title,City + State,Quick Link,Start,Stage,Winning Bidder,Phone,Email,Name,Notes,Lead Origin\n46204,X,\"A, B\",http://x,46265,PB,TekTone,555,d@x.com,D,MB,CMD\n";
    const out = normalizeLeadCsv(csv);
    const cols = out.csv.split("\n")[0].split(",");
    expect(cols.filter((c) => c === "Lead Origin").length).toBe(1);
  });
});

describe("Project Value column (the machine-readable twin n8n writes from)", () => {
  const cmd = (confirmedValue) =>
    `Bid Date,Project Title,City + State,Quick Link,Start,Stage,Winning Bidder,Phone,Email,Name,Notes,Confirmed Value\n46204,X,"A, B",http://x,46265,PB,TekTone,555,d@x.com,D,MB,${confirmedValue}\n`;
  const valueOf = (csv) => {
    const rows = parseCsv(normalizeLeadCsv(csv).csv);
    return rows[1][rows[0].indexOf("Project Value")];
  };

  it("emits a bare number n8n can Number() directly", () => {
    expect(valueOf(cmd("1171783"))).toBe("1171783");
  });

  it("strips currency formatting before n8n ever sees it", () => {
    expect(valueOf(cmd('"$1,171,783.00"'))).toBe("1171783");
  });

  it("emits EMPTY for the junk values, so the n8n ternary yields null not 0", () => {
    expect(valueOf(cmd("na"))).toBe("");
    expect(valueOf(cmd("No update"))).toBe("");
    expect(valueOf(cmd(""))).toBe("");
    expect(valueOf(cmd("0"))).toBe("");
  });

  it("keeps the raw column alongside it so the review screen shows what Derek typed", () => {
    const rows = parseCsv(normalizeLeadCsv(cmd("na")).csv);
    expect(rows[1][rows[0].indexOf("Confirmed Value")]).toBe("na");
    expect(rows[1][rows[0].indexOf("Project Value")]).toBe("");
  });

  it("is empty on the aggregator sheet, which has no value column at all", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,http://bc,Frost,RJ,rj@frost.com,\n";
    const rows = parseCsv(normalizeLeadCsv(csv).csv);
    expect(rows[0]).toContain("Project Value");
    expect(rows[1][rows[0].indexOf("Project Value")]).toBe("");
  });
});

describe("detectPlatform / source platform on Lead Origin", () => {
  it("reads BuildingConnected off the real link format in Milo's sheet", () => {
    expect(detectPlatform("https://app.buildingconnected.com/opportunities/69d935d205a7")).toBe("BuildingConnected");
  });

  it("reads the other two platforms Derek named, which have no rows yet", () => {
    expect(detectPlatform("https://www.isqft.com/app/project/123")).toBe("iSqFt");
    expect(detectPlatform("https://app.constructconnect.com/x")).toBe("ConstructConnect");
  });

  it("returns null rather than guessing on an unknown host, a blank, or junk", () => {
    expect(detectPlatform("https://insight.cmdgroup.com/Project/Home")).toBeNull();
    expect(detectPlatform("")).toBeNull();
    expect(detectPlatform(null)).toBeNull();
    expect(detectPlatform("not a url")).toBeNull();
  });

  it("does not match a lookalike domain", () => {
    expect(detectPlatform("https://buildingconnected.com.evil.io/x")).toBeNull();
  });

  it("appends the platform to Lead Origin, keeping the Bid Invite prefix the scorer needs", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,https://app.buildingconnected.com/opportunities/abc,Frost,RJ,rj@frost.com,\n";
    const rows = parseCsv(normalizeLeadCsv(csv).csv);
    const origin = rows[1][rows[0].indexOf("Lead Origin")];
    expect(origin).toBe("Bid Invite: BuildingConnected");
    expect(origin.startsWith("Bid Invite")).toBe(true);
  });

  it("leaves a link-less row as plain Bid Invite, so the flat 50 still applies", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,,Frost,RJ,rj@frost.com,\n";
    const rows = parseCsv(normalizeLeadCsv(csv).csv);
    expect(rows[1][rows[0].indexOf("Lead Origin")]).toBe("Bid Invite");
  });

  it("never platform-tags the CMD sheet, whose links are cmdgroup", () => {
    const csv = "Bid Date,Project Title,City + State,Quick Link,Start,Stage,Winning Bidder,Phone,Email,Name,Notes\n46204,X,\"A, B\",https://insight.cmdgroup.com/Project/Home,46265,PB,TekTone,555,d@x.com,D,MB\n";
    const rows = parseCsv(normalizeLeadCsv(csv).csv);
    expect(rows[1][rows[0].indexOf("Lead Origin")]).toBe("CMD");
  });
});

describe("upload contract", () => {
  it("produces a base64 payload n8n can parse back to canonical headers", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,http://bc,Frost,RJ,rj@frost.com,\n";
    const out = normalizeLeadCsv(csv);
    const roundTripped = Buffer.from(Buffer.from(out.csv).toString("base64"), "base64").toString("utf8");
    const headers = parseCsv(roundTripped)[0];
    expect(headers).toContain("Winning Bidder");
    expect(headers).toContain("Stage");
    expect(detectSource(headers)).toBe("cmd"); // now canonical
  });
});

// --- Phase A: Platform column, tolerant headers, Bid Invite stage, ISO bid dates ---

const DEREK_HEADERS = ["Company", "Contact Name", "Primary Email", "Phone", "Bid Date", "Project Title", "Quick Link", "Platform"];
const derek = (...rows) => [DEREK_HEADERS.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
const cell = (out, row, col) => { const t = parseCsv(out.csv); return t[row][t[0].indexOf(col)]; };

describe("bid invites upload: Derek's headers with a Platform column", () => {
  const csv = derek(["Frost LLC", "RJ Frost", "rj@frost.com", "555-1", "9/15/2026", "City Hall", "https://app.buildingconnected.com/o/1", "BC"]);

  it("is read as a bid sheet, renamed to the canonical names, and keeps Platform", () => {
    const out = normalizeLeadCsv(csv, { kind: "bid_sheet" });
    expect(out.source).toBe("bid-aggregator");
    expect(out.renamed).toEqual(["Company", "Contact Name", "Primary Email"]);
    const header = parseCsv(out.csv)[0];
    for (const h of ["Winning Bidder", "Name", "Email", "Phone", "Bid Date", "Project Title", "Quick Link", "Platform", "Stage", "Lead Origin"]) {
      expect(header).toContain(h);
    }
    expect(header).not.toContain("Company");
    expect(cell(out, 1, "Winning Bidder")).toBe("Frost LLC");
    expect(cell(out, 1, "Platform")).toBe("BC");
  });

  it("detects the same headers without a kind, because of the Platform marker", () => {
    expect(detectSource(DEREK_HEADERS)).toBe("bid-aggregator");
    expect(normalizeLeadCsv(csv).source).toBe("bid-aggregator");
  });
});

describe("tolerant header detection", () => {
  const variant = ["company", "Email", "Contact", "Platform", "bid date", "Project", "link"];
  it("detects variant headers when the upload is a bid sheet", () => {
    expect(detectSource(["company", "Email", "Contact"], { kind: "bid_sheet" })).toBe("bid-aggregator");
    expect(detectSource(variant, { kind: "bid_sheet" })).toBe("bid-aggregator");
  });
  it("without a kind, variant headers need the Platform marker", () => {
    expect(detectSource(variant)).toBe("bid-aggregator");
    expect(detectSource(["company", "Email", "Contact"])).toBe("unknown");
    expect(detectSource(["company", "Email", "Contact"], { kind: "project_list" })).toBe("unknown");
  });
  it("renames variant headers to the names the importer reads", () => {
    const out = normalizeLeadCsv("company,Email,Contact,Platform,bid date,Project,link\nFrost,rj@frost.com,RJ,CC,9/15/2026,City Hall,http://x\n", { kind: "bid_sheet" });
    const header = parseCsv(out.csv)[0];
    for (const h of ["Winning Bidder", "Email", "Name", "Bid Date", "Project Title", "Quick Link"]) expect(header).toContain(h);
    expect(out.renamed).toEqual(["Contact", "Project", "bid date", "company", "link"]);
  });
  it("never claims a CMD sheet, even when asked to read it as a bid sheet", () => {
    expect(detectSource(CMD_HEADERS, { kind: "bid_sheet" })).toBe("cmd");
    expect(detectSource([...CMD_HEADERS, "Platform"])).toBe("cmd");
  });
  it("does not create two columns with the same name", () => {
    const out = normalizeLeadCsv("Company,Contact Name,Primary Email,Email,Platform\nA,B,p@x.com,e@x.com,BC\n");
    const header = parseCsv(out.csv)[0];
    expect(header.filter((h) => h === "Email")).toHaveLength(1);
    expect(cell(out, 1, "Email")).toBe("e@x.com");
  });
  it("still reads a header row that starts with a byte order mark", () => {
    const csv = "﻿Company,Contact Name,Primary Email,Platform,Bid Date\nFrost,RJ,rj@frost.com,BC,9/15/2026\n";
    expect(normalizeLeadCsv(csv, { kind: "bid_sheet" }).source).toBe("bid-aggregator");
    expect(detectSource(["﻿company", "contact", "email", "Platform"])).toBe("bid-aggregator");
  });
});

describe("Platform column becomes the Lead Origin tag", () => {
  const origin = (platform, link = "https://app.buildingconnected.com/o/1") =>
    cell(normalizeLeadCsv(derek(["Frost", "RJ", "rj@frost.com", "", "9/15/2026", "City Hall", link, platform])), 1, "Lead Origin");

  it("maps BC, cc, ISQFT and Other, keeping the Bid Invite prefix the guards match", () => {
    expect(origin("BC")).toBe("Bid Invite: BuildingConnected");
    expect(origin("cc")).toBe("Bid Invite: ConstructConnect");
    expect(origin("ISQFT")).toBe("Bid Invite: iSqFt");
    expect(origin("Other")).toBe("Bid Invite: Other");
    expect(origin(" BuildingConnected ")).toBe("Bid Invite: BuildingConnected");
  });
  it("lets the Platform column win over the link domain", () => {
    expect(origin("CC", "https://app.buildingconnected.com/o/1")).toBe("Bid Invite: ConstructConnect");
  });
  it("falls back to the link domain, then to plain Bid Invite, when Platform is empty", () => {
    expect(origin("")).toBe("Bid Invite: BuildingConnected");
    expect(origin("", "")).toBe("Bid Invite");
  });
  it("platformFromColumn is strict", () => {
    expect(platformFromColumn("XYZ")).toBeNull();
    expect(platformFromColumn("")).toBeNull();
    expect(platformFromColumn("bc")).toBe("BuildingConnected");
  });
  it("counts rows per origin", () => {
    const out = normalizeLeadCsv(derek(
      ["A", "a", "a@x.com", "", "9/15/2026", "P1", "", "BC"],
      ["B", "b", "b@x.com", "", "9/16/2026", "P2", "", "BC"],
      ["C", "c", "c@x.com", "", "9/17/2026", "P3", "", "Other"],
    ));
    expect(out.platforms).toEqual({ "Bid Invite: BuildingConnected": 2, "Bid Invite: Other": 1 });
  });
});

describe("unknown Platform value refuses the upload", () => {
  const sheet = derek(
    ["A", "a", "a@x.com", "", "9/15/2026", "P1", "", "BC"],
    ["B", "b", "b@x.com", "", "9/16/2026", "P2", "", "XYZ"],
    ["C", "c", "c@x.com", "", "9/17/2026", "P3", "", "BC"],
    ["D", "d", "d@x.com", "", "9/17/2026", "P4", "", "Procore"],
  );
  it("lists the bad rows (header is row 1)", () => {
    const out = normalizeLeadCsv(sheet, { kind: "bid_sheet" });
    expect(out.platformErrors).toEqual([{ row: 3, value: "XYZ" }, { row: 5, value: "Procore" }]);
  });
  it("checkUploadKind answers 400 naming the rows", () => {
    const check = checkUploadKind("bid_sheet", normalizeLeadCsv(sheet, { kind: "bid_sheet" }));
    expect(check).toEqual({ ok: false, status: 400, error: "Platform must be BC, CC, ISQFT or Other (rows 3, 5)" });
  });
  it("a clean sheet has no errors and passes", () => {
    const ok = normalizeLeadCsv(derek(["A", "a", "a@x.com", "", "9/15/2026", "P1", "", "ISQFT"]), { kind: "bid_sheet" });
    expect(ok.platformErrors).toEqual([]);
    expect(checkUploadKind("bid_sheet", ok)).toEqual({ ok: true });
  });
});

describe("Stage is Bid Invite even when the sheet has its own Stage column", () => {
  it("overrides it on every bid row", () => {
    const out = normalizeLeadCsv("Company,Contact Name,Primary Email,Platform,Stage\nA,a,a@x.com,BC,AGC\nB,b,b@x.com,CC,PB\n", { kind: "bid_sheet" });
    expect(cell(out, 1, "Stage")).toBe("Bid Invite");
    expect(cell(out, 2, "Stage")).toBe("Bid Invite");
    expect(parseCsv(out.csv)[0].filter((h) => h === "Stage")).toHaveLength(1);
  });
  it("leaves the CMD sheet's stage alone", () => {
    const csv = "Bid Date,Project Title,City + State,Quick Link,Start,Stage,Winning Bidder,Phone,Email,Name,Notes\n46204,X,\"A, B\",http://x,46265,PB,TekTone,555,d@x.com,D,MB\n";
    expect(cell(normalizeLeadCsv(csv), 1, "Stage")).toBe("PB");
  });
});

describe("a bare short code already in Lead Origin (how lead 21b9e420 got 'BC')", () => {
  const withOrigin = (o) => normalizeLeadCsv(`Company,Contact Name,Primary Email,Lead Origin\nA,a,a@x.com,${o}\n`, { kind: "bid_sheet" });
  it("becomes the full tag, and the file passes the bid sheet check", () => {
    const out = withOrigin("BC");
    expect(cell(out, 1, "Lead Origin")).toBe("Bid Invite: BuildingConnected");
    expect(checkUploadKind("bid_sheet", out)).toEqual({ ok: true });
    expect(cell(withOrigin("isqft"), 1, "Lead Origin")).toBe("Bid Invite: iSqFt");
  });
  it("keeps anything that already starts with Bid Invite, and an empty cell is filled in", () => {
    expect(cell(withOrigin("Bid Invite: iSqFt"), 1, "Lead Origin")).toBe("Bid Invite: iSqFt");
    expect(cell(withOrigin("Bid Invite"), 1, "Lead Origin")).toBe("Bid Invite");
    expect(cell(withOrigin(""), 1, "Lead Origin")).toBe("Bid Invite");
  });
  it("leaves other values as typed so the kind check still refuses them", () => {
    const out = withOrigin("CMD");
    expect(cell(out, 1, "Lead Origin")).toBe("CMD");
    expect(checkUploadKind("bid_sheet", out)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("bid dates are written as ISO", () => {
  it.each(["9/15/2026", "9/15/26", "2026-09-15", "Sep 15, 2026 2:00 PM", "09/15/2026 14:00", "September 15, 2026", "2026-09-15T14:00:00Z"])(
    "reads %s as 2026-09-15", (typed) => {
      expect(parseBidDate(typed)).toBe("2026-09-15");
      const out = normalizeLeadCsv(`Company,Contact Name,Primary Email,Platform,Bid Date\nA,a,a@x.com,BC,"${typed}"\n`, { kind: "bid_sheet" });
      expect(cell(out, 1, "Bid Date")).toBe("2026-09-15");
      expect(out.bidDates).toEqual({ parsed: 1, missing: 0, beforeFloor: 0 });
    });
  it("keeps junk as typed and counts it as missing", () => {
    const out = normalizeLeadCsv("Company,Contact Name,Primary Email,Platform,Bid Date\nA,a,a@x.com,BC,TBD\nB,b,b@x.com,BC,\nC,c,c@x.com,BC,2/30/2026\n", { kind: "bid_sheet" });
    expect(cell(out, 1, "Bid Date")).toBe("TBD");
    expect(out.bidDates).toEqual({ parsed: 0, missing: 3, beforeFloor: 0 });
    expect(out.warnings.join(" ")).toContain("3 rows have no readable bid date");
  });
  it("counts bids before 2026-09-01 as a warning, not a refusal", () => {
    const out = normalizeLeadCsv("Company,Contact Name,Primary Email,Platform,Bid Date\nA,a,a@x.com,BC,2026-08-20\nB,b,b@x.com,BC,9/1/2026\n", { kind: "bid_sheet" });
    expect(out.bidDates).toEqual({ parsed: 2, missing: 0, beforeFloor: 1 });
    expect(out.warnings.join(" ")).toContain("before 2026-09-01");
    expect(checkUploadKind("bid_sheet", out)).toEqual({ ok: true });
  });
  it("uses a different cut-off date when given one", () => {
    const out = normalizeLeadCsv("Company,Contact Name,Primary Email,Platform,Bid Date\nA,a,a@x.com,BC,2026-09-10\n", { kind: "bid_sheet", minBidDate: "2026-10-01" });
    expect(out.bidDates.beforeFloor).toBe(1);
  });
  it("does not touch the dates on a CMD sheet", () => {
    const csv = "Bid Date,Project Title,City + State,Quick Link,Start,Stage,Winning Bidder,Phone,Email,Name,Notes\n46204,X,\"A, B\",http://x,46265,PB,TekTone,555,d@x.com,D,MB\n";
    const out = normalizeLeadCsv(csv);
    expect(cell(out, 1, "Bid Date")).toBe("46204");
    expect(out.bidDates).toEqual({ parsed: 0, missing: 0, beforeFloor: 0 });
  });
});
