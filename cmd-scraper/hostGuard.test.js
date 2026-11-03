import { test } from "node:test";
import assert from "node:assert/strict";
import { isCmdUrl, refuseNonCmdUrl } from "./hostGuard.js";

test("accepts CMD Insight links", () => {
  assert.equal(isCmdUrl("https://insight.cmdgroup.com/Project/Home/ProjectInformation/1007823561/1/72024461"), true);
  assert.equal(isCmdUrl("https://insight.cmdgroup.com/Company/Home/CompanyInformation/12345"), true);
  assert.equal(isCmdUrl("https://CMDGROUP.com/p/1"), true);
  assert.equal(refuseNonCmdUrl("https://insight.cmdgroup.com/x", "project_url"), null);
});

test("refuses bid invite platforms with a 400", () => {
  for (const url of [
    "https://app.buildingconnected.com/opportunities/69d935d205a7",
    "https://app.constructconnect.com/x",
    "https://www.isqft.com/app/project/123",
  ]) {
    assert.equal(isCmdUrl(url), false);
    const refusal = refuseNonCmdUrl(url, "project_url");
    assert.equal(refusal.status, 400);
    assert.equal(refusal.body.error, "not_a_cmd_url");
  }
});

test("refuses lookalike hosts, other schemes, and junk", () => {
  for (const url of [
    "https://cmdgroup.com.evil.io/x",
    "https://evilcmdgroup.com/x",
    "https://evil.io/?u=insight.cmdgroup.com",
    "ftp://insight.cmdgroup.com/x",
    "not a url",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isCmdUrl(url), false, String(url));
  }
});
