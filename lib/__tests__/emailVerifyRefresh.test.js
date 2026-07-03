// lib/__tests__/emailVerifyRefresh.test.js
import { describe, it, expect } from "vitest";
import {
  needsVerify, classifyVerifyResult, emailDomain, pickBestCandidate, STALE_MS,
} from "../emailVerifyRefresh.js";

const NOW = Date.parse("2026-07-02T00:00:00Z");

describe("needsVerify", () => {
  const base = { status: "clear", triggerType: "agc", email: "a@b.com", verifiedValue: null, verifiedAt: null, now: NOW };
  it("verifies an eligible, never-verified lead", () => {
    expect(needsVerify(base)).toBe(true);
  });
  it("skips non-clear leads", () => {
    expect(needsVerify({ ...base, status: "contacted_recent" })).toBe(false);
  });
  it("skips leads with no trigger", () => {
    expect(needsVerify({ ...base, triggerType: null })).toBe(false);
  });
  it("skips leads with no email", () => {
    expect(needsVerify({ ...base, email: null })).toBe(false);
  });
  it("skips when verified recently and email unchanged", () => {
    expect(needsVerify({ ...base, verifiedValue: "a@b.com", verifiedAt: NOW - 1000 })).toBe(false);
  });
  it("re-verifies when the email changed", () => {
    expect(needsVerify({ ...base, verifiedValue: "old@b.com", verifiedAt: NOW - 1000 })).toBe(true);
  });
  it("re-verifies when the cache is older than 90 days", () => {
    expect(needsVerify({ ...base, verifiedValue: "a@b.com", verifiedAt: NOW - STALE_MS - 1000 })).toBe(true);
  });
});

describe("classifyVerifyResult", () => {
  it("maps skipped → skip", () => expect(classifyVerifyResult({ ok: true, skipped: true })).toBe("skip"));
  it("maps ok:false → hard_fail", () => expect(classifyVerifyResult({ ok: false, status: "invalid" })).toBe("hard_fail"));
  it("maps ok pass → pass", () => expect(classifyVerifyResult({ ok: true, status: "valid" })).toBe("pass"));
  it("maps soft (catchall) → pass", () => expect(classifyVerifyResult({ ok: true, status: "catchall", soft: "catchall" })).toBe("pass"));
});

describe("emailDomain", () => {
  it("extracts + lowercases", () => expect(emailDomain("Bob@Acme.COM")).toBe("acme.com"));
  it("returns null on garbage", () => expect(emailDomain("nope")).toBe(null));
});

describe("pickBestCandidate", () => {
  const pri = ["owner", "estimator"];
  it("prefers the higher-priority title", () => {
    const c = pickBestCandidate([{ email: "e@x.com", title: "Estimator" }, { email: "o@x.com", title: "Owner" }], pri);
    expect(c.email).toBe("o@x.com");
  });
  it("drops locked/emailless candidates", () => {
    const c = pickBestCandidate([{ email: "email_not_unlocked@domain.com", title: "Owner" }, { email: "real@x.com", title: "Clerk" }], pri);
    expect(c.email).toBe("real@x.com");
  });
  it("returns null when nothing usable", () => {
    expect(pickBestCandidate([{ email: null, title: "Owner" }], pri)).toBe(null);
  });
});
