import { describe, it, expect } from "vitest";
import { isCmdUrl, refuseNonCmdUrl } from "../../cmd-scraper/hostGuard.js";

// The same cases run under `node --test` in cmd-scraper/hostGuard.test.js; this copy keeps them
// in the main `npx vitest run` suite. The CMD scraper holds a logged-in CMD session, so it must
// refuse bid invite links (BuildingConnected and the rest) with a 400.
describe("cmd-scraper host guard", () => {
  it("refuses a BuildingConnected URL with 400 and accepts a CMD Insight URL", () => {
    expect(refuseNonCmdUrl("https://app.buildingconnected.com/opportunities/abc", "project_url")).toEqual({
      status: 400,
      body: { ok: false, error: "not_a_cmd_url", message: "project_url must be a cmdgroup.com link" },
    });
    expect(refuseNonCmdUrl("https://insight.cmdgroup.com/Project/Home/ProjectInformation/1/1/2", "project_url")).toBeNull();
  });
  it("refuses lookalike hosts and junk", () => {
    for (const u of ["https://cmdgroup.com.evil.io/x", "https://evilcmdgroup.com/x", "ftp://insight.cmdgroup.com/x", "nope", "", null]) {
      expect(isCmdUrl(u)).toBe(false);
    }
  });
});
