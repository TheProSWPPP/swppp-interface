import { describe, it, expect } from "vitest";
import { detectSource, parseProjectValue, normalizeLeadCsv, parseCsv, detectPlatform } from "../leadCsvNormalize.js";

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

  it("sets Stage to CM on every aggregator row, because that is the bidding sequence", () => {
    const csv = "Bid Date,Project Title,Quick Link,Company,Contact Name,Primary Email,Notes\n46145,X,http://bc,Frost,RJ,rj@frost.com,\n46146,Y,http://bc2,Acme,Jo,jo@acme.com,\n";
    const out = normalizeLeadCsv(csv);
    const rows = out.csv.trim().split("\n").slice(1);
    const cols = out.csv.split("\n")[0].split(",");
    const stageIdx = cols.indexOf("Stage");
    expect(rows.every((r) => r.split(",")[stageIdx] === "CM")).toBe(true);
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
